// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Pre-Migration Database Backup
 *
 * Simple file-copy backup of SQLite database files before schema migrations.
 * Distinct from the full workspace ZIP backup (src/core/backup.ts) —
 * this is a lightweight snapshot scoped to the DB files only.
 *
 * Backup naming: `{dbFile}.pre-update-bak`
 * Covers: database.db + WAL/SHM sidecar files + additional DBs (audit.db)
 */

import { promises as fs } from "node:fs";
import { join }           from "node:path";
import { createLogger }   from "../logger.js";

const logger = createLogger("db-backup");

const ADDITIONAL_DBS = ["audit.db"];

/**
 * Copy the main SQLite database and its WAL/SHM sidecar files
 * to `.pre-update-bak` paths in the same directory.
 *
 * @returns The path of the main backup file.
 */
export async function backupDatabase(dataDir: string): Promise<string> {
  const dbPath     = join(dataDir, "database.db");
  const backupPath = `${dbPath}.pre-update-bak`;

  await fs.copyFile(dbPath, backupPath);

  // WAL/SHM may contain data not yet flushed to the main file
  for (const ext of ["-wal", "-shm"]) {
    try {
      await fs.copyFile(`${dbPath}${ext}`, `${backupPath}${ext}`);
    } catch (_err) {
      // Sidecar file absent — safe to skip
    }
  }

  // Backup supplementary databases (audit.db, etc.)
  for (const dbName of ADDITIONAL_DBS) {
    const srcPath = join(dataDir, dbName);
    try {
      await fs.access(srcPath);
      await fs.copyFile(srcPath, `${srcPath}.pre-update-bak`);
    } catch (_err) {
      // DB does not exist — skip
    }
  }

  logger.info("db-backup", "Pre-migration backup created", { metadata: { backupPath } });
  return backupPath;
}

/**
 * Restore the main database and its WAL/SHM from the `.pre-update-bak` copies.
 * Throws if no backup file is found.
 */
export async function restoreDatabase(dataDir: string): Promise<void> {
  const dbPath     = join(dataDir, "database.db");
  const backupPath = `${dbPath}.pre-update-bak`;

  try {
    await fs.access(backupPath);
  } catch (_err) {
    throw new Error(`No pre-migration backup found at: ${backupPath}`);
  }

  await fs.copyFile(backupPath, dbPath);

  for (const ext of ["-wal", "-shm"]) {
    try {
      await fs.copyFile(`${backupPath}${ext}`, `${dbPath}${ext}`);
    } catch (_err) {
      // Sidecar backup absent — skip
    }
  }

  // Restore supplementary databases
  for (const dbName of ADDITIONAL_DBS) {
    const bakPath = join(dataDir, `${dbName}.pre-update-bak`);
    try {
      await fs.access(bakPath);
      await fs.copyFile(bakPath, join(dataDir, dbName));
    } catch (_err) {
      // No backup — skip
    }
  }

  logger.info("db-backup", "Database restored from pre-migration backup", { metadata: { backupPath } });
}

/**
 * Remove all `.pre-update-bak` files after a successful migration.
 * Non-fatal — missing files are silently skipped.
 */
export async function cleanupBackup(dataDir: string): Promise<void> {
  const dbPath     = join(dataDir, "database.db");
  const backupPath = `${dbPath}.pre-update-bak`;

  for (const f of [backupPath, `${backupPath}-wal`, `${backupPath}-shm`]) {
    try { await fs.unlink(f); } catch (_err) { /* already gone */ }
  }

  for (const dbName of ADDITIONAL_DBS) {
    try { await fs.unlink(join(dataDir, `${dbName}.pre-update-bak`)); } catch (_err) { /* already gone */ }
  }

  logger.info("db-backup", "Pre-migration backup cleaned up", { metadata: { backupPath } });
}
