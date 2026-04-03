// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Step 10: FINALIZE
 *
 * Writes the apply state file and auto-generates the workspace README.
 *
 * Operations:
 *   1. Compute governance_hash (hash of governance/ directory file listing)
 *   2. Load existing state.json (if present) to preserve history
 *   3. Write {workDir}/.system/state.json with updated last_apply + appended history
 *   4. Write {workDir}/README.md (always overwritten — auto-generated navigation)
 *
 * The state file is the apply audit trail — it is always overwritten with the
 * latest run details while history is appended (never truncated).
 */

import { sha256hex } from "../core/crypto-utils.js";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedConfig } from "../types/config.js";
import type { ApplyHistoryEntry, LastApplyState, StateFile } from "../types/apply.js";
import { ApplyError, type StepResult } from "../types/apply.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("apply-finalize");


/**
 * Compute a SHA-256 hash of the governance/ directory's file listing.
 * Used to detect configuration drift between apply runs.
 * Returns sha256("") if the directory does not exist.
 */
function computeGovernanceHash(workDir: string): string {
  const govDir = join(workDir, "governance");
  if (!existsSync(govDir)) {
    return sha256hex("");
  }

  // Node 22: readdirSync with recursive returns relative file paths
  const entries = readdirSync(govDir, { recursive: true }) as string[];
  const sorted = entries.sort().join("\n");
  return sha256hex(sorted);
}

/**
 * Load and parse the existing state.json.
 * Returns null if the file does not exist or is malformed.
 */
function loadExistingState(statePath: string): StateFile | null {
  if (!existsSync(statePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    return raw as StateFile;
  } catch (e: unknown) {
    logger.debug("finalize", "State file not found or malformed — starting fresh", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    return null;
  }
}

/**
 * Count unique non-null head.agent values across ALL divisions
 * (active + inactive) — represents agents configured in the workspace.
 */
function countAgents(config: ParsedConfig): number {
  const agents = new Set<string>();
  for (const div of config.divisions) {
    if (div.head.agent) {
      agents.add(div.head.agent);
    }
  }
  return agents.size;
}

/**
 * Determine what changed vs the previous apply run.
 * Returns human-readable change descriptions for the history entry.
 */
function computeChanges(
  config: ParsedConfig,
  existing: StateFile | null,
  divisionsYamlHash: string,
): string[] {
  const changes: string[] = [];

  if (!existing) {
    changes.push("initial setup");
    changes.push(`${config.activeDivisions.length} active divisions`);
    return changes;
  }

  const prevActive = new Set(existing.last_apply.active_divisions);
  const currActive = new Set(config.activeDivisions.map((d) => d.code));

  for (const code of currActive) {
    if (!prevActive.has(code)) changes.push(`added division: ${code}`);
  }
  for (const code of prevActive) {
    if (!currActive.has(code)) changes.push(`deactivated division: ${code}`);
  }

  if (existing.last_apply.divisions_yaml_hash !== divisionsYamlHash) {
    if (changes.length === 0) changes.push("divisions.yaml updated");
  } else {
    if (changes.length === 0) changes.push("re-apply (no structural changes)");
  }

  return changes;
}


function generateReadme(config: ParsedConfig): string {
  const { company, mode, activeDivisions, divisions } = config;
  const inactive = divisions.filter((d) => !d.active);
  const now = new Date().toISOString();

  const divRows = activeDivisions
    .map((d) => {
      const scope = d.scope || "—";
      const agent = d.head.agent ?? "unassigned";
      return `| ${d.code} | ${d.name.en ?? d.code} | ${scope} | ${agent} |`;
    })
    .join("\n");

  const inactiveList =
    inactive.length > 0 ? inactive.map((d) => `- \`${d.code}\``).join("\n") : "_none_";

  return [
    `# ${company.name} — AI Agent Workspace`,
    "",
    `**Mode:** ${mode} | **Size:** ${company.size} | **Last updated:** ${now.slice(0, 10)}`,
    "",
    `## Active Divisions (${activeDivisions.length})`,
    "",
    "| Code | Name | Scope | Head Agent |",
    "|------|------|-------|------------|",
    divRows,
    "",
    `## Inactive Divisions (${inactive.length})`,
    "",
    inactiveList,
    "",
    "## System Files",
    "",
    "| File | Description |",
    "|------|-------------|",
    "| `.system/state.json` | Apply state and run history |",
    "| `.system/routing-table.yaml` | Agent routing table |",
    "| `.system/rbac.yaml` | Role-based access control assignments |",
    "| `.system/cost-centers.yaml` | Budget configuration per division |",
    "| `.system/sidjua.db` | Main SQLite database |",
    "| `.system/secrets.db` | Encrypted secrets store |",
    "",
    "## Governance",
    "",
    "| Path | Description |",
    "|------|-------------|",
    "| `governance/audit/audit-config.yaml` | Audit retention and event configuration |",
    "| `governance/audit/reports/` | Exported audit reports |",
    "",
    "---",
    "",
    `*Auto-generated by \`sidjua apply\`. Do not edit manually — changes will be overwritten.*`,
    "",
  ].join("\n");
}


/**
 * @param applyDurationMs Total elapsed milliseconds for the entire apply run
 *                        (passed from the orchestrator to populate state.json)
 */
export function applyFinalize(
  config: ParsedConfig,
  workDir: string,
  applyDurationMs: number,
): StepResult {
  const start = Date.now();

  try {
    const statePath = join(workDir, ".system", "state.json");
    const readmePath = join(workDir, "README.md");

    const divisionsYamlHash = `sha256:${config.contentHash}`;
    const governanceHash = `sha256:${computeGovernanceHash(workDir)}`;
    const existing = loadExistingState(statePath);
    const changes = computeChanges(config, existing, divisionsYamlHash);
    const timestamp = new Date().toISOString();

    // Build the last_apply section
    const lastApply: LastApplyState = {
      timestamp,
      divisions_yaml_hash: divisionsYamlHash,
      governance_hash: governanceHash,
      mode: config.mode,
      active_divisions: config.activeDivisions.map((d) => d.code),
      inactive_divisions: config.divisions.filter((d) => !d.active).map((d) => d.code),
      db_version: "1.0",
      agent_count: countAgents(config),
      apply_duration_ms: applyDurationMs,
    };

    // Build history: append new entry to existing history
    const newEntry: ApplyHistoryEntry = {
      timestamp,
      action: "apply",
      changes,
    };
    const history = [...(existing?.history ?? []), newEntry];

    const state: StateFile = {
      schema_version: "1.0",
      last_apply: lastApply,
      history,
    };

    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    logger.debug("finalize", `Written state.json (history length: ${history.length})`);

    // Generate README.md (always overwrite)
    const readme = generateReadme(config);
    writeFileSync(readmePath, readme, "utf-8");
    logger.debug("finalize", "Written README.md");

    logger.info("finalize", `State file + README written (history entries: ${history.length})`);

    return {
      step: "FINALIZE",
      success: true,
      duration_ms: Date.now() - start,
      summary: `state.json + README.md written`,
      details: {
        statePath,
        readmePath,
        historyLength: history.length,
        changes,
      },
    };
  } catch (err) {
    throw new ApplyError(
      "FILESYSTEM_ERROR",
      "FINALIZE",
      `Finalize step failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
