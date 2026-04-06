// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V1.1: AgentDaemon
 *
 * Continuous task-processing loop for a single agent.
 * Lifecycle: start() → loop → stop()
 *
 * Governance enforced on every iteration:
 *   1. ProcessSupervisor circuit breaker (crash threshold)
 *   2. Hourly budget limit (in-memory sliding window)
 *   3. Hourly rate limit (in-memory sliding window)
 *   4. TaskQueue.dequeue() → execute → record cost
 */

import type { Task } from "../tasks/types.js";
import type { TaskQueue } from "../tasks/queue.js";
import type { TaskStore } from "../tasks/store.js";
import type { TaskEventBus } from "../tasks/event-bus.js";
import type { CronScheduler } from "../scheduler/cron-scheduler.js";
import type { DeadlineWatcher } from "../scheduler/deadline-watcher.js";
import type { BudgetTracker } from "./budget-tracker.js";
import type { ProcessSupervisor } from "./supervisor/process-supervisor.js";
import type { WatchdogPair } from "./watchdog-pair.js";
import type { ProactiveScanner } from "./proactive-scanner.js";
import type {
  AgentDaemonConfig,
  DaemonGovernance,
  DaemonStatus,
  DaemonAuditEvent,
} from "./types.js";
import type { Database } from "../utils/db.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("agent-daemon");


const DEFAULT_POLL_MS     = 5_000;
const DEFAULT_MAX_CONC    = 1;
const DEFAULT_IDLE_MS     = 0;       // 0 = never time out
const SLIDING_WINDOW_MS   = 3_600_000; // 1 hour


/** Execute a task. Returns cost incurred in USD. */
export type ExecuteTaskFn = (agentId: string, task: Task) => Promise<number>;

/** Sleep for ms milliseconds. */
export type SleepFn = (ms: number) => Promise<void>;

/**
 * Optional scheduler services injected into the daemon loop.
 * When provided, the daemon checks for due schedules each iteration
 * and emits DeadlineWatcher escalations via the event bus.
 */
export interface SchedulerServices {
  cronScheduler:  CronScheduler;
  deadlineWatcher: DeadlineWatcher;
  taskStore:       TaskStore;
  eventBus:        TaskEventBus;
  agentDivision:   string;
}

const defaultSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));


export class AgentDaemon {
  private running     = false;
  private loopPromise: Promise<void> | null = null;
  private startedAt:  string | null = null;

  // Stats
  private tasksCompleted  = 0;
  private tasksFailed     = 0;
  private lastTaskAt:     string | null = null;

  // Hourly sliding-window trackers (epoch ms timestamps / costs)
  private taskTimestamps: number[]  = [];
  private costEntries:    { ts: number; cost: number }[] = [];

  // Config resolved with defaults
  private readonly pollMs:    number;
  private readonly maxConc:   number;
  private readonly idleMs:    number;

  // Audit event buffer
  private readonly auditLog: DaemonAuditEvent[] = [];

  constructor(
    private readonly agentId:    string,
    private readonly config:     AgentDaemonConfig,
    private readonly governance: DaemonGovernance,
    private readonly queue:      TaskQueue,
    private readonly budget:     BudgetTracker,
    private readonly supervisor: ProcessSupervisor,
    private readonly execute:    ExecuteTaskFn,
    private readonly sleep:              SleepFn          = defaultSleep,
    private readonly watchdogPair?:      WatchdogPair,
    private readonly proactiveScanner?:  ProactiveScanner,
    private readonly schedulerServices?: SchedulerServices,
    private readonly db?:                Database | null,
  ) {
    this.pollMs  = config.poll_interval_ms ?? DEFAULT_POLL_MS;
    this.maxConc = config.max_concurrent   ?? DEFAULT_MAX_CONC;
    this.idleMs  = config.idle_timeout_ms  ?? DEFAULT_IDLE_MS;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start the daemon loop (no-op if already running). */
  start(): void {
    if (this.running) return;
    this._loadRateState();
    this.running   = true;
    this.startedAt = new Date().toISOString();
    this.emit("started");
    this.loopPromise = this._loop();
  }

  /**
   * Stop the daemon loop.
   * Signals the loop to exit and waits up to 30 s for in-flight tasks.
   * Rate/budget state is persisted to SQLite (if db was provided) so that
   * limits survive a daemon restart (single-process deployment).
   *
   * NOTE: Multi-instance deployments (multiple processes sharing the same DB)
   * are NOT supported in the Free Tier — rate limits are enforced per-process.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.emit("stopped");
    if (this.loopPromise) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      await Promise.race([this.loopPromise, timeout]);
      this.loopPromise = null;
    }
    this._persistRateState();
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  getStatus(): DaemonStatus {
    return {
      agent_id:        this.agentId,
      running:         this.running,
      tasks_completed: this.tasksCompleted,
      tasks_failed:    this.tasksFailed,
      last_task_at:    this.lastTaskAt,
      started_at:      this.startedAt,
      hourly_cost_usd: this._hourlySpend(),
    };
  }

  /** Return a copy of the audit log (most recent first). */
  getAuditLog(): DaemonAuditEvent[] {
    return [...this.auditLog].reverse();
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  private async _loop(): Promise<void> {
    let idleSince: number | null = null;

    while (this.running) {
      // 1a. Watchdog health check (only if this agent has restart authority)
      if (this.config.watchdog?.restart_authority && this.watchdogPair) {
        await this.watchdogPair.performHealthCheck(this.agentId);
      }

      // 1b. Circuit breaker check
      const health = this.supervisor.getAgentStatus(this.agentId);
      if (health?.circuit_open) {
        this.emit("circuit_open", undefined, undefined, "circuit breaker open");
        await this.sleep(this.pollMs);
        continue;
      }

      // 2. Hourly budget check
      if (this._isBudgetBlocked()) {
        this.emit("budget_blocked", undefined, undefined, "hourly cost limit reached");
        await this.sleep(this.pollMs);
        continue;
      }

      // 3. Hourly rate check
      if (this._isRateBlocked()) {
        this.emit("rate_blocked", undefined, undefined, "hourly task rate limit reached");
        await this.sleep(this.pollMs);
        continue;
      }

      // 4. Heartbeat — only reached when not blocked by circuit/budget/rate guards
      this.supervisor.recordHeartbeat(this.agentId);

      // 5. Dequeue
      const task = this.queue.dequeue(this.agentId);
      if (task === null) {
        // Nothing to do — run proactive scan before sleeping
        if (this.config.proactive_checks && this.proactiveScanner) {
          const scanResult = await this.proactiveScanner.scan(this.agentId);
          if (scanResult.found_tasks > 0) {
            // New tasks may have been submitted — re-check the queue
            continue;
          }
        }

        // Check idle timeout
        if (this.idleMs > 0) {
          if (idleSince === null) {
            idleSince = Date.now();
          } else if (Date.now() - idleSince >= this.idleMs) {
            this.emit("idle_timeout", undefined, undefined, "idle timeout elapsed");
            this.running = false;
            break;
          }
        }
        await this.sleep(this.pollMs);
        continue;
      }

      // Reset idle counter — we have work
      idleSince = null;
      this.emit("task_dequeued", task.id);

      // 5. Execute (bounded by maxConc — V1 allows 1 concurrent task at a time)
      //    For maxConc > 1, future work; for now run inline.
      await this._runTask(task);

      // 6. Scheduler: check due schedules and submit recurring tasks
      await this._runSchedulerStep();
    }
  }

  /** Run scheduler and deadline-watcher checks for this iteration. */
  private async _runSchedulerStep(): Promise<void> {
    const svc = this.schedulerServices;
    if (svc === undefined) return;

    const now = new Date();

    // 6a. Execute due schedules
    const due = svc.cronScheduler.getDueTasks(this.agentId, now);
    for (const schedule of due) {
      let result: { executed: boolean; reason?: string };
      try {
        result = await svc.cronScheduler.executeDueSchedule(schedule, now);
      } catch (err: unknown) {
        logger.warn("agent-daemon", "executeDueSchedule threw unexpectedly", {
          metadata: { schedule_id: schedule.id, error: err instanceof Error ? err.message : String(err) },
        });
        continue;
      }

      if (result.executed) {
        // Submit recurring task via TaskStore + EventBus
        try {
          const task = svc.taskStore.create({
            title:                  `[recurring] ${schedule.task_template.description.slice(0, 80)}`,
            description:            schedule.task_template.description,
            division:               svc.agentDivision,
            type:                   "root",
            tier:                   2,
            assigned_agent:         this.agentId,
            token_budget:           schedule.task_template.budget_tokens ?? 8_000,
            cost_budget:            schedule.task_template.budget_usd    ?? schedule.governance.max_cost_per_run,
            priority:               schedule.task_template.priority      ?? 5,
            ...(schedule.task_template.ttl_seconds !== undefined
              ? { ttl_seconds: schedule.task_template.ttl_seconds }
              : {}),
            recurring_schedule_id:  schedule.id,
            is_recurring:           true,
          });
          await svc.eventBus.emitTask({
            event_type:     "TASK_CREATED",
            task_id:        task.id,
            parent_task_id: null,
            agent_from:     this.agentId,
            agent_to:       this.agentId,
            division:       svc.agentDivision,
            data:           { schedule_id: schedule.id },
          });
          logger.info("agent-daemon", "Recurring task submitted", {
            metadata: { schedule_id: schedule.id, task_id: task.id },
          });
        } catch (err: unknown) {
          logger.warn("agent-daemon", "Failed to submit recurring task", {
            metadata: { schedule_id: schedule.id, error: err instanceof Error ? err.message : String(err) },
          });
        }
      } else if (result.reason === "budget_exhausted") {
        // Emit escalation via EventBus (best-effort)
        svc.eventBus.emitTask({
          event_type:     "BUDGET_EXHAUSTED",
          task_id:        schedule.id,
          parent_task_id: null,
          agent_from:     this.agentId,
          agent_to:       null,
          division:       svc.agentDivision,
          data:           { schedule_id: schedule.id, reason: "budget_exhausted" },
        }).catch(() => undefined);
      } else if (result.reason === "requires_approval") {
        logger.info("agent-daemon", "Schedule awaiting approval for first run", {
          metadata: { schedule_id: schedule.id },
        });
      }
    }

    // 6b. DeadlineWatcher: check active tasks for TTL / budget violations
    const escalations = svc.deadlineWatcher.checkAll(now);
    for (const event of escalations) {
      const eventType = event.type === "budget_exhausted" ? "BUDGET_EXHAUSTED" : "TTL_WARNING";
      svc.eventBus.emitTask({
        event_type:     eventType,
        task_id:        event.task_id,
        parent_task_id: null,
        agent_from:     this.agentId,
        agent_to:       null,
        division:       svc.agentDivision,
        data:           { type: event.type, severity: event.severity, details: event.details },
      }).catch(() => undefined);
    }
  }

  private async _runTask(task: Task): Promise<void> {
    try {
      const cost = await this.execute(this.agentId, task);
      this.tasksCompleted++;
      this.lastTaskAt = new Date().toISOString();
      this._recordCost(cost);
      this._recordTask();
      this.emit("task_done", task.id, cost);

      // If this was a recurring task, update the schedule's total cost
      if (task.is_recurring && task.recurring_schedule_id !== null && this.schedulerServices !== undefined) {
        try {
          this.schedulerServices.cronScheduler.updateScheduleCost(task.recurring_schedule_id, cost);
        } catch (_err) { /* best-effort */ }
      }
    } catch (err: unknown) {
      this.tasksFailed++;
      this.lastTaskAt = new Date().toISOString();
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn("agent-daemon", "Task execution failed", {
        metadata: { agent_id: this.agentId, task_id: task.id, reason },
      });
      this.emit("task_failed", task.id, undefined, reason);
    }
  }

  // ---------------------------------------------------------------------------
  // Sliding-window helpers
  // ---------------------------------------------------------------------------

  private _purgeWindow(): void {
    const cutoff = Date.now() - SLIDING_WINDOW_MS;
    this.taskTimestamps = this.taskTimestamps.filter((ts) => ts > cutoff);
    this.costEntries    = this.costEntries.filter((e)  => e.ts > cutoff);
  }

  private _hourlySpend(): number {
    this._purgeWindow();
    return this.costEntries.reduce((sum, e) => sum + e.cost, 0);
  }

  private _isBudgetBlocked(): boolean {
    const limit = this.governance.max_cost_per_hour_usd ?? 0;
    if (limit <= 0) return false;
    return this._hourlySpend() >= limit;
  }

  private _isRateBlocked(): boolean {
    const limit = this.governance.max_tasks_per_hour ?? 0;
    if (limit <= 0) return false;
    this._purgeWindow();
    return this.taskTimestamps.length >= limit;
  }

  private _recordCost(cost: number): void {
    this.costEntries.push({ ts: Date.now(), cost });
  }

  private _recordTask(): void {
    this.taskTimestamps.push(Date.now());
  }

  // ---------------------------------------------------------------------------
  // Rate-state persistence (SQLite — single-process restart survival)
  // ---------------------------------------------------------------------------

  /**
   * Load rate-limit state from SQLite into memory.
   * Only entries within the current sliding window are loaded; older rows are
   * discarded so the window is always fresh on startup.
   *
   * Called by start() before the loop begins.
   */
  private _loadRateState(): void {
    if (this.db == null) return;
    try {
      const cutoff = Date.now() - SLIDING_WINDOW_MS;
      const tasks = this.db.prepare<[string, number], { ts: number }>(
        "SELECT ts FROM daemon_rate_state WHERE agent_id = ? AND type = 'task' AND ts > ?",
      ).all(this.agentId, cutoff);
      this.taskTimestamps = tasks.map((r) => r.ts);

      const costs = this.db.prepare<[string, number], { ts: number; cost: number }>(
        "SELECT ts, cost FROM daemon_rate_state WHERE agent_id = ? AND type = 'cost' AND ts > ?",
      ).all(this.agentId, cutoff);
      this.costEntries = costs.map((r) => ({ ts: r.ts, cost: r.cost }));
    } catch (err: unknown) {
      // Non-fatal: table may not exist yet (schema migration pending).
      logger.warn("agent-daemon", "Failed to load rate state from DB (will use empty window)", {
        metadata: { agent_id: this.agentId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /**
   * Persist current rate-limit state to SQLite.
   * Old entries (outside the sliding window) are pruned first.
   *
   * Called by stop() so that limits survive a daemon restart.
   */
  private _persistRateState(): void {
    if (this.db == null) return;
    try {
      this._purgeWindow();
      const cutoff = Date.now() - SLIDING_WINDOW_MS;
      this.db.transaction(() => {
        this.db!.prepare<[string, number], void>(
          "DELETE FROM daemon_rate_state WHERE agent_id = ? AND ts <= ?",
        ).run(this.agentId, cutoff);

        const taskStmt = this.db!.prepare<[string, string, number, null], void>(
          "INSERT OR REPLACE INTO daemon_rate_state (agent_id, type, ts, cost) VALUES (?, ?, ?, ?)",
        );
        for (const ts of this.taskTimestamps) {
          taskStmt.run(this.agentId, "task", ts, null);
        }

        const costStmt = this.db!.prepare<[string, string, number, number], void>(
          "INSERT OR REPLACE INTO daemon_rate_state (agent_id, type, ts, cost) VALUES (?, ?, ?, ?)",
        );
        for (const e of this.costEntries) {
          costStmt.run(this.agentId, "cost", e.ts, e.cost);
        }
      })();
    } catch (err: unknown) {
      logger.warn("agent-daemon", "Failed to persist rate state to DB", {
        metadata: { agent_id: this.agentId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  private emit(
    event:    DaemonAuditEvent["event"],
    taskId?:  string,
    cost?:    number,
    reason?:  string,
  ): void {
    const entry: DaemonAuditEvent = {
      agent_id:  this.agentId,
      event,
      timestamp: new Date().toISOString(),
      ...(taskId !== undefined && { task_id: taskId }),
      ...(cost   !== undefined && { cost_usd: cost }),
      ...(reason !== undefined && { reason }),
    };
    this.auditLog.push(entry);
    // Cap in-memory log to last 500 entries
    if (this.auditLog.length > 500) this.auditLog.shift();
  }
}
