// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 7: TaskEventBus
 *
 * SQLite-backed event bus for the Task System. Satisfies Phase 6's EventBus
 * interface (emit(string, unknown) + on(string, fn)) AND adds Phase 7 task-
 * specific functionality via emitTask(), consume(), acknowledge(), poll(),
 * subscribe(), unsubscribe(), and cleanup().
 *
 * Event flow:
 *   1. emitTask() writes to SQLite (source of truth)
 *   2. Calls in-memory subscriber callbacks (subscribe())
 *   3. Optionally pushes via IPCChannel
 *   4. Agents poll() as 500ms fallback
 */

import type { Database } from "../utils/db.js";
import type { EventBus } from "../types/provider.js";
import type { TaskEvent, TaskEventInput, IPCChannel } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("task-event-bus");


interface EventDbRow {
  id: string;
  event_type: string;
  task_id: string;
  parent_task_id: string | null;
  agent_from: string | null;
  agent_to: string | null;
  division: string;
  data: string; // JSON
  created_at: string;
  consumed: number; // 0 or 1
  consumed_at: string | null;
}

function rowToEvent(row: EventDbRow): TaskEvent {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch (parseErr: unknown) {
    logger.warn("event_parse_failed", "Skipping malformed event data — using empty object", {
      metadata: { id: row.id, error: parseErr instanceof Error ? parseErr.message : String(parseErr) },
    });
  }
  return {
    id: row.id,
    event_type: row.event_type as TaskEvent["event_type"],
    task_id: row.task_id,
    parent_task_id: row.parent_task_id,
    agent_from: row.agent_from,
    agent_to: row.agent_to,
    division: row.division,
    data,
    created_at: row.created_at,
    consumed: row.consumed === 1,
    consumed_at: row.consumed_at,
  };
}


/**
 * Full-featured event bus for Phase 7.
 *
 * Implements Phase 6's EventBus interface (emit(string, unknown) + on(string, fn))
 * for backward compatibility. ProviderRegistry can be passed a TaskEventBus.
 */
export class TaskEventBus implements EventBus {
  private readonly subscribers = new Map<string, (event: TaskEvent) => void>();
  private readonly stringHandlers = new Map<string, Array<(data: unknown) => void>>();
  /** Global listeners — notified for every emitTask() call (used by activity bridge). */
  private readonly globalListeners: Array<(event: TaskEvent) => void> = [];

  constructor(
    private readonly db: Database,
    private readonly ipcChannel?: IPCChannel,
  ) {
    this.initialize();
  }

  /** Create event table and indexes. Idempotent. */
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        task_id TEXT NOT NULL,
        parent_task_id TEXT,
        agent_from TEXT,
        agent_to TEXT,
        division TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0,
        consumed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_agent_to ON task_events(agent_to, consumed);
      CREATE INDEX IF NOT EXISTS idx_events_task     ON task_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_type     ON task_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_created  ON task_events(created_at);
    `);
  }

  // ---------------------------------------------------------------------------
  // Phase 6 EventBus interface (string-based, synchronous)
  // ---------------------------------------------------------------------------

  /**
   * Phase 6 compatibility: emit a named string event to in-memory handlers.
   * Does NOT write to SQLite — use emitTask() for persistent task events.
   */
  emit(event: string, data: unknown): void {
    const handlers = this.stringHandlers.get(event);
    if (handlers !== undefined) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }

  /** Phase 6 compatibility: subscribe to a named string event. */
  on(event: string, handler: (data: unknown) => void): void {
    const existing = this.stringHandlers.get(event);
    if (existing !== undefined) {
      existing.push(handler);
    } else {
      this.stringHandlers.set(event, [handler]);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 7: Task-specific event operations
  // ---------------------------------------------------------------------------

  /**
   * Emit a TaskEvent: write to SQLite, notify subscribers, push via IPC.
   * Returns the new event ID.
   */
  async emitTask(input: TaskEventInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.prepare<unknown[], void>(`
      INSERT INTO task_events
        (id, event_type, task_id, parent_task_id, agent_from, agent_to, division, data, created_at, consumed, consumed_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
    `).run(
      id,
      input.event_type,
      input.task_id,
      input.parent_task_id,
      input.agent_from,
      input.agent_to,
      input.division,
      JSON.stringify(input.data),
      now,
    );

    const event: TaskEvent = {
      ...input,
      id,
      created_at: now,
      consumed: false,
      consumed_at: null,
    };

    // Notify string-event handlers (e.g. TaskLifecycleRouter subscribed via on())
    this.emit(input.event_type, event);

    // Notify in-memory subscriber for the target agent
    if (input.agent_to !== null) {
      const subscriber = this.subscribers.get(input.agent_to);
      if (subscriber !== undefined) {
        // Call asynchronously to avoid blocking the emitter
        Promise.resolve().then(() => subscriber(event)).catch(() => undefined);
      }

      // IPC push (best-effort, event already persisted in SQLite)
      if (this.ipcChannel !== undefined) {
        try {
          this.ipcChannel.send(input.agent_to, event);
        } catch (e: unknown) {
          logger.warn("task-event-bus", "IPC notification failed — agent will poll from SQLite", { metadata: { error: e instanceof Error ? e.message : String(e) } });
        }
      }
    }

    // Notify global (wildcard) listeners — used by activity stream bridge
    for (const cb of this.globalListeners) {
      Promise.resolve().then(() => cb(event)).catch(() => undefined);
    }

    return id;
  }

  /**
   * Consume unconsumed events for an agent. Events remain in DB until acknowledged.
   */
  async consume(agentId: string, limit = 100): Promise<TaskEvent[]> {
    const rows = this.db
      .prepare<[string, number], EventDbRow>(
        "SELECT * FROM task_events WHERE agent_to = ? AND consumed = 0 ORDER BY created_at ASC LIMIT ?",
      )
      .all(agentId, limit);
    return rows.map(rowToEvent);
  }

  /** Mark events as consumed. */
  async acknowledge(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    const now = new Date().toISOString();
    for (const id of eventIds) {
      this.db.prepare<unknown[], void>(
        "UPDATE task_events SET consumed = 1, consumed_at = ? WHERE id = ?",
      ).run(now, id);
    }
  }

  /**
   * Poll for unconsumed events — DB fallback when IPC push was missed.
   * Same as consume() but with no side effects.
   */
  async poll(agentId: string): Promise<TaskEvent[]> {
    return this.consume(agentId);
  }

  /**
   * Subscribe to real-time events for an agent.
   * Callback is called immediately when emitTask() targets this agent.
   * Only one subscription per agentId (last wins).
   */
  subscribe(agentId: string, callback: (event: TaskEvent) => void): void {
    this.subscribers.set(agentId, callback);
  }

  /** Remove subscription for an agent. */
  unsubscribe(agentId: string): void {
    this.subscribers.delete(agentId);
  }

  /**
   * Subscribe to ALL task events (wildcard).
   * Called by the activity stream bridge — multiple callers are allowed.
   * Callback is invoked asynchronously after emitTask() persists the event.
   */
  subscribeAll(callback: (event: TaskEvent) => void): void {
    this.globalListeners.push(callback);
  }

  /**
   * Delete consumed events older than `olderThanDays` days.
   * Returns number of events deleted.
   */
  async cleanup(olderThanDays: number): Promise<number> {
    const cutoff = new Date(
      Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db.prepare<unknown[], void>(
      "DELETE FROM task_events WHERE consumed = 1 AND created_at < ?",
    ).run(cutoff);
    return result.changes;
  }
}
