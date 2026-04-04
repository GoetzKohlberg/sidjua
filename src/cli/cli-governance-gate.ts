// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — CLI Governance Gate
 *
 * Establishes a real caller identity for security-sensitive CLI operations
 * so that audit trails carry the actual OS user rather than synthetic IDs.
 *
 * CLI commands bypass API auth/RBAC middleware (they open the DB directly),
 * so this module provides the equivalent of CallerContext for CLI paths:
 *   - Real OS username from os.userInfo()
 *   - Role read from workspace_config ("cli_default_role"), default "operator"
 *   - Audit persistence to cli_audit_log (best-effort, non-fatal)
 *
 * Usage:
 *   const ctx = getCliCallerContext(db);
 *   auditCliAccess(ctx, "secret:reveal", "ns/key", db);
 */

import { userInfo }       from "node:os";
import { createLogger }   from "../core/logger.js";
import type BetterSqlite3 from "better-sqlite3";

const logger = createLogger("cli-governance-gate");

/** Allowed CLI roles — mirrors API CallerContext roles. */
export type CliRole = "admin" | "operator" | "readonly";

/**
 * Caller context for CLI commands.
 * Equivalent of the API's CallerContext but derived from OS identity.
 */
export interface CliCallerContext {
  /** Real OS username (from os.userInfo() or env fallback). */
  username: string;
  /** Role assigned to this CLI caller (from workspace_config or default). */
  role:     CliRole;
  /** Always "cli" — distinguishes from API token callers in audit logs. */
  source:   "cli";
}

/**
 * Resolve the real OS username.
 * Falls back through env vars if os.userInfo() throws (e.g. in containers
 * where the UID has no /etc/passwd entry).
 */
export function getOsUsername(): string {
  try {
    const name = userInfo().username;
    if (name && name !== "") return name;
  } catch (_err: unknown) {
    // Ignore — fall through to env fallback
  }
  return process.env["USER"] ?? process.env["USERNAME"] ?? process.env["LOGNAME"] ?? "cli-unknown";
}

/**
 * Build a CliCallerContext for the current process.
 *
 * @param db  Optional open database to read workspace_config from.
 *            If null/undefined, the default role "operator" is used.
 */
export function getCliCallerContext(
  db?: InstanceType<typeof BetterSqlite3> | null,
): CliCallerContext {
  const username = getOsUsername();

  let role: CliRole = "operator"; // safe default

  if (db !== null && db !== undefined) {
    try {
      const row = db
        .prepare<[string], { value: string }>(
          "SELECT value FROM workspace_config WHERE key = ?",
        )
        .get("cli_default_role") as { value: string } | undefined;

      if (row?.value === "admin" || row?.value === "operator" || row?.value === "readonly") {
        role = row.value;
      }
    } catch (_err: unknown) {
      // workspace_config may not exist yet (pre-apply) — use default
    }
  }

  return { username, role, source: "cli" };
}

/**
 * Write a CLI governance audit entry.
 *
 * Writes to:
 *   1. The structured logger (always)
 *   2. cli_audit_log table in the provided DB (best-effort, non-fatal)
 *
 * @param ctx      Caller context (from getCliCallerContext)
 * @param action   Action key, e.g. "secret:reveal", "token:create"
 * @param details  Optional detail string (e.g. resource path)
 * @param db       Optional open database for persistence
 */
export function auditCliAccess(
  ctx:     CliCallerContext,
  action:  string,
  details?: string,
  db?:     InstanceType<typeof BetterSqlite3> | null,
): void {
  const timestamp = new Date().toISOString();

  logger.info(
    "cli_governance_access",
    `CLI access: ${action} by ${ctx.username} (${ctx.role})`,
    {
      metadata: {
        username:  ctx.username,
        role:      ctx.role,
        action,
        ...(details !== undefined ? { details } : {}),
        timestamp,
      },
    },
  );

  if (db === null || db === undefined) return;

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cli_audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        command    TEXT NOT NULL,
        subcommand TEXT NOT NULL DEFAULT '',
        username   TEXT NOT NULL DEFAULT 'unknown',
        sensitive  INTEGER NOT NULL DEFAULT 0,
        timestamp  TEXT NOT NULL
      )
    `);

    // Split action into command/subcommand for compatibility with existing schema
    const colonIdx   = action.indexOf(":");
    const command    = colonIdx >= 0 ? action.slice(0, colonIdx) : action;
    const subcommand = colonIdx >= 0 ? action.slice(colonIdx + 1) : "";

    db.prepare<[string, string, string, string], void>(
      `INSERT INTO cli_audit_log (command, subcommand, username, sensitive, timestamp)
       VALUES (?, ?, ?, 1, ?)`,
    ).run(command, subcommand, ctx.username, timestamp);
  } catch (_err: unknown) {
    // Non-fatal — audit logging must never break the CLI
  }
}
