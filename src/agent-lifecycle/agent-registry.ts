// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5: AgentRegistry
 *
 * CRUD operations on the agent_definitions table.
 * Also provides conversion from AgentLifecycleDefinition → Phase 8 AgentDefinition.
 */

import { sha256hex } from "../core/crypto-utils.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Database } from "../utils/db.js";
import type { AgentDefinition } from "../agents/types.js";
import type {
  AgentLifecycleDefinition,
  AgentDefinitionRow,
  AgentLifecycleStatus,
  RegistryFilters,
} from "./types.js";
import { SidjuaError } from "../core/error-codes.js";
import { createLogger } from "../core/logger.js";
import { MAX_AGENTS_FREE, MAX_AGENTS_FREE_SOFT_LIMIT } from "../core/constants.js";

const logger = createLogger("agent-registry");

/** @deprecated Use MAX_AGENTS_FREE from src/core/constants.ts */
export const FREE_TIER_AGENT_SOFT_LIMIT = MAX_AGENTS_FREE_SOFT_LIMIT;
/** @deprecated Use MAX_AGENTS_FREE from src/core/constants.ts */
export const FREE_TIER_AGENT_HARD_LIMIT = MAX_AGENTS_FREE;


export class AgentRegistry {
  constructor(private readonly db: Database) {}

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  /**
   * Persist a new agent definition to the database.
   * Throws if an agent with the same ID already exists.
   */
  create(def: AgentLifecycleDefinition, createdBy = "system"): AgentDefinitionRow {
    const configYaml = stringifyYaml(def);
    const configHash = hashYaml(configYaml);
    const now    = new Date().toISOString();
    const author = def.created_by ?? createdBy;

    // Atomic count-check + INSERT under BEGIN IMMEDIATE to prevent race conditions
    // where two concurrent requests both observe count < MAX and both succeed.
    const txFn = this.db.transaction((): void => {
      const countRow = this.db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM agent_definitions WHERE status != 'deleted'",
        )
        .get() as { count: number } | undefined;
      const activeCount = countRow?.count ?? 0;

      if (activeCount >= MAX_AGENTS_FREE) {
        throw SidjuaError.from(
          "LIMIT-001",
          `Agent limit reached (${MAX_AGENTS_FREE} for Free tier). Remove unused agents or upgrade to Sidjua Enterprise for unlimited agents.`,
        );
      }

      if (activeCount >= MAX_AGENTS_FREE_SOFT_LIMIT) {
        logger.warn(
          "agent_limit_warning",
          `Agent count at ${activeCount}/${MAX_AGENTS_FREE}. Free tier supports max ${MAX_AGENTS_FREE} agents. Sidjua Enterprise supports unlimited agents.`,
          { metadata: { active_count: activeCount, limit: MAX_AGENTS_FREE } },
        );
      }

      this.insertStmt().run(
        def.id,
        def.name,
        def.tier,
        def.division,
        def.provider,
        def.model,
        def.skill,
        configYaml,
        configHash,
        "stopped",
        now,
        author,
        now,
      );
    });

    txFn.immediate();

    const row = this.getById(def.id);
    if (row === undefined) {
      throw new Error(`Failed to retrieve agent "${def.id}" after creation`);
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /** Get a single agent definition by ID. */
  getById(id: string): AgentDefinitionRow | undefined {
    return this.getByIdStmt().get(id) as AgentDefinitionRow | undefined;
  }

  /** List all agents, optionally filtered. */
  list(filters: RegistryFilters = {}): AgentDefinitionRow[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.division !== undefined) {
      conditions.push("division = ?");
      params.push(filters.division);
    }
    if (filters.tier !== undefined) {
      conditions.push("tier = ?");
      params.push(filters.tier);
    }
    if (filters.status !== undefined) {
      conditions.push("status = ?");
      params.push(filters.status);
    }
    if (filters.provider !== undefined) {
      conditions.push("provider = ?");
      params.push(filters.provider);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM agent_definitions ${where} ORDER BY tier ASC, id ASC`;

    return this.db
      .prepare<(string | number)[], AgentDefinitionRow>(sql)
      .all(...params) as AgentDefinitionRow[];
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  /**
   * Update an agent definition (partial fields).
   * Recomputes config_hash when config fields change.
   */
  update(
    id: string,
    patch: Partial<AgentLifecycleDefinition>,
  ): AgentDefinitionRow {
    const existing = this.getById(id);
    if (existing === undefined) {
      throw new Error(`Agent "${id}" not found`);
    }

    // Merge patch into existing definition for YAML re-serialization
    const existingDef = this.parseConfigYaml(existing.config_yaml);
    const merged: AgentLifecycleDefinition = { ...existingDef, ...patch };

    const newYaml = stringifyYaml(merged);
    const newHash = hashYaml(newYaml);
    const now = new Date().toISOString();

    const cols: string[] = ["config_yaml = ?", "config_hash = ?", "updated_at = ?"];
    const vals: (string | number)[] = [newYaml, newHash, now];

    if (patch.name !== undefined) { cols.push("name = ?"); vals.push(patch.name); }
    if (patch.tier !== undefined) { cols.push("tier = ?"); vals.push(patch.tier); }
    if (patch.division !== undefined) { cols.push("division = ?"); vals.push(patch.division); }
    if (patch.provider !== undefined) { cols.push("provider = ?"); vals.push(patch.provider); }
    if (patch.model !== undefined) { cols.push("model = ?"); vals.push(patch.model); }
    if (patch.skill !== undefined) { cols.push("skill_path = ?"); vals.push(patch.skill); }

    vals.push(id);

    this.db
      .prepare<(string | number)[], void>(
        `UPDATE agent_definitions SET ${cols.join(", ")} WHERE id = ?`,
      )
      .run(...vals);

    const updated = this.getById(id);
    if (updated === undefined) {
      throw new Error(`Agent "${id}" disappeared after update`);
    }
    return updated;
  }

  /**
   * Update only the status field (used by lifecycle commands).
   */
  setStatus(id: string, status: AgentLifecycleStatus): void {
    this.db
      .prepare<[string, string], void>(
        "UPDATE agent_definitions SET status = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(status, id);
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  /**
   * Delete an agent definition.
   * @param keepHistory — if true, only marks as deleted (sets status), preserves audit trail.
   */
  delete(id: string, keepHistory = false): void {
    if (keepHistory) {
      this.db
        .prepare<[string], void>(
          "UPDATE agent_definitions SET status = 'stopped', updated_at = datetime('now') WHERE id = ?",
        )
        .run(id);
      // Also soft-delete by marking with a special status
      this.db
        .prepare<[string], void>(
          "UPDATE agent_definitions SET status = 'deleted', updated_at = datetime('now') WHERE id = ?",
        )
        .run(id);
    } else {
      this.deleteStmt().run(id);
      this.deleteAgentBudgetsStmt().run(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Convert to Phase 8 AgentDefinition (for runtime)
  // ---------------------------------------------------------------------------

  /**
   * Convert an AgentLifecycleDefinition to the Phase 8 AgentDefinition format
   * expected by AgentProcess and AgentLoop.
   */
  toRuntimeDefinition(def: AgentLifecycleDefinition): AgentDefinition {
    return {
      id: def.id,
      name: def.name,
      tier: (def.tier <= 3 ? def.tier : 3) as 1 | 2 | 3,
      provider: def.provider,
      model: def.model,
      skill_file: def.skill,
      division: def.division,
      capabilities: def.capabilities,
      max_concurrent_tasks: def.max_concurrent_tasks ?? 1,
      token_budget_per_task: def.budget?.token_budget_per_task ?? 100_000,
      cost_limit_per_hour: def.budget?.per_hour_usd ?? 10.0,
      checkpoint_interval_ms: (def.checkpoint_interval_seconds ?? 60) * 1000,
      ttl_default_seconds: def.ttl_default_seconds ?? 3600,
      heartbeat_interval_ms: (def.heartbeat_interval_seconds ?? 30) * 1000,
      max_retries: 3,
      metadata: {
        reports_to: def.reports_to,
        max_classification: def.max_classification,
        tags: def.tags,
        created_by: def.created_by,
        ...(def.fallback_provider !== undefined ? { fallback_provider: def.fallback_provider } : {}),
        ...(def.fallback_model !== undefined ? { fallback_model: def.fallback_model } : {}),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  parseConfigYaml(yaml: string): AgentLifecycleDefinition {
    return parseYaml(yaml) as AgentLifecycleDefinition;
  }

  // ---------------------------------------------------------------------------
  // Prepared statements
  // ---------------------------------------------------------------------------

  private insertStmt() {
    return this.db.prepare<
      [string, string, number, string, string, string, string, string, string, string, string, string, string],
      void
    >(`
      INSERT INTO agent_definitions
        (id, name, tier, division, provider, model, skill_path, config_yaml, config_hash, status, created_at, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  private getByIdStmt() {
    return this.db.prepare<[string], AgentDefinitionRow>(
      "SELECT * FROM agent_definitions WHERE id = ?",
    );
  }

  private deleteStmt() {
    return this.db.prepare<[string], void>(
      "DELETE FROM agent_definitions WHERE id = ?",
    );
  }

  private deleteAgentBudgetsStmt() {
    return this.db.prepare<[string], void>(
      "DELETE FROM agent_budgets WHERE agent_id = ?",
    );
  }
}


function hashYaml(yaml: string): string {
  return sha256hex(yaml).slice(0, 16);
}
