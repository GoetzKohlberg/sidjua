// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5: DB Migration
 *
 * V1.5 migration adds the agent-lifecycle tables:
 *   agent_definitions  — YAML-parsed agent configs
 *   agent_budgets      — per-agent budget tracking
 *   provider_configs   — provider registrations
 *   division_budgets   — division-level budget limits
 *
 * This migration is applied lazily by the agent-lifecycle module
 * (not by `sidjua apply`, which manages the V1 tables).
 */

import type { Database, DbMigration } from "../utils/db.js";
import { runMigrations } from "../utils/db.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("agent-migration");


const V1_5_AGENT_LIFECYCLE: DbMigration = {
  version: "1.5",
  description: "Phase 10.5 — agent lifecycle tables",
  up: `
    -- Agent definitions persisted for crash recovery + lifecycle management
    CREATE TABLE IF NOT EXISTS agent_definitions (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      tier        INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 7),
      division    TEXT NOT NULL,
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      skill_path  TEXT NOT NULL,
      config_yaml TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'stopped',
      created_at  TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agentdef_division ON agent_definitions(division);
    CREATE INDEX IF NOT EXISTS idx_agentdef_status   ON agent_definitions(status);
    CREATE INDEX IF NOT EXISTS idx_agentdef_tier     ON agent_definitions(tier);

    -- Budget tracking per agent per period
    CREATE TABLE IF NOT EXISTS agent_budgets (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_type  TEXT NOT NULL,
      spent_usd    REAL NOT NULL DEFAULT 0.0,
      limit_usd    REAL NOT NULL DEFAULT 0.0,
      tokens_used  INTEGER NOT NULL DEFAULT 0,
      token_limit  INTEGER,
      UNIQUE (agent_id, period_start, period_type),
      FOREIGN KEY (agent_id) REFERENCES agent_definitions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_agentbudget_agent  ON agent_budgets(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agentbudget_period ON agent_budgets(period_start);

    -- Provider configurations
    CREATE TABLE IF NOT EXISTS provider_configs (
      id                TEXT PRIMARY KEY,
      type              TEXT NOT NULL,
      config_yaml       TEXT NOT NULL,
      api_key_ref       TEXT NOT NULL,
      last_health_check TEXT,
      health_status     TEXT NOT NULL DEFAULT 'unknown',
      created_at        TEXT NOT NULL
    );

    -- Division budgets (phase 10.5 extended budget tracking)
    CREATE TABLE IF NOT EXISTS division_budgets (
      division     TEXT PRIMARY KEY,
      period_start TEXT NOT NULL,
      period_type  TEXT NOT NULL DEFAULT 'monthly',
      spent_usd    REAL NOT NULL DEFAULT 0.0,
      limit_usd    REAL NOT NULL,
      provider_limits TEXT
    );
  `,
  down: `
    DROP INDEX IF EXISTS idx_agentbudget_period;
    DROP INDEX IF EXISTS idx_agentbudget_agent;
    DROP TABLE IF EXISTS agent_budgets;
    DROP INDEX IF EXISTS idx_agentdef_tier;
    DROP INDEX IF EXISTS idx_agentdef_status;
    DROP INDEX IF EXISTS idx_agentdef_division;
    DROP TABLE IF EXISTS agent_definitions;
    DROP TABLE IF EXISTS provider_configs;
    DROP TABLE IF EXISTS division_budgets;
  `,
};


const V1_6_RESILIENCE: DbMigration = {
  version: "1.6",
  description: "Phase 10.5c — process resilience: checkpoints, WAL, system state",
  up: `
    -- Agent checkpoints: periodic snapshots of agent state
    CREATE TABLE IF NOT EXISTS agent_checkpoints (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      type        TEXT NOT NULL,
      state_json  TEXT NOT NULL,
      wal_sequence INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agent_definitions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_time
      ON agent_checkpoints(agent_id, timestamp DESC);

    -- Write-ahead log: granular operation log between checkpoints
    CREATE TABLE IF NOT EXISTS agent_wal (
      sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      operation   TEXT NOT NULL,
      data_json   TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agent_definitions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_wal_agent_seq
      ON agent_wal(agent_id, sequence);

    -- System-level state for shutdown tracking and recovery
    CREATE TABLE IF NOT EXISTS system_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO system_state VALUES ('shutdown_clean', 'true',  datetime('now'));
    INSERT OR IGNORE INTO system_state VALUES ('last_startup',   '',      datetime('now'));
    INSERT OR IGNORE INTO system_state VALUES ('last_shutdown',  '',      datetime('now'));
  `,
  down: `
    DROP INDEX IF EXISTS idx_wal_agent_seq;
    DROP TABLE IF EXISTS agent_wal;
    DROP INDEX IF EXISTS idx_checkpoints_agent_time;
    DROP TABLE IF EXISTS agent_checkpoints;
    DROP TABLE IF EXISTS system_state;
  `,
};

const V1_7_DAEMON_RATE_STATE: DbMigration = {
  version: "1.7",
  description: "Daemon rate-state persistence — survive restart without resetting sliding windows",
  up: `
    -- Persists per-agent sliding-window rate/budget entries so that hourly limits
    -- survive a daemon restart (single-process deployment). Rows older than one
    -- hour are pruned on load and on shutdown.
    --
    -- NOTE: Multi-instance deployments (multiple processes sharing the same DB)
    -- are NOT supported — rate limits are enforced per-process.
    CREATE TABLE IF NOT EXISTS daemon_rate_state (
      agent_id TEXT    NOT NULL,
      type     TEXT    NOT NULL CHECK (type IN ('task', 'cost')),
      ts       INTEGER NOT NULL,
      cost     REAL,
      PRIMARY KEY (agent_id, type, ts)
    );

    CREATE INDEX IF NOT EXISTS idx_daemon_rate_agent
      ON daemon_rate_state(agent_id, type, ts);
  `,
  down: `
    DROP INDEX IF EXISTS idx_daemon_rate_agent;
    DROP TABLE IF EXISTS daemon_rate_state;
  `,
};


// #833 (S809): One-shot migration — flip legacy starter agents from default-stopped to default-active.
// Version "1.7a" chosen to sort correctly AFTER "1.7" via String.localeCompare (verified:
// "1.7a".localeCompare("1.7") > 0). "1.10" was rejected: localeCompare sorts "1.10" before "1.5",
// which would cause UPDATE to run before CREATE TABLE on fresh DBs.
const V1_7A_AGENT_DEFAULT_ACTIVE: DbMigration = {
  version: "1.7a",
  description: "#833 — flip legacy starter agents from default-stopped to default-active",
  up: `
    -- Goetz product decision S809: status='active' is the correct default for
    -- agent_definitions. Existing pre-fix DBs have starter agents stuck at
    -- 'stopped', which causes Tool-Governance (agent-tools.ts) to reject every
    -- tool call. This one-shot migration flips them. Future user-issued
    -- 'sidjua agent stop <id>' calls happen AFTER this migration runs and are
    -- preserved (migrations execute exactly once per version per DB).
    --
    -- Excludes status='deleted' (soft-deleted, do not resurrect).
    UPDATE agent_definitions
       SET status = 'active',
           updated_at = datetime('now')
     WHERE status = 'stopped';
  `,
  down: `
    -- Down-migration intentionally no-op: we cannot distinguish between
    -- pre-migration 'stopped' (the bug) and post-migration user-issued
    -- 'stopped' (legitimate pause). Manual rollback only.
    SELECT 1;
  `,
};


export const LIFECYCLE_MIGRATIONS: DbMigration[] = [
  V1_5_AGENT_LIFECYCLE,
  V1_6_RESILIENCE,
  V1_7_DAEMON_RATE_STATE,
  V1_7A_AGENT_DEFAULT_ACTIVE,
];


/**
 * Ensure Phase 10.5 tables exist (including V1.6 resilience tables).
 * Idempotent — safe to call before every CLI command.
 * Uses the shared runMigrations() which tracks applied migrations.
 */
export function runMigrations105(db: Database): void {
  runMigrations(db, LIFECYCLE_MIGRATIONS);
  seedDefaultProviders(db);
}

/**
 * Seed the free Cloudflare Workers AI provider (no API key required).
 * Uses INSERT OR IGNORE so repeated calls are safe.
 */
function seedDefaultProviders(db: Database): void {
  try {
    db.prepare<[string, string, string, string, string], void>(`
      INSERT OR IGNORE INTO provider_configs
        (id, type, config_yaml, api_key_ref, health_status, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      "cloudflare",
      "cloudflare-ai",
      "type: cloudflare-ai\nname: Cloudflare Workers AI\nrequires_api_key: false\nmodels:\n  - id: \"@cf/meta/llama-3.1-8b-instruct\"\n    name: Llama 3.1 8B Instruct\n  - id: \"@cf/mistral/mistral-7b-instruct-v0.2\"\n    name: Mistral 7B Instruct\n",
      "",
      "healthy",
    );
  } catch (e: unknown) { logger.debug("agent-migration", "provider_configs table not found — skipping (pre-migration guard)", { metadata: { error: e instanceof Error ? e.message : String(e) } }); }
}
