// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Schema Migration Framework
 *
 * Handles SQLite schema changes between SIDJUA versions.
 *
 * Architecture:
 *   - migration-registry.json (in system/migrations/) lists all migrations in order
 *   - Each migration is a JS file in system/migrations/ with up() and down()
 *   - Migration state is tracked in data/.migration-state.json
 *   - Migrations run per-agent SQLite database
 *   - Atomic state writes (temp file + rename)
 *   - Each migration is wrapped in a SQLite transaction; failure rolls back
 *
 * NOTE: Migrations run on AGENT databases (data/divisions/[div]/agents/[agent]/state.sqlite).
 * They do NOT run on the main workspace database (which has its own migration
 * system in src/apply/database.ts).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join, dirname }        from "node:path";
import { createRequire }        from "node:module";
import { fileURLToPath }        from "node:url";
import type { Database }        from "better-sqlite3";
import { createLogger }         from "../logger.js";

// CommonJS require for loading .cjs migration files from ESM context
const _require = createRequire(fileURLToPath(import.meta.url));

const logger = createLogger("migration-framework");


export interface Migration {
  id:          string;   // e.g., "004_add-health-status"
  version:     string;   // SIDJUA version this migration ships with
  description: string;

  /** Apply the migration (forward) */
  up(db: Database): Promise<void>;

  /** Reverse the migration (rollback) */
  down(db: Database): Promise<void>;
}

export interface MigrationRecord {
  id:        string;
  appliedAt: string;  // ISO timestamp
  version:   string;  // SIDJUA version
}

export interface MigrationState {
  schemaVersion:      number;
  appliedMigrations:  MigrationRecord[];
}

export interface MigrationResult {
  applied:  string[];        // migration IDs applied this run
  skipped:  string[];        // already-applied IDs that were skipped
  failed:   string | null;   // ID of failed migration, null if all succeeded
  error?:   string;
}

interface RegistryEntry {
  id:          string;
  version:     string;
  file:        string;
  description: string;
}

interface MigrationRegistry {
  migrations: RegistryEntry[];
}


/**
 * Read .migration-state.json from the data directory.
 * Returns an empty state if the file does not exist.
 */
export function loadMigrationState(dataDir: string): MigrationState {
  const statePath = join(dataDir, ".migration-state.json");
  if (!existsSync(statePath)) {
    return { schemaVersion: 0, appliedMigrations: [] };
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    return JSON.parse(raw) as MigrationState;
  } catch (e: unknown) {
    logger.warn("migration-framework", `Failed to parse migration state; starting fresh`, {
      error:    { code: "PARSE_ERROR", message: e instanceof Error ? e.message : String(e) },
      metadata: { path: statePath },
    });
    return { schemaVersion: 0, appliedMigrations: [] };
  }
}


/**
 * Write migration state atomically (temp file + rename).
 */
export function saveMigrationState(dataDir: string, state: MigrationState): void {
  const statePath = join(dataDir, ".migration-state.json");
  const tmpPath   = `${statePath}.tmp`;

  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, statePath);
}


/**
 * Read and parse migration-registry.json from system/migrations/.
 * Returns entries in the order they appear in the registry (order matters).
 */
export function loadMigrationRegistry(systemMigrationsDir: string): RegistryEntry[] {
  const registryPath = join(systemMigrationsDir, "migration-registry.json");
  if (!existsSync(registryPath)) {
    logger.warn("migration-framework", `Migration registry not found at "${registryPath}"`);
    return [];
  }

  try {
    const raw = readFileSync(registryPath, "utf-8");
    const reg = JSON.parse(raw) as MigrationRegistry;
    return Array.isArray(reg.migrations) ? reg.migrations : [];
  } catch (e: unknown) {
    logger.warn("migration-framework", `Failed to parse migration registry`, {
      error: { code: "PARSE_ERROR", message: e instanceof Error ? e.message : String(e) },
    });
    return [];
  }
}


/**
 * Dynamically require a migration JS file and return the Migration object.
 * Uses createRequire for CommonJS interop (migration files are .js modules).
 */
function loadMigrationModule(systemMigrationsDir: string, entry: RegistryEntry): Migration | null {
  const filePath = join(systemMigrationsDir, entry.file);
  if (!existsSync(filePath)) {
    logger.warn("migration-framework", `Migration file not found: "${filePath}"`);
    return null;
  }

  try {
    const mod = _require(filePath) as { default?: Migration } | Migration;
    const migration = ("default" in mod && mod.default !== undefined) ? mod.default : mod as Migration;
    return migration;
  } catch (e: unknown) {
    logger.warn("migration-framework", `Failed to load migration module "${entry.file}"`, {
      error: { code: "LOAD_FAILED", message: e instanceof Error ? e.message : String(e) },
    });
    return null;
  }
}


/**
 * Apply all unapplied migrations in order to the given database.
 *
 * Each migration is wrapped in a SQLite transaction. If any fails, the
 * transaction is rolled back and the function returns with a failed result.
 *
 * State is saved after each successful migration.
 */
export async function runPendingMigrations(
  db:                   Database,
  systemMigrationsDir:  string,
  dataDir:              string,
): Promise<MigrationResult> {
  const registry = loadMigrationRegistry(systemMigrationsDir);
  const state    = loadMigrationState(dataDir);

  const appliedIds = new Set(state.appliedMigrations.map((m) => m.id));
  const applied:  string[] = [];
  const skipped:  string[] = [];

  for (const entry of registry) {
    if (appliedIds.has(entry.id)) {
      skipped.push(entry.id);
      continue;
    }

    const migration = loadMigrationModule(systemMigrationsDir, entry);
    if (migration === null) {
      return { applied, skipped, failed: entry.id, error: `Migration file not found: ${entry.file}` };
    }

    logger.info("migration-framework", `Applying migration ${entry.id}`, {
      metadata: { description: entry.description },
    });

    // Wrap in a db.transaction() so SQLite handles BEGIN/COMMIT/ROLLBACK atomically.
    // better-sqlite3 transactions are synchronous; migration.up() must not do async I/O.
    // If up() returns a Promise (legacy async migration), await it after the transaction
    // to propagate any deferred errors.
    try {
      let upResult: Promise<void> | undefined;
      db.transaction(() => {
        const r = migration.up(db);
        if (r instanceof Promise) upResult = r;
      })();
      // Await any returned Promise (async migration compatibility)
      if (upResult !== undefined) await upResult;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("migration-framework", `Migration ${entry.id} failed — rolled back`, { error: { code: "MIGRATION_FAILED", message: msg } });
      return { applied, skipped, failed: entry.id, error: msg };
    }

    // Update state
    state.appliedMigrations.push({
      id:        entry.id,
      appliedAt: new Date().toISOString(),
      version:   entry.version,
    });
    state.schemaVersion++;
    saveMigrationState(dataDir, state);

    applied.push(entry.id);
    logger.info("migration-framework", `Migration ${entry.id} applied successfully`);
  }

  return { applied, skipped, failed: null };
}


/**
 * Reverse a specific migration by ID.
 */
export async function rollbackMigration(
  migrationId:         string,
  db:                  Database,
  systemMigrationsDir: string,
  dataDir:             string,
): Promise<MigrationResult> {
  const registry = loadMigrationRegistry(systemMigrationsDir);
  const entry    = registry.find((e) => e.id === migrationId);

  if (entry === undefined) {
    return { applied: [], skipped: [], failed: migrationId, error: `Migration "${migrationId}" not found in registry` };
  }

  const state     = loadMigrationState(dataDir);
  const wasApplied = state.appliedMigrations.some((m) => m.id === migrationId);

  if (!wasApplied) {
    return { applied: [], skipped: [migrationId], failed: null };
  }

  const migration = loadMigrationModule(systemMigrationsDir, entry);
  if (migration === null) {
    return { applied: [], skipped: [], failed: migrationId, error: `Migration file not found: ${entry.file}` };
  }

  logger.info("migration-framework", `Rolling back migration ${migrationId}`);

  try {
    let downResult: Promise<void> | undefined;
    db.transaction(() => {
      const r = migration.down(db);
      if (r instanceof Promise) downResult = r;
    })();
    if (downResult !== undefined) await downResult;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("migration-framework", `Rollback of ${migrationId} failed`, { error: { code: "ROLLBACK_FAILED", message: msg } });
    return { applied: [], skipped: [], failed: migrationId, error: msg };
  }

  // Remove from state
  state.appliedMigrations = state.appliedMigrations.filter((m) => m.id !== migrationId);
  if (state.schemaVersion > 0) state.schemaVersion--;
  saveMigrationState(dataDir, state);

  logger.info("migration-framework", `Rollback of ${migrationId} completed`);
  return { applied: [migrationId], skipped: [], failed: null };
}


/**
 * Find all agent state.sqlite databases under the data/divisions/ directory.
 * Pattern: data/divisions/<division>/agents/<agent>/state.sqlite
 *
 * Returns empty array if the divisions directory does not exist.
 */
export function findAgentDatabases(dataDir: string): string[] {
  const divisionsDir = join(dataDir, "divisions");
  if (!existsSync(divisionsDir)) return [];

  const results: string[] = [];
  collectAgentDbs(divisionsDir, results, 0);
  return results;
}

function collectAgentDbs(dir: string, out: string[], depth: number): void {
  if (depth > 4) return; // guard against unexpected deep nesting

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e: unknown) {
    logger.debug("migration-framework", "Could not read agent directory — skipping", { metadata: { error: e instanceof Error ? e.message : String(e), dir } });
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);

    // Check if it's the target file
    if (entry === "state.sqlite") {
      out.push(full);
      continue;
    }

    // Otherwise recurse into subdirectories — use statSync instead of
    // exception-driven readdirSync to distinguish files from directories.
    const st = statSync(full, { throwIfNoEntry: false });
    if (st?.isDirectory()) {
      collectAgentDbs(full, out, depth + 1);
    }
  }
}
