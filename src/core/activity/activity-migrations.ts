// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: Database Migrations
 *
 * Creates activity_events and activity_digests tables.
 * Idempotent — safe to call on every command invocation.
 */

import type Database from "better-sqlite3";


/**
 * Idempotently create the activity stream tables and indexes.
 * Follows the same pattern as runAuditMigrations().
 */
export function runActivityMigrations(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_events (
      id          TEXT    PRIMARY KEY,
      timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
      event_type  TEXT    NOT NULL,
      category    TEXT    NOT NULL,
      agent_id    TEXT,
      division    TEXT    NOT NULL DEFAULT 'default',
      user_id     TEXT,
      severity    TEXT    NOT NULL DEFAULT 'info'
                          CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
      title       TEXT    NOT NULL,
      details     TEXT    NOT NULL DEFAULT '{}',
      metadata    TEXT    NOT NULL DEFAULT '{}',
      source      TEXT    NOT NULL DEFAULT 'internal'
                          CHECK (source IN ('internal', 'webhook', 'system', 'user')),
      parent_id   TEXT,
      session_id  TEXT,
      FOREIGN KEY (parent_id) REFERENCES activity_events(id)
    );

    CREATE INDEX IF NOT EXISTS idx_activity_ts       ON activity_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_activity_type     ON activity_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_activity_category ON activity_events(category);
    CREATE INDEX IF NOT EXISTS idx_activity_agent    ON activity_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_activity_division ON activity_events(division);
    CREATE INDEX IF NOT EXISTS idx_activity_severity ON activity_events(severity);
    CREATE INDEX IF NOT EXISTS idx_activity_source   ON activity_events(source);
    CREATE INDEX IF NOT EXISTS idx_activity_session  ON activity_events(session_id);

    CREATE TABLE IF NOT EXISTS activity_digests (
      id           TEXT    PRIMARY KEY,
      digest_type  TEXT    NOT NULL
                           CHECK (digest_type IN ('daily', 'weekly', 'project', 'agent', 'division')),
      scope_id     TEXT,
      period_start TEXT    NOT NULL,
      period_end   TEXT    NOT NULL,
      generated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      summary      TEXT    NOT NULL,
      stats        TEXT    NOT NULL DEFAULT '{}',
      delivered_to TEXT    NOT NULL DEFAULT '[]',
      event_count  INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_digest_type   ON activity_digests(digest_type);
    CREATE INDEX IF NOT EXISTS idx_digest_period ON activity_digests(period_start, period_end);
    CREATE INDEX IF NOT EXISTS idx_digest_scope  ON activity_digests(scope_id);
  `);
}
