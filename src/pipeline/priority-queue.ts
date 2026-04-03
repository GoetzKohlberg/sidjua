// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9.5: PriorityQueue
 *
 * Multi-lane SQLite-backed priority queue. The "lanes" are not in-memory
 * data structures — they are SQL queries ordered by (priority ASC, queued_at ASC).
 *
 * Crash recovery is trivial: on restart, query non-terminal rows.
 *
 * Atomic dequeue: SELECT + UPDATE inside a transaction prevents double delivery.
 * SQLite is single-writer, so the transaction guarantees exclusivity.
 */

import type { Database } from "../utils/db.js";
import {
  AckState,
  TaskPriority,
  PIPELINE_SCHEMA_SQL,
} from "./types.js";
import type { QueueEntry, ExpiredTask } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("pipeline-queue");


interface QueueRow {
  task_id:           string;
  producer_agent_id: string;
  consumer_agent_id: string | null;
  priority:          number;
  original_priority: number;
  ack_state:         string;
  queued_at:         string;
  accepted_at:       string | null;
  started_at:        string | null;
  completed_at:      string | null;
  ttl_expires_at:    string;
  delivery_attempts: number;
  last_delivery_at:  string | null;
  excluded_agents:   string | null; // JSON array
  metadata:          string | null; // JSON object
}

function rowToEntry(row: QueueRow): QueueEntry {
  return {
    task_id:           row.task_id,
    producer_agent_id: row.producer_agent_id,
    consumer_agent_id: row.consumer_agent_id,
    priority:          row.priority as TaskPriority,
    original_priority: row.original_priority as TaskPriority,
    ack_state:         row.ack_state as AckState,
    queued_at:         row.queued_at,
    accepted_at:       row.accepted_at,
    started_at:        row.started_at,
    completed_at:      row.completed_at,
    ttl_expires_at:    row.ttl_expires_at,
    delivery_attempts: row.delivery_attempts,
    last_delivery_at:  row.last_delivery_at,
    excluded_agents:   row.excluded_agents !== null
      ? (JSON.parse(row.excluded_agents) as string[])
      : [],
    metadata:          row.metadata !== null
      ? (JSON.parse(row.metadata) as Record<string, string>)
      : {},
  };
}


export class PriorityQueue {
  constructor(private readonly db: Database) {
    this.db.exec(PIPELINE_SCHEMA_SQL);
  }

  // ---------------------------------------------------------------------------
  // enqueue
  // ---------------------------------------------------------------------------

  /**
   * Insert a new entry into the queue. Crash-safe (single INSERT).
   */
  enqueue(entry: QueueEntry): void {
    this.db.prepare<unknown[], void>(`
      INSERT INTO pipeline_queue
        (task_id, producer_agent_id, consumer_agent_id,
         priority, original_priority, ack_state,
         queued_at, accepted_at, started_at, completed_at,
         ttl_expires_at, delivery_attempts, last_delivery_at,
         excluded_agents, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.task_id,
      entry.producer_agent_id,
      entry.consumer_agent_id,
      entry.priority,
      entry.original_priority,
      entry.ack_state,
      entry.queued_at,
      entry.accepted_at,
      entry.started_at,
      entry.completed_at,
      entry.ttl_expires_at,
      entry.delivery_attempts,
      entry.last_delivery_at,
      entry.excluded_agents.length > 0 ? JSON.stringify(entry.excluded_agents) : null,
      Object.keys(entry.metadata).length > 0 ? JSON.stringify(entry.metadata) : null,
    );

    logger.debug("pipeline_queue", "Task enqueued", { metadata: {
      task_id:  entry.task_id,
      priority: entry.priority,
      consumer: entry.consumer_agent_id ?? "unassigned",
    } });
  }

  // ---------------------------------------------------------------------------
  // dequeueNext
  // ---------------------------------------------------------------------------

  /**
   * Atomically claim the highest-priority QUEUED task for an agent.
   *
   * Atomic via SQLite transaction (single-writer: SELECT + UPDATE is safe).
   * Returns null if no eligible task exists.
   *
   * Eligibility:
   *   - consumer_agent_id = agent_id OR consumer_agent_id IS NULL
   *   - ack_state = 'QUEUED'
   *   - ttl_expires_at > NOW
   *   - agent_id not in excluded_agents
   */
  dequeueNext(agent_id: string): QueueEntry | null {
    const now = new Date().toISOString();

    return this.db.transaction((): QueueEntry | null => {
      // Find best candidate (priority ASC, FIFO within priority)
      const candidates = this.db.prepare<[string, string], QueueRow>(`
        SELECT * FROM pipeline_queue
        WHERE (consumer_agent_id = ? OR consumer_agent_id IS NULL)
          AND ack_state = 'QUEUED'
          AND ttl_expires_at > ?
        ORDER BY priority ASC, queued_at ASC
        LIMIT 20
      `).all(agent_id, now);

      // Filter out excluded agents in TypeScript (avoids JSON SQLite dependency)
      const eligible = candidates.find((row) => {
        if (row.excluded_agents === null) return true;
        const excluded = JSON.parse(row.excluded_agents) as string[];
        return !excluded.includes(agent_id);
      });

      if (eligible === undefined) return null;

      // Atomic claim: only succeed if still QUEUED (prevents double delivery)
      const result = this.db.prepare<[string, string], void>(`
        UPDATE pipeline_queue
        SET ack_state = 'ACCEPTED', accepted_at = ?
        WHERE task_id = ? AND ack_state = 'QUEUED'
      `).run(now, eligible.task_id);

      if (result.changes === 0) {
        // Another writer claimed it first (shouldn't happen with single-writer SQLite,
        // but defensive check for correctness)
        return null;
      }

      return rowToEntry({ ...eligible, ack_state: AckState.ACCEPTED, accepted_at: now });
    })();
  }

  // ---------------------------------------------------------------------------
  // peek
  // ---------------------------------------------------------------------------

  /**
   * View top N tasks for an agent without modifying state.
   */
  peek(agent_id: string, limit: number): QueueEntry[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare<[string, string, number], QueueRow>(`
      SELECT * FROM pipeline_queue
      WHERE (consumer_agent_id = ? OR consumer_agent_id IS NULL)
        AND ack_state = 'QUEUED'
        AND ttl_expires_at > ?
      ORDER BY priority ASC, queued_at ASC
      LIMIT ?
    `).all(agent_id, now, limit);
    return rows.map(rowToEntry);
  }

  // ---------------------------------------------------------------------------
  // requeue
  // ---------------------------------------------------------------------------

  /**
   * Put a task back into QUEUED state.
   * Called after REJECTED or delivery failure.
   * Optional: change priority, exclude specific agent.
   */
  requeue(task_id: string, new_priority?: TaskPriority, exclude_agent?: string): void {
    const now = new Date().toISOString();

    const current = this.db.prepare<[string], QueueRow>(
      "SELECT * FROM pipeline_queue WHERE task_id = ?",
    ).get(task_id);

    if (current === undefined) {
      logger.warn("pipeline_queue", "requeue: task not found", { metadata: { task_id } });
      return;
    }

    // Build updated excluded_agents list
    let excluded: string[] = current.excluded_agents !== null
      ? (JSON.parse(current.excluded_agents) as string[])
      : [];
    if (exclude_agent !== undefined && !excluded.includes(exclude_agent)) {
      excluded = [...excluded, exclude_agent];
    }

    const priority = new_priority ?? (current.priority as TaskPriority);

    this.db.prepare<unknown[], void>(`
      UPDATE pipeline_queue
      SET ack_state = 'QUEUED',
          priority = ?,
          queued_at = ?,
          consumer_agent_id = NULL,
          accepted_at = NULL,
          started_at = NULL,
          excluded_agents = ?
      WHERE task_id = ?
    `).run(
      priority,
      now,
      excluded.length > 0 ? JSON.stringify(excluded) : null,
      task_id,
    );

    logger.debug("pipeline_queue", "Task requeued", { metadata: {
      task_id,
      priority,
      excluded_count: excluded.length,
    } });
  }

  // ---------------------------------------------------------------------------
  // boostStarved
  // ---------------------------------------------------------------------------

  /**
   * Promote tasks waiting longer than threshold_ms by one priority level.
   * CRITICAL (0) cannot be boosted further. original_priority is preserved.
   * Returns count of boosted tasks.
   */
  boostStarved(threshold_ms: number): number {
    const cutoff = new Date(Date.now() - threshold_ms).toISOString();
    const now    = new Date().toISOString();

    // Find QUEUED tasks older than cutoff that aren't already CRITICAL
    const starved = this.db.prepare<[string, string], { task_id: string; priority: number }>(`
      SELECT task_id, priority FROM pipeline_queue
      WHERE ack_state = 'QUEUED'
        AND queued_at < ?
        AND priority > 0
        AND ttl_expires_at > ?
    `).all(cutoff, now);

    if (starved.length === 0) return 0;

    let boosted = 0;
    for (const row of starved) {
      const newPriority = row.priority - 1; // promote one level
      this.db.prepare<unknown[], void>(`
        UPDATE pipeline_queue
        SET priority = ?
        WHERE task_id = ? AND ack_state = 'QUEUED' AND priority = ?
      `).run(newPriority, row.task_id, row.priority);
      boosted++;
    }

    if (boosted > 0) {
      logger.info("pipeline_queue", "Starvation boost applied", { metadata: { count: boosted } });
    }

    return boosted;
  }

  // ---------------------------------------------------------------------------
  // expireStale
  // ---------------------------------------------------------------------------

  /**
   * Mark QUEUED tasks past ttl_expires_at as EXPIRED.
   * Returns list for producer notification.
   */
  expireStale(): ExpiredTask[] {
    const now = new Date().toISOString();

    const expired = this.db.prepare<[string], QueueRow>(`
      SELECT * FROM pipeline_queue
      WHERE ack_state = 'QUEUED'
        AND ttl_expires_at <= ?
    `).all(now);

    if (expired.length === 0) return [];

    // Mark each as EXPIRED
    const stmt = this.db.prepare<[string], void>(
      "UPDATE pipeline_queue SET ack_state = 'EXPIRED' WHERE task_id = ? AND ack_state = 'QUEUED'",
    );
    for (const row of expired) {
      stmt.run(row.task_id);
    }

    logger.info("pipeline_queue", "Expired stale tasks", { metadata: { count: expired.length } });

    return expired.map((row) => ({
      task_id:           row.task_id,
      producer_agent_id: row.producer_agent_id,
      priority:          row.priority as TaskPriority,
      queued_at:         row.queued_at,
      ttl_expires_at:    row.ttl_expires_at,
    }));
  }

  // ---------------------------------------------------------------------------
  // size
  // ---------------------------------------------------------------------------

  /**
   * Count queued tasks, optionally filtered by agent and/or priority.
   */
  size(agent_id?: string, priority?: TaskPriority): number {
    let sql = "SELECT COUNT(*) AS cnt FROM pipeline_queue WHERE ack_state = 'QUEUED'";
    const params: unknown[] = [];

    if (agent_id !== undefined) {
      sql += " AND (consumer_agent_id = ? OR consumer_agent_id IS NULL)";
      params.push(agent_id);
    }
    if (priority !== undefined) {
      sql += " AND priority = ?";
      params.push(priority);
    }

    const row = this.db.prepare<unknown[], { cnt: number }>(sql).get(...params);
    return row?.cnt ?? 0;
  }

  // ---------------------------------------------------------------------------
  // purgeCompleted
  // ---------------------------------------------------------------------------

  /**
   * Remove terminal entries older than threshold. Keeps DB table clean.
   * Returns count of removed rows.
   */
  purgeCompleted(older_than_ms: number): number {
    const cutoff = new Date(Date.now() - older_than_ms).toISOString();
    const result = this.db.prepare<[string], { changes: number }>(`
      DELETE FROM pipeline_queue
      WHERE ack_state IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'REJECTED')
        AND queued_at < ?
    `).run(cutoff);
    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // getEntry / getAll (internal use by TaskPipeline)
  // ---------------------------------------------------------------------------

  /** Get a single entry by task_id. */
  getEntry(task_id: string): QueueEntry | null {
    const row = this.db.prepare<[string], QueueRow>(
      "SELECT * FROM pipeline_queue WHERE task_id = ?",
    ).get(task_id);
    return row !== undefined ? rowToEntry(row) : null;
  }

  /** Get all entries in non-terminal states (used for recovery). */
  getNonTerminal(): QueueEntry[] {
    const rows = this.db.prepare<[], QueueRow>(`
      SELECT * FROM pipeline_queue
      WHERE ack_state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
      ORDER BY priority ASC, queued_at ASC
    `).all();
    return rows.map(rowToEntry);
  }

  /** Update ack_state and optional timestamps. */
  updateState(
    task_id:   string,
    ack_state: AckState,
    fields:    { accepted_at?: string; started_at?: string; completed_at?: string; delivery_attempts?: number; last_delivery_at?: string; consumer_agent_id?: string | null } = {},
  ): void {
    const sets: string[] = ["ack_state = ?"];
    const params: unknown[] = [ack_state];

    if (fields.accepted_at !== undefined)     { sets.push("accepted_at = ?");     params.push(fields.accepted_at); }
    if (fields.started_at !== undefined)      { sets.push("started_at = ?");      params.push(fields.started_at); }
    if (fields.completed_at !== undefined)    { sets.push("completed_at = ?");    params.push(fields.completed_at); }
    if (fields.last_delivery_at !== undefined){ sets.push("last_delivery_at = ?"); params.push(fields.last_delivery_at); }
    if (fields.consumer_agent_id !== undefined) { sets.push("consumer_agent_id = ?"); params.push(fields.consumer_agent_id); }
    if (fields.delivery_attempts !== undefined) { sets.push("delivery_attempts = ?"); params.push(fields.delivery_attempts); }

    params.push(task_id);
    this.db.prepare<unknown[], void>(
      `UPDATE pipeline_queue SET ${sets.join(", ")} WHERE task_id = ?`,
    ).run(...params);
  }

  /** Count all non-terminal tasks in the pipeline. */
  totalQueued(): number {
    const row = this.db.prepare<[], { cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM pipeline_queue WHERE ack_state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'REJECTED')",
    ).get();
    return row?.cnt ?? 0;
  }

  /** Count COMPLETED tasks in the last N ms (throughput metric). */
  completedInWindow(window_ms: number): number {
    const since = new Date(Date.now() - window_ms).toISOString();
    const row   = this.db.prepare<[string], { cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM pipeline_queue WHERE ack_state = 'COMPLETED' AND completed_at >= ?",
    ).get(since);
    return row?.cnt ?? 0;
  }

  /** Get oldest queued task's age in ms, or 0 if none. */
  oldestQueuedAge(): number {
    const row = this.db.prepare<[], { queued_at: string }>(
      "SELECT queued_at FROM pipeline_queue WHERE ack_state = 'QUEUED' ORDER BY queued_at ASC LIMIT 1",
    ).get();
    if (row === undefined) return 0;
    return Date.now() - new Date(row.queued_at).getTime();
  }

  /** Count tasks by priority lane (QUEUED only). */
  countByPriority(): Record<TaskPriority, number> {
    const rows = this.db.prepare<[], { priority: number; cnt: number }>(`
      SELECT priority, COUNT(*) AS cnt
      FROM pipeline_queue
      WHERE ack_state = 'QUEUED'
      GROUP BY priority
    `).all();

    return {
      [TaskPriority.CRITICAL]:   0,
      [TaskPriority.URGENT]:     0,
      [TaskPriority.REGULAR]:    0,
      [TaskPriority.LOW]:        0,
      [TaskPriority.BACKGROUND]: 0,
      ...Object.fromEntries(rows.map((r) => [r.priority as number, r.cnt])) as Record<number, number>,
    } as Record<TaskPriority, number>;
  }

  /** Get all QUEUED tasks for position calculation. */
  getQueuedAhead(task_id: string): number {
    const entry = this.getEntry(task_id);
    if (entry === null) return 0;

    // Count tasks ahead: same or higher priority (lower number) that came in earlier
    const p   = entry.priority as number;
    const row = this.db.prepare<[number, number, string], { cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM pipeline_queue
      WHERE ack_state = 'QUEUED'
        AND (priority < ? OR (priority = ? AND queued_at < ?))
    `).get(p, p, entry.queued_at);

    return row?.cnt ?? 0;
  }

  /** Count QUEUED tasks within same priority lane ahead of this task. */
  getPositionInLane(task_id: string): number {
    const entry = this.getEntry(task_id);
    if (entry === null) return 0;

    const row = this.db.prepare<[number, string], { cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM pipeline_queue
      WHERE ack_state = 'QUEUED'
        AND priority = ?
        AND queued_at < ?
    `).get(entry.priority, entry.queued_at);

    return (row?.cnt ?? 0) + 1; // 1-based
  }

  /** Get all QUEUED tasks for a specific consumer (used in backpressure tracking). */
  getQueuedForAgent(agent_id: string): QueueEntry[] {
    const rows = this.db.prepare<[string], QueueRow>(`
      SELECT * FROM pipeline_queue
      WHERE consumer_agent_id = ? AND ack_state = 'QUEUED'
    `).all(agent_id);
    return rows.map(rowToEntry);
  }

  /** Get tasks in ACCEPTED state that have been waiting for ACK timeout. */
  getAcceptedOlderThan(cutoff: string): QueueEntry[] {
    const rows = this.db.prepare<[string], QueueRow>(`
      SELECT * FROM pipeline_queue
      WHERE ack_state = 'ACCEPTED'
        AND last_delivery_at IS NOT NULL
        AND last_delivery_at < ?
    `).all(cutoff);
    return rows.map(rowToEntry);
  }

  /** Get tasks that have been ACCEPTED but never transitioned to RUNNING. */
  getStuckAccepted(cutoff: string): QueueEntry[] {
    const rows = this.db.prepare<[string], QueueRow>(`
      SELECT * FROM pipeline_queue
      WHERE ack_state = 'ACCEPTED'
        AND accepted_at < ?
        AND started_at IS NULL
    `).all(cutoff);
    return rows.map(rowToEntry);
  }
}
