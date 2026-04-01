// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Step 3: DATABASE
 *
 * Opens (or creates) the main SQLite database at {workDir}/.system/sidjua.db,
 * applies any pending migrations, syncs the divisions table with the config, and
 * initialises cost_budgets rows for every active division.
 *
 * The returned Database handle must be kept open and passed to Step 8 (AUDIT)
 * and Step 9 (COST_CENTERS) which execute further queries on the same file.
 *
 * Idempotency:
 *   - Migrations are tracked in _migrations and only applied once.
 *   - divisions rows are INSERT OR REPLACE (upsert) — safe to run twice.
 *   - Divisions removed from config are set active=0, rows are NEVER deleted.
 *   - cost_budgets uses INSERT OR IGNORE — existing rows preserved.
 */

import { join } from "node:path";
import type { ParsedConfig } from "../types/config.js";
import { ApplyError, type StepResult } from "../types/apply.js";
import { openDatabase, runMigrations, type Database, type DbMigration } from "../utils/db.js";
import { loadDefaultDivisions } from "../defaults/loader.js";
import { logger } from "../utils/logger.js";
import { seedOrgChart, assignOrphanAgents } from "../org-chart/org-chart-seeder.js";


const V1_INITIAL: DbMigration = {
  version: "1.0",
  description: "Initial schema — all V1 tables + indexes",
  up: `
    -- Division registry (mirrors divisions.yaml in queryable form)
    CREATE TABLE IF NOT EXISTS divisions (
      code           TEXT PRIMARY KEY,
      name_en        TEXT NOT NULL,
      name_localized TEXT,
      scope          TEXT,
      active         INTEGER NOT NULL DEFAULT 0,
      required       INTEGER NOT NULL DEFAULT 0,
      head_role      TEXT,
      head_agent     TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Audit trail (V1 — readable, exportable, NOT tamper-proof)
    CREATE TABLE IF NOT EXISTS audit_trail (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
      agent_id        TEXT NOT NULL,
      division_code   TEXT,
      action_type     TEXT NOT NULL,
      action_detail   TEXT NOT NULL,
      governance_check BLOB,
      input_summary   TEXT,
      output_summary  TEXT,
      token_count     INTEGER,
      cost_usd        REAL,
      classification  TEXT DEFAULT 'INTERNAL',
      parent_task_id  TEXT,
      metadata        BLOB
    );

    CREATE INDEX IF NOT EXISTS idx_audit_timestamp  ON audit_trail(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_agent      ON audit_trail(agent_id);
    CREATE INDEX IF NOT EXISTS idx_audit_division   ON audit_trail(division_code);
    CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_trail(action_type);

    -- Cost tracking
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp      TEXT NOT NULL DEFAULT (datetime('now')),
      division_code  TEXT NOT NULL,
      agent_id       TEXT NOT NULL,
      provider       TEXT NOT NULL,
      model          TEXT NOT NULL,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd       REAL NOT NULL DEFAULT 0,
      task_id        TEXT,
      cost_type      TEXT NOT NULL DEFAULT 'llm_call',
      FOREIGN KEY (division_code) REFERENCES divisions(code)
    );

    CREATE INDEX IF NOT EXISTS idx_cost_division  ON cost_ledger(division_code);
    CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_ledger(timestamp);
    CREATE INDEX IF NOT EXISTS idx_cost_type      ON cost_ledger(cost_type);

    -- Per-division budget limits
    CREATE TABLE IF NOT EXISTS cost_budgets (
      division_code           TEXT PRIMARY KEY,
      monthly_limit_usd       REAL,
      daily_limit_usd         REAL,
      alert_threshold_percent REAL DEFAULT 80.0,
      FOREIGN KEY (division_code) REFERENCES divisions(code)
    );

    -- FIX-452: Budget reservation table for TOCTOU-safe atomic check+reserve
    -- Reservations expire after 1 hour; stale rows are pruned at budget-check time.
    CREATE TABLE IF NOT EXISTS pending_reservations (
      id            TEXT PRIMARY KEY,
      division_code TEXT NOT NULL,
      amount_usd    REAL NOT NULL CHECK (amount_usd >= 0),
      reserved_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_res_div     ON pending_reservations(division_code);
    CREATE INDEX IF NOT EXISTS idx_pending_res_expires ON pending_reservations(expires_at);

    -- Governance approval queue
    CREATE TABLE IF NOT EXISTS approval_queue (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      agent_id           TEXT NOT NULL,
      division_code      TEXT,
      action_description TEXT NOT NULL,
      rule_triggered     TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      decided_by         TEXT,
      decided_at         TEXT,
      metadata           BLOB
    );

    CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_queue(status);

    -- Agent registry
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      tier          INTEGER NOT NULL,
      provider      TEXT NOT NULL,
      model         TEXT NOT NULL,
      division_code TEXT,
      active        INTEGER NOT NULL DEFAULT 1,
      capabilities  BLOB,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (division_code) REFERENCES divisions(code)
    );

    -- Bootstrap key store (V1 passphrase storage — see SIDJUA-APPLY-TECH-SPEC-V1.md §4)
    CREATE TABLE IF NOT EXISTS _system_keys (
      key_name   TEXT PRIMARY KEY,
      key_value  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
  down: `
    DROP TABLE IF EXISTS _system_keys;
    DROP TABLE IF EXISTS agents;
    DROP INDEX IF EXISTS idx_approval_status;
    DROP TABLE IF EXISTS approval_queue;
    DROP TABLE IF EXISTS cost_budgets;
    DROP INDEX IF EXISTS idx_cost_timestamp;
    DROP INDEX IF EXISTS idx_cost_division;
    DROP TABLE IF EXISTS cost_ledger;
    DROP INDEX IF EXISTS idx_audit_action;
    DROP INDEX IF EXISTS idx_audit_division;
    DROP INDEX IF EXISTS idx_audit_agent;
    DROP INDEX IF EXISTS idx_audit_timestamp;
    DROP TABLE IF EXISTS audit_trail;
    DROP TABLE IF EXISTS divisions;
  `,
};

/**
 * V2: add cost_type column to cost_ledger to distinguish LLM costs
 * from tool execution costs. Safe for databases created before v0.9.7.
 */
/**
 * V2: add cost_type column to cost_ledger for pre-0.9.7 databases.
 * Safe to run on databases that already have the column (guarded below in applyDatabase).
 * Databases created from V1_INITIAL already include this column, so migration is a no-op.
 */
const V2_COST_TYPE: DbMigration = {
  version: "2.0",
  description: "FIX-464: add cost_type column to cost_ledger to distinguish LLM vs tool costs",
  up: `
    -- No-op placeholder; actual ALTER TABLE is applied conditionally in applyDatabase()
    -- to avoid "duplicate column name" on fresh databases where V1_INITIAL already adds it.
    SELECT 1;
  `,
  down: `
    -- No rollback needed; column was present in V1_INITIAL for new databases.
  `,
};

/**
 * V3: org-chart columns for agents and divisions tables.
 * Adds reporting hierarchy and budget allocation metadata.
 * Safe for databases created before v0.10.1.
 * Databases created from V1_INITIAL already have these columns once V3 is applied.
 */
const V3_ORG_CHART: DbMigration = {
  version: "3.0",
  description: "P345: add org-chart columns (reports_to, delegate_to, role_title on agents; parent_division_code, budget_allocation on divisions)",
  up: `
    -- No-op placeholder; actual ALTER TABLEs applied conditionally in applyDatabase()
    -- to avoid "duplicate column name" on databases where columns already exist.
    SELECT 1;
  `,
  down: `
    -- No rollback needed; columns were present in V1_INITIAL for new databases.
  `,
};

export const MIGRATIONS: DbMigration[] = [V1_INITIAL, V2_COST_TYPE, V3_ORG_CHART];


/**
 * Open (or create) the main sidjua.db, apply any pending migrations, sync
 * the divisions table, and initialise cost_budgets rows.
 *
 * Returns both the StepResult (for the orchestrator log) and the open Database
 * handle that must be passed to subsequent steps (AUDIT, COST_CENTERS).
 */
export function applyDatabase(
  config: ParsedConfig,
  workDir: string,
): { result: StepResult; db: Database } {
  const start = Date.now();

  try {
    const dbPath = join(workDir, ".system", "sidjua.db");
    logger.info("DATABASE", "Opening main database", { dbPath });

    const db = openDatabase(dbPath);

    // Ensure WAL mode for better concurrent read performance
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Run pending migrations
    const migrationsApplied = runMigrations(db, MIGRATIONS);
    logger.info("DATABASE", `Migrations applied: ${migrationsApplied}`);

    // Conditionally add cost_type column for databases created before v0.9.7.
    // V1_INITIAL already includes the column; this is only needed for older on-disk databases.
    const colInfo = db.pragma("table_info(cost_ledger)") as { name: string }[];
    const hasCostType = colInfo.some((c) => c.name === "cost_type");
    if (!hasCostType) {
      db.exec("ALTER TABLE cost_ledger ADD COLUMN cost_type TEXT NOT NULL DEFAULT 'llm_call'");
      db.exec("CREATE INDEX IF NOT EXISTS idx_cost_type ON cost_ledger(cost_type)");
      logger.info("DATABASE", "Added cost_type column to cost_ledger (pre-0.9.7 upgrade)");
    }

    // V3: add org-chart columns to agents table for pre-v0.10.1 databases.
    const agentColInfo = db.pragma("table_info(agents)") as { name: string }[];
    const agentColNames = new Set(agentColInfo.map((c) => c.name));
    if (!agentColNames.has("reports_to")) {
      db.exec("ALTER TABLE agents ADD COLUMN reports_to TEXT REFERENCES agents(id)");
    }
    if (!agentColNames.has("delegate_to")) {
      db.exec("ALTER TABLE agents ADD COLUMN delegate_to TEXT REFERENCES agents(id)");
    }
    if (!agentColNames.has("role_title")) {
      db.exec("ALTER TABLE agents ADD COLUMN role_title TEXT");
    }
    if (!agentColNames.has("org_level")) {
      db.exec("ALTER TABLE agents ADD COLUMN org_level INTEGER");
    }
    // Only create the index once all columns exist
    if (!agentColNames.has("reports_to")) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_agents_reports_to ON agents(reports_to)");
    }

    // V3: add org-chart columns to divisions table for pre-v0.10.1 databases.
    const divColInfo = db.pragma("table_info(divisions)") as { name: string }[];
    const divColNames = new Set(divColInfo.map((c) => c.name));
    if (!divColNames.has("parent_division_code")) {
      db.exec("ALTER TABLE divisions ADD COLUMN parent_division_code TEXT REFERENCES divisions(code)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_divisions_parent ON divisions(parent_division_code)");
    }
    if (!divColNames.has("budget_allocation")) {
      db.exec("ALTER TABLE divisions ADD COLUMN budget_allocation REAL");
    }

    // Sync default system divisions first (INSERT OR IGNORE — never overwrite user config)
    syncDefaultDivisions(db);

    // Sync divisions table
    const { inserted, updated, deactivated } = syncDivisions(db, config);
    logger.info("DATABASE", "Divisions synced", { inserted, updated, deactivated });

    // Ensure cost_budgets rows for all active divisions
    const budgetsInitialised = ensureBudgetRows(db, config);
    logger.info("DATABASE", `Budget rows initialised: ${budgetsInitialised}`);

    // Seed org chart hierarchy (C-level positions for core agents) — idempotent
    const orgSeeded       = seedOrgChart(db);
    const orphansAssigned = assignOrphanAgents(db);
    logger.info("DATABASE", `Org chart: ${orgSeeded} agents positioned, ${orphansAssigned} orphans assigned`);

    const summary =
      `${migrationsApplied} migrations applied, ` +
      `${inserted + updated} divisions synced, ` +
      `${budgetsInitialised} budget rows, ` +
      `${orgSeeded} org positions`;

    return {
      result: {
        step: "DATABASE",
        success: true,
        duration_ms: Date.now() - start,
        summary,
        details: { migrationsApplied, inserted, updated, deactivated, budgetsInitialised, orgSeeded, orphansAssigned },
      },
      db,
    };
  } catch (err) {
    throw new ApplyError(
      "DATABASE_ERROR",
      "DATABASE",
      `Database step failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}


interface DivisionRow {
  code: string;
  name_en: string;
  name_localized: string | null;
  scope: string | null;
  active: number;
  required: number;
  head_role: string | null;
  head_agent: string | null;
  created_at: string;
  updated_at: string;
}

function syncDivisions(
  db: Database,
  config: ParsedConfig,
): { inserted: number; updated: number; deactivated: number } {
  const upsert = db.prepare<
    [string, string, string | null, string | null, number, number, string | null, string | null],
    void
  >(`
    INSERT INTO divisions
      (code, name_en, name_localized, scope, active, required, head_role, head_agent, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(code) DO UPDATE SET
      name_en        = excluded.name_en,
      name_localized = excluded.name_localized,
      scope          = excluded.scope,
      active         = excluded.active,
      required       = excluded.required,
      head_role      = excluded.head_role,
      head_agent     = excluded.head_agent,
      updated_at     = datetime('now')
  `);

  // Set active=0 for every non-protected division not present in current config.
  // Protected codes (system, executive, workspace) are never deactivated.
  const protectedJson = JSON.stringify([...PROTECTED_DIVISION_CODES]);
  const deactivateStale = db.prepare<[string, string], void>(`
    UPDATE divisions SET active = 0, updated_at = datetime('now')
    WHERE code NOT IN (SELECT value FROM json_each(?))
      AND code NOT IN (SELECT value FROM json_each(?))
  `);

  const existing = db
    .prepare<[], DivisionRow>("SELECT code FROM divisions")
    .all() as DivisionRow[];
  const existingCodes = new Set(existing.map((r) => r.code));

  let inserted = 0;
  let updated = 0;

  db.transaction(() => {
    for (const div of config.divisions) {
      const nameLocalized = Object.keys(div.name).length > 1 ? JSON.stringify(div.name) : null;
      upsert.run(
        div.code,
        div.name.en ?? div.code,
        nameLocalized,
        div.scope || null,
        div.active ? 1 : 0,
        div.required ? 1 : 0,
        div.head.role,
        div.head.agent,
      );
      if (existingCodes.has(div.code)) {
        updated++;
      } else {
        inserted++;
      }
    }

    // Deactivate divisions in DB that are not in the current YAML at all
    // (protected codes are excluded from deactivation)
    const configCodes = JSON.stringify(config.divisions.map((d) => d.code));
    deactivateStale.run(configCodes, protectedJson);
  })();

  // Count how many were actually deactivated
  const deactivated = existing.filter(
    (r) => !config.divisions.some((d) => d.code === r.code),
  ).length;

  return { inserted, updated, deactivated };
}


/**
 * Codes of the built-in system divisions that are never deactivated by
 * syncDivisions, even when absent from the user's config.
 */
export const PROTECTED_DIVISION_CODES: ReadonlySet<string> = new Set([
  "system",
  "executive",
  "workspace",
]);

/**
 * Sync the 3 built-in divisions (system, executive, workspace) from
 * src/defaults/divisions/ into the divisions table.
 *
 * Uses INSERT OR IGNORE so user-modified rows are never overwritten.
 * Non-fatal — a failure to load the YAML files is logged and silently skipped.
 */
function syncDefaultDivisions(db: Database): void {
  let divisions;
  try {
    divisions = loadDefaultDivisions();
  } catch (err) {
    logger.warn("DATABASE", `Could not load default divisions (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const insert = db.prepare<[string, string], void>(`
    INSERT OR IGNORE INTO divisions
      (code, name_en, active, required, updated_at)
    VALUES (?, ?, 1, 1, datetime('now'))
  `);

  db.transaction(() => {
    for (const div of divisions) {
      // Map Division.id → divisions.code; mark active + required
      insert.run(div.id, div.name);
    }
  })();
}

function ensureBudgetRows(db: Database, config: ParsedConfig): number {
  const insertBudget = db.prepare<[string], void>(`
    INSERT OR IGNORE INTO cost_budgets
      (division_code, monthly_limit_usd, daily_limit_usd, alert_threshold_percent)
    VALUES (?, NULL, NULL, 80.0)
  `);

  let count = 0;
  db.transaction(() => {
    for (const div of config.activeDivisions) {
      const result = insertBudget.run(div.code);
      if (result.changes > 0) count++;
    }
  })();

  return count;
}
