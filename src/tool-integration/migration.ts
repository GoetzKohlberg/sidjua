// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.7: DB Migration V1.8
 *
 * Adds tool integration tables:
 *   tool_definitions, tool_capabilities, tool_access,
 *   tool_governance_rules, tool_actions, environments
 */

import type { Database, DbMigration } from "../utils/db.js";
import { runMigrations } from "../utils/db.js";

const V1_8_TOOL_INTEGRATION: DbMigration = {
  version: "1.8",
  description: "Phase 10.7 — tool integration tables",
  up: `
    -- Tool definitions
    CREATE TABLE IF NOT EXISTS tool_definitions (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      type            TEXT NOT NULL,
      config_yaml     TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'inactive',
      pid             INTEGER,
      error_message   TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    -- Tool capabilities (id is composite text key: toolId:capName)
    CREATE TABLE IF NOT EXISTS tool_capabilities (
      id                TEXT PRIMARY KEY,
      tool_id           TEXT NOT NULL,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      risk_level        TEXT NOT NULL DEFAULT 'low',
      requires_approval INTEGER NOT NULL DEFAULT 0,
      input_schema      TEXT NOT NULL DEFAULT '{}',
      output_schema     TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (tool_id) REFERENCES tool_definitions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_capabilities_tool_id ON tool_capabilities(tool_id);

    -- Tool access control
    CREATE TABLE IF NOT EXISTS tool_access (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id             TEXT NOT NULL,
      division_code       TEXT,
      agent_id            TEXT,
      tier_max            INTEGER,
      classification_max  TEXT,
      FOREIGN KEY (tool_id) REFERENCES tool_definitions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_access_tool_id ON tool_access(tool_id);

    -- Tool governance rules
    CREATE TABLE IF NOT EXISTS tool_governance_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id     TEXT NOT NULL,
      rule_type   TEXT NOT NULL,
      pattern     TEXT,
      condition   TEXT,
      enforcement TEXT NOT NULL DEFAULT 'block',
      reason      TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      FOREIGN KEY (tool_id) REFERENCES tool_definitions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_governance_tool_id ON tool_governance_rules(tool_id);

    -- Tool actions audit log
    CREATE TABLE IF NOT EXISTS tool_actions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id           TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      capability        TEXT NOT NULL,
      params_json       TEXT NOT NULL DEFAULT '{}',
      result_summary    TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      governance_checks TEXT NOT NULL DEFAULT '[]',
      duration_ms       INTEGER NOT NULL DEFAULT 0,
      cost_usd          REAL NOT NULL DEFAULT 0.0,
      task_id           TEXT,
      timestamp         TEXT NOT NULL,
      FOREIGN KEY (tool_id) REFERENCES tool_definitions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_actions_agent_ts ON tool_actions(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_actions_tool_ts  ON tool_actions(tool_id, timestamp);

    -- Environments
    CREATE TABLE IF NOT EXISTS environments (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      type              TEXT NOT NULL,
      platform          TEXT,
      platform_version  TEXT,
      config_yaml       TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'unknown',
      last_tested_at    TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
  `,
  down: `
    DROP INDEX IF EXISTS idx_tool_actions_tool_ts;
    DROP INDEX IF EXISTS idx_tool_actions_agent_ts;
    DROP TABLE IF EXISTS tool_actions;
    DROP INDEX IF EXISTS idx_tool_governance_tool_id;
    DROP TABLE IF EXISTS tool_governance_rules;
    DROP INDEX IF EXISTS idx_tool_access_tool_id;
    DROP TABLE IF EXISTS tool_access;
    DROP INDEX IF EXISTS idx_tool_capabilities_tool_id;
    DROP TABLE IF EXISTS tool_capabilities;
    DROP TABLE IF EXISTS tool_definitions;
    DROP TABLE IF EXISTS environments;
  `,
};

/**
 * V1.8a — Rename config_yaml → config_json in tool_definitions + environments.
 * The columns always stored JSON (not YAML); renaming makes the schema self-documenting.
 */
const V1_8A_CONFIG_COLUMN_RENAME: DbMigration = {
  version: "1.8a",
  description: "Rename config_yaml → config_json in tool_definitions and environments",
  up: `
    ALTER TABLE tool_definitions RENAME COLUMN config_yaml TO config_json;
    ALTER TABLE environments     RENAME COLUMN config_yaml TO config_json;
  `,
  down: `
    ALTER TABLE tool_definitions RENAME COLUMN config_json TO config_yaml;
    ALTER TABLE environments     RENAME COLUMN config_json TO config_yaml;
  `,
};

export const TOOL_MIGRATIONS: DbMigration[] = [V1_8_TOOL_INTEGRATION, V1_8A_CONFIG_COLUMN_RENAME];

export function runToolMigrations(db: Database): void {
  runMigrations(db, TOOL_MIGRATIONS);
}
