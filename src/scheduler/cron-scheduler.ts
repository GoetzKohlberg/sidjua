// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V1.1: CronScheduler
 *
 * Manages recurring scheduled tasks for SIDJUA agents.
 *
 * Responsibilities:
 *   - SQLite persistence of schedule definitions
 *   - Cron expression parsing and next_run_at calculation (via cron-parser)
 *   - Governance enforcement: interval minimum, per-agent/division limits,
 *     per-day run caps, budget checks, approval requirements
 *   - CRUD API: create, update, delete, enable, disable, list, get
 *   - getDueTasks: find enabled schedules whose next_run_at has passed
 *   - executeDueSchedule: check+bookkeep (actual task submission in P221)
 *   - loadSchedulesFromConfig: sync agent YAML schedule declarations into DB
 */

import { CronExpressionParser } from "cron-parser";
import type { Database } from "../utils/db.js";
import { createLogger } from "../core/logger.js";
import type {
  ScheduleDefinition,
  ScheduleCreateInput,
  SchedulingGovernance,
  AgentConfig,
  BudgetTrackerLike,
} from "./types.js";

const logger = createLogger("cron-scheduler");


const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schedule_budget_reservations (
  id           TEXT PRIMARY KEY,
  schedule_id  TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  division_id  TEXT NOT NULL,
  reserved_usd REAL NOT NULL,
  actual_usd   REAL,
  created_at   TEXT NOT NULL,
  released_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservations_schedule
  ON schedule_budget_reservations(schedule_id);
CREATE INDEX IF NOT EXISTS idx_reservations_division_day
  ON schedule_budget_reservations(division_id, agent_id, created_at);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  division TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  task_description TEXT NOT NULL,
  task_priority INTEGER DEFAULT 5,
  task_budget_tokens INTEGER,
  task_budget_usd REAL,
  task_ttl_seconds INTEGER,
  enabled INTEGER DEFAULT 1,
  max_cost_per_run REAL DEFAULT 1.00,
  max_runs_per_day INTEGER DEFAULT 24,
  require_approval INTEGER DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  total_runs INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0.0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedules_agent ON schedules(agent_id);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS schedule_runs (
  id          INTEGER PRIMARY KEY,
  schedule_id TEXT    NOT NULL,
  run_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_lookup
  ON schedule_runs(schedule_id, run_at);
`;


interface ScheduleRow {
  id:                string;
  agent_id:          string;
  division:          string;
  cron_expression:   string;
  task_description:  string;
  task_priority:     number;
  task_budget_tokens: number | null;
  task_budget_usd:   number | null;
  task_ttl_seconds:  number | null;
  enabled:           number;
  max_cost_per_run:  number;
  max_runs_per_day:  number;
  require_approval:  number;
  last_run_at:       string | null;
  next_run_at:       string;
  total_runs:        number;
  total_cost_usd:    number;
  created_at:        string;
  updated_at:        string;
}


function rowToDefinition(row: ScheduleRow): ScheduleDefinition {
  return {
    id:              row.id,
    agent_id:        row.agent_id,
    division:        row.division,
    cron_expression: row.cron_expression,
    task_template: {
      description:    row.task_description,
      priority:       row.task_priority,
      ...(row.task_budget_tokens !== null ? { budget_tokens: row.task_budget_tokens } : {}),
      ...(row.task_budget_usd    !== null ? { budget_usd:    row.task_budget_usd    } : {}),
      ...(row.task_ttl_seconds   !== null ? { ttl_seconds:   row.task_ttl_seconds   } : {}),
    },
    enabled: row.enabled !== 0,
    governance: {
      max_cost_per_run: row.max_cost_per_run,
      max_runs_per_day: row.max_runs_per_day,
      require_approval: row.require_approval !== 0,
    },
    last_run_at:    row.last_run_at,
    next_run_at:    row.next_run_at,
    total_runs:     row.total_runs,
    total_cost_usd: row.total_cost_usd,
  };
}

/**
 * Compute the next fire time for a cron expression.
 * Returns ISO 8601 UTC string.
 */
function nextRunAt(cronExpression: string, from: Date = new Date()): string {
  const interval = CronExpressionParser.parse(cronExpression, { currentDate: from, tz: "UTC" });
  const next = interval.next();
  return (next as unknown as Date).toISOString();
}

/**
 * Compute the minimum interval (in minutes) of a cron expression by
 * comparing two consecutive fire times.
 */
function cronIntervalMinutes(cronExpression: string): number {
  const base = new Date("2026-01-01T00:00:00Z");
  const interval = CronExpressionParser.parse(cronExpression, { currentDate: base, tz: "UTC" });
  const t1 = interval.next().getTime();
  const t2 = interval.next().getTime();
  return Math.round((t2 - t1) / 60_000);
}


export class CronScheduler {
  constructor(
    private readonly db:             Database,
    private readonly budgetTracker:  BudgetTrackerLike,
    private readonly governance:     SchedulingGovernance,
    private readonly log =           logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  /** Create the schedules table and indexes. Idempotent. */
  initialize(): Promise<void> {
    this.db.exec(SCHEMA_SQL);
    this.log.info("cron-scheduler", "Schema initialized", { metadata: {} });
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Config sync
  // ---------------------------------------------------------------------------

  /**
   * Sync schedule declarations from agent YAML configs into the DB.
   * Existing schedules are updated if changed; run history is preserved.
   * New schedules are inserted with next_run_at calculated from now.
   */
  loadSchedulesFromConfig(agentConfigs: AgentConfig[]): void {
    for (const agent of agentConfigs) {
      if (!agent.schedules || agent.schedules.length === 0) continue;

      for (const entry of agent.schedules) {
        const compositeId = `${agent.id}:${entry.id}`;
        const existing = this._getRow(compositeId);

        const cron = entry.cron_expression;
        const gov  = entry.governance ?? {};

        if (existing !== null) {
          // Preserve run history; update config fields only
          const newNext = existing.next_run_at;
          const recalc  = existing.cron_expression !== cron
            ? nextRunAt(cron)
            : newNext;

          this.db.prepare<unknown[], void>(`
            UPDATE schedules SET
              division         = ?,
              cron_expression  = ?,
              task_description = ?,
              task_priority    = ?,
              task_budget_tokens = ?,
              task_budget_usd  = ?,
              task_ttl_seconds = ?,
              enabled          = ?,
              max_cost_per_run = ?,
              max_runs_per_day = ?,
              require_approval = ?,
              next_run_at      = ?,
              updated_at       = datetime('now')
            WHERE id = ?
          `).run(
            agent.division,
            cron,
            entry.task_template.description,
            entry.task_template.priority ?? 5,
            entry.task_template.budget_tokens ?? null,
            entry.task_template.budget_usd    ?? null,
            entry.task_template.ttl_seconds   ?? null,
            (entry.enabled ?? true) ? 1 : 0,
            gov.max_cost_per_run  ?? 1.0,
            gov.max_runs_per_day  ?? 24,
            (gov.require_approval ?? false) ? 1 : 0,
            recalc,
            compositeId,
          );
        } else {
          this.db.prepare<unknown[], void>(`
            INSERT INTO schedules
              (id, agent_id, division, cron_expression, task_description,
               task_priority, task_budget_tokens, task_budget_usd, task_ttl_seconds,
               enabled, max_cost_per_run, max_runs_per_day, require_approval,
               last_run_at, next_run_at, total_runs, total_cost_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0.0)
          `).run(
            compositeId,
            agent.id,
            agent.division,
            cron,
            entry.task_template.description,
            entry.task_template.priority ?? 5,
            entry.task_template.budget_tokens ?? null,
            entry.task_template.budget_usd    ?? null,
            entry.task_template.ttl_seconds   ?? null,
            (entry.enabled ?? true) ? 1 : 0,
            gov.max_cost_per_run  ?? 1.0,
            gov.max_runs_per_day  ?? 24,
            (gov.require_approval ?? false) ? 1 : 0,
            nextRunAt(cron),
          );
        }
      }
    }

    this.log.info("cron-scheduler", "Loaded schedules from config", {
      metadata: { agent_count: agentConfigs.length },
    });
  }

  // ---------------------------------------------------------------------------
  // Due-task query
  // ---------------------------------------------------------------------------

  /**
   * Return enabled schedules for the given agent whose next_run_at has passed.
   * Optionally scoped to a specific agent_id.
   */
  getDueTasks(agentId: string, now: Date = new Date()): ScheduleDefinition[] {
    const nowIso = now.toISOString();
    const rows   = this.db.prepare<unknown[], ScheduleRow>(
      "SELECT * FROM schedules WHERE agent_id = ? AND enabled = 1 AND next_run_at <= ?",
    ).all(agentId, nowIso);
    return rows.map(rowToDefinition);
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /**
   * Check governance constraints and advance DB bookkeeping for one due schedule.
   *
   * Atomically reserves budget before executing; returns a `reservationId` the
   * daemon layer MUST pass to `releaseReservation()` after the task completes
   * (or fails), so the budget window is closed correctly.
   *
   * Returns `{ executed: true, reservationId }` on success, or
   * `{ executed: false, reason }` when any constraint is not met.
   *
   * NOTE: Does NOT submit a task — actual task submission handled in the daemon layer.
   */
  async executeDueSchedule(
    schedule: ScheduleDefinition,
    now: Date = new Date(),
  ): Promise<{ executed: boolean; reason?: string; reservationId?: string }> {
    // 1. Check daily run count via the schedule_runs ledger table
    const todayDate = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const countRow  = this.db.prepare<[string, string], { cnt: number }>(
      "SELECT COUNT(*) as cnt FROM schedule_runs WHERE schedule_id = ? AND date(run_at) = ?",
    ).get(schedule.id, todayDate);
    const runsToday = countRow?.cnt ?? 0;

    if (runsToday >= schedule.governance.max_runs_per_day) {
      return { executed: false, reason: "max_runs_per_day exceeded" };
    }

    // 2. Check approval requirement (first run only)
    if (schedule.governance.require_approval && schedule.total_runs === 0) {
      return { executed: false, reason: "requires_approval" };
    }

    // 3. Atomic budget check + reserve (replaces non-atomic canAfford check)
    let reservationId: string;
    try {
      reservationId = this._atomicCheckAndReserve(
        schedule.id,
        schedule.agent_id,
        schedule.division,
        schedule.governance.max_cost_per_run,
        now,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "daily_cap_exceeded") {
        return { executed: false, reason: "daily_cap_exceeded" };
      }
      return { executed: false, reason: "budget_exhausted" };
    }

    // 4. All checks passed — update DB bookkeeping
    const newNextRun = nextRunAt(schedule.cron_expression, now);
    const nowIso     = now.toISOString();
    this.db.prepare<unknown[], void>(`
      UPDATE schedules SET
        last_run_at  = ?,
        total_runs   = total_runs + 1,
        next_run_at  = ?,
        updated_at   = datetime('now')
      WHERE id = ?
    `).run(nowIso, newNextRun, schedule.id);

    // Record run in ledger so daily cap is enforced accurately.
    this.db.prepare<[string, string], void>(
      "INSERT INTO schedule_runs (schedule_id, run_at) VALUES (?, ?)",
    ).run(schedule.id, nowIso);

    this.log.info("cron-scheduler", "Schedule executed", {
      metadata: {
        schedule_id:    schedule.id,
        agent_id:       schedule.agent_id,
        next_run_at:    newNextRun,
        reservation_id: reservationId,
      },
    });

    return { executed: true, reservationId };
  }

  // ---------------------------------------------------------------------------
  // Budget reservation
  // ---------------------------------------------------------------------------

  /**
   * Release a budget reservation after a scheduled task completes.
   * Records the actual cost (may be less than the reserved amount).
   * Call this from the daemon layer on both success and failure.
   *
   * @param reservationId  ID returned by executeDueSchedule.
   * @param actualCostUsd  Actual cost incurred; 0 on failure.
   */
  releaseReservation(reservationId: string, actualCostUsd: number): void {
    const nowIso = new Date().toISOString();
    this.db.prepare<unknown[], void>(
      `UPDATE schedule_budget_reservations
         SET actual_usd = ?, released_at = ?
       WHERE id = ?`,
    ).run(actualCostUsd, nowIso, reservationId);
  }

  // ---------------------------------------------------------------------------
  // Cost tracking
  // ---------------------------------------------------------------------------

  /** Update total_cost_usd after a scheduled task completes. */
  updateScheduleCost(scheduleId: string, costUsd: number): void {
    this.db.prepare<unknown[], void>(
      "UPDATE schedules SET total_cost_usd = total_cost_usd + ?, updated_at = datetime('now') WHERE id = ?",
    ).run(costUsd, scheduleId);
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /** Create a new schedule with validation. */
  createSchedule(input: ScheduleCreateInput): ScheduleDefinition {
    // Validate cron expression
    try {
      CronExpressionParser.parse(input.cron_expression, { tz: "UTC" });
    } catch (_err) {
      throw new Error(`Invalid cron expression: ${input.cron_expression}`);
    }

    // Validate minimum interval
    const intervalMin = cronIntervalMinutes(input.cron_expression);
    const minInterval = this.governance.global_limits.min_cron_interval_minutes;
    if (intervalMin < minInterval) {
      throw new Error(
        `Cron interval ${intervalMin}m is below the minimum allowed ${minInterval}m`,
      );
    }

    // Validate per-agent schedule count
    const agentCount = this._countSchedules({ agent_id: input.agent_id });
    if (agentCount >= this.governance.global_limits.max_schedules_per_agent) {
      throw new Error(
        `Agent ${input.agent_id} already has ${agentCount} schedules (max: ${this.governance.global_limits.max_schedules_per_agent})`,
      );
    }

    // Validate per-division schedule count
    const divisionCount = this._countSchedules({ division: input.division });
    if (divisionCount >= this.governance.global_limits.max_schedules_per_division) {
      throw new Error(
        `Division ${input.division} already has ${divisionCount} schedules (max: ${this.governance.global_limits.max_schedules_per_division})`,
      );
    }

    const id       = crypto.randomUUID();
    const enabled  = input.enabled ?? true;
    const gov      = input.governance ?? {};
    const now      = new Date();
    const nextRun  = nextRunAt(input.cron_expression, now);

    const maxCostPerRun  = gov.max_cost_per_run  ?? 1.0;
    const maxRunsPerDay  = gov.max_runs_per_day  ?? 24;
    const requireApproval = gov.require_approval ?? false;

    this.db.prepare<unknown[], void>(`
      INSERT INTO schedules
        (id, agent_id, division, cron_expression, task_description,
         task_priority, task_budget_tokens, task_budget_usd, task_ttl_seconds,
         enabled, max_cost_per_run, max_runs_per_day, require_approval,
         last_run_at, next_run_at, total_runs, total_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0.0)
    `).run(
      id,
      input.agent_id,
      input.division,
      input.cron_expression,
      input.task_template.description,
      input.task_template.priority ?? 5,
      input.task_template.budget_tokens ?? null,
      input.task_template.budget_usd    ?? null,
      input.task_template.ttl_seconds   ?? null,
      enabled ? 1 : 0,
      maxCostPerRun,
      maxRunsPerDay,
      requireApproval ? 1 : 0,
      nextRun,
    );

    this.log.info("cron-scheduler", "Schedule created", {
      metadata: { id, agent_id: input.agent_id, cron: input.cron_expression },
    });

    return this.getSchedule(id) as ScheduleDefinition;
  }

  /** Update fields of an existing schedule. */
  updateSchedule(id: string, updates: Partial<ScheduleDefinition>): void {
    const existing = this._getRow(id);
    if (existing === null) throw new Error(`Schedule '${id}' not found`);

    const cron = updates.cron_expression ?? existing.cron_expression;

    // Validate new cron expression if changed
    if (updates.cron_expression !== undefined) {
      try {
        CronExpressionParser.parse(cron, { tz: "UTC" });
      } catch (_err) {
        throw new Error(`Invalid cron expression: ${cron}`);
      }

      const intervalMin = cronIntervalMinutes(cron);
      const minInterval = this.governance.global_limits.min_cron_interval_minutes;
      if (intervalMin < minInterval) {
        throw new Error(
          `Cron interval ${intervalMin}m is below the minimum allowed ${minInterval}m`,
        );
      }
    }

    const nextRun = updates.cron_expression !== undefined
      ? nextRunAt(cron)
      : existing.next_run_at;

    const gov     = (updates.governance    ?? {}) as Partial<ScheduleDefinition["governance"]>;
    const tmpl    = (updates.task_template ?? {}) as Partial<ScheduleDefinition["task_template"]>;
    const enabled = updates.enabled ?? existing.enabled;

    this.db.prepare<unknown[], void>(`
      UPDATE schedules SET
        cron_expression  = ?,
        task_description = ?,
        task_priority    = ?,
        task_budget_tokens = ?,
        task_budget_usd  = ?,
        task_ttl_seconds = ?,
        enabled          = ?,
        max_cost_per_run = ?,
        max_runs_per_day = ?,
        require_approval = ?,
        next_run_at      = ?,
        updated_at       = datetime('now')
      WHERE id = ?
    `).run(
      cron,
      tmpl.description         ?? existing.task_description,
      tmpl.priority            ?? existing.task_priority,
      tmpl.budget_tokens       !== undefined ? (tmpl.budget_tokens ?? null) : existing.task_budget_tokens,
      tmpl.budget_usd          !== undefined ? (tmpl.budget_usd    ?? null) : existing.task_budget_usd,
      tmpl.ttl_seconds         !== undefined ? (tmpl.ttl_seconds   ?? null) : existing.task_ttl_seconds,
      enabled ? 1 : 0,
      gov.max_cost_per_run  ?? existing.max_cost_per_run,
      gov.max_runs_per_day  ?? existing.max_runs_per_day,
      (gov.require_approval ?? (existing.require_approval !== 0)) ? 1 : 0,
      nextRun,
      id,
    );
  }

  /** Delete a schedule by ID. */
  deleteSchedule(id: string): void {
    this.db.prepare<unknown[], void>("DELETE FROM schedules WHERE id = ?").run(id);
    this.log.info("cron-scheduler", "Schedule deleted", { metadata: { id } });
  }

  /** List all schedules, optionally filtered by agent_id. */
  listSchedules(agentId?: string): ScheduleDefinition[] {
    let rows: ScheduleRow[];
    if (agentId !== undefined) {
      rows = this.db.prepare<unknown[], ScheduleRow>(
        "SELECT * FROM schedules WHERE agent_id = ? ORDER BY created_at",
      ).all(agentId);
    } else {
      rows = this.db.prepare<unknown[], ScheduleRow>(
        "SELECT * FROM schedules ORDER BY created_at",
      ).all();
    }
    return rows.map(rowToDefinition);
  }

  /** Get a single schedule by ID, or null if not found. */
  getSchedule(id: string): ScheduleDefinition | null {
    const row = this._getRow(id);
    return row !== null ? rowToDefinition(row) : null;
  }

  /** Enable a schedule and recalculate next_run_at from now. */
  enableSchedule(id: string): void {
    const existing = this._getRow(id);
    if (existing === null) throw new Error(`Schedule '${id}' not found`);
    const nextRun = nextRunAt(existing.cron_expression);
    this.db.prepare<unknown[], void>(
      "UPDATE schedules SET enabled = 1, next_run_at = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(nextRun, id);
  }

  /** Disable a schedule (will no longer appear in getDueTasks). */
  disableSchedule(id: string): void {
    this.db.prepare<unknown[], void>(
      "UPDATE schedules SET enabled = 0, updated_at = datetime('now') WHERE id = ?",
    ).run(id);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Atomically check daily-cap + per-run budget, then insert a reservation row.
   * Runs inside a SQLite BEGIN…COMMIT transaction so two concurrent callers
   * cannot both pass the cap check and oversubscribe.
   *
   * Budget key: agent_id + division_id (schedule_id is tracked for audit).
   *
   * @throws Error("daily_cap_exceeded") when the agent/division daily cap is full.
   * @throws Error("budget_exhausted")  when the real-time budget tracker rejects.
   * @returns Reservation ID (UUID string).
   */
  private _atomicCheckAndReserve(
    scheduleId:     string,
    agentId:        string,
    divisionId:     string,
    reservedAmount: number,
    now:            Date,
  ): string {
    const reservationId = crypto.randomUUID();
    const todayDate     = now.toISOString().slice(0, 10);
    const nowIso        = now.toISOString();

    const txn = this.db.transaction(() => {
      // 1. Daily-cap check: sum all reservations for this agent+division today
      const sumRow = this.db.prepare<[string, string, string], { total: number }>(
        `SELECT COALESCE(SUM(reserved_usd), 0.0) AS total
           FROM schedule_budget_reservations
          WHERE agent_id = ? AND division_id = ? AND date(created_at) = ?`,
      ).get(agentId, divisionId, todayDate);
      const todayTotal = sumRow?.total ?? 0;

      const dailyCap = this.governance.global_limits.max_total_scheduled_cost_per_day;
      if (todayTotal + reservedAmount > dailyCap) {
        throw new Error("daily_cap_exceeded");
      }

      // 2. Real-time budget check (fail-closed: rejection = blocked)
      if (!this.budgetTracker.canAfford(reservedAmount, divisionId)) {
        throw new Error("budget_exhausted");
      }

      // 3. Insert the reservation — visible to concurrent callers immediately
      this.db.prepare<unknown[], void>(
        `INSERT INTO schedule_budget_reservations
           (id, schedule_id, agent_id, division_id, reserved_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(reservationId, scheduleId, agentId, divisionId, reservedAmount, nowIso);
    });

    txn(); // Execute within a single SQLite transaction
    return reservationId;
  }

  private _getRow(id: string): ScheduleRow | null {
    const row = this.db.prepare<unknown[], ScheduleRow>(
      "SELECT * FROM schedules WHERE id = ?",
    ).get(id);
    return row ?? null;
  }

  private _countSchedules(filter: { agent_id?: string; division?: string }): number {
    if (filter.agent_id !== undefined) {
      const r = this.db.prepare<unknown[], { cnt: number }>(
        "SELECT COUNT(*) as cnt FROM schedules WHERE agent_id = ?",
      ).get(filter.agent_id);
      return r?.cnt ?? 0;
    }
    if (filter.division !== undefined) {
      const r = this.db.prepare<unknown[], { cnt: number }>(
        "SELECT COUNT(*) as cnt FROM schedules WHERE division = ?",
      ).get(filter.division);
      return r?.cnt ?? 0;
    }
    return 0;
  }
}
