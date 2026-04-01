// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: Emitter (Singleton)
 *
 * Central hub for all activity events. Writes to SQLite (best-effort),
 * notifies in-memory listeners (for SSE bridge, etc.), and exposes query APIs.
 *
 * Design principles:
 * - emit() NEVER throws — a logging failure must not break the caller
 * - Listeners NEVER block the emitter — errors are swallowed
 * - init() must be called once at startup with an open Database
 */

import { randomUUID }                from "crypto";
import type Database                  from "better-sqlite3";
import { runActivityMigrations }      from "./activity-migrations.js";
import type {
  ActivityEvent,
  ActivityRecord,
  ActivityFilters,
  ActivityCategory,
  TimelineEntry,
}                                     from "./activity-types.js";
import { createLogger }               from "../logger.js";

const logger = createLogger("activity-emitter");


export class ActivityEmitter {
  private db: InstanceType<typeof Database> | null = null;
  private readonly listeners = new Map<string, Array<(event: ActivityRecord) => void>>();

  /** Initialise with an open SQLite database. Must be called once at startup. */
  init(db: InstanceType<typeof Database>): void {
    this.db = db;
    runActivityMigrations(db);
  }

  /**
   * Emit a single activity event.
   * Writes to SQLite (best-effort) and notifies in-memory listeners.
   * NEVER throws — failures are logged at WARN level.
   *
   * @returns The generated UUID for the event.
   */
  emit(event: ActivityEvent): string {
    const id = randomUUID();
    const record: ActivityRecord = {
      ...event,
      id,
      timestamp: new Date().toISOString(),
      severity:  event.severity  ?? "info",
      division:  event.division  ?? "default",
      source:    event.source    ?? "internal",
      details:   event.details   ?? {},
      metadata:  event.metadata  ?? {},
    };

    // Best-effort SQLite write — NEVER block or throw to caller
    if (this.db !== null) {
      try {
        this.db.prepare<unknown[], void>(
          `INSERT INTO activity_events
             (id, timestamp, event_type, category, agent_id, division, user_id,
              severity, title, details, metadata, source, parent_id, session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.id,
          record.timestamp,
          record.event_type,
          record.category,
          record.agent_id  ?? null,
          record.division,
          record.user_id   ?? null,
          record.severity,
          record.title,
          JSON.stringify(record.details),
          JSON.stringify(record.metadata),
          record.source,
          record.parent_id  ?? null,
          record.session_id ?? null,
        );
      } catch (err: unknown) {
        logger.warn(
          "activity_write_failed",
          "Activity event write failed (non-fatal)",
          { metadata: { error: err instanceof Error ? err.message : String(err) } },
        );
      }
    }

    // Notify listeners (fire-and-forget — errors are swallowed)
    this._notifyListeners(record);

    return id;
  }

  /** Emit multiple events atomically in a single transaction. */
  emitBatch(events: ActivityEvent[]): string[] {
    if (events.length === 0) return [];

    const ids: string[]              = [];
    const records: ActivityRecord[]  = [];

    for (const event of events) {
      const id = randomUUID();
      ids.push(id);
      records.push({
        ...event,
        id,
        timestamp: new Date().toISOString(),
        severity:  event.severity  ?? "info",
        division:  event.division  ?? "default",
        source:    event.source    ?? "internal",
        details:   event.details   ?? {},
        metadata:  event.metadata  ?? {},
      });
    }

    // Bulk insert in a single transaction (best-effort — never throws to caller)
    if (this.db !== null) {
      try {
        const insert = this.db.prepare<unknown[], void>(
          `INSERT INTO activity_events
             (id, timestamp, event_type, category, agent_id, division, user_id,
              severity, title, details, metadata, source, parent_id, session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.db.transaction(() => {
          for (const r of records) {
            insert.run(
              r.id, r.timestamp, r.event_type, r.category,
              r.agent_id ?? null, r.division, r.user_id ?? null,
              r.severity, r.title,
              JSON.stringify(r.details), JSON.stringify(r.metadata),
              r.source, r.parent_id ?? null, r.session_id ?? null,
            );
          }
        })();
      } catch (err: unknown) {
        logger.warn(
          "activity_batch_write_failed",
          `Batch write of ${events.length} events failed (non-fatal)`,
          { metadata: { error: err instanceof Error ? err.message : String(err), count: events.length } },
        );
      }
    }

    for (const record of records) {
      this._notifyListeners(record);
    }

    return ids;
  }

  /**
   * Subscribe to activity events.
   *
   * Supported key formats:
   *  - Exact event_type:     "task.created"
   *  - Category prefix:      "category:task"
   *  - Wildcard (all):       "*"
   *
   * Multiple callbacks per key are allowed.
   */
  on(key: string, callback: (event: ActivityRecord) => void): void {
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key)!.push(callback);
  }

  /** Remove a specific callback for a key. */
  off(key: string, callback: (event: ActivityRecord) => void): void {
    const cbs = this.listeners.get(key);
    if (!cbs) return;
    const idx = cbs.indexOf(callback);
    if (idx !== -1) cbs.splice(idx, 1);
  }

  /**
   * Query stored activity events with optional filters.
   * Returns [] when DB is not initialised or on error.
   */
  query(filters: ActivityFilters): ActivityRecord[] {
    if (this.db === null) return [];
    try {
      const { sql, params } = this._buildQuery(filters);
      const rows = this.db.prepare<unknown[], Record<string, unknown>>(sql).all(...params);
      return rows.map(this._rowToRecord);
    } catch (err: unknown) {
      logger.warn(
        "activity_query_failed",
        "Activity query failed",
        { metadata: { error: err instanceof Error ? err.message : String(err) } },
      );
      return [];
    }
  }

  /** Count events matching the given filters. Returns 0 on error. */
  count(filters: ActivityFilters): number {
    if (this.db === null) return 0;
    try {
      const { sql, params } = this._buildQuery(filters, true);
      const row = this.db.prepare<unknown[], { cnt: number }>(sql).get(...params);
      return row?.cnt ?? 0;
    } catch (_e) {
      return 0;
    }
  }

  /**
   * Return a bucketed timeline for charting.
   * Groups events by time bucket and category.
   */
  getTimeline(
    filters: ActivityFilters & { granularity: "hour" | "day" | "week" },
  ): TimelineEntry[] {
    if (this.db === null) return [];

    const fmt =
      filters.granularity === "hour" ? "%Y-%m-%d %H:00"
      : filters.granularity === "week" ? "%Y-W%W"
      : "%Y-%m-%d";

    const wheres: string[] = [];
    const params: unknown[] = [];
    if (filters.since)    { wheres.push("timestamp >= ?"); params.push(filters.since); }
    if (filters.until)    { wheres.push("timestamp <= ?"); params.push(filters.until); }
    if (filters.division) { wheres.push("division = ?");   params.push(filters.division); }
    if (filters.agent_id) { wheres.push("agent_id = ?");   params.push(filters.agent_id); }

    const where = wheres.length > 0 ? "WHERE " + wheres.join(" AND ") : "";
    const sql = `
      SELECT strftime('${fmt}', timestamp) AS bucket, category, COUNT(*) AS cnt
      FROM activity_events ${where}
      GROUP BY bucket, category
      ORDER BY bucket
    `;

    try {
      const rows = this.db
        .prepare<unknown[], { bucket: string; category: string; cnt: number }>(sql)
        .all(...params);

      const map = new Map<string, TimelineEntry>();
      for (const row of rows) {
        if (!map.has(row.bucket)) {
          map.set(row.bucket, { bucket: row.bucket, count: 0, categories: {} });
        }
        const entry = map.get(row.bucket)!;
        entry.count += row.cnt;
        entry.categories[row.category as ActivityCategory] = row.cnt;
      }
      return Array.from(map.values());
    } catch (_e) {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _notifyListeners(record: ActivityRecord): void {
    try {
      const exact    = this.listeners.get(record.event_type) ?? [];
      const category = this.listeners.get("category:" + record.category) ?? [];
      const wildcard = this.listeners.get("*") ?? [];
      for (const cb of [...exact, ...category, ...wildcard]) {
        try { cb(record); } catch (_) { /* swallow listener errors */ }
      }
    } catch (_) { /* swallow */ }
  }

  private _rowToRecord(row: Record<string, unknown>): ActivityRecord {
    return {
      id:         row["id"] as string,
      timestamp:  row["timestamp"] as string,
      event_type: row["event_type"] as string,
      category:   row["category"] as ActivityCategory,
      agent_id:   (row["agent_id"] as string | null) ?? undefined,
      division:   row["division"] as string,
      user_id:    (row["user_id"] as string | null) ?? undefined,
      severity:   row["severity"] as ActivityRecord["severity"],
      title:      row["title"] as string,
      details:    JSON.parse((row["details"] as string) || "{}") as Record<string, unknown>,
      metadata:   JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
      source:     row["source"] as ActivityRecord["source"],
      parent_id:  (row["parent_id"] as string | null) ?? undefined,
      session_id: (row["session_id"] as string | null) ?? undefined,
    };
  }

  private _buildQuery(
    filters: ActivityFilters,
    countOnly = false,
  ): { sql: string; params: unknown[] } {
    const wheres: string[] = [];
    const params: unknown[] = [];

    if (filters.since)      { wheres.push("timestamp >= ?");  params.push(filters.since); }
    if (filters.until)      { wheres.push("timestamp <= ?");  params.push(filters.until); }
    if (filters.category)   { wheres.push("category = ?");    params.push(filters.category); }
    if (filters.agent_id)   { wheres.push("agent_id = ?");    params.push(filters.agent_id); }
    if (filters.division)   { wheres.push("division = ?");    params.push(filters.division); }
    if (filters.severity)   { wheres.push("severity = ?");    params.push(filters.severity); }
    if (filters.source)     { wheres.push("source = ?");      params.push(filters.source); }
    if (filters.event_type) { wheres.push("event_type = ?");  params.push(filters.event_type); }
    if (filters.session_id) { wheres.push("session_id = ?");  params.push(filters.session_id); }

    const where = wheres.length > 0 ? "WHERE " + wheres.join(" AND ") : "";

    if (countOnly) {
      return { sql: `SELECT COUNT(*) AS cnt FROM activity_events ${where}`, params };
    }

    const limit  = filters.limit  ?? 100;
    const offset = filters.offset ?? 0;
    return {
      sql:    `SELECT * FROM activity_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      params: [...params, limit, offset],
    };
  }
}


/** Module-level singleton. Call `activityEmitter.init(db)` once at startup. */
export const activityEmitter = new ActivityEmitter();
