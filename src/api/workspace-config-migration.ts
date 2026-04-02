// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Workspace Config DB Migration (V2.1)
 *
 * Adds a key-value `workspace_config` table for server-side GUI configuration.
 * First use-case: first_run_completed flag for the expectations overlay (P188).
 *
 * Applied lazily by runWorkspaceConfigMigration() before config route queries.
 */

import type { Database, DbMigration } from "../utils/db.js";
import { runMigrations } from "../utils/db.js";


const V2_1_WORKSPACE_CONFIG: DbMigration = {
  version: "2.1",
  description: "workspace config key-value table for server-side GUI settings",
  up: `
    CREATE TABLE IF NOT EXISTS workspace_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO workspace_config (key, value)
      VALUES ('first_run_completed', '0');

    INSERT OR IGNORE INTO workspace_config (key, value)
      VALUES ('locale', 'en');

    INSERT OR IGNORE INTO workspace_config (key, value)
      VALUES ('bouncer_enabled', 'true');

    INSERT OR IGNORE INTO workspace_config (key, value)
      VALUES ('bouncer_sensitivity', 'normal');
  `,
  down: `
    DROP TABLE IF EXISTS workspace_config;
  `,
};

export const WORKSPACE_CONFIG_MIGRATIONS: DbMigration[] = [V2_1_WORKSPACE_CONFIG];


/**
 * Ensure the workspace_config table exists.
 * Idempotent — safe to call multiple times.
 */
export function runWorkspaceConfigMigration(db: Database): void {
  runMigrations(db, WORKSPACE_CONFIG_MIGRATIONS);
}
