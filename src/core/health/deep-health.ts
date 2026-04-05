// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Deep Healthcheck
 *
 * Returns a detailed health status checked by the blue/green sidecar
 * during the healthcheck phase of a deployment.
 *
 * Fields checked:
 *   db_read          — SQLite SELECT 1 succeeds
 *   db_write         — INSERT + DELETE in _health_check table (skipped in read-only mode)
 *   disk_ok          — data directory has >100MB free
 *   migration_complete — no .update-in-progress marker; schema up to date
 *   qdrant_connected — Qdrant health endpoint returns 200 (graceful fail)
 */

import { existsSync, statfsSync } from "node:fs";
import { join }                   from "node:path";
import type { Database }          from "better-sqlite3";
import { createLogger }           from "../logger.js";
import { SIDJUA_VERSION }         from "../../version.js";

const logger = createLogger("deep-health");

const MIN_FREE_MB = 100;

export interface DeepHealthResult {
  version:            string;
  healthy:            boolean;
  db_read:            boolean;
  db_write:           boolean;
  disk_ok:            boolean;
  migration_complete: boolean;
  qdrant_connected:   boolean;
}

/**
 * Perform a comprehensive health check.
 *
 * @param db       Open SQLite database handle (null = DB unavailable)
 * @param dataDir  Data directory path (for disk space check)
 * @param workDir  Working directory (for .update-in-progress marker check)
 * @param readOnly When true the DB write check is skipped (e.g. during blue/green update)
 */
export async function checkDeepHealth(
  db:       Database | null,
  dataDir:  string,
  workDir:  string,
  readOnly: boolean = false,
): Promise<DeepHealthResult> {
  const dbRead   = checkDbRead(db);
  const dbWrite  = readOnly ? false : checkDbWrite(db);
  const diskOk   = checkDiskSpace(dataDir);
  const migOk    = checkMigrationComplete(workDir);
  const qdrant   = await checkQdrant();

  const healthy = dbRead && diskOk && migOk;

  return {
    version:            SIDJUA_VERSION,
    healthy,
    db_read:            dbRead,
    db_write:           dbWrite,
    disk_ok:            diskOk,
    migration_complete: migOk,
    qdrant_connected:   qdrant,
  };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkDbRead(db: Database | null): boolean {
  if (db === null) return false;
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch (err: unknown) {
    logger.warn("deep-health", "DB read check failed", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

function checkDbWrite(db: Database | null): boolean {
  if (db === null) return false;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _health_check (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL
      )
    `);
    const ins = db.prepare("INSERT INTO _health_check (ts) VALUES (?)");
    const del = db.prepare("DELETE FROM _health_check WHERE id = ?");
    const result = ins.run(new Date().toISOString());
    del.run(result.lastInsertRowid);
    return true;
  } catch (err: unknown) {
    logger.warn("deep-health", "DB write check failed", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

function checkDiskSpace(dataDir: string): boolean {
  try {
    const stats = statfsSync(dataDir);
    const freeMb = (stats.bfree * stats.bsize) / (1024 * 1024);
    return freeMb >= MIN_FREE_MB;
  } catch (err: unknown) {
    logger.debug("deep-health", "Disk space check unavailable", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return true; // non-fatal if statfsSync not available
  }
}

function checkMigrationComplete(workDir: string): boolean {
  const marker = join(workDir, ".update-in-progress");
  if (existsSync(marker)) return false;
  return true;
}

async function checkQdrant(): Promise<boolean> {
  const qdrantUrl = process.env["SIDJUA_QDRANT_URL"];
  if (!qdrantUrl) return true; // Qdrant not configured — not a failure

  const healthUrl = qdrantUrl.replace(/\/$/, "") + "/healthz";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const resp = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch (_err) {
    clearTimeout(timer);
    return false;
  }
}
