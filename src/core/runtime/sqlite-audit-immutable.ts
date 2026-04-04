// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Immutable Audit Log Triggers
 *
 * Installs SQLite BEFORE UPDATE / BEFORE DELETE triggers on the audit_events
 * table so that no agent (including T1) can tamper with audit records.
 * Idempotent: uses CREATE TRIGGER IF NOT EXISTS.
 *
 * Call once after runAuditMigrations() during DB initialisation.
 */

import type Database from "better-sqlite3";
import { createLogger } from "../logger.js";

const logger = createLogger("audit-immutable");

const AUDIT_TABLE = "audit_events";

// ---------------------------------------------------------------------------
// installImmutableAuditTriggers
// ---------------------------------------------------------------------------

/**
 * Install BEFORE UPDATE and BEFORE DELETE triggers on audit_events.
 * Any attempt to modify or delete a row will raise an ABORT error.
 * Idempotent — safe to call on every server start.
 */
export function installImmutableAuditTriggers(
  db: InstanceType<typeof Database>,
): void {
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS audit_immutable_update
        BEFORE UPDATE ON ${AUDIT_TABLE}
        BEGIN
          SELECT RAISE(ABORT, 'audit records are immutable — updates are not permitted');
        END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS audit_immutable_delete
        BEFORE DELETE ON ${AUDIT_TABLE}
        BEGIN
          SELECT RAISE(ABORT, 'audit records are immutable — deletions are not permitted');
        END;
    `);

    logger.info("audit-immutable", "Immutable audit triggers installed", {
      metadata: { table: AUDIT_TABLE },
    });
  } catch (err: unknown) {
    // Non-fatal: table may not exist yet on first-ever startup before migrations.
    // Migrations run before this in server-startup.ts so this should be rare.
    logger.warn("audit-immutable", "Could not install audit triggers", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ---------------------------------------------------------------------------
// verifyImmutableAuditTriggers
// ---------------------------------------------------------------------------

/**
 * Verify that both immutable triggers are present and active.
 * Used in health checks.
 */
export function verifyImmutableAuditTriggers(
  db: InstanceType<typeof Database>,
): { update: boolean; delete: boolean } {
  try {
    const rows = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger'
           AND name IN ('audit_immutable_update', 'audit_immutable_delete')`,
      )
      .all();
    const names = new Set(rows.map((r) => r.name));
    return {
      update: names.has("audit_immutable_update"),
      delete: names.has("audit_immutable_delete"),
    };
  } catch (_err: unknown) {
    return { update: false, delete: false };
  }
}
