// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Unified SQLite open helper
 *
 * Consolidates CLI and utility open patterns into one place:
 *
 *   openSafeDatabase(path)                             — read-write + safety PRAGMAs
 *   openSafeDatabase(path, { readonly: true })         — read-only connection
 *   openSafeDatabase(path, { fileMustExist: true })    — throws if file missing
 *
 * For read-write databases, `enforceSQLiteSafety()` is called automatically
 * (WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON).
 * For read-only databases, write-mode PRAGMAs are intentionally skipped.
 * For in-memory databases (':memory:'), use `openDatabase()` in src/utils/db.ts.
 */

import BetterSQLite3, { type Database } from "better-sqlite3";
import { existsSync, mkdirSync }        from "node:fs";
import { dirname }                      from "node:path";
import { enforceSQLiteSafety }          from "./sqlite-safety.js";

export type { Database } from "better-sqlite3";

export interface SafeOpenOptions {
  readonly?:      boolean;
  fileMustExist?: boolean;
}

/**
 * Open a SQLite database at `dbPath` with consistent safety defaults.
 *
 * - Read-write (default): creates missing parent directories; enforces
 *   WAL journal mode, busy_timeout, synchronous=NORMAL, and foreign_keys.
 * - Read-only (`readonly: true`): skips write-mode PRAGMAs entirely.
 * - `fileMustExist: true`: throws if the database file does not exist.
 */
export function openSafeDatabase(dbPath: string, options?: SafeOpenOptions): Database {
  const readonly      = options?.readonly      ?? false;
  const fileMustExist = options?.fileMustExist ?? false;

  if (!readonly && !fileMustExist) {
    const parent = dirname(dbPath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
  }

  const db = new BetterSQLite3(dbPath, {
    ...(readonly      ? { readonly: true }      : {}),
    ...(fileMustExist ? { fileMustExist: true }  : {}),
  });

  if (!readonly) {
    enforceSQLiteSafety(db);
  }

  return db;
}
