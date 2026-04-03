// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Step 5: RBAC
 *
 * Generates {workDir}/.system/rbac.yaml from the validated ParsedConfig.
 * This file is always overwritten on every apply — it is never user-editable.
 *
 * Generation logic (from spec):
 *   - Four fixed roles: system_admin, division_head, division_agent, cross_division_reader
 *   - For each unique head.agent in active divisions → assign division_head role
 *   - Tier-based cross-division read access:
 *       T1 → cross_division_reader for ALL active divisions ("*")
 *       T2 → cross_division_reader for T1-headed divisions
 *       T3 → no cross-division access
 *
 * Agent tier is inferred from the agent_id suffix: *-t1 | *-t2 | *-t3.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ParsedConfig } from "../types/config.js";
import type { RBACConfig, AgentAssignment, RoleDefinition, RoleAssignment } from "../types/apply.js";
import { ApplyError, type StepResult } from "../types/apply.js";
import type { Database } from "../utils/db.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("apply-rbac");


const DEFAULT_ROLES: RoleDefinition[] = [
  {
    role: "system_admin",
    permissions: ["*"],
    description: "Full system access (human only)",
  },
  {
    role: "division_head",
    scope: "own_division",
    permissions: [
      "read_all",
      "write_all",
      "approve_tasks",
      "manage_agents",
      "view_audit",
      "view_costs",
      "read_secrets",
      "write_secrets",
      "read_secrets_global",
    ],
  },
  {
    role: "division_agent",
    scope: "own_division",
    permissions: [
      "read_workspace",
      "write_workspace",
      "read_knowledge",
      "read_inbox",
      "write_outbox",
      "create_audit_entry",
      "read_secrets",
      "read_secrets_global",
    ],
  },
  {
    role: "cross_division_reader",
    scope: "specified_divisions",
    permissions: ["read_outbox"],
  },
];


/**
 * Infer agent tier from ID suffix convention: *-t1 | *-t2 | *-t3.
 * Returns null for IDs that don't follow this convention.
 */
export function getAgentTier(agentId: string): 1 | 2 | 3 | null {
  const match = /-(t[123])$/i.exec(agentId);
  if (!match) return null;
  const tier = match[1]?.toLowerCase();
  if (tier === "t1") return 1;
  if (tier === "t2") return 2;
  if (tier === "t3") return 3;
  return null;
}


export function generateRBAC(config: ParsedConfig, db: Database | null = null): RBACConfig {
  // Collect: agent → [divisions it heads] (from divisions.yaml head.agent)
  const agentDivisions = new Map<string, string[]>();
  for (const div of config.activeDivisions) {
    if (!div.head.agent) continue;
    const existing = agentDivisions.get(div.head.agent) ?? [];
    existing.push(div.code);
    agentDivisions.set(div.head.agent, existing);
  }

  // Find T1-headed division codes (T2 agents need read access to these)
  const t1HeadedDivisions = config.activeDivisions
    .filter((d) => d.head.agent && getAgentTier(d.head.agent) === 1)
    .map((d) => d.code);

  // Load all registered agents from agent_definitions DB → division_agent role
  // agent_id → division mapping (non-fatal if table is missing or DB is null)
  const dbAgents: Array<{ id: string; division: string; tier: number }> = [];
  if (db !== null) {
    try {
      const rows = db.prepare<[], { id: string; division: string; tier: number }>(
        "SELECT id, division, tier FROM agent_definitions",
      ).all() as Array<{ id: string; division: string; tier: number }>;
      dbAgents.push(...rows);
    } catch (_err) {
      // Table may not exist yet — non-fatal; head-agents still processed
    }
  }

  const assignments: AgentAssignment[] = [];

  // Track which agents already have assignments (to merge correctly)
  const agentAssignmentMap = new Map<string, RoleAssignment[]>();

  // Head agents → division_head + cross-division reader
  for (const [agent, divisions] of agentDivisions) {
    const tier  = getAgentTier(agent);
    const roles = agentAssignmentMap.get(agent) ?? [];

    for (const divCode of divisions) {
      roles.push({ role: "division_head", division: divCode });
    }

    if (tier === 1) {
      roles.push({ role: "cross_division_reader", divisions: ["*"] });
    } else if (tier === 2 && t1HeadedDivisions.length > 0) {
      roles.push({ role: "cross_division_reader", divisions: [...t1HeadedDivisions] });
    }

    agentAssignmentMap.set(agent, roles);
  }

  // DB agents → division_agent role for their registered division
  for (const row of dbAgents) {
    const roles = agentAssignmentMap.get(row.id) ?? [];

    // Add division_agent if not already a head of this division
    const alreadyHead = roles.some(
      (r) => r.role === "division_head" && "division" in r && r.division === row.division,
    );
    if (!alreadyHead) {
      roles.push({ role: "division_agent", division: row.division });
    }

    // Cross-division reader by DB tier (for agents not in divisions.yaml head)
    if (!agentDivisions.has(row.id)) {
      if (row.tier === 1) {
        roles.push({ role: "cross_division_reader", divisions: ["*"] });
      } else if (row.tier === 2 && t1HeadedDivisions.length > 0) {
        roles.push({ role: "cross_division_reader", divisions: [...t1HeadedDivisions] });
      }
    }

    agentAssignmentMap.set(row.id, roles);
  }

  for (const [agent, roles] of agentAssignmentMap) {
    if (roles.length > 0) {
      assignments.push({ agent, roles });
    }
  }

  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    roles: DEFAULT_ROLES,
    assignments,
  };
}


export function applyRBAC(config: ParsedConfig, workDir: string, db: Database | null = null): StepResult {
  const start = Date.now();

  try {
    const rbac = generateRBAC(config, db);
    const outPath = join(workDir, ".system", "rbac.yaml");

    const yaml =
      "# AUTO-GENERATED by sidjua apply — DO NOT EDIT MANUALLY\n" +
      stringify(rbac, { indent: 2 });

    writeFileSync(outPath, yaml, "utf-8");

    const agentCount = rbac.assignments.length;
    const roleCount = rbac.assignments.reduce((n, a) => n + a.roles.length, 0);

    logger.info("rbac", `Generated rbac.yaml: ${agentCount} agents, ${roleCount} role assignments`);

    return {
      step: "RBAC",
      success: true,
      duration_ms: Date.now() - start,
      summary: `${agentCount} agents → ${roleCount} role assignments`,
      details: { agentCount, roleCount, outPath },
    };
  } catch (err) {
    throw new ApplyError(
      "GENERATION_ERROR",
      "RBAC",
      `RBAC step failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
