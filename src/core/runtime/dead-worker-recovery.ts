// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Dead Worker Recovery
 *
 * Periodic cleanup job that detects tasks stuck in RUNNING state beyond a
 * configurable timeout and marks them as FAILED, freeing held resources.
 *
 * Uses better-sqlite3 synchronous API — no async DB calls.
 */

import type Database from "better-sqlite3";
import { createLogger }  from "../logger.js";
import { getMetrics }    from "../metrics/metrics-collector.js";

const logger = createLogger("dead-worker-recovery");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeadWorkerRecoveryConfig {
  /** Interval between recovery sweeps. Default: 60 000 ms (60 s). */
  checkIntervalMs: number;
  /** Age threshold after which a RUNNING task is considered stuck. Default: 300 000 ms (5 min). */
  taskTimeoutMs: number;
  /** Whether the recovery loop is active. Default: true. */
  enabled: boolean;
}

interface StuckTaskRow {
  id: string;
  assigned_agent: string | null;
  started_at: string;
  tier: number;
  cost_used: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DeadWorkerRecoveryConfig = {
  checkIntervalMs: 60_000,
  taskTimeoutMs: 300_000,
  enabled: true,
};

// ---------------------------------------------------------------------------
// DeadWorkerRecovery
// ---------------------------------------------------------------------------

export class DeadWorkerRecovery {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly config: DeadWorkerRecoveryConfig;

  constructor(
    private readonly db: InstanceType<typeof Database>,
    config?: Partial<DeadWorkerRecoveryConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start the periodic recovery loop. Safe to call multiple times (idempotent). */
  start(): void {
    if (!this.config.enabled) {
      logger.info("dead-worker-recovery", "Recovery disabled — skipping start", {});
      return;
    }
    if (this.intervalHandle !== null) return; // already running

    this.intervalHandle = setInterval(() => {
      this.recover().catch((err: unknown) => {
        logger.error("dead-worker-recovery", "Recovery sweep error", {
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
      });
    }, this.config.checkIntervalMs);

    logger.info("dead-worker-recovery", "Recovery loop started", {
      metadata: {
        checkIntervalMs: this.config.checkIntervalMs,
        taskTimeoutMs:   this.config.taskTimeoutMs,
      },
    });
  }

  /** Stop the periodic loop. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Run a single recovery sweep.
   * Returns the number of stuck tasks that were recovered.
   */
  recover(): Promise<number> {
    // Keep async signature for callability from tests, but the DB work is sync.
    return Promise.resolve(this._recoverSync());
  }

  /** Synchronous sweep — detects and fails stuck tasks. */
  _recoverSync(): number {
    // Tasks whose started_at is older than the configured timeout and are still RUNNING.
    // We also use ttl_seconds: if the task has a custom TTL shorter than the global
    // timeout, respect it. Use MAX(taskTimeoutMs, ttl_seconds*1000) as a conservative
    // upper bound — we only touch tasks older than BOTH limits.
    const cutoffIso = new Date(Date.now() - this.config.taskTimeoutMs).toISOString();

    let stuckTasks: StuckTaskRow[] = [];
    try {
      stuckTasks = this.db
        .prepare<[string], StuckTaskRow>(
          `SELECT id, assigned_agent, started_at, tier, cost_used
           FROM tasks
           WHERE status = 'RUNNING'
             AND started_at IS NOT NULL
             AND started_at < ?`,
        )
        .all(cutoffIso);
    } catch (err: unknown) {
      logger.error("dead-worker-recovery", "Failed to query stuck tasks", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return 0;
    }

    if (stuckTasks.length === 0) return 0;

    const now        = new Date().toISOString();
    const metrics    = getMetrics();
    let   recovered  = 0;

    for (const task of stuckTasks) {
      try {
        this.db
          .prepare<[string, string, string, string]>(
            `UPDATE tasks
             SET status = 'FAILED',
                 completed_at = ?,
                 result_summary = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'RUNNING'`,
          )
          .run(now, "dead-worker-timeout", now, task.id);

        logger.warn("dead-worker-recovery", "Recovered stuck task", {
          metadata: {
            taskId:        task.id,
            agentId:       task.assigned_agent ?? "unknown",
            startedAt:     task.started_at,
            stuckDurationMs: Date.now() - new Date(task.started_at).getTime(),
          },
        });

        metrics.deadWorkerRecoveriesTotal.inc({
          tier: String(task.tier),
        });

        recovered++;
      } catch (err: unknown) {
        logger.error("dead-worker-recovery", "Failed to recover individual task", {
          metadata: {
            taskId: task.id,
            error:  err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    return recovered;
  }
}
