// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Migration 1.0.1 → 1.0.2
 *
 * Adds tables introduced by the blue/green update infrastructure:
 *   - agent_checkpoints: cross-version agent state persistence
 *   - agent_freeze_audit: append-only freeze/resume audit log
 *   - schema_version: tracks applied cross-version migrations
 *
 * All DDL uses IF NOT EXISTS — safe to run multiple times.
 */

import { join }          from "node:path";
import { openDatabase }  from "../../../utils/db.js";
import { createLogger }  from "../../logger.js";
import type { VersionedMigration } from "./index.js";

const logger = createLogger("migration-1.0.1-to-1.0.2");

export const migration_1_0_1_to_1_0_2: VersionedMigration = {
  from: "1.0.1",
  to:   "1.0.2",

  async up(workDir: string): Promise<void> {
    const dbPath = join(workDir, ".system", "sidjua.db");
    const db = openDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_checkpoints (
          id           TEXT PRIMARY KEY,
          version      TEXT NOT NULL,
          status       TEXT NOT NULL,
          memory       TEXT,
          current_task TEXT,
          last_step    TEXT,
          updated_at   TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_freeze_audit (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          event         TEXT NOT NULL,
          triggered_by  TEXT NOT NULL,
          active_agents INTEGER NOT NULL DEFAULT 0,
          timestamp     TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version    TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `);

      db.prepare<[string], void>(
        "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
      ).run("1.0.2");

      logger.info("migration-1.0.1-to-1.0.2", "Migration up() complete");
    } finally {
      db.close();
    }
  },

  async down(workDir: string): Promise<void> {
    const dbPath = join(workDir, ".system", "sidjua.db");
    const db = openDatabase(dbPath);
    try {
      // These tables are new in 1.0.2 — safe to drop on rollback
      db.exec("DROP TABLE IF EXISTS agent_checkpoints");
      db.exec("DROP TABLE IF EXISTS agent_freeze_audit");
      db.prepare<[string], void>(
        "DELETE FROM schema_version WHERE version = ?",
      ).run("1.0.2");
      logger.info("migration-1.0.1-to-1.0.2", "Migration down() complete");
    } finally {
      db.close();
    }
  },
};
