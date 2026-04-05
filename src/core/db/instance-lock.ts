// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — SQLite Instance Lock
 *
 * Prevents multiple processes from opening the same SQLite database file
 * concurrently, which can cause WAL corruption under heavy write loads.
 *
 * A PID file (`<dbPath>.instance.lock`) is written with the current process
 * PID when the lock is acquired.  On acquire:
 *   1. If no lock file exists: write PID, acquire succeeds.
 *   2. If lock file exists: read PID; if the process is alive, refuse.
 *      If the process is dead (stale lock), remove the file and retry.
 *
 * The `wx` open flag (O_CREAT | O_EXCL) makes the file creation atomic —
 * concurrent processes cannot both succeed; one will get EEXIST.
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { createLogger } from "../logger.js";

const logger = createLogger("instance-lock");

export class InstanceLock {
  private readonly lockPath: string;
  private held = false;

  constructor(dbPath: string) {
    this.lockPath = `${dbPath}.instance.lock`;
  }

  /**
   * Try to acquire the instance lock.
   * Returns true if the lock was acquired; false if another live process holds it.
   */
  acquire(): boolean {
    try {
      if (existsSync(this.lockPath)) {
        const content = readFileSync(this.lockPath, "utf8").trim();
        const pid = parseInt(content, 10);

        if (!isNaN(pid) && isProcessAlive(pid)) {
          logger.warn("instance_lock_busy", "SQLite instance lock held by another process", {
            metadata: { lockPath: this.lockPath, pid },
          });
          return false;
        }

        // Stale lock from a crashed process — remove it before re-acquiring.
        logger.info("instance_lock_stale", "Removing stale SQLite instance lock", {
          metadata: { lockPath: this.lockPath, stalePid: isNaN(pid) ? "unknown" : pid },
        });
        unlinkSync(this.lockPath);
      }

      // O_CREAT | O_EXCL — atomic create; throws EEXIST if another process raced.
      writeFileSync(this.lockPath, String(process.pid), { flag: "wx" });
      this.held = true;
      logger.debug("instance_lock_acquired", "SQLite instance lock acquired", {
        metadata: { lockPath: this.lockPath, pid: process.pid },
      });
      return true;
    } catch (err: unknown) {
      // EEXIST: a concurrent process created the file between our check and write.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        logger.warn("instance_lock_race", "SQLite instance lock race — another process won", {
          metadata: { lockPath: this.lockPath },
        });
        return false;
      }
      logger.warn("instance_lock_error", "SQLite instance lock error", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }

  /**
   * Release the instance lock.
   * No-op if this instance does not hold the lock.
   */
  release(): void {
    if (!this.held) return;
    try {
      unlinkSync(this.lockPath);
      this.held = false;
      logger.debug("instance_lock_released", "SQLite instance lock released", {
        metadata: { lockPath: this.lockPath },
      });
    } catch (err: unknown) {
      logger.warn("instance_lock_release_error", "Failed to release SQLite instance lock", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** Whether this instance currently holds the lock. */
  isHeld(): boolean {
    return this.held;
  }
}

/**
 * Check whether a process with the given PID is alive.
 * `process.kill(pid, 0)` does not send a signal — it only tests existence.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_e) {
    return false;
  }
}
