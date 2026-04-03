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
 */

import { createServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync, chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { timingSafeCompare } from "../core/crypto-utils.js";
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
import { TaskPriority, AckState } from "../pipeline/types.js";
import { createSandboxProvider } from "../core/sandbox/sandbox-factory.js";
import { BubblewrapProvider } from "../core/sandbox/bubblewrap-provider.js";
import { startViolationLogger } from "../core/sandbox/violation-logger.js";
import type { SandboxProvider } from "../core/sandbox/types.js";
import type {
  OrchestratorConfig,
  OrchestratorState,
  OrchestratorStatus,
  AgentInstance,
  EscalationReason,
  PHASE9_SCHEMA_SQL as _Schema,
} from "./types.js";
import { PHASE9_SCHEMA_SQL } from "./types.js";
import { createLogger } from "../core/logger.js";
import type { AgentDaemonManager } from "../agent-lifecycle/daemon-manager.js";
import type { InboundMessageGateway } from "../messaging/inbound-gateway.js";
import type { AdapterRegistry } from "../messaging/adapter-registry.js";
import type { UserMappingStore } from "../messaging/user-mapping.js";
import { CronScheduler } from "../scheduler/cron-scheduler.js";
import { DeadlineWatcher } from "../scheduler/deadline-watcher.js";
import { loadSchedulingGovernance } from "../scheduler/config-loader.js";

const _coreLogger = createLogger("orchestrator");


/** Filename for the IPC authentication token, placed alongside the socket file. */
export const IPC_TOKEN_FILENAME = "ipc.token";

export interface CLIRequest {
  command:    "stop" | "shutdown" | "pause" | "resume" | "submit_task" | "decide" | "health" |
              "daemon_status" | "daemon_start" | "daemon_stop" | "daemon_restart" |
              "messaging_status" | "messaging_start" | "messaging_stop" | "messaging_reload" |
              "messaging_adapters" | "messaging_map" | "messaging_unmap" | "messaging_mappings" |
              "delegation_status" | "delegation_history";
  payload:    Record<string, unknown>;
  request_id: string;
  /** IPC authentication token — must match the token in {socketDir}/ipc.token. */
  token?:     string;
}

export interface CLIResponse {
  request_id: string;
  success:    boolean;
  data:       Record<string, unknown>;
  error?:     string;
}


export class OrchestratorProcess {
  private _state: OrchestratorState = "STOPPED";
  private _startedAt: Date | null   = null;
  private _loopRunning              = false;
  private _loopPromise: Promise<void> | null = null;

  /** Phase 10: Unix domain socket server for CLI IPC. */
  private _socketServer: NetServer | null = null;
  /** Phase 10: Path to socket file (set when socketPath passed to startSocketServer). */
  private _socketPath: string | null = null;
  /** IPC secret (64-char hex, 32 bytes). Written to ipc.token; null until startSocketServer(). */
  private _ipcSecret: string | null = null;

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
  private _messagingConfigs:    import("../messaging/types.js").AdapterInstanceConfig[] | null = null;
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
  }

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

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  private async handleNewTask(event: TaskEvent): Promise<void> {
    const task = this.store.get(event.task_id);
    if (task === null) return;

    // Skip already-assigned/running tasks
    if (task.status !== "CREATED" && task.status !== "PENDING") return;

    // Phase 9.5: Use TaskPipeline if configured
    if (this.pipeline !== null) {
      const producerId = event.agent_from ?? "orchestrator";
      // Derive priority from task type / tier
      const priority   = task.tier === 1 ? TaskPriority.URGENT : TaskPriority.REGULAR;
      this.pipeline.submit(task, priority, producerId);
      // Pipeline handles assignment, IPC, and ACK tracking
      return;
    }

    // Phase 9 direct assignment (no pipeline)
    const agents     = [...this.agents.values()];
    const assignment = this.distributor.assignTask(task, agents);

    if (assignment === null) {
      // No agent available — stay PENDING, retry on next loop
      this.store.update(task.id, { status: "PENDING" });
      _coreLogger.debug("task_queued_no_agent", "Task queued: no agent available", {
        metadata: { task_id: task.id, tier: task.tier },
      });
      return;
    }

    // Assign task in DB
    this.store.update(task.id, {
      status:        "ASSIGNED",
      assigned_agent: assignment.agent_id,
    });

    // Update in-memory agent tracking
    const inst = this.agents.get(assignment.agent_id);
    if (inst !== undefined) {
      inst.active_task_count++;
      inst.status = inst.active_task_count >= inst.definition.max_concurrent_tasks
        ? "overloaded"
        : "busy";

      // IPC: send task to agent subprocess
      inst.process.send({ type: "TASK_ASSIGNED", task_id: task.id });
    }

    _coreLogger.info("task_assigned", "Task assigned", {
      metadata: { task_id: task.id, agent_id: assignment.agent_id, reason: assignment.reason },
    });
  }

  private async handleResultReady(event: TaskEvent): Promise<void> {
    const task = this.store.get(event.task_id);
    if (task === null) return;

    const now = new Date().toISOString();

    // Update task to DONE if not already
    if (task.status !== "DONE") {
      this.store.update(task.id, {
        status:       "DONE",
        completed_at: task.completed_at ?? now,
      });
    }

    // Update agent tracking
    const agentId = task.assigned_agent;
    if (agentId !== null) {
      const inst = this.agents.get(agentId);
      if (inst !== undefined) {
        inst.active_task_count   = Math.max(0, inst.active_task_count - 1);
        inst.total_tasks_completed++;
        inst.status              = inst.active_task_count === 0 ? "idle" : "busy";
      }
    }

    // Phase 9.5: notify pipeline of COMPLETED state
    if (this.pipeline !== null && agentId !== null) {
      this.pipeline.handleAck(task.id, AckState.COMPLETED, agentId);
    }

    if (task.parent_id === null) {
      // Root task complete — user will be notified by Phase 10/11
      _coreLogger.info("root_task_complete", "Root task complete", { metadata: { task_id: task.id } });
      return;
    }

    // Child task: check if parent is ready for synthesis
    const completedTask = this.store.get(task.id) ?? task;
    const synthStatus   = this.synthesisCollector.registerResult({
      ...completedTask,
      status: "DONE",
    });

    if (synthStatus.ready) {
      await this.synthesisCollector.triggerParentSynthesis(
        synthStatus.parent_task_id,
        synthStatus.child_summaries,
      );
    }
  }

  private async handleTaskFailed(event: TaskEvent): Promise<void> {
    const task = this.store.get(event.task_id);
    if (task === null) return;

    // Update agent tracking
    const agentId = task.assigned_agent;
    if (agentId !== null) {
      const inst = this.agents.get(agentId);
      if (inst !== undefined) {
        inst.active_task_count = Math.max(0, inst.active_task_count - 1);
        inst.status            = inst.active_task_count === 0 ? "idle" : "busy";
      }

      // Phase 9.5: notify pipeline of FAILED state
      if (this.pipeline !== null) {
        this.pipeline.handleAck(task.id, AckState.FAILED, agentId);
      }
    }

    if (task.retry_count < task.max_retries) {
      // Retry: reset to PENDING, increment counter
      this.store.update(task.id, {
        status:        "PENDING",
        retry_count:   task.retry_count + 1,
        assigned_agent: null,
      });
      _coreLogger.info("task_queued_for_retry", "Task queued for retry", {
        metadata: { task_id: task.id, retry: task.retry_count + 1, max: task.max_retries },
      });
    } else {
      // Retries exhausted → escalate
      this.store.update(task.id, { status: "FAILED" });
      const refreshed = this.store.get(task.id) ?? task;
      this.escalationManager.escalate(refreshed, "max_retries_exceeded");
    }
  }

  private async handleEscalation(event: TaskEvent): Promise<void> {
    const task = this.store.get(event.task_id);
    if (task === null) return;

    const reason = (event.data["reason"] as string ?? "agent_requested") as EscalationReason;
    this.escalationManager.escalate(task, reason);
  }

  private async handleConsultation(event: TaskEvent): Promise<void> {
    const task = this.store.get(event.task_id);
    if (task === null) return;

    this.peerRouter.route(task);
  }

  private async handleAgentCrash(event: TaskEvent): Promise<void> {
    const agentId = event.agent_from;
    if (agentId === null) return;

    const inst = this.agents.get(agentId);
    if (inst !== undefined) {
      inst.status = "crashed";
    }

    // Tasks assigned to crashed agent — without checkpoint: reset to PENDING
    const activeTasks = this.store.getByAgent(agentId);
    for (const task of activeTasks) {
      if (task.status === "RUNNING" || task.status === "ASSIGNED") {
        if (task.checkpoint === null) {
          this.store.update(task.id, {
            status:        "PENDING",
            assigned_agent: null,
            retry_count:   task.retry_count + 1,
          });
        }
        // Tasks with checkpoint: agent will resume after ITBootstrapAgent restarts it
      }
    }

    _coreLogger.warn("agent_crashed", "Agent crashed", {
      metadata: { agent_id: agentId, tasks_affected: activeTasks.length },
    });
  }

  private async handleAgentRecovery(event: TaskEvent): Promise<void> {
    const agentId = event.agent_from;
    if (agentId === null) return;

    const inst = this.agents.get(agentId);
    if (inst !== undefined) {
      inst.status = inst.active_task_count > 0 ? "busy" : "idle";
    }

    _coreLogger.info("agent_recovered", "Agent recovered", { metadata: { agent_id: agentId } });
  }

  private async handleBudgetExceeded(event: TaskEvent): Promise<void> {
    const task = this.store.get(event.task_id);
    if (task === null) return;

    this.escalationManager.escalate(task, "budget_exceeded");
  }

  private async handleHeartbeatTimeout(event: TaskEvent): Promise<void> {
    // ITBootstrapAgent (Phase 8) handles the actual process health check and restart.
    // Orchestrator just logs and marks the agent as potentially unhealthy.
    const agentId = (event.data["agent_id"] as string | undefined) ?? event.agent_to;

    _coreLogger.warn("heartbeat_timeout", "Heartbeat timeout — delegating to ITBootstrapAgent", {
      metadata: { agent_id: agentId, task_id: event.task_id },
    });

    if (agentId !== null) {
      const inst = this.agents.get(agentId);
      if (inst !== undefined && inst.status !== "crashed") {
        inst.last_heartbeat = new Date().toISOString();
        // ITBootstrapAgent will emit AGENT_CRASHED if process is confirmed dead
      }
    }
  }

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
          status:        "PENDING",
          retry_count:   task.retry_count + 1,
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
          status:        "PENDING",
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
  // V1.1: Daemon manager
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
    configs:     import("../messaging/types.js").AdapterInstanceConfig[],
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

  /** Current orchestrator state. */
  get state(): OrchestratorState {
    return this._state;
  }

  // ---------------------------------------------------------------------------
  // Phase 10: Unix socket IPC
  // ---------------------------------------------------------------------------

  /**
   * Start the Unix domain socket server for CLI IPC.
   * Call this after start() to enable CLI commands (stop, pause, resume, health, decide).
   *
   * @param socketPath Filesystem path for the socket file (e.g. `.system/orchestrator.sock`)
   */
  startSocketServer(socketPath: string): void {
    // Remove stale socket file if present
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch (e: unknown) { void e; /* cleanup-ignore: socket file cleanup is best-effort */ }
    }

    // Ensure socket directory exists with owner-only (0o700) permissions.
    // For Unix domain sockets the containing directory's permissions control access —
    // other local users cannot connect to the socket if they cannot traverse the dir.
    const socketDir = dirname(socketPath);
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    try { chmodSync(socketDir, 0o700); } catch (e: unknown) { void e; /* cleanup-ignore: chmod socket dir best-effort */ }

    // Generate a 32-byte IPC secret and write it to {socketDir}/ipc.token
    // (mode 0o600). The CLI client reads this secret and includes it in every
    // request so unauthenticated local processes cannot control the orchestrator.
    const secretHex = randomBytes(32).toString("hex");
    this._ipcSecret  = secretHex;
    const tokenFilePath = join(socketDir, IPC_TOKEN_FILENAME);
    try {
      writeFileSync(tokenFilePath, secretHex, { encoding: "utf-8", mode: 0o600 });
      try { chmodSync(tokenFilePath, 0o600); } catch (_e) { /* best-effort */ }
    } catch (e: unknown) {
      _coreLogger.warn("ipc_secret_write_failed", "Failed to write IPC secret file — IPC auth disabled", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
      this._ipcSecret = null; // disable auth if secret write failed
    }

    // Allowed IPC command types — reject unknown commands before processing.
    const ALLOWED_IPC_COMMANDS = new Set<CLIRequest["command"]>([
      "stop", "pause", "resume", "submit_task", "decide", "health",
      "daemon_status", "daemon_start", "daemon_stop", "daemon_restart",
      "messaging_status", "messaging_start", "messaging_stop", "messaging_reload",
      "messaging_adapters", "messaging_map", "messaging_unmap", "messaging_mappings",
      "delegation_status", "delegation_history",
    ]);

    this._socketPath   = socketPath;
    this._socketServer = createServer((socket: Socket) => {
      let buf = "";

      // Log each new connection to the audit trail so unexpected
      // connections from other local processes are visible in logs.
      _coreLogger.info("ipc_connection", "ipc_connection", { metadata: { socketPath } });

      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;

        const line = buf.slice(0, nl);
        buf        = buf.slice(nl + 1);

        let req: CLIRequest;
        try {
          req = JSON.parse(line) as CLIRequest;
        } catch (e: unknown) {
          _coreLogger.warn("orchestrator", "Invalid JSON from IPC client — skipping request", { metadata: { error: e instanceof Error ? e.message : String(e) } });
          const errResp: CLIResponse = {
            request_id: "unknown",
            success:    false,
            data:       {},
            error:      "Invalid JSON",
          };
          socket.write(JSON.stringify(errResp) + "\n");
          return;
        }

        // Verify the IPC secret using the canonical constant-time comparison
        // from crypto-utils (SHA-256 hash normalisation prevents length-based
        // timing leaks when secrets differ — never log the provided value).
        if (this._ipcSecret !== null) {
          const providedToken = typeof req.token === "string" ? req.token : "";
          const tokenOk = timingSafeCompare(this._ipcSecret, providedToken);
          if (!tokenOk) {
            _coreLogger.warn("orchestrator", "IPC authentication failed — rejecting request", {
              metadata: { command: req.command, request_id: req.request_id ?? "unknown" },
            });
            const authErr: CLIResponse = {
              request_id: req.request_id ?? "unknown",
              success:    false,
              data:       {},
              error:      "IPC_AUTH_FAILED",
            };
            socket.write(JSON.stringify(authErr) + "\n");
            socket.destroy();
            return;
          }
        }

        // Validate command type against whitelist before processing.
        if (!ALLOWED_IPC_COMMANDS.has(req.command)) {
          _coreLogger.warn("ipc_unknown_command", "ipc_unknown_command", { metadata: { command: req.command } });
          const errResp: CLIResponse = {
            request_id: req.request_id ?? "unknown",
            success:    false,
            data:       {},
            error:      `Unknown IPC command: ${req.command}`,
          };
          socket.write(JSON.stringify(errResp) + "\n");
          return;
        }

        this.handleSocketRequest(req).then((resp) => {
          socket.write(JSON.stringify(resp) + "\n");
        }).catch((err: unknown) => {
          const errResp: CLIResponse = {
            request_id: req.request_id,
            success:    false,
            data:       {},
            error:      String(err),
          };
          socket.write(JSON.stringify(errResp) + "\n");
        });
      });

      socket.on("error", () => {
        // ignore client disconnect errors
      });
    });

    // P272 Task 2: Set umask to 0o177 before creating the socket file so it is
    // created with mode 0o600 (0o777 & ~0o177 = 0o600) from the start, closing
    // the race window between listen() and the chmod in the callback.
    const prevUmask = process.umask(0o177);
    this._socketServer.listen(socketPath, () => {
      process.umask(prevUmask); // restore immediately after socket is created
      // Belt-and-suspenders: chmod in case the OS ignored umask
      try { chmodSync(socketPath, 0o600); } catch (_e) { /* best-effort on platforms without chmod */ }
      _coreLogger.info("ipc_socket_listening", "IPC socket listening", { metadata: { path: socketPath } });
    });
  }

  /** Stop the Unix domain socket server and remove the socket file. */
  stopSocketServer(): void {
    if (this._socketServer !== null) {
      this._socketServer.close();
      this._socketServer = null;
    }
    if (this._socketPath !== null && existsSync(this._socketPath)) {
      try { unlinkSync(this._socketPath); } catch (e: unknown) { void e; /* cleanup-ignore: socket file cleanup best-effort */ }
      this._socketPath = null;
    }
  }

  /** Handle an incoming IPC request from the CLI. */
  private async handleSocketRequest(req: CLIRequest): Promise<CLIResponse> {
    switch (req.command) {
      case "health": {
        const status = this.getStatus();
        return { request_id: req.request_id, success: true, data: { status } };
      }

      case "stop": {
        // Kick off stop in background; respond immediately
        void this.stop().finally(() => this.stopSocketServer());
        return { request_id: req.request_id, success: true, data: { message: "stopping" } };
      }

      case "shutdown": {
        // Graceful shutdown: drain in-flight tasks, flush WAL, then stop.
        const drainTimeout = (req.payload["drain_timeout"] as number | undefined) ?? 30;
        void this.gracefulShutdown(drainTimeout).finally(() => this.stopSocketServer());
        return { request_id: req.request_id, success: true, data: { message: "shutting_down" } };
      }

      case "pause": {
        await this.pause();
        return { request_id: req.request_id, success: true, data: { state: this._state } };
      }

      case "resume": {
        await this.resume();
        return { request_id: req.request_id, success: true, data: { state: this._state } };
      }

      case "decide": {
        const taskId  = req.payload["task_id"] as string | undefined;
        const action  = req.payload["action"]  as string | undefined;
        const guidance = req.payload["guidance"] as string | undefined;
        const agentId  = req.payload["agent_id"] as string | undefined;
        const result   = req.payload["result"]  as string | undefined;

        if (taskId === undefined || action === undefined) {
          return {
            request_id: req.request_id,
            success:    false,
            data:       {},
            error:      "decide requires task_id and action",
          };
        }

        const task = this.store.get(taskId);
        if (task === null) {
          return {
            request_id: req.request_id,
            success:    false,
            data:       {},
            error:      `Task not found: ${taskId}`,
          };
        }

        const decision: import("./types.js").HumanDecision = {
          action: action as import("./types.js").HumanDecision["action"],
        };
        if (guidance !== undefined) decision.guidance     = guidance;
        if (agentId  !== undefined) decision.target_agent = agentId;
        if (result   !== undefined) decision.result       = result;

        this.escalationManager.handleHumanDecision(taskId, decision);

        return {
          request_id: req.request_id,
          success:    true,
          data:       { task_id: taskId, action },
        };
      }

      case "submit_task": {
        // Basic task submission via IPC (full impl in run.ts CLI command)
        return {
          request_id: req.request_id,
          success:    false,
          data:       {},
          error:      "submit_task not implemented via IPC in V1 — use TaskStore directly",
        };
      }

      case "daemon_status": {
        if (this._daemonManager === null) {
          return { request_id: req.request_id, success: true, data: { daemons: [] } };
        }
        const agentId = req.payload["agent_id"] as string | undefined;
        const daemons = agentId !== undefined
          ? (() => { const s = this._daemonManager!.getStatus(agentId); return s !== undefined ? [s] : []; })()
          : this._daemonManager.getAllStatuses();
        return { request_id: req.request_id, success: true, data: { daemons } };
      }

      case "daemon_start": {
        const agentId = req.payload["agent_id"] as string | undefined;
        if (agentId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "daemon_start requires agent_id" };
        }
        if (this._daemonManager === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Daemon manager not configured" };
        }
        const started = this._daemonManager.startAgent(agentId);
        if (!started) {
          return { request_id: req.request_id, success: false, data: {}, error: `Daemon already running for agent '${agentId}'` };
        }
        return { request_id: req.request_id, success: true, data: { agent_id: agentId, action: "started" } };
      }

      case "daemon_stop": {
        const agentId = req.payload["agent_id"] as string | undefined;
        if (agentId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "daemon_stop requires agent_id" };
        }
        if (this._daemonManager === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Daemon manager not configured" };
        }
        const stopped = await this._daemonManager.stopAgent(agentId);
        if (!stopped) {
          return { request_id: req.request_id, success: false, data: {}, error: `No daemon running for agent '${agentId}'` };
        }
        return { request_id: req.request_id, success: true, data: { agent_id: agentId, action: "stopped" } };
      }

      case "daemon_restart": {
        const agentId = req.payload["agent_id"] as string | undefined;
        if (agentId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "daemon_restart requires agent_id" };
        }
        if (this._daemonManager === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Daemon manager not configured" };
        }
        const restarted = await this._daemonManager.restartAgent(agentId);
        if (!restarted) {
          return { request_id: req.request_id, success: false, data: {}, error: `Agent '${agentId}' not found in registry` };
        }
        return { request_id: req.request_id, success: true, data: { agent_id: agentId, action: "restarted" } };
      }

      case "messaging_adapters": {
        if (this._messagingRegistry === null) {
          return { request_id: req.request_id, success: true, data: { adapters: [] } };
        }
        const adapters = this._messagingRegistry.getAvailableAdapters();
        return { request_id: req.request_id, success: true, data: { adapters } };
      }

      case "messaging_status": {
        if (this._messagingRegistry === null) {
          return { request_id: req.request_id, success: true, data: { instances: [] } };
        }
        const instanceId = req.payload["instance_id"] as string | undefined;
        if (instanceId !== undefined) {
          const inst = this._messagingRegistry.getInstance(instanceId);
          const instances = inst !== undefined
            ? [{ instanceId, channel: inst.channel, healthy: inst.isHealthy() }]
            : [];
          return { request_id: req.request_id, success: true, data: { instances } };
        }
        const instances = this._messagingRegistry.getAllInstances();
        return { request_id: req.request_id, success: true, data: { instances } };
      }

      case "messaging_start": {
        const instanceId = req.payload["instance_id"] as string | undefined;
        if (instanceId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "messaging_start requires instance_id" };
        }
        if (this._messagingRegistry === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        try {
          await this._messagingRegistry.startInstance(instanceId);
          return { request_id: req.request_id, success: true, data: { instance_id: instanceId, action: "started" } };
        } catch (e: unknown) {
          return { request_id: req.request_id, success: false, data: {}, error: String(e) };
        }
      }

      case "messaging_stop": {
        const instanceId = req.payload["instance_id"] as string | undefined;
        if (instanceId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "messaging_stop requires instance_id" };
        }
        if (this._messagingRegistry === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        try {
          await this._messagingRegistry.stopInstance(instanceId);
          return { request_id: req.request_id, success: true, data: { instance_id: instanceId, action: "stopped" } };
        } catch (e: unknown) {
          return { request_id: req.request_id, success: false, data: {}, error: String(e) };
        }
      }

      case "messaging_reload": {
        if (this._messagingGateway === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        // Stop all current instances, then restart with fresh config
        try {
          await this._messagingGateway.stop();
          if (this._messagingConfigs !== null) {
            await this._messagingGateway.start(this._messagingConfigs);
          }
          return { request_id: req.request_id, success: true, data: { reloaded: true } };
        } catch (e: unknown) {
          return { request_id: req.request_id, success: false, data: {}, error: String(e) };
        }
      }

      case "messaging_map": {
        if (this._userMappingStore === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        const { instance_id, platform_user_id, sidjua_user_id, role } = req.payload as {
          instance_id?: string; platform_user_id?: string; sidjua_user_id?: string; role?: string;
        };
        if (!instance_id || !platform_user_id || !sidjua_user_id) {
          return { request_id: req.request_id, success: false, data: {}, error: "messaging_map requires instance_id, platform_user_id, sidjua_user_id" };
        }
        const validRole = (["admin", "user", "viewer"] as const).includes(role as "admin" | "user" | "viewer")
          ? (role as "admin" | "user" | "viewer") : "user";
        await this._userMappingStore.mapUser(sidjua_user_id, instance_id, platform_user_id, validRole);
        return { request_id: req.request_id, success: true, data: { mapped: true } };
      }

      case "messaging_unmap": {
        if (this._userMappingStore === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        const { instance_id, platform_user_id } = req.payload as {
          instance_id?: string; platform_user_id?: string;
        };
        if (!instance_id || !platform_user_id) {
          return { request_id: req.request_id, success: false, data: {}, error: "messaging_unmap requires instance_id, platform_user_id" };
        }
        await this._userMappingStore.unmapUser(instance_id, platform_user_id);
        return { request_id: req.request_id, success: true, data: { removed: true } };
      }

      case "messaging_mappings": {
        if (this._userMappingStore === null) {
          return { request_id: req.request_id, success: true, data: { mappings: [] } };
        }
        const sidjuaId = req.payload["sidjua_user_id"] as string | undefined;
        const mappings  = this._userMappingStore.listMappings(sidjuaId);
        return { request_id: req.request_id, success: true, data: { mappings } };
      }

      case "delegation_status": {
        return { request_id: req.request_id, success: true, data: { delegations: [] } };
      }

      case "delegation_history": {
        return { request_id: req.request_id, success: true, data: { delegations: [] } };
      }

      default: {
        return {
          request_id: req.request_id,
          success:    false,
          data:       {},
          error:      `Unknown command: ${(req as CLIRequest).command}`,
        };
      }
    }
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
