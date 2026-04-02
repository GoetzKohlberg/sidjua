// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Freeze/Resume Audit Log
 *
 * Persists a tamper-evident audit trail of every freeze and resume cycle
 * to SQLite.  Entries are never updated in place — each event appends a
 * new row so the history is append-only.
 *
 * Table: agent_freeze_audit
 *   id         — monotonic INTEGER PRIMARY KEY (rowid alias)
 *   event      — "freeze_requested" | "frozen" | "resume_requested" | "resumed"
 *   triggered_by — free-form string (e.g. "sidecar", "user:<id>", "startup")
 *   active_agents — agent count at the time of the event
 *   timestamp  — ISO 8601 UTC string
 */

import type { Database } from "better-sqlite3";
import { createLogger }  from "../logger.js";

const logger = createLogger("freeze-audit");

export type FreezeAuditEvent =
  | "freeze_requested"
  | "frozen"
  | "resume_requested"
  | "resumed";

export interface FreezeAuditEntry {
  id?:           number;
  event:         FreezeAuditEvent;
  triggeredBy:   string;
  activeAgents:  number;
  timestamp:     string;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS agent_freeze_audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event         TEXT NOT NULL,
    triggered_by  TEXT NOT NULL,
    active_agents INTEGER NOT NULL DEFAULT 0,
    timestamp     TEXT NOT NULL
  )
`;

/** Maximum rows to retain — older rows are pruned by cleanupFreezeAudit(). */
const MAX_AUDIT_ROWS = 1000;

let _db: Database | null = null;

/** Wire in the database handle (called during app init). */
export function wireFreezeAuditDb(db: Database): void {
  _db = db;
  db.exec(DDL);
}

/**
 * Append a freeze audit entry.  Non-fatal — logs a warning on DB failure.
 */
export function logFreezeAudit(entry: Omit<FreezeAuditEntry, "id">): void {
  if (_db === null) {
    logger.warn("freeze-audit", "DB not wired — skipping audit entry", {
      metadata: { event: entry.event },
    });
    return;
  }

  try {
    _db.prepare<[string, string, number, string], void>(`
      INSERT INTO agent_freeze_audit (event, triggered_by, active_agents, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(entry.event, entry.triggeredBy, entry.activeAgents, entry.timestamp);
  } catch (err: unknown) {
    logger.warn("freeze-audit", "Failed to write freeze audit entry", {
      metadata: {
        event: entry.event,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/**
 * Remove rows beyond MAX_AUDIT_ROWS, keeping the most recent entries.
 * Safe to call periodically (e.g. on resume) — idempotent.
 */
export function cleanupFreezeAudit(): void {
  if (_db === null) return;

  try {
    _db.prepare<[], void>(`
      DELETE FROM agent_freeze_audit
      WHERE id NOT IN (
        SELECT id FROM agent_freeze_audit
        ORDER BY id DESC
        LIMIT ${MAX_AUDIT_ROWS}
      )
    `).run();
  } catch (err: unknown) {
    logger.warn("freeze-audit", "Failed to prune freeze audit log", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Load the most recent audit entries (newest first).
 * Returns up to `limit` rows (default 50).
 */
export function loadFreezeAudit(limit = 50): FreezeAuditEntry[] {
  if (_db === null) return [];

  try {
    const rows = _db.prepare<[number], Record<string, unknown>>(`
      SELECT id, event, triggered_by, active_agents, timestamp
      FROM agent_freeze_audit
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      ...(typeof row["id"] === "number" ? { id: row["id"] } : {}),
      event:        typeof row["event"]          === "string" ? row["event"] as FreezeAuditEvent     : "frozen",
      triggeredBy:  typeof row["triggered_by"]   === "string" ? row["triggered_by"]                  : "unknown",
      activeAgents: typeof row["active_agents"]  === "number" ? row["active_agents"]                 : 0,
      timestamp:    typeof row["timestamp"]      === "string" ? row["timestamp"]                     : new Date().toISOString(),
    }));
  } catch (err: unknown) {
    logger.warn("freeze-audit", "Failed to load freeze audit log", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }
}

/** Reset DB handle — for tests only. */
export function _resetFreezeAuditDb(): void {
  _db = null;
}
