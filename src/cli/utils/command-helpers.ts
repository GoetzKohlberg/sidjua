// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Shared CLI command utilities.
 *
 * Consolidates the three patterns duplicated across most CLI command files:
 *
 *   1. withCliDb / withCliDbAsync  — DB lifecycle wrapper (re-exported from
 *      with-cli-database.ts for a single import point).
 *
 *   2. formatCliTable              — Columnar table output to stdout.
 *
 *   3. cliErrorHandler             — Consistent error formatting + process.exit(1).
 *
 * Usage:
 *   import { withCliDbAsync, formatCliTable, cliErrorHandler } from "../utils/command-helpers.js";
 */

export {
  withCliDatabase  as withCliDb,
  withCliDatabaseAsync as withCliDbAsync,
} from "./with-cli-database.js";


// ---------------------------------------------------------------------------
// formatCliTable
// ---------------------------------------------------------------------------

/**
 * Render an array of records as a fixed-width table and write it to stdout.
 *
 * Each `column` entry is a key name; the column width is the maximum of the
 * header label width and the widest value in that column.
 *
 * @param rows    Data rows — each is a plain object; missing keys render as "".
 * @param columns Column key names (used as the header label).
 *
 * @example
 * formatCliTable(
 *   [{ id: "agent-1", status: "active" }, { id: "agent-2", status: "idle" }],
 *   ["id", "status"],
 * );
 * // ID       STATUS
 * // ──────── ──────
 * // agent-1  active
 * // agent-2  idle
 */
export function formatCliTable(
  rows:    Record<string, unknown>[],
  columns: string[],
): void {
  if (columns.length === 0) return;

  // Compute column widths: max(header length, max cell length)
  const widths = columns.map((col) => {
    const headerLen = col.toUpperCase().length;
    const maxVal    = rows.reduce<number>((acc, row) => {
      const cell = String(row[col] ?? "");
      return Math.max(acc, cell.length);
    }, 0);
    return Math.max(headerLen, maxVal);
  });

  const header    = columns.map((col, i) => col.toUpperCase().padEnd(widths[i] ?? 0)).join("  ");
  const separator = widths.map((w) => "─".repeat(w)).join("  ");

  process.stdout.write(header    + "\n");
  process.stdout.write(separator + "\n");

  for (const row of rows) {
    const line = columns
      .map((col, i) => String(row[col] ?? "").padEnd(widths[i] ?? 0))
      .join("  ");
    process.stdout.write(line + "\n");
  }
}


// ---------------------------------------------------------------------------
// cliErrorHandler
// ---------------------------------------------------------------------------

/**
 * Write a formatted error message to stderr and exit with code 1.
 *
 * Replaces the repetitive pattern:
 * ```
 * process.stderr.write(`Error: ${String(e)}\n`);
 * process.exit(1);
 * ```
 *
 * @param error    The caught error value (any type).
 * @param context  Optional context string prepended to the message.
 *                 E.g. "secret set" → "secret set: <message>"
 * @returns        `never` — always exits.
 */
export function cliErrorHandler(error: unknown, context?: string): never {
  const message = error instanceof Error ? error.message : String(error);
  const prefix  = context !== undefined ? `${context}: ` : "";
  process.stderr.write(`Error: ${prefix}${message}\n`);
  process.exit(1);
}
