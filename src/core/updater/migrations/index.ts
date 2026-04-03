// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Cross-Version Schema Migration Runner
 *
 * Executes version-keyed database migrations in order, protected by a
 * file lock so that only one container runs migrations at a time during
 * a blue/green update.
 *
 * Migration lifecycle:
 *   1. Acquire file lock on {workDir}/migration.lock (10 s timeout)
 *   2. Check .update-in-progress marker — skip if absent (normal startup)
 *   3. Filter and sort applicable migrations
 *   4. Run each migration's up(); on failure run down() in reverse order
 *   5. Remove .update-in-progress marker on completion
 *   6. Release file lock
 *
 * Every migration MUST be idempotent (CREATE TABLE IF NOT EXISTS, etc.).
 */

import { promises as fs }            from "node:fs";
import { join }                      from "node:path";
import { createLogger }              from "../../logger.js";
import { FileLockManager }           from "../../update/lock-manager.js";
import { migration_1_0_1_to_1_0_2 } from "./1.0.1-to-1.0.2.js";

const logger = createLogger("migration-runner");

export interface VersionedMigration {
  /** Source semver string, e.g. "1.0.1" */
  from: string;
  /** Target semver string, e.g. "1.0.2" */
  to:   string;
  /** Apply the migration — MUST be idempotent. */
  up(workDir: string): Promise<void>;
  /** Reverse the migration for rollback. */
  down(workDir: string): Promise<void>;
}

/** Registered migrations in semver order. Add new migrations here. */
const MIGRATIONS: VersionedMigration[] = [
  migration_1_0_1_to_1_0_2,
];

const LOCK_TIMEOUT_MS = 10_000;
const MARKER_FILE     = ".update-in-progress";

/**
 * Run all applicable migrations from `fromVersion` to `toVersion`.
 *
 * Guards:
 *   - Acquires a file lock; throws if another process holds it after 10 s
 *   - Skips entirely if no `.update-in-progress` marker exists
 *   - Applies migrations in ascending `from` order
 *   - On any migration failure: runs `down()` in reverse, then re-throws
 *
 * @param workDir     Workspace directory (lock file + marker + DB location)
 * @param fromVersion The version the DB is currently at
 * @param toVersion   The version the app is updating to
 */
export async function runMigrations(
  workDir:     string,
  fromVersion: string,
  toVersion:   string,
): Promise<void> {
  const markerPath = join(workDir, MARKER_FILE);

  // Guard: skip if no update is in progress
  try {
    await fs.access(markerPath);
  } catch (_err) {
    logger.info("migration-runner", "No update-in-progress marker — skipping migrations");
    return;
  }

  const lock = new FileLockManager(workDir);

  // Acquire file lock with polling until timeout
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await lock.acquire("migration");
      break;
    } catch (err: unknown) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Migration lock acquisition timed out after ${LOCK_TIMEOUT_MS}ms. ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
      await sleep(500);
    }
  }

  try {
    const applicable = MIGRATIONS
      .filter((m) => semverGte(m.from, fromVersion) && semverLte(m.to, toVersion))
      .sort((a, b) => semverCompare(a.from, b.from));

    if (applicable.length === 0) {
      logger.info("migration-runner", "No applicable migrations", {
        metadata: { fromVersion, toVersion },
      });
    } else {
      logger.info("migration-runner", "Running migrations", {
        metadata: { fromVersion, toVersion, count: applicable.length },
      });

      const applied: VersionedMigration[] = [];

      for (const migration of applicable) {
        logger.info("migration-runner", `Applying migration ${migration.from} → ${migration.to}`);
        try {
          await migration.up(workDir);
          applied.push(migration);
          logger.info("migration-runner", `Migration ${migration.from} → ${migration.to} applied`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("migration-runner", `Migration ${migration.from} → ${migration.to} failed — rolling back`, {
            error: { code: "MIGRATION_FAILED", message: msg },
          });

          // Roll back all previously applied migrations in reverse order
          for (const m of [...applied].reverse()) {
            try {
              await m.down(workDir);
              logger.info("migration-runner", `Rolled back ${m.from} → ${m.to}`);
            } catch (rollbackErr: unknown) {
              logger.error("migration-runner", `Rollback of ${m.from} → ${m.to} failed`, {
                error: {
                  code:    "ROLLBACK_FAILED",
                  message: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
                },
              });
            }
          }

          throw new Error(`Migration ${migration.from} → ${migration.to} failed: ${msg}`);
        }
      }

      logger.info("migration-runner", "All migrations applied", {
        metadata: { count: applied.length },
      });
    }

    // Remove the in-progress marker on success
    try {
      await fs.unlink(markerPath);
      logger.info("migration-runner", "Removed update-in-progress marker");
    } catch (_err) {
      logger.warn("migration-runner", "Could not remove update-in-progress marker — not critical");
    }
  } finally {
    await lock.release();
  }
}

/**
 * Get the current schema version from the `schema_version` table.
 * Returns "1.0.1" if the table doesn't exist (pre-migration baseline).
 */
export function getSchemaVersion(db: import("better-sqlite3").Database): string {
  try {
    const row = db
      .prepare<[], { version: string }>(
        "SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1",
      )
      .get();
    return row?.version ?? "1.0.1";
  } catch (_err) {
    return "1.0.1"; // table doesn't exist yet
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a semver string into [major, minor, patch] numbers. */
function parseSemver(v: string): [number, number, number] {
  const parts = v.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function semverCompare(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

/** Returns true if `a >= b`. */
function semverGte(a: string, b: string): boolean {
  return semverCompare(a, b) >= 0;
}

/** Returns true if `a <= b`. */
function semverLte(a: string, b: string): boolean {
  return semverCompare(a, b) <= 0;
}
