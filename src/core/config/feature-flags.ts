// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Feature Flag Infrastructure
 *
 * Provides runtime feature flag management with a three-tier override hierarchy:
 *   1. JSON defaults  — config/feature-flags.json (lowest precedence)
 *   2. Env vars       — SIDJUA_FF_<FLAG_NAME_UPPERCASE> (overrides JSON)
 *   3. DB per-workspace — workspace_config key ff_<name> (highest precedence)
 *
 * Usage:
 *   initFeatureFlags(workDir, db)  — call once at startup
 *   getFeatureFlags()              — returns the singleton manager
 *   manager.isEnabled("memory_consolidation_enabled")
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../logger.js";
import type Database from "better-sqlite3";
import { ensureWorkspaceConfigTable } from "../../api/workspace-config-migration.js";

const logger = createLogger("feature-flags");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeatureFlagMap = Record<string, boolean>;

export interface FeatureFlagState {
  flags:     FeatureFlagMap;
  source:    Record<string, "json" | "env" | "db">;
  loadedAt:  string;
  workDir:   string;
}

// ---------------------------------------------------------------------------
// FeatureFlagManager
// ---------------------------------------------------------------------------

export class FeatureFlagManager {
  private _flags:  FeatureFlagMap = {};
  private _source: Record<string, "json" | "env" | "db"> = {};

  constructor(
    private readonly _workDir: string,
    private readonly _db: InstanceType<typeof Database> | null = null,
  ) {}

  /**
   * Load flags from all sources in precedence order.
   * Idempotent — can be called multiple times to refresh.
   */
  load(): void {
    this._flags  = {};
    this._source = {};

    // Tier 1: JSON defaults
    const jsonFlags = this._loadJsonDefaults();
    for (const [key, val] of Object.entries(jsonFlags)) {
      this._flags[key]  = val;
      this._source[key] = "json";
    }

    // Tier 2: Environment variables (SIDJUA_FF_<NAME_UPPER>)
    for (const key of Object.keys(this._flags)) {
      const envKey = `SIDJUA_FF_${key.toUpperCase()}`;
      const envVal = process.env[envKey];
      if (envVal !== undefined) {
        this._flags[key]  = envVal === "1" || envVal.toLowerCase() === "true";
        this._source[key] = "env";
        logger.info("feature_flag_env_override", `Flag ${key} overridden by env var ${envKey}`, {
          metadata: { key, value: this._flags[key] },
        });
      }
    }

    // Tier 3: DB per-workspace overrides (workspace_config table)
    if (this._db !== null) {
      this._applyDbOverrides();
    }
  }

  /** Check if a flag is enabled. Returns false for unknown flags. */
  isEnabled(key: string): boolean {
    return this._flags[key] ?? false;
  }

  /** Get a flag value (alias for isEnabled). */
  get(key: string): boolean {
    return this.isEnabled(key);
  }

  /** Return all flags. */
  getAll(): FeatureFlagMap {
    return { ...this._flags };
  }

  /** Return the full state including sources. */
  getState(): FeatureFlagState {
    return {
      flags:    this.getAll(),
      source:   { ...this._source },
      loadedAt: new Date().toISOString(),
      workDir:  this._workDir,
    };
  }

  /**
   * Override a flag in the DB for the current workspace.
   * Requires a DB connection — no-op if DB is null.
   */
  setDbOverride(key: string, value: boolean, db?: InstanceType<typeof Database>): void {
    // Reject unknown flags to prevent typo-silently-creating-orphan entries in the DB.
    if (!Object.prototype.hasOwnProperty.call(this._flags, key)) {
      logger.warn("feature_flag_unknown", `Unknown feature flag "${key}" — setDbOverride ignored`, {
        metadata: { key },
      });
      return;
    }
    const target = db ?? this._db;
    if (target === null) {
      logger.warn("feature_flag_set", "No DB available — cannot persist flag override", { metadata: { key } });
      return;
    }
    try {
      this._ensureWorkspaceConfigTable(target);
      target.prepare(
        `INSERT OR REPLACE INTO workspace_config (key, value, updated_at)
         VALUES (?, ?, datetime('now'))`,
      ).run(`ff_${key}`, value ? "true" : "false");
      this._flags[key]  = value;
      this._source[key] = "db";
      logger.info("feature_flag_db_override", `Flag ${key} set to ${value} via DB override`, {
        metadata: { key, value },
      });
    } catch (err: unknown) {
      logger.warn("feature_flag_set_error", "Failed to persist flag override", {
        metadata: { key, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _loadJsonDefaults(): FeatureFlagMap {
    // Look for config/feature-flags.json relative to workDir, then package root
    const candidates = [
      join(this._workDir, "config", "feature-flags.json"),
      join(resolve(this._workDir), "config", "feature-flags.json"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try {
          const raw = readFileSync(candidate, "utf-8");
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const result: FeatureFlagMap = {};
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof v === "boolean") result[k] = v;
            }
            logger.info("feature_flag_loaded", `Loaded ${Object.keys(result).length} feature flags from ${candidate}`, {
              metadata: { path: candidate, count: Object.keys(result).length },
            });
            return result;
          }
        } catch (err: unknown) {
          logger.warn("feature_flag_load_error", `Failed to parse ${candidate}`, {
            metadata: { candidate, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }

    // Return built-in defaults if no JSON file found
    return {
      memory_consolidation_enabled:          false,
      governance_notifications_enabled:      true,
      advanced_cost_tracking_enabled:        false,
      delegation_chain_limits_enabled:       true,
      experimental_reasoning_loop_enabled:   false,
      multi_provider_failover_enabled:       false,
      task_deduplication_enabled:            true,
      audit_verbose_mode_enabled:            false,
    };
  }

  private _applyDbOverrides(): void {
    if (this._db === null) return;
    try {
      this._ensureWorkspaceConfigTable(this._db);
      const rows = this._db.prepare<[], { key: string; value: string }>(
        "SELECT key, value FROM workspace_config WHERE key LIKE 'ff_%'",
      ).all();
      for (const row of rows) {
        const flagKey = row.key.slice(3); // strip "ff_" prefix
        this._flags[flagKey]  = row.value === "true" || row.value === "1";
        this._source[flagKey] = "db";
      }
    } catch (err: unknown) {
      logger.warn("feature_flag_db_load_error", "Failed to load DB flag overrides", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private _ensureWorkspaceConfigTable(db: InstanceType<typeof Database>): void {
    ensureWorkspaceConfigTable(db);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: FeatureFlagManager | null = null;

/**
 * Initialize the singleton feature flag manager.
 * Call once at server startup.
 */
export function initFeatureFlags(
  workDir: string,
  db?: InstanceType<typeof Database> | null,
): FeatureFlagManager {
  _instance = new FeatureFlagManager(workDir, db ?? null);
  _instance.load();
  return _instance;
}

/**
 * Return the singleton feature flag manager.
 * Throws if initFeatureFlags() has not been called first.
 */
export function getFeatureFlags(): FeatureFlagManager {
  if (_instance === null) {
    // Return a no-op manager with built-in defaults if not initialized yet
    const fallback = new FeatureFlagManager(process.cwd(), null);
    fallback.load();
    return fallback;
  }
  return _instance;
}

/** Reset the singleton (for tests only). */
export function _resetFeatureFlags(): void {
  _instance = null;
}
