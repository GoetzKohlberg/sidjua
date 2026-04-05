// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9: OrchestratorProcess
 *
 * The coordination brain. Manages the full 3-tier agent hierarchy:
 *   - Receives task events from the SQLite EventBus
 *   - Routes tasks to agents via WorkDistributor
 *   - Tracks sub-task completion via SynthesisCollector
 *   - Handles failures via EscalationManager
 *   - Routes consultations via PeerRouter
 *   - Provides cascading cancellation via TaskTreeManager
 *
 * CRITICAL: Event processing is sequential per batch (no parallel handlers).
 * This prevents race conditions on task state (e.g., double synthesis trigger).
 * Throughput comes from agents working in parallel, not from parallel event handling.
 *
 * No LLM calls — pure coordination logic.
 *
 * Event handlers: orchestrator-event-handlers.ts
 * IPC server:     orchestrator-ipc.ts
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "../utils/db.js";
import type { TaskEvent } from "../tasks/types.js";
import { TaskStore } from "../tasks/store.js";
import { TaskEventBus } from "../tasks/event-bus.js";
import { DelegationEngine } from "./delegation.js";
import { WorkDistributor } from "./distributor.js";
import { SynthesisCollector } from "./synthesis.js";
import { EscalationManager } from "./escalation.js";
import { PeerRouter } from "./peer-router.js";
import { TaskTreeManager } from "./tree-manager.js";
import { TaskPipeline } from "../pipeline/task-pipeline.js";
import { createSandboxProvider } from "../core/sandbox/sandbox-factory.js";
import { BubblewrapProvider } from "../core/sandbox/bubblewrap-provider.js";
import { startViolationLogger } from "../core/sandbox/violation-logger.js";
import type { SandboxProvider } from "../core/sandbox/types.js";
import type {
  OrchestratorConfig,
  OrchestratorState,
  OrchestratorStatus,
  AgentInstance,
  PHASE9_SCHEMA_SQL as _Schema,
} from "./types.js";
import { PHASE9_SCHEMA_SQL } from "./types.js";
import { createLogger } from "../core/logger.js";
import type { AgentDaemonManager } from "../agent-lifecycle/daemon-manager.js";
import type { InboundMessageGateway } from "../messaging/inbound-gateway.js";
import type { AdapterRegistry } from "../messaging/adapter-registry.js";
import type { UserMappingStore } from "../messaging/user-mapping.js";
import type { AdapterInstanceConfig } from "../messaging/types.js";
import { CronScheduler } from "../scheduler/cron-scheduler.js";
import { DeadlineWatcher } from "../scheduler/deadline-watcher.js";
import { loadSchedulingGovernance } from "../scheduler/config-loader.js";
import {
  OrchestratorIpcServer,
} from "./orchestrator-ipc.js";
import type { OrchestratorIpcDelegate, CLIRequest, CLIResponse } from "./orchestrator-ipc.js";
import {
  handleNewTask,
  handleResultReady,
  handleTaskFailed,
  handleEscalation,
  handleConsultation,
  handleAgentCrash,
  handleAgentRecovery,
  handleBudgetExceeded,
  handleHeartbeatTimeout,
} from "./orchestrator-event-handlers.js";
import type { EventHandlerContext } from "./orchestrator-event-handlers.js";

// Re-export IPC types for backwards compatibility — ipc-client.ts imports these
export type { CLIRequest, CLIResponse } from "./orchestrator-ipc.js";
export { IPC_TOKEN_FILENAME } from "./orchestrator-ipc.js";

const _coreLogger = createLogger("orchestrator");


export class OrchestratorProcess implements OrchestratorIpcDelegate {
  private _state: OrchestratorState = "STOPPED";
  private _startedAt: Date | null   = null;
  private _loopRunning              = false;
  private _loopPromise: Promise<void> | null = null;

  /** Phase 10: IPC server (socket + command dispatch). */
  private readonly _ipcServer: OrchestratorIpcServer;

  // In-memory agent registry (source of truth at runtime)
  readonly agents = new Map<string, AgentInstance>();

  // Sub-components
  readonly store:               TaskStore;
  readonly delegationEngine:    DelegationEngine;
  readonly distributor:         WorkDistributor;
  readonly synthesisCollector:  SynthesisCollector;
  readonly escalationManager:   EscalationManager;
  readonly peerRouter:          PeerRouter;
  readonly treeManager:         TaskTreeManager;
  /** Phase 9.5 Task Pipeline (optional — only set when config.pipeline is provided). */
  readonly pipeline:            TaskPipeline | null;
  /** Phase 19 Sandbox provider (optional — only set when config.sandbox is provided). */
  private _sandboxProvider:     SandboxProvider | null = null;
  private _violationLoggerStop: (() => void) | null    = null;
  /** V1.1 AgentDaemonManager (optional — injected via setDaemonManager after construction). */
  private _daemonManager:       AgentDaemonManager | null = null;
  /** V1.1 Messaging gateway (optional — injected via setMessagingServices after construction). */
  private _messagingGateway:    InboundMessageGateway | null = null;
  private _messagingRegistry:   AdapterRegistry | null = null;
  private _userMappingStore:    UserMappingStore | null = null;
  private _messagingConfigs:    AdapterInstanceConfig[] | null = null;
  /** V1.1 CronScheduler + DeadlineWatcher (instantiated in constructor when DB available). */
  private readonly _cronScheduler:    CronScheduler;
  private readonly _deadlineWatcher:  DeadlineWatcher;

  constructor(
    private readonly db: Database,
    readonly eventBus: TaskEventBus,
    readonly config: OrchestratorConfig,
    /** Pre-built agent instances (used in tests to inject mocks). */
    prebuiltAgents?: Map<string, AgentInstance>,
  ) {
    this.store              = new TaskStore(db);
    this.delegationEngine   = new DelegationEngine(config);
    this.distributor        = new WorkDistributor();
    this.treeManager        = new TaskTreeManager(db, eventBus);
    this.synthesisCollector = new SynthesisCollector(db, eventBus);
    this.escalationManager  = new EscalationManager(
      db, eventBus, this.distributor, this.agents, this.treeManager,
    );
    this.peerRouter = new PeerRouter(db, eventBus, this.distributor, this.agents);

    // Phase 9.5: TaskPipeline (optional — only when config.pipeline is provided)
    this.pipeline = config.pipeline !== undefined
      ? new TaskPipeline(db, eventBus, this.agents, config.pipeline)
      : null;

    // Pre-load agents if provided (testing / pre-configured environments)
    if (prebuiltAgents !== undefined) {
      for (const [id, inst] of prebuiltAgents) {
        this.agents.set(id, inst);
      }
    }

    // Initialize Phase 9 DB schema (idempotent)
    this.db.exec(PHASE9_SCHEMA_SQL);

    // V1.1: CronScheduler + DeadlineWatcher — instantiated once, shared with daemons
    const workDir        = dirname(config.governance_root);
    const schedulingGov  = loadSchedulingGovernance(join(workDir));
    const budgetPassthrough = { canAfford: () => true }; // orchestrator-level: defer to per-schedule governance
    this._cronScheduler   = new CronScheduler(db, budgetPassthrough, schedulingGov);
    this._deadlineWatcher = new DeadlineWatcher(this.store, schedulingGov);

    // Phase 10: IPC server — wires back into this orchestrator via delegate interface
    this._ipcServer = new OrchestratorIpcServer(this);
  }

  // ---------------------------------------------------------------------------
  // OrchestratorIpcDelegate accessors
  // ---------------------------------------------------------------------------

  /** Current orchestrator state (also satisfies IpcDelegate.state). */
  get state(): OrchestratorState { return this._state; }

  get daemonManager():    AgentDaemonManager | null        { return this._daemonManager; }
  get messagingGateway(): InboundMessageGateway | null     { return this._messagingGateway; }
  get messagingRegistry(): AdapterRegistry | null          { return this._messagingRegistry; }
  get messagingConfigs(): AdapterInstanceConfig[] | null   { return this._messagingConfigs; }
  get userMappingStore(): UserMappingStore | null          { return this._userMappingStore; }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start the orchestrator: recover in-flight tasks, then begin event loop. */
  async start(): Promise<void> {
    if (this._state !== "STOPPED") {
      throw new Error(`Cannot start: current state is '${this._state}'`);
    }

    this._state    = "STARTING";
    this._startedAt = new Date();
    this.persistState();

    _coreLogger.info("orchestrator_starting", "Starting", { metadata: { agents: this.agents.size } });

    // Phase 19: Initialize sandbox provider if configured
    if (this.config.sandbox !== undefined) {
      this._sandboxProvider = createSandboxProvider(this.config.sandbox);
      await this._sandboxProvider.initialize();
      // BubblewrapProvider manages its own violation logger lifecycle
      // via an internal AbortController that is aborted in cleanup(). For other
      // providers the external subscription is used for backward compatibility.
      if (this._sandboxProvider instanceof BubblewrapProvider) {
        this._sandboxProvider.startViolationLogging();
        this._violationLoggerStop = null; // owned by provider; cleanup() handles it
      } else {
        this._violationLoggerStop = startViolationLogger(this._sandboxProvider);
      }
      _coreLogger.info("sandbox_initialized", "Sandbox initialized", { metadata: { provider: this._sandboxProvider.name } });
    }

    // Recover any in-flight tasks from previous crash/restart
    await this.recoverInFlightTasks();

    // P270 B2: Process pending decisions from previous offline period (best-effort)
    try {
      await this._processPendingDecisions();
    } catch (e: unknown) {
      _coreLogger.warn("pending_decisions_replay_failed", "Pending decisions replay failed (non-fatal)", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
    }

    this._state      = "RUNNING";
    this._loopRunning = true;
    this.persistState();

    // Start event loop (runs in background)
    this._loopPromise = this.eventLoop();

    // V1.1: Start daemon manager loops (best-effort — failure does not block orchestrator)
    if (this._daemonManager !== null) {
      // Initialize scheduler schema and inject scheduler services into daemons
      void this._cronScheduler.initialize();
      this._daemonManager.setSchedulerServices({
        cronScheduler:   this._cronScheduler,
        deadlineWatcher: this._deadlineWatcher,
        taskStore:        this.store,
        eventBus:         this.eventBus,
        agentDivision:    this.config.default_division,
      });
      const started = this._daemonManager.startAll();
      _coreLogger.info("daemon_loops_started", "Daemon loops started", { metadata: { count: started } });
    }

    // V1.1: Start messaging gateway (best-effort — failure does not block orchestrator)
    if (this._messagingGateway !== null && this._messagingConfigs !== null) {
      this._messagingGateway.start(this._messagingConfigs).catch((e: unknown) => {
        _coreLogger.warn("messaging_gateway_start_error", "Messaging gateway start error", { metadata: { error: String(e) } });
      });
      _coreLogger.info("messaging_gateway_starting", "Messaging gateway starting", { metadata: { instances: this._messagingConfigs.length } });
    }

    _coreLogger.info("orchestrator_running", "Running", { metadata: { agents: this.agents.size } });
  }

  /** Graceful shutdown: stop accepting events, shut down all agents. */
  async stop(): Promise<void> {
    if (this._state === "STOPPED") return;

    this._state      = "SHUTTING_DOWN";
    this._loopRunning = false;
    this.persistState();

    // Wait for current loop iteration to finish
    if (this._loopPromise !== null) {
      await this._loopPromise.catch(() => undefined);
    }

    // Shut down all agent processes gracefully
    await Promise.allSettled(
      [...this.agents.values()].map((inst) =>
        inst.process.shutdown(true).catch(() => undefined),
      ),
    );

    // V1.1: Stop messaging gateway before daemon loops
    if (this._messagingGateway !== null) {
      await this._messagingGateway.stop().catch(() => undefined);
    }

    // V1.1: Stop all daemon loops before cleaning up other resources
    if (this._daemonManager !== null) {
      await this._daemonManager.stopAll().catch(() => undefined);
    }

    // Phase 19: Clean up sandbox provider
    if (this._violationLoggerStop !== null) {
      this._violationLoggerStop();
      this._violationLoggerStop = null;
    }
    if (this._sandboxProvider !== null) {
      await this._sandboxProvider.cleanup();
      this._sandboxProvider = null;
    }

    this._state = "STOPPED";
    this.persistState();

    _coreLogger.info("orchestrator_stopped", "Stopped");
  }

  /**
   * Graceful shutdown: drain in-flight tasks up to `drainTimeoutSec`, mark
   * any remaining in-flight tasks as FAILED, flush the WAL, then stop.
   */
  async gracefulShutdown(drainTimeoutSec: number): Promise<void> {
    if (this._state === "STOPPED") return;

    // Stop accepting new tasks
    this._state       = "SHUTTING_DOWN";
    this._loopRunning = false;
    this.persistState();

    if (this._loopPromise !== null) {
      await this._loopPromise.catch(() => undefined);
    }

    // Wait for in-flight tasks to complete
    const deadline = Date.now() + drainTimeoutSec * 1000;
    const activeStatuses = ["RUNNING", "ASSIGNED"] as const;
    while (Date.now() < deadline) {
      const inFlight = activeStatuses.flatMap((s) => this.store.getByStatus(s));
      if (inFlight.length === 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }

    // Mark remaining in-flight tasks as FAILED
    let interrupted = 0;
    for (const s of activeStatuses) {
      const tasks = this.store.getByStatus(s);
      for (const task of tasks) {
        try {
          this.store.update(task.id, {
            status:         "FAILED",
            result_summary: "Interrupted by shutdown",
          });
          interrupted++;
        } catch (e: unknown) {
          _coreLogger.warn("shutdown_task_fail_error", "Could not mark task as failed during shutdown", {
            metadata: { task_id: task.id, error: e instanceof Error ? e.message : String(e) },
          });
        }
      }
    }
    if (interrupted > 0) {
      _coreLogger.info("shutdown_interrupted_tasks", `Shutdown interrupted ${interrupted} in-flight task(s)`, {
        metadata: { interrupted },
      });
    }

    // Flush WAL to main database file
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch (_e) { /* flush-ignore */ }

    // Delegate to existing stop() for service teardown
    await this.stop();
  }

  /** Pause: stop accepting new events, let in-flight tasks reach checkpoint. */
  async pause(): Promise<void> {
    if (this._state !== "RUNNING") return;

    this._state      = "PAUSING";
    this._loopRunning = false;

    if (this._loopPromise !== null) {
      await this._loopPromise.catch(() => undefined);
    }

    this._state = "PAUSED";
    this.persistState();

    _coreLogger.info("orchestrator_paused", "Paused");
  }

  /** Resume from paused state. */
  async resume(): Promise<void> {
    if (this._state !== "PAUSED") return;

    this._state      = "RESUMING";
    this._loopRunning = true;
    this._state      = "RUNNING";
    this.persistState();

    this._loopPromise = this.eventLoop();

    _coreLogger.info("orchestrator_resumed", "Resumed");
  }

  // ---------------------------------------------------------------------------
  // Sandbox helpers
  // ---------------------------------------------------------------------------

  /**
   * Return environment variables to inject into agent processes for network
   * isolation. Only populated when the active provider is BubblewrapProvider
   * and the proxy has been initialized.
   *
   * Callers should merge these into ProcessOptions.env before spawning an
   * AgentProcess so that the forked process routes traffic through the
   * SandboxManager's filtering proxy.
   */
  getSandboxEnvVars(): Record<string, string> {
    if (!(this._sandboxProvider instanceof BubblewrapProvider)) return {};
    const port = this._sandboxProvider.getProxyPort();
    if (port === undefined) return {};
    const proxy = `http://127.0.0.1:${port}`;
    return {
      HTTP_PROXY:  proxy,
      HTTPS_PROXY: proxy,
      http_proxy:  proxy,
      https_proxy: proxy,
    };
  }

  // ---------------------------------------------------------------------------
  // Event Loop
  // ---------------------------------------------------------------------------

  private async eventLoop(): Promise<void> {
    while (this._loopRunning && this._state === "RUNNING") {
      const events = await this.eventBus.consume("orchestrator", 50);

      if (events.length === 0) {
        await sleep(this.config.event_poll_interval_ms);
        continue;
      }

      // Process events sequentially — no parallel handling
      for (const event of events) {
        try {
          await this.routeEvent(event);
        } catch (err) {
          _coreLogger.error("event_handler_error", "Event handler error", {
            metadata: { event_type: event.event_type, task_id: event.task_id, error: String(err) },
          });
        }
      }

      // Mark all as consumed after processing the batch
      await this.eventBus.acknowledge(events.map((e) => e.id));

      // Phase 9.5: dispatch pending pipeline tasks after each event batch
      if (this.pipeline !== null) {
        this.pipeline.dispatchPending();
      }
    }
  }

  private async routeEvent(event: TaskEvent): Promise<void> {
    switch (event.event_type) {
      case "TASK_CREATED":          return this.handleNewTask(event);
      case "RESULT_READY":          return this.handleResultReady(event);
      case "TASK_FAILED":           return this.handleTaskFailed(event);
      case "TASK_ESCALATED":        return this.handleEscalation(event);
      case "CONSULTATION_REQUEST":  return this.handleConsultation(event);
      case "AGENT_CRASHED":         return this.handleAgentCrash(event);
      case "AGENT_RECOVERED":       return this.handleAgentRecovery(event);
      case "BUDGET_EXHAUSTED":      return this.handleBudgetExceeded(event);
      case "HEARTBEAT_TIMEOUT":     return this.handleHeartbeatTimeout(event);
      default:
        // Other events (TASK_PROGRESS, CHECKPOINT_SAVED, etc.) not handled here
        break;
    }
  }

  // Private wrapper methods — delegate to free functions in orchestrator-event-handlers.ts.
  // Kept as methods so that tests that call priv(orch).handleXxx() continue to work.
  private ctx(): EventHandlerContext {
    return {
      store:              this.store,
      agents:             this.agents,
      distributor:        this.distributor,
      synthesisCollector: this.synthesisCollector,
      escalationManager:  this.escalationManager,
      peerRouter:         this.peerRouter,
      pipeline:           this.pipeline,
    };
  }
  private async handleNewTask(event: TaskEvent):        Promise<void> { return handleNewTask(this.ctx(), event); }
  private async handleResultReady(event: TaskEvent):    Promise<void> { return handleResultReady(this.ctx(), event); }
  private async handleTaskFailed(event: TaskEvent):     Promise<void> { return handleTaskFailed(this.ctx(), event); }
  private async handleEscalation(event: TaskEvent):     Promise<void> { return handleEscalation(this.ctx(), event); }
  private async handleConsultation(event: TaskEvent):   Promise<void> { return handleConsultation(this.ctx(), event); }
  private async handleAgentCrash(event: TaskEvent):     Promise<void> { return handleAgentCrash(this.ctx(), event); }
  private async handleAgentRecovery(event: TaskEvent):  Promise<void> { return handleAgentRecovery(this.ctx(), event); }
  private async handleBudgetExceeded(event: TaskEvent): Promise<void> { return handleBudgetExceeded(this.ctx(), event); }
  private async handleHeartbeatTimeout(event: TaskEvent): Promise<void> { return handleHeartbeatTimeout(this.ctx(), event); }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  /**
   * Called on startup after a crash or restart.
   *
   * Queries DB for non-terminal tasks and resumes from last known state:
   *   RUNNING without checkpoint → reset to PENDING
   *   WAITING → check if sub-tasks completed → trigger synthesis if ready
   *   ASSIGNED without live agent → reset to PENDING
   */
  async recoverInFlightTasks(): Promise<void> {
    const runningTasks  = this.store.getByStatus("RUNNING");
    const waitingTasks  = this.store.getByStatus("WAITING");
    const assignedTasks = this.store.getByStatus("ASSIGNED");

    // RUNNING tasks without checkpoint → reset to PENDING
    for (const task of runningTasks) {
      if (task.checkpoint === null) {
        this.store.update(task.id, {
          status:         "PENDING",
          retry_count:    task.retry_count + 1,
          assigned_agent: null,
        });
      }
      // With checkpoint: agent resumes from checkpoint when ITBootstrapAgent restarts it
    }

    // WAITING tasks → check if all sub-tasks completed while orchestrator was down
    for (const task of waitingTasks) {
      const children = this.store.getByParent(task.id);
      if (children.length === 0) continue;

      const allTerminal = children.every(
        (c) => c.status === "DONE" || c.status === "FAILED" || c.status === "CANCELLED",
      );

      if (allTerminal) {
        // All sub-tasks done while orchestrator was down — trigger synthesis directly.
        // We skip registerResult to avoid stale counter interference.
        const terminalChildren = children.filter(
          (c) => c.status === "DONE" || c.status === "FAILED",
        );
        const summaries = terminalChildren.map((c) => ({
          task_id:     c.id,
          title:       c.title,
          summary:     c.result_summary ?? "(no summary)",
          confidence:  c.confidence ?? 0,
          result_file: c.result_file ?? "",
          status:      (c.status === "DONE" ? "DONE" : "FAILED") as "DONE" | "FAILED",
        }));
        await this.synthesisCollector.triggerParentSynthesis(task.id, summaries);
      }
    }

    // ASSIGNED tasks → check if agent is alive; if not, reset to PENDING
    for (const task of assignedTasks) {
      const agentId = task.assigned_agent;
      if (agentId === null) {
        this.store.update(task.id, { status: "PENDING" });
        continue;
      }

      const inst = this.agents.get(agentId);
      if (inst === undefined || inst.status === "crashed") {
        this.store.update(task.id, {
          status:         "PENDING",
          assigned_agent: null,
        });
      }
    }

    _coreLogger.info("recovery_complete", "Recovery complete", {
      metadata: { running: runningTasks.length, waiting: waitingTasks.length, assigned: assignedTasks.length },
    });
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /** Returns current orchestrator state, agent counts, and task statistics. */
  getStatus(): OrchestratorStatus {
    const instances   = [...this.agents.values()];
    const byTier:   Record<number, number> = {};
    const byStatus: Record<string, number> = {};

    for (const inst of instances) {
      const tier = inst.definition.tier;
      byTier[tier]         = (byTier[tier] ?? 0) + 1;
      byStatus[inst.status] = (byStatus[inst.status] ?? 0) + 1;
    }

    const taskCounts   = this.store.countByStatus();
    const byTaskStatus = Object.fromEntries(
      Object.entries(taskCounts).map(([s, n]) => [s, n]),
    );

    // Active trees: root tasks (parent_id === null) in non-terminal states
    const activeTrees = [
      ...this.store.getByStatus("RUNNING"),
      ...this.store.getByStatus("WAITING"),
      ...this.store.getByStatus("ASSIGNED"),
      ...this.store.getByStatus("PENDING"),
    ].filter((t) => t.parent_id === null).length;

    const uptimeSeconds = this._startedAt !== null
      ? Math.floor((Date.now() - this._startedAt.getTime()) / 1000)
      : 0;

    return {
      state:          this._state,
      uptime_seconds: uptimeSeconds,
      agents: {
        total:    instances.length,
        by_tier:  byTier,
        by_status: byStatus,
      },
      tasks: {
        total:        Object.values(byTaskStatus).reduce((s, n) => s + n, 0),
        by_status:    byTaskStatus,
        active_trees: activeTrees,
      },
      costs: {
        total_usd:   instances.reduce((s, a) => s + a.total_cost_usd, 0),
        by_division: {}, // Phase 10+: computed from task cost_used per division
      },
    };
  }

  // ---------------------------------------------------------------------------
  // V1.1: Daemon manager + Messaging
  // ---------------------------------------------------------------------------

  /**
   * Inject an AgentDaemonManager.
   * Must be called before start() to enable daemon lifecycle management.
   */
  setDaemonManager(manager: AgentDaemonManager): void {
    this._daemonManager = manager;
  }

  /**
   * Inject messaging services.
   * Must be called before start() to enable the messaging gateway.
   */
  setMessagingServices(
    gateway:     InboundMessageGateway,
    registry:    AdapterRegistry,
    userMapping: UserMappingStore,
    configs:     AdapterInstanceConfig[],
  ): void {
    this._messagingGateway  = gateway;
    this._messagingRegistry = registry;
    this._userMappingStore  = userMapping;
    this._messagingConfigs  = configs;
  }

  /**
   * Wire a MessageProcessor (e.g. MessageToTaskBridge) into the messaging gateway
   * and start a TaskLifecycleRouter on the event bus.
   *
   * Must be called after setMessagingServices().
   */
  wireTaskBridge(
    processor:       import("../messaging/inbound-gateway.js").MessageProcessor,
    lifecycleRouter: { start(): void },
  ): void {
    if (this._messagingGateway !== null) {
      this._messagingGateway.onMessage((msg) => processor.processMessage(msg));
    }
    lifecycleRouter.start();
  }

  // ---------------------------------------------------------------------------
  // Agent registration (test helper + runtime use)
  // ---------------------------------------------------------------------------

  /** Register an agent instance with the orchestrator. */
  registerAgent(instance: AgentInstance): void {
    this.agents.set(instance.definition.id, instance);
    // Phase 9.5: also register with pipeline backpressure monitor
    if (this.pipeline !== null) {
      this.pipeline.registerAgent(instance.definition.id, instance.definition.max_concurrent_tasks);
    }

    // Auto-remove agent from registry when its process exits to prevent
    // zombie entries. This also handles unexpected crashes during normal operation.
    instance.process.onExit((code, signal) => {
      const agentId = instance.definition.id;
      if (this.agents.has(agentId)) {
        this.agents.delete(agentId);
        _coreLogger.info("agent_process_exited", "Agent process exited — removed from registry", {
          metadata: { agent_id: agentId, exit_code: code, signal },
        });
      }
    });
  }

  /** Remove an agent instance from the registry. */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  // ---------------------------------------------------------------------------
  // Phase 10: Unix socket IPC (delegated to OrchestratorIpcServer)
  // ---------------------------------------------------------------------------

  /**
   * Start the Unix domain socket server for CLI IPC.
   * Call this after start() to enable CLI commands (stop, pause, resume, health, decide).
   */
  startSocketServer(socketPath: string): void {
    this._ipcServer.startSocketServer(socketPath);
  }

  /** Stop the Unix domain socket server and remove the socket file. */
  stopSocketServer(): void {
    this._ipcServer.stopSocketServer();
  }

  /** Exposed for tests that call priv(orch).handleSocketRequest(req). */
  private handleSocketRequest(req: CLIRequest): Promise<CLIResponse> {
    return this._ipcServer.handleSocketRequest(req);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * P270 B2: Process any pending governance decisions saved while the orchestrator
   * was offline. Each pending decision is emitted as a "decide" event on the event bus,
   * then marked processed.
   */
  private async _processPendingDecisions(): Promise<void> {
    const { getPendingDecisions, markDecisionProcessed, ensurePendingDecisionsTable } =
      await import("../core/pending-decisions.js");
    ensurePendingDecisionsTable(this.db);
    const pending = getPendingDecisions(this.db);
    if (pending.length === 0) return;
    _coreLogger.info("orchestrator", `Replaying ${pending.length} pending decision(s)`, {
      metadata: { count: pending.length },
    });
    for (const decision of pending) {
      this.eventBus.emit("PENDING_DECISION", {
        type:          "PENDING_DECISION",
        task_id:       decision.task_id,
        payload:       decision.payload,
        decision_type: decision.type,
        timestamp:     new Date().toISOString(),
      });
      markDecisionProcessed(this.db, decision.id);
    }
  }

  private persistState(): void {
    const now = new Date().toISOString();
    this.db.prepare<unknown[], void>(`
      INSERT INTO orchestrator_state (id, state, started_at, last_heartbeat, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        started_at = COALESCE(orchestrator_state.started_at, excluded.started_at),
        last_heartbeat = excluded.last_heartbeat,
        updated_at = excluded.updated_at
    `).run(
      this._state,
      this._startedAt?.toISOString() ?? null,
      now,
      now,
    );
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
