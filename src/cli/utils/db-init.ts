// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Shared CLI database initialisation helper.
 *
 * Eliminates boilerplate from every CLI command that needs to open the DB.
 *
 * Also exports hasTable() for pre-flight schema checks in routes and commands,
 * replacing fragile "no such table" error-message matching.
 *
 * ## DB Connection Lifecycle
 *
 * ### Ownership
 * The caller owns the returned connection and MUST close it.
 * `openCliDatabase` never holds a reference after returning.
 *
 * ### When to open
 * Open exactly once per CLI invocation, before the first DB read or write.
 * Do NOT re-open mid-command (use a single connection for the full command).
 *
 * ### When to close
 * Close in a `finally` block after ALL async work that uses the DB completes:
 *
 *   ```typescript
 *   const db = openCliDatabase({ workDir });
 *   if (!db) return 1;
 *   try {
 *     // ... all DB operations, including any await-ed polling loops ...
 *     exitCode = await doWork(db);
 *   } finally {
 *     db.close();           // runs after awaits resolve, not while they're pending
 *   }
 *   return exitCode;
 *   ```
 *
 * ### Anti-patterns
 * - `return await somePoller(store)` inside try/finally is safe because the
 *   finally runs after the awaited promise resolves — but an explicit
 *   `exitCode` variable is preferred for clarity (see run.ts).
 * - Never pass `process.cwd()` to DB path helpers — use `opts.workDir` so
 *   commands work correctly when the CWD differs from the workspace root.
 */

import { existsSync } from "node:fs";
import { join }       from "node:path";
import { openDatabase }      from "../../utils/db.js";
import { openSafeDatabase }  from "../../core/db/safe-open.js";
import { PHASE9_SCHEMA_SQL } from "../../orchestrator/types.js";
import { TOKEN_SCHEMA_SQL }  from "../../api/token-store.js";
import { runKnowledgeMigrations } from "../../knowledge-pipeline/migration.js";
import { validateWorkDir }    from "../../utils/path-utils.js";
import Database from "better-sqlite3";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("db-init");


export interface CliDbOptions {
  workDir:    string;
  /** Prevent any writes — set true for read-only commands. Default: false */
  queryOnly?: boolean;
}


/**
 * Open the SIDJUA SQLite database for a CLI command.
 *
 * - Prints an actionable error to stderr and returns `null` when the DB file
 *   does not exist (run `sidjua apply` first).
 * - Enables WAL mode.
 * - Applies the Phase 9 schema idempotently (no-op if already up to date).
 *
 * @returns The open database, or `null` on failure (caller should `return 1`).
 */
export function openCliDatabase(opts: CliDbOptions): InstanceType<typeof Database> | null {
  validateWorkDir(opts.workDir);

  const dbFile = join(opts.workDir, ".system", "sidjua.db");

  if (!existsSync(dbFile)) {
    process.stderr.write("✗ Database not found. Run 'sidjua apply' first.\n");
    return null;
  }

  // openDatabase() already calls enforceSQLiteSafety() (WAL, busy_timeout, etc.)
  const db = openDatabase(dbFile);

  if (opts.queryOnly) {
    // Open a separate read-only connection instead of toggling query_only on an
    // existing read-write connection — toggling has known reliability issues with WAL.
    db.close();
    return openSafeDatabase(dbFile, { readonly: true });
  }

  // Fast-path: if both schema families are already present, skip the exclusive
  // init lock entirely.  This eliminates per-CLI-invocation lock contention on
  // long-running deployments where schema is stable.
  const schemaPresent = (): boolean => {
    const check = db.prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('task_events','api_tokens')",
    ).get();
    return (check?.n ?? 0) >= 2;
  };

  if (!schemaPresent()) {
    // Apply schema inside a BEGIN EXCLUSIVE transaction.
    // Retry once immediately if the first attempt fails.
    // If the retry also fails, close the DB and throw — fail-secure.
    const applySchema = (): void => {
      db.transaction(() => {
        db.exec(PHASE9_SCHEMA_SQL);
        db.exec(TOKEN_SCHEMA_SQL);
      }).exclusive();
    };

    try {
      applySchema();
    } catch (e: unknown) {
      logger.warn("db-init", "Schema init failed — table may exist with different structure; retrying once", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
      // Retry immediately. busy_timeout=5000 (set above) causes better-sqlite3
      // to wait up to 5 s on SQLITE_BUSY before throwing, so a spin delay
      // between retries adds no value and blocks the event loop. A second
      // synchronous attempt covers the narrow window where the EXCLUSIVE
      // transaction races with a concurrent schema init from another process.
      try {
        applySchema();
      } catch (e2: unknown) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        logger.error("db-init", "Schema init failed after retry — aborting", {
          metadata: { error: msg },
        });
        db.close();
        throw new Error(`Database schema initialisation failed: ${msg}`);
      }
    }
  }

  return db;
}


/**
 * Open the SIDJUA SQLite database and apply knowledge-pipeline migrations.
 *
 * Consolidates the identical `openDb()` wrappers that existed in
 * `cli-knowledge.ts` and `memory.ts`.
 */
export function openKnowledgeDatabase(workDir: string): InstanceType<typeof Database> {
  const db = openDatabase(join(workDir, ".system", "sidjua.db"));
  runKnowledgeMigrations(db);
  return db;
}


/**
 * Check whether a table exists in the database.
 *
 * Use this to guard queries that rely on tables created by `sidjua apply`,
 * instead of catching SQLite error messages (which are fragile strings).
 *
 * @example
 * if (!hasTable(db, 'divisions')) return c.json({ divisions: [] });
 */
export function hasTable(db: InstanceType<typeof Database>, tableName: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(tableName);
  return row !== undefined;
}
