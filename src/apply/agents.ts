// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P282: AGENTS apply step
 *
 * Idempotently registers all known agent definitions in agent_definitions:
 *   1. Starter agents from src/defaults/roles/*.yaml
 *   2. User-defined agents from {workDir}/agents/definitions/*.yaml
 *
 * Uses INSERT … ON CONFLICT DO UPDATE so re-running produces the same result.
 * The V1.5 lifecycle migration is applied lazily here so `sidjua apply` does
 * not require the lifecycle module to have been separately initialized.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join }                                   from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { sha256hex }         from "../core/crypto-utils.js";
import { runMigrations105 }  from "../agent-lifecycle/migration.js";
import { loadDefaultRoles }  from "../defaults/loader.js";
import { ApplyError, type StepResult } from "../types/apply.js";
import type { Database }     from "../utils/db.js";
import type { ParsedConfig } from "../types/config.js";
import { createLogger }      from "../core/logger.js";
import { MAX_AGENTS_FREE }   from "../core/constants.js";

const logger = createLogger("apply-agents");


// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface AgentEntry {
  id:          string;
  name:        string;
  tier:        number;
  division:    string;
  provider:    string;
  model:       string;
  skill_path:  string;
  config_yaml: string;
  config_hash: string;
  status:      string;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashYaml(yaml: string): string {
  return sha256hex(yaml).slice(0, 16);
}

/** Build an AgentEntry from a starter role (src/defaults/roles/). */
function buildStarterEntry(role: ReturnType<typeof loadDefaultRoles>[number]): AgentEntry {
  const configYaml = stringifyYaml({ role });
  return {
    id:          role.id,
    name:        role.name,
    tier:        role.tier,
    division:    role.division,
    provider:    "auto",
    model:       "auto",
    skill_path:  "",
    config_yaml: configYaml,
    config_hash: hashYaml(configYaml),
    status:      "stopped",
  };
}

/**
 * Parse a user-defined agent YAML from {workDir}/agents/definitions/.
 * Accepts both "role:" and "agent:" top-level keys.
 * Returns null on malformed files so the step continues non-fatally.
 */
export function parseUserAgentFile(filePath: string): AgentEntry | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const doc = parseYaml(raw) as Record<string, unknown>;

    const node = (doc["role"] ?? doc["agent"]) as Record<string, unknown> | undefined;
    if (!node || typeof node !== "object") return null;

    const id       = node["id"];
    const name     = node["name"];
    const tier     = node["tier"] ?? 3;
    const division = node["division"] ?? "workspace";
    const provider = node["provider"] ?? "auto";

    // model: prefer explicit "model" field; only fall back to recommended_model.suggested
    // when provider is explicitly set (not "auto") to avoid contradictory provider/model pairs
    let model: unknown = node["model"] ?? "auto";
    if (typeof provider === "string" && provider !== "auto") {
      const recModel = node["recommended_model"];
      if (typeof recModel === "object" && recModel !== null) {
        model = (recModel as Record<string, unknown>)["suggested"] ?? model;
      }
    }

    if (typeof id !== "string" || id.trim() === "") return null;
    if (typeof name !== "string" || name.trim() === "") return null;

    return {
      id:          id.trim(),
      name:        name.trim(),
      tier:        typeof tier === "number" ? Math.min(Math.max(Math.round(tier), 1), 7) : 3,
      division:    typeof division === "string" ? division : "workspace",
      provider:    typeof provider === "string" ? provider : "auto",
      model:       typeof model === "string" ? model : "auto",
      skill_path:  "",
      config_yaml: raw,
      config_hash: hashYaml(raw),
      status:      "stopped",
    };
  } catch (_err) {
    return null;
  }
}

/** Upsert one agent row — idempotent (INSERT … ON CONFLICT DO UPDATE). */
export function upsertAgentRow(db: Database, entry: AgentEntry, now: string): void {
  // Enforce Free tier agent limit (same check as AgentRegistry.create).
  // Only applies to NEW agents — updating an existing agent is always allowed.
  const existing = db.prepare<[string], { id: string }>(
    "SELECT id FROM agent_definitions WHERE id = ?",
  ).get(entry.id);

  if (existing === undefined) {
    const countRow = db.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM agent_definitions WHERE status != 'deleted'",
    ).get() as { count: number } | undefined;
    const total = countRow?.count ?? 0;

    if (total >= MAX_AGENTS_FREE) {
      throw new Error(
        `Agent limit reached (${MAX_AGENTS_FREE} for Free tier). ` +
        `Remove unused agents or upgrade to SIDJUA Enterprise.`,
      );
    }
  }

  db.prepare<
    [string, string, number, string, string, string, string, string, string, string, string, string, string],
    void
  >(`
    INSERT INTO agent_definitions
      (id, name, tier, division, provider, model, skill_path,
       config_yaml, config_hash, status, created_at, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      tier        = excluded.tier,
      division    = excluded.division,
      provider    = excluded.provider,
      model       = excluded.model,
      skill_path  = CASE WHEN excluded.skill_path != ''
                         THEN excluded.skill_path
                         ELSE agent_definitions.skill_path END,
      config_yaml = excluded.config_yaml,
      config_hash = excluded.config_hash,
      updated_at  = excluded.updated_at
  `).run(
    entry.id,
    entry.name,
    entry.tier,
    entry.division,
    entry.provider,
    entry.model,
    entry.skill_path,
    entry.config_yaml,
    entry.config_hash,
    entry.status,
    now,
    "apply",
    now,
  );
}


// ---------------------------------------------------------------------------
// Main step function
// ---------------------------------------------------------------------------

/**
 * AGENTS step — register starter and user-defined agents in agent_definitions.
 *
 * Idempotent: safe to run on every `sidjua apply`.
 * The V1.5 lifecycle migration (agent_definitions table) is applied lazily.
 */
export function applyAgents(
  _config: ParsedConfig,
  workDir: string,
  db:      Database,
): StepResult {
  const start = Date.now();

  try {
    // Ensure agent_definitions table exists (V1.5 + V1.6 + later migrations)
    runMigrations105(db);

    const now = new Date().toISOString();

    // Pre-loop guard: count non-deleted agents before ANY bulk insert.
    // This surfaces the limit as a clear early error rather than a mid-transaction throw,
    // and ensures the total across both starter + user loops is bounded atomically.
    const countBefore = db.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM agent_definitions WHERE status != 'deleted'",
    ).get() as { count: number } | undefined;
    const existingTotal = countBefore?.count ?? 0;

    if (existingTotal >= MAX_AGENTS_FREE) {
      logger.warn(
        "agents",
        `Agent limit reached (${existingTotal}/${MAX_AGENTS_FREE} non-deleted). ` +
        `No new agents will be registered. Remove unused agents or upgrade to Enterprise.`,
      );
      return {
        step:        "AGENTS",
        success:     true,
        duration_ms: Date.now() - start,
        summary:     `Agent limit reached (${existingTotal}/${MAX_AGENTS_FREE}) — no new agents registered`,
        details: { starter_registered: 0, user_registered: 0, user_skipped: 0 },
      };
    }

    // 1. Starter agents from src/defaults/roles/
    let starterCount = 0;
    let starterError: string | null = null;
    try {
      const roles = loadDefaultRoles();
      db.transaction(() => {
        for (const role of roles) {
          upsertAgentRow(db, buildStarterEntry(role), now);
          starterCount++;
        }
      })();
    } catch (err) {
      starterError = err instanceof Error ? err.message : String(err);
      logger.warn("agents", `Starter agents load failed (non-fatal): ${starterError}`);
    }

    // 2. User-defined agents from {workDir}/agents/definitions/
    let userCount   = 0;
    let userSkipped = 0;
    const definitionsDir = join(workDir, "agents", "definitions");
    if (existsSync(definitionsDir)) {
      const files = readdirSync(definitionsDir).filter((f) => f.endsWith(".yaml"));
      db.transaction(() => {
        for (const file of files) {
          const entry = parseUserAgentFile(join(definitionsDir, file));
          if (entry === null) {
            userSkipped++;
            logger.warn("agents", `Skipped malformed agent YAML: ${file}`);
            continue;
          }
          upsertAgentRow(db, entry, now);
          userCount++;
        }
      })();
    }

    const parts: string[] = [
      `${starterCount} starter agents registered`,
      `${userCount} user agents registered`,
    ];
    if (userSkipped  > 0) parts.push(`${userSkipped} files skipped`);
    if (starterError !== null) parts.push(`starter load warning: ${starterError}`);
    const summary = parts.join(", ");

    logger.info("agents", summary);

    return {
      step:        "AGENTS",
      success:     true,
      duration_ms: Date.now() - start,
      summary,
      details: {
        starter_registered: starterCount,
        user_registered:    userCount,
        user_skipped:       userSkipped,
      },
    };
  } catch (err) {
    throw new ApplyError(
      "DATABASE_ERROR",
      "AGENTS",
      `AGENTS step failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
