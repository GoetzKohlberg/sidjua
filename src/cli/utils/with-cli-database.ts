// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — CLI database lifecycle wrappers.
 *
 * Eliminates the open / null-check / try-finally / close boilerplate
 * that appears in every CLI command that needs a SQLite connection.
 *
 * ## Usage
 *
 * ### Sync command
 * ```ts
 * export function runMyCommand(opts: Opts): number {
 *   return withCliDatabase({ workDir: opts.workDir }, (db) => {
 *     // ... use db ...
 *     return 0;
 *   });
 * }
 * ```
 *
 * ### Async command
 * ```ts
 * export async function runMyCommand(opts: Opts): Promise<number> {
 *   return withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
 *     // ... use db ...
 *     return 0;
 *   });
 * }
 * ```
 *
 * The wrapper guarantees `db.close()` is called even when the callback
 * throws or returns early. The caller MUST NOT close the DB itself.
 */

import type Database from "better-sqlite3";
import { openCliDatabase, type CliDbOptions } from "./db-init.js";


/**
 * Open the CLI database, run a synchronous callback, and close the DB.
 *
 * @returns The exit code returned by `fn`, or `1` if the DB could not be opened.
 */
export function withCliDatabase(
  opts: CliDbOptions,
  fn: (db: InstanceType<typeof Database>) => number,
): number {
  const db = openCliDatabase(opts);
  if (db === null) return 1;
  try {
    return fn(db);
  } finally {
    db.close();
  }
}


/**
 * Open the CLI database, run an async callback, and close the DB.
 *
 * @returns A Promise resolving to the exit code returned by `fn`,
 *          or `1` if the DB could not be opened.
 */
export async function withCliDatabaseAsync(
  opts: CliDbOptions,
  fn: (db: InstanceType<typeof Database>) => Promise<number>,
): Promise<number> {
  const db = openCliDatabase(opts);
  if (db === null) return 1;
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
