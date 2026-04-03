// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — SQLite Safety Enforcement
 *
 * Enforces mandatory SQLite PRAGMAs on every database handle:
 *   WAL journal mode    — concurrent readers, single writer, crash-safe
 *   synchronous=NORMAL  — safe with WAL, avoids fsync on every commit
 *   busy_timeout=5000   — wait up to 5s for a locked page before SQLITE_BUSY
 *   foreign_keys=ON     — enforces referential integrity
 *
 * Call immediately after opening any SQLite database.
 * `openDatabase()` in src/utils/db.ts calls this automatically.
 */

import type { Database } from "better-sqlite3";
import { createLogger }  from "../logger.js";

const logger = createLogger("sqlite-safety");

/**
 * Enforce mandatory SQLite PRAGMAs.
 * Throws if WAL mode cannot be set (e.g. read-only filesystem).
 */
export function enforceSQLiteSafety(db: Database): void {
  // WAL mode must be set first — other PRAGMAs are harmless regardless.
  const walResult = db.pragma("journal_mode=WAL") as Array<{ journal_mode: string }>;
  const journalMode = walResult?.[0]?.journal_mode;
  if (journalMode !== "wal") {
    throw new Error(
      `Failed to set WAL journal mode — got '${journalMode ?? "unknown"}'. ` +
      `Check that the database file is on a filesystem that supports WAL.`,
    );
  }

  db.pragma("synchronous=NORMAL");
  db.pragma("busy_timeout=5000");
  db.pragma("foreign_keys=ON");

  const synchronous   = (db.pragma("synchronous") as Array<{ synchronous: number }>)?.[0]?.synchronous;
  const busyTimeout   = (db.pragma("busy_timeout") as Array<{ timeout: number }>)?.[0]?.timeout;

  logger.debug("sqlite-safety", "SQLite safety PRAGMAs enforced", {
    metadata: { journalMode, synchronous, busyTimeout },
  });
}
