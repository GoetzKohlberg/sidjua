// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Memory Consolidation Trigger & Advisory Lock
 *
 * Determines when consolidation should run and manages the advisory lock
 * that prevents concurrent consolidation runs across processes.
 *
 * Lock state is stored in workspace_config:
 *   key = "consolidation_lock"
 *   value = JSON { holder, acquired_at, expires_at }
 *
 * Stale lock: if expires_at < now, the lock is auto-released.
 */

import { createLogger } from "../logger.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConsolidationLock } from "./types.js";
import type { MemoryIndexManager } from "./memory-index.js";
import { ensureWorkspaceConfigTable } from "../../api/workspace-config-migration.js";

const logger = createLogger("memory-trigger");

/** Advisory lock TTL: 1 hour. */
const LOCK_TTL_MS = 60 * 60 * 1000;

/** Minimum entries before consolidation is triggered. */
const CONSOLIDATION_ENTRY_THRESHOLD = 50;

/** Minimum hours between consolidation runs (cooldown). */
const CONSOLIDATION_COOLDOWN_HOURS = 6;

const LOCK_CONFIG_KEY   = "consolidation_lock";
const LAST_RUN_KEY      = "consolidation_last_run";

// ---------------------------------------------------------------------------
// Advisory lock helpers
// ---------------------------------------------------------------------------

/** Try to acquire the advisory lock. Returns true if lock was acquired. */
export function acquireConsolidationLock(
  db: InstanceType<typeof Database>,
  holder?: string,
): boolean {
  const lockHolder = holder ?? randomUUID();
  const now        = new Date();
  const expiresAt  = new Date(now.getTime() + LOCK_TTL_MS);

  try {
    // DDL must run outside a transaction (CREATE TABLE IF NOT EXISTS).
    _ensureWorkspaceConfig(db);

    // Wrap the read-check-write in an EXCLUSIVE transaction to prevent
    // concurrent processes from both reading "no lock" and both writing a lock.
    const txFn = db.transaction((): boolean => {
      const existing = db.prepare<[string], { value: string }>(
        "SELECT value FROM workspace_config WHERE key = ?",
      ).get(LOCK_CONFIG_KEY);

      if (existing !== undefined) {
        let lock: ConsolidationLock;
        try {
          lock = JSON.parse(existing.value) as ConsolidationLock;
        } catch (_e) {
          // Corrupt lock — treat as stale
          lock = { holder: "unknown", acquired_at: "1970-01-01T00:00:00.000Z", expires_at: "1970-01-01T00:00:00.000Z" };
        }

        if (new Date(lock.expires_at) > now) {
          logger.info("consolidation_lock_busy", "Consolidation lock held by another process", {
            metadata: { holder: lock.holder, expiresAt: lock.expires_at },
          });
          return false;
        }

        // Stale lock — auto-release
        logger.info("consolidation_lock_stale", "Releasing stale consolidation lock", {
          metadata: { staleHolder: lock.holder, expiredAt: lock.expires_at },
        });
      }

      const lockData: ConsolidationLock = {
        holder:      lockHolder,
        acquired_at: now.toISOString(),
        expires_at:  expiresAt.toISOString(),
      };

      db.prepare(
        `INSERT OR REPLACE INTO workspace_config (key, value, updated_at)
         VALUES (?, ?, datetime('now'))`,
      ).run(LOCK_CONFIG_KEY, JSON.stringify(lockData));

      logger.info("consolidation_lock_acquired", "Consolidation lock acquired", {
        metadata: { holder: lockHolder, expiresAt: expiresAt.toISOString() },
      });

      return true;
    });

    return txFn.exclusive();
  } catch (err: unknown) {
    logger.warn("consolidation_lock_error", "Failed to acquire consolidation lock", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

/** Release the advisory lock. */
export function releaseConsolidationLock(db: InstanceType<typeof Database>): void {
  try {
    _ensureWorkspaceConfig(db);
    db.prepare("DELETE FROM workspace_config WHERE key = ?").run(LOCK_CONFIG_KEY);
    logger.info("consolidation_lock_released", "Consolidation lock released", {});
  } catch (err: unknown) {
    logger.warn("consolidation_lock_release_error", "Failed to release consolidation lock", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** Return the current lock state, or null if no lock is held. */
export function getConsolidationLock(
  db: InstanceType<typeof Database>,
): ConsolidationLock | null {
  try {
    _ensureWorkspaceConfig(db);
    const row = db.prepare<[string], { value: string }>(
      "SELECT value FROM workspace_config WHERE key = ?",
    ).get(LOCK_CONFIG_KEY);

    if (row === undefined) return null;

    const lock = JSON.parse(row.value) as ConsolidationLock;
    // Return null if lock has expired (but leave DB cleanup to next acquire)
    if (new Date(lock.expires_at) <= new Date()) return null;
    return lock;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

/**
 * Determine whether consolidation should run.
 * Returns true if the entry count exceeds the threshold and cooldown has passed.
 */
export function shouldConsolidate(
  db: InstanceType<typeof Database>,
  indexManager: MemoryIndexManager,
): boolean {
  const stats = indexManager.getStats();

  if (stats.total < CONSOLIDATION_ENTRY_THRESHOLD) {
    return false;
  }

  // Check cooldown
  try {
    _ensureWorkspaceConfig(db);
    const row = db.prepare<[string], { value: string }>(
      "SELECT value FROM workspace_config WHERE key = ?",
    ).get(LAST_RUN_KEY);

    if (row !== undefined) {
      const lastRun = new Date(row.value);
      const elapsed = Date.now() - lastRun.getTime();
      if (elapsed < CONSOLIDATION_COOLDOWN_HOURS * 60 * 60 * 1000) {
        logger.info("consolidation_cooldown", "Consolidation skipped — cooldown active", {
          metadata: { elapsedHours: (elapsed / 3_600_000).toFixed(1) },
        });
        return false;
      }
    }
  } catch (_e) {
    // No cooldown state — allow run
  }

  return true;
}

/** Record the timestamp of the last successful consolidation run. */
export function recordLastConsolidationRun(db: InstanceType<typeof Database>): void {
  try {
    _ensureWorkspaceConfig(db);
    db.prepare(
      `INSERT OR REPLACE INTO workspace_config (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
    ).run(LAST_RUN_KEY, new Date().toISOString());
  } catch (err: unknown) {
    logger.warn("consolidation_record_error", "Failed to record last consolidation run", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _ensureWorkspaceConfig(db: InstanceType<typeof Database>): void {
  ensureWorkspaceConfigTable(db);
}
