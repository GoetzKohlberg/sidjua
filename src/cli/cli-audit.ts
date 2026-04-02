// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — CLI Audit Logger
 *
 * Lightweight audit logger for security-sensitive CLI operations.
 * Writes to the logger (structured log) and optionally to a SQLite table.
 *
 * Security-sensitive operations bypass API middleware (auth, RBAC, rate limiting)
 * because the CLI opens the database directly. This module ensures those
 * operations are logged for security review.
 */

import { createLogger } from "../core/logger.js";

const logger = createLogger("cli-audit");

export interface CliAuditEntry {
  command:    string;
  subcommand: string;
  user:       string;
  sensitive:  boolean;
  timestamp:  string;
}

/** Commands that bypass API auth/RBAC — must be audited. */
export const SENSITIVE_CLI_COMMANDS = new Set([
  "token:create",
  "token:list",
  "token:revoke",
  "secret:set",
  "secret:delete",
  "secret:reveal",
  "governance:set",
  "governance:delete",
  "api-key:rotate",
  "api-key:disable-bootstrap",
  "apply",
  "start-over",
]);

/** Stderr warning printed before sensitive CLI operations. */
export const SENSITIVE_CLI_WARNING =
  "WARNING: This command bypasses API middleware (auth, RBAC, rate limiting). " +
  "The operation is logged to cli_audit_log. Use API tokens for production.";

/**
 * Log a CLI command invocation.
 * Non-fatal — errors are swallowed so audit logging never breaks the CLI.
 *
 * @param command     Top-level CLI command name (e.g. "tokens")
 * @param subcommand  Sub-command name (e.g. "create"), or undefined
 * @param db          Optional open SQLite database for persistence
 */
export function auditCliCommand(
  command:    string,
  subcommand: string | undefined,
  db?:        import("better-sqlite3").Database | null,
): void {
  const key = subcommand ? `${command}:${subcommand}` : command;
  const sensitive = SENSITIVE_CLI_COMMANDS.has(key);

  const entry: CliAuditEntry = {
    command,
    subcommand: subcommand ?? "",
    user:       process.env["USER"] ?? process.env["USERNAME"] ?? "unknown",
    sensitive,
    timestamp:  new Date().toISOString(),
  };

  if (sensitive) {
    logger.warn("cli_audit", `SENSITIVE CLI operation: ${key}`, { metadata: entry as unknown as Record<string, unknown> });
    process.stderr.write(`${SENSITIVE_CLI_WARNING}\n`);
  } else {
    logger.info("cli_audit", `CLI operation: ${key}`, { metadata: entry as unknown as Record<string, unknown> });
  }

  // Persist to DB if available (best-effort — non-fatal)
  if (db !== null && db !== undefined) {
    try {
      ensureCliAuditTable(db);
      db.prepare<[string, string, string, number, string], void>(
        `INSERT INTO cli_audit_log (command, subcommand, username, sensitive, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(entry.command, entry.subcommand, entry.user, entry.sensitive ? 1 : 0, entry.timestamp);
    } catch (_e) {
      // Non-fatal — audit logging must never break CLI
    }
  }
}

/**
 * Ensure the cli_audit_log table exists.
 * Safe to call multiple times (idempotent).
 */
export function ensureCliAuditTable(db: import("better-sqlite3").Database): void {
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
}
