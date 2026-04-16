// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P642: Agent Tool-Call System
 *
 * Provides tool execution for agents with REST endpoint and shared executor.
 *
 * Authorization matrix:
 *   HR:    create_agent_role, update_agent_role, create_division, update_division, list_agents, list_divisions, ask_agent
 *   Guide: list_agents, list_divisions, ask_agent
 *   All:   ask_agent
 *
 * POST /api/v1/agents/:agentId/tool-call
 */

import { Hono }                                        from "hono";
import { requireScope }                               from "../middleware/require-scope.js";
import { existsSync, mkdirSync, readdirSync,
         readFileSync, writeFileSync }                 from "node:fs";
import { join }                                        from "node:path";
import { createLogger }                                from "../../core/logger.js";
import { SidjuaError }                                 from "../../core/error-codes.js";
import { loadDefaultRoles, loadDefaultDivisions,
         buildSystemPrompt }                           from "../../defaults/loader.js";
import { getProviderForAgent }                         from "../../core/provider-config.js";
import { CostTracker }                                 from "../../provider/cost-tracker.js";
import { runMigrations105 }                            from "../../agent-lifecycle/migration.js";
import { sha256hex }                                   from "../../core/crypto-utils.js";
import type { Database as BetterSqliteDb }             from "../../utils/db.js";
import type { CallerContext }                          from "../caller-context.js";
import type { Database }                               from "better-sqlite3";
import { isToolVisibleForAgent, type AgentVisibilityContext } from "../../tool-integration/tool-visibility.js";
import type { ToolAccess }                             from "../../tool-integration/types.js";
import { scanForSensitiveData }                        from "../../core/bouncer/sensitive-filter.js";
import { getBouncerConfig }                            from "../../core/bouncer/bouncer-config.js";

export type { AgentVisibilityContext };

export type { CallerContext };

const logger = createLogger("agent-tools");

const MAX_ASK_DEPTH     = 3;
/** Hard limit on YAML agent-definition files (mirrors AgentRegistry DB limit). */
const MAX_AGENT_FILES   = 100;
/** Estimated cost per ask_agent LLM call for budget pre-check (USD). */
const ASK_AGENT_COST_ESTIMATE_USD = 0.001;

const TOOL_GRANTS: Readonly<Record<string, ReadonlySet<string>>> = {
  hr:    new Set(["create_agent_role", "update_agent_role", "create_division", "update_division", "list_agents", "list_divisions", "ask_agent"]),
  guide: new Set(["list_agents", "list_divisions", "ask_agent"]),
};

/** Tools that mutate system configuration — require operator-level caller. */
const MUTATION_TOOLS = new Set(["create_agent_role", "update_agent_role", "create_division", "update_division"]);

/** Returns the set of tools this agent is authorized to call. */
export function getAllowedTools(agentId: string): ReadonlySet<string> {
  return TOOL_GRANTS[agentId] ?? new Set<string>(["ask_agent"]);
}

export interface ToolCallContext {
  workDir:        string;
  db:             Database | null;
  /** Current recursion depth for ask_agent calls. */
  depth:          number;
  /** V1.0: always "operator" for authenticated callers. V1.1: from scoped token. */
  callerContext?: CallerContext;
}

export interface ToolCallResult {
  success: boolean;
  data?:   unknown;
  error?:  string;
}

// ---------------------------------------------------------------------------
// Governance audit log (in-memory, mirrors secrets.ts pattern)
// ---------------------------------------------------------------------------

export interface ToolAuditEvent {
  type:        "TOOL_CALL" | "CONFIG_MUTATION";
  agentId:     string;
  toolName:    string;
  allowed:     boolean;
  reason?:     string;
  /** Keys present in params — values omitted to avoid logging sensitive data. */
  paramKeys:   string[];
  callerRole?: string;
  timestamp:   string;
  subtype?:    string;    // for CONFIG_MUTATION: the specific tool name
  targetId?:   string;    // for CONFIG_MUTATION: the created entity id
}

/** In-memory audit log — for tests; cleared by clearToolAuditLog(). */
export const _toolAuditEvents: ToolAuditEvent[] = [];
const MAX_TOOL_AUDIT_EVENTS = 1000;

/** Return a copy of the tool audit log. */
export function getToolAuditLog(): ToolAuditEvent[] {
  return [..._toolAuditEvents];
}

/** Clear the tool audit log (call in test beforeEach). */
export function clearToolAuditLog(): void {
  _toolAuditEvents.length = 0;
}

function recordAuditEvent(event: ToolAuditEvent): void {
  _toolAuditEvents.push(event);
  if (_toolAuditEvents.length > MAX_TOOL_AUDIT_EVENTS) {
    _toolAuditEvents.splice(0, _toolAuditEvents.length - MAX_TOOL_AUDIT_EVENTS);
  }
  logger.debug("tool_audit", `Tool ${event.allowed ? "allowed" : "denied"}: ${event.toolName}`, {
    metadata: {
      agent_id:    event.agentId,
      tool:        event.toolName,
      allowed:     event.allowed,
      caller_role: event.callerRole,
    },
  });
}

// ---------------------------------------------------------------------------
// Governance check
// ---------------------------------------------------------------------------

interface ToolGovernanceContext {
  agentId:       string;
  toolName:      string;
  params:        Record<string, unknown>;
  callerContext: CallerContext;
  db?:           Database | null;
}

interface GovernanceResult {
  allowed: boolean;
  reason?: string;
}

function checkToolGovernance(ctx: ToolGovernanceContext): GovernanceResult {
  const { agentId, toolName, params, callerContext } = ctx;

  // 1. Verify agent exists and is active — prefer DB, fall back to YAML
  let agentExists = false;
  if (ctx.db !== null && ctx.db !== undefined) {
    try {
      const row = ctx.db.prepare<[string], { status: string }>(
        "SELECT status FROM agent_definitions WHERE id = ?",
      ).get(agentId);
      agentExists = row !== undefined && row.status === "active";
    } catch (_dbErr: unknown) {
      // DB check failed — fall back to YAML
      try {
        const roles = loadDefaultRoles();
        agentExists = roles.some((r) => r.id === agentId && r.status === "active");
      } catch (_loadErr: unknown) { /* treat as exists=false */ }
    }
  } else {
    try {
      const roles = loadDefaultRoles();
      agentExists = roles.some((r) => r.id === agentId && r.status === "active");
    } catch (_loadErr: unknown) { /* treat as exists=false */ }
  }

  const roleField = callerContext.role !== undefined ? { callerRole: callerContext.role } : {};

  if (!agentExists) {
    const result = { allowed: false, reason: `Agent "${agentId}" not found or not active` };
    recordAuditEvent({
      type:      "TOOL_CALL",
      agentId,
      toolName,
      allowed:   false,
      reason:    result.reason,
      paramKeys: Object.keys(params),
      timestamp: new Date().toISOString(),
      ...roleField,
    });
    return result;
  }

  // 2. Check authorization matrix
  const allowed = getAllowedTools(agentId);
  if (!allowed.has(toolName)) {
    const result = { allowed: false, reason: `Agent "${agentId}" is not authorized to use tool "${toolName}"` };
    recordAuditEvent({
      type:      "TOOL_CALL",
      agentId,
      toolName,
      allowed:   false,
      reason:    result.reason,
      paramKeys: Object.keys(params),
      timestamp: new Date().toISOString(),
      ...roleField,
    });
    return result;
  }

  // 3. Mutation tools require operator-level caller
  if (MUTATION_TOOLS.has(toolName)) {
    const isOperator = callerContext.role === "operator" || callerContext.role === "admin";
    if (!isOperator) {
      const result = { allowed: false, reason: `Tool "${toolName}" requires operator access` };
      recordAuditEvent({
        type:      "TOOL_CALL",
        agentId,
        toolName,
        allowed:   false,
        reason:    result.reason,
        paramKeys: Object.keys(params),
        timestamp: new Date().toISOString(),
        ...roleField,
      });
      return result;
    }
  }

  // Allowed — log and return
  recordAuditEvent({
    type:      "TOOL_CALL",
    agentId,
    toolName,
    allowed:   true,
    paramKeys: Object.keys(params),
    timestamp: new Date().toISOString(),
    ...roleField,
  });

  return { allowed: true };
}


function toolListAgents(): ToolCallResult {
  try {
    const roles = loadDefaultRoles();
    return {
      success: true,
      data: roles.map((r) => ({
        id:          r.id,
        name:        r.name,
        tier:        r.tier,
        division:    r.division,
        description: r.description,
        status:      r.status,
        capabilities: r.capabilities,
      })),
    };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function toolListDivisions(): ToolCallResult {
  try {
    const divisions = loadDefaultDivisions();
    return {
      success: true,
      data: divisions.map((d) => ({
        id:          d.id,
        name:        d.name,
        protected:   d.protected,
        description: d.description,
        agents:      d.agents,
        budget:      d.budget,
      })),
    };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function toolCreateAgentRole(
  params:        Record<string, unknown>,
  workDir:       string,
  callerAgentId: string,
  db?:           Database | null,
): Promise<ToolCallResult> {
  const roleId       = params["role_id"];
  const name         = params["name"];
  const description  = typeof params["description"] === "string" ? params["description"] : "";
  const tier         = params["tier"] ?? 3;
  const division     = params["division"] ?? "workspace";
  const capabilities = params["capabilities"];
  const icon         = params["icon"] ?? "bot";

  if (typeof roleId !== "string" || !/^[a-z0-9-]+$/.test(roleId)) {
    return { success: false, error: "role_id must be a lowercase alphanumeric slug (hyphens allowed)" };
  }
  if (typeof name !== "string" || name.trim() === "") {
    return { success: false, error: "name is required" };
  }
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    return { success: false, error: "tier must be 1, 2, or 3" };
  }

  const caps: string[] = Array.isArray(capabilities)
    ? (capabilities as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  const definitionsDir = join(workDir, "agents", "definitions");
  if (!existsSync(definitionsDir)) {
    mkdirSync(definitionsDir, { recursive: true });
  }

  // Enforce hard agent limit via DB count (consistent + race-condition-free).
  if (db !== null && db !== undefined) {
    const countRow = db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM agent_definitions WHERE status != 'deleted'")
      .get() as { count: number } | undefined;
    if ((countRow?.count ?? 0) >= MAX_AGENT_FILES) {
      return { success: false, error: `AGT-006: Agent limit reached (max ${MAX_AGENT_FILES}). Remove unused agents or upgrade to Enterprise.` };
    }
  } else {
    // Fallback when DB is unavailable: use file count
    const existingFiles = readdirSync(definitionsDir).filter((f) => f.endsWith(".yaml"));
    if (existingFiles.length >= MAX_AGENT_FILES) {
      return { success: false, error: `LIMIT-001: Agent file limit reached (max ${MAX_AGENT_FILES})` };
    }
  }

  const targetPath = join(definitionsDir, `${roleId}.yaml`);
  if (existsSync(targetPath)) {
    return { success: false, error: `Agent role "${roleId}" already exists at ${targetPath}` };
  }

  const capsYaml = caps.length > 0
    ? caps.map((c) => `    - ${c}`).join("\n")
    : "    - General assistance";

  const yaml = [
    `role:`,
    `  id: ${roleId}`,
    `  name: ${name.trim()}`,
    `  tier: ${tier}`,
    `  division: ${division}`,
    `  description: "${String(description).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    `  icon: ${icon}`,
    `  domains:`,
    `    - general`,
    `  status: active`,
    `  capabilities:`,
    capsYaml,
    `  recommended_model:`,
    `    min_quality: "B+"`,
    `    suggested: "groq-llama70b-free"`,
  ].join("\n");

  try {
    writeFileSync(targetPath, yaml + "\n", "utf-8");

    // Sync to DB immediately so the new agent is discoverable without a full apply.
    if (db !== null && db !== undefined) {
      try {
        const typedDb = db as unknown as BetterSqliteDb;
        runMigrations105(typedDb);
        const now = new Date().toISOString();
        typedDb.prepare(`
          INSERT INTO agent_definitions
            (id, name, tier, division, provider, model, skill_path,
             config_yaml, config_hash, status, created_at, created_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, 'tool', ?)
          ON CONFLICT(id) DO UPDATE SET
            name        = excluded.name,
            tier        = excluded.tier,
            division    = excluded.division,
            config_yaml = excluded.config_yaml,
            config_hash = excluded.config_hash,
            updated_at  = excluded.updated_at
        `).run(
          roleId,
          typeof name === "string" ? name.trim() : String(name),
          typeof tier === "number" ? tier : 3,
          typeof division === "string" ? division : "workspace",
          "auto",
          "groq-llama70b-free",
          "",
          yaml,
          sha256hex(yaml).slice(0, 16),
          now,
          now,
        );
        logger.debug("agent_role_db_sync", `Synced agent ${roleId} to DB`, {
          metadata: { role_id: roleId },
        });
      } catch (dbErr) {
        // Non-fatal — DB sync failure must not fail the tool call
        logger.warn("agent_role_db_sync", `DB sync skipped: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`, {
          metadata: { role_id: roleId },
        });
      }
    }

    logger.info("agent_role_created", `Created agent role ${roleId}`, {
      metadata: { role_id: roleId, path: targetPath },
    });
    recordAuditEvent({
      type:      "CONFIG_MUTATION",
      agentId:   callerAgentId,
      toolName:  "create_agent_role",
      allowed:   true,
      paramKeys: Object.keys(params),
      timestamp: new Date().toISOString(),
      subtype:   "create_agent_role",
      targetId:  roleId,
    });
    return { success: true, data: { role_id: roleId, path: targetPath } };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function toolCreateDivision(
  params:  Record<string, unknown>,
  workDir: string,
  callerAgentId: string,
): ToolCallResult {
  const id          = params["id"];
  const name        = params["name"];
  const description = typeof params["description"] === "string" ? params["description"] : "";
  const dailyLimit  = typeof params["daily_limit_usd"] === "number" ? params["daily_limit_usd"] : 5.0;
  const monthlyCap  = typeof params["monthly_cap_usd"] === "number" ? params["monthly_cap_usd"] : 50.0;
  const protected_  = params["protected"] === true;

  if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) {
    return { success: false, error: "id must be a lowercase alphanumeric slug (hyphens allowed)" };
  }
  if (typeof name !== "string" || name.trim() === "") {
    return { success: false, error: "name is required" };
  }
  if (dailyLimit <= 0) {
    return { success: false, error: "daily_limit_usd must be a positive number" };
  }
  if (monthlyCap <= 0) {
    return { success: false, error: "monthly_cap_usd must be a positive number" };
  }

  const divisionsDir = join(workDir, "governance", "divisions");
  if (!existsSync(divisionsDir)) {
    mkdirSync(divisionsDir, { recursive: true });
  }

  const targetPath = join(divisionsDir, `${id}.yaml`);
  if (existsSync(targetPath)) {
    return { success: false, error: `Division "${id}" already exists at ${targetPath}` };
  }

  const yaml = [
    `division:`,
    `  id: ${id}`,
    `  name: ${name.trim()}`,
    `  protected: ${protected_}`,
    `  description: "${String(description).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    `  budget:`,
    `    daily_limit_usd: ${dailyLimit}`,
    `    monthly_cap_usd: ${monthlyCap}`,
    `  agents: []`,
  ].join("\n");

  try {
    writeFileSync(targetPath, yaml + "\n", "utf-8");
    logger.info("division_created", `Created division ${id}`, {
      metadata: { division_id: id, path: targetPath },
    });
    recordAuditEvent({
      type:      "CONFIG_MUTATION",
      agentId:   callerAgentId,
      toolName:  "create_division",
      allowed:   true,
      paramKeys: Object.keys(params),
      timestamp: new Date().toISOString(),
      subtype:   "create_division",
      targetId:  id,
    });
    return { success: true, data: { division_id: id, path: targetPath } };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function toolUpdateAgentRole(
  params:        Record<string, unknown>,
  workDir:       string,
  callerAgentId: string,
  db?:           Database | null,
): Promise<ToolCallResult> {
  const roleId = params["role_id"];
  if (typeof roleId !== "string" || !/^[a-z0-9-]+$/.test(roleId)) {
    return { success: false, error: "role_id must be a lowercase alphanumeric slug (hyphens allowed)" };
  }
  if (params["tier"] !== undefined && params["tier"] !== 1 && params["tier"] !== 2 && params["tier"] !== 3) {
    return { success: false, error: "tier must be 1, 2, or 3" };
  }

  const definitionsDir = join(workDir, "agents", "definitions");
  const targetPath     = join(definitionsDir, `${roleId}.yaml`);
  if (!existsSync(targetPath)) {
    return { success: false, error: `Agent role "${roleId}" not found at ${targetPath}` };
  }

  // Parse current YAML via simple line-based key extraction (no yaml dep needed here)
  let existing: string;
  try {
    existing = readFileSync(targetPath, "utf-8");
  } catch (err) {
    return { success: false, error: `Failed to read role file: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Build updated YAML by replacing or keeping existing lines
  const updatedFields: string[] = [];

  function patchLine(yaml: string, key: string, newVal: string | undefined): string {
    if (newVal === undefined) return yaml;
    const re = new RegExp(`^(  ${key}:).*$`, "m");
    if (re.test(yaml)) {
      return yaml.replace(re, `$1 ${newVal}`);
    }
    // Append under `role:` block if key not present
    return yaml.replace(/^(role:\n)/m, `$1  ${key}: ${newVal}\n`);
  }

  let updated = existing;

  if (typeof params["name"] === "string" && params["name"].trim() !== "") {
    updated = patchLine(updated, "name", params["name"].trim());
    updatedFields.push("name");
  }
  if (typeof params["description"] === "string") {
    const escaped = params["description"].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    updated = patchLine(updated, "description", `"${escaped}"`);
    updatedFields.push("description");
  }
  if (params["tier"] === 1 || params["tier"] === 2 || params["tier"] === 3) {
    updated = patchLine(updated, "tier", String(params["tier"]));
    updatedFields.push("tier");
  }
  if (typeof params["division"] === "string" && params["division"].trim() !== "") {
    updated = patchLine(updated, "division", params["division"].trim());
    updatedFields.push("division");
  }
  if (typeof params["model"] === "string" && params["model"].trim() !== "") {
    // model is nested under recommended_model → just append a comment-style field for now
    updated = patchLine(updated, "model", params["model"].trim());
    updatedFields.push("model");
  }
  if (typeof params["system_prompt"] === "string") {
    const escaped = params["system_prompt"].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    updated = patchLine(updated, "system_prompt", `"${escaped}"`);
    updatedFields.push("system_prompt");
  }

  if (updatedFields.length === 0) {
    return { success: false, error: "No updatable fields provided (name, description, tier, division, model, system_prompt)" };
  }

  try {
    writeFileSync(targetPath, updated, "utf-8");

    // Sync updated fields to DB
    if (db !== null && db !== undefined) {
      try {
        const typedDb = db as unknown as BetterSqliteDb;
        runMigrations105(typedDb);
        const setClauses: string[] = ["config_yaml = ?", "config_hash = ?", "updated_at = ?"];
        const now = new Date().toISOString();
        const runArgs: unknown[] = [updated, sha256hex(updated).slice(0, 16), now];
        if (updatedFields.includes("name"))     { setClauses.push("name = ?");     runArgs.push(String(params["name"]).trim()); }
        if (updatedFields.includes("tier"))     { setClauses.push("tier = ?");     runArgs.push(params["tier"]); }
        if (updatedFields.includes("division")) { setClauses.push("division = ?"); runArgs.push(String(params["division"]).trim()); }
        runArgs.push(roleId);
        typedDb.prepare(`UPDATE agent_definitions SET ${setClauses.join(", ")} WHERE id = ?`).run(...runArgs);
      } catch (dbErr) {
        logger.warn("agent_role_db_sync", `DB sync skipped: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`, {
          metadata: { role_id: roleId },
        });
      }
    }

    logger.info("agent_role_updated", `Updated agent role ${roleId}`, {
      metadata: { role_id: roleId, fields: updatedFields },
    });
    recordAuditEvent({
      type:      "CONFIG_MUTATION",
      agentId:   callerAgentId,
      toolName:  "update_agent_role",
      allowed:   true,
      paramKeys: Object.keys(params),
      timestamp: new Date().toISOString(),
      subtype:   "update_agent_role",
      targetId:  roleId,
    });
    return { success: true, data: { role_id: roleId, updated_fields: updatedFields } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}


function toolUpdateDivision(
  params:        Record<string, unknown>,
  workDir:       string,
  callerAgentId: string,
): ToolCallResult {
  const id = params["id"];
  if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) {
    return { success: false, error: "id must be a lowercase alphanumeric slug (hyphens allowed)" };
  }

  // Resolve the division YAML file — check governance/divisions/ first, then config/
  const govPath    = join(workDir, "governance", "divisions", `${id}.yaml`);
  const configPath = join(workDir, "config", "divisions", `${id}.yaml`);
  const targetPath = existsSync(govPath) ? govPath : existsSync(configPath) ? configPath : null;

  if (targetPath === null) {
    return { success: false, error: `Division "${id}" not found. Run list_divisions to see existing divisions.` };
  }

  let existing: string;
  try {
    existing = readFileSync(targetPath, "utf-8");
  } catch (err) {
    return { success: false, error: `Failed to read division file: ${err instanceof Error ? err.message : String(err)}` };
  }

  const updatedFields: string[] = [];

  function patchLine(yaml: string, key: string, newVal: string | undefined): string {
    if (newVal === undefined) return yaml;
    const re = new RegExp(`^(  ${key}:).*$`, "m");
    if (re.test(yaml)) {
      return yaml.replace(re, `$1 ${newVal}`);
    }
    return yaml.replace(/^(division:\n)/m, `$1  ${key}: ${newVal}\n`);
  }

  let updated = existing;

  if (typeof params["name"] === "string" && params["name"].trim() !== "") {
    updated = patchLine(updated, "name", params["name"].trim());
    updatedFields.push("name");
  }
  if (typeof params["description"] === "string") {
    const escaped = params["description"].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    updated = patchLine(updated, "description", `"${escaped}"`);
    updatedFields.push("description");
  }
  if (typeof params["scope"] === "string" && params["scope"].trim() !== "") {
    updated = patchLine(updated, "scope", params["scope"].trim());
    updatedFields.push("scope");
  }
  if (typeof params["active"] === "boolean") {
    updated = patchLine(updated, "active", String(params["active"]));
    updatedFields.push("active");
  }
  if (typeof params["head_role"] === "string" && params["head_role"].trim() !== "") {
    updated = patchLine(updated, "head_role", params["head_role"].trim());
    updatedFields.push("head_role");
  }
  if (typeof params["head_agent"] === "string" && params["head_agent"].trim() !== "") {
    // head_agent is nested under head: — patch with indented key
    const headRe = /^(    agent:).*$/m;
    if (headRe.test(updated)) {
      updated = updated.replace(headRe, `$1 ${params["head_agent"].trim()}`);
    } else {
      // Ensure head: block exists
      const headBlockRe = /^(  head:\n)/m;
      if (headBlockRe.test(updated)) {
        updated = updated.replace(headBlockRe, `$1    agent: ${params["head_agent"].trim()}\n`);
      } else {
        updated = updated.replace(/^(division:\n)/m, `$1  head:\n    agent: ${params["head_agent"].trim()}\n`);
      }
    }
    updatedFields.push("head_agent");
  }

  if (updatedFields.length === 0) {
    return { success: false, error: "No updatable fields provided (name, description, scope, active, head_role, head_agent)" };
  }

  try {
    writeFileSync(targetPath, updated, "utf-8");

    logger.info("division_updated", `Updated division ${id}`, {
      metadata: { division_id: id, fields: updatedFields },
    });
    recordAuditEvent({
      type:      "CONFIG_MUTATION",
      agentId:   callerAgentId,
      toolName:  "update_division",
      allowed:   true,
      paramKeys: Object.keys(params),
      timestamp: new Date().toISOString(),
      subtype:   "update_division",
      targetId:  id,
    });
    return {
      success: true,
      data: {
        division_id:    id,
        updated_fields: updatedFields,
        note:           "Run sidjua apply to activate the changes.",
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}


async function toolAskAgent(
  params:        Record<string, unknown>,
  callerAgentId: string,
  ctx:           ToolCallContext,
): Promise<ToolCallResult> {
  if (ctx.depth >= MAX_ASK_DEPTH) {
    return { success: false, error: `ask_agent depth limit (${MAX_ASK_DEPTH}) reached` };
  }

  const targetAgentId = params["agent_id"];
  const question      = params["question"];

  if (typeof targetAgentId !== "string" || targetAgentId.trim() === "") {
    return { success: false, error: "agent_id is required" };
  }
  if (typeof question !== "string" || question.trim() === "") {
    return { success: false, error: "question is required" };
  }
  if (targetAgentId === callerAgentId) {
    return { success: false, error: "An agent cannot ask itself" };
  }

  let targetRole;
  try {
    const roles = loadDefaultRoles();
    targetRole  = roles.find((r) => r.id === targetAgentId);
  } catch (_loadErr: unknown) {
    // ignore
  }
  if (!targetRole) {
    return { success: false, error: `Target agent "${targetAgentId}" not found` };
  }

  // Budget pre-check before making an LLM call.
  if (ctx.db !== null) {
    try {
      const divisionCode = ctx.callerContext?.division ?? "";
      const tracker   = new CostTracker(ctx.db);
      const budgetChk = tracker.checkBudget(divisionCode, ASK_AGENT_COST_ESTIMATE_USD);
      if (!budgetChk.allowed) {
        return { success: false, error: `ask_agent budget check failed: ${budgetChk.reason ?? "budget exceeded"}` };
      }
    } catch (_budgetErr: unknown) {
      // Non-fatal — budget table may not exist yet; allow the call.
    }
  }

  const provider = getProviderForAgent(targetAgentId) ?? getProviderForAgent(callerAgentId);
  if (provider === null) {
    return { success: false, error: "No LLM provider configured for ask_agent" };
  }

  const systemPrompt = buildSystemPrompt(targetRole);
  const apiBase      = (provider.api_base ?? "").replace(/\/$/, "");
  const apiKey       = provider.api_key;
  const model        = provider.model ?? "llama-3.3-70b-versatile";

  try {
    const res = await fetch(`${apiBase}/chat/completions`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: String(question).trim() },
        ],
        stream:     false,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      return { success: false, error: `LLM request to ${targetAgentId} failed with HTTP ${res.status}` };
    }

    const json    = await res.json() as Record<string, unknown>;
    const choices = json["choices"] as Array<Record<string, unknown>> | undefined;
    const msg     = choices?.[0]?.["message"] as Record<string, unknown> | undefined;
    const answer  = msg?.["content"];

    if (typeof answer !== "string") {
      return { success: false, error: "Target agent returned no answer" };
    }

    logger.info("ask_agent_complete", `ask_agent: ${callerAgentId} → ${targetAgentId}`, {
      metadata: { caller: callerAgentId, target: targetAgentId, depth: ctx.depth },
    });

    return { success: true, data: { agent_id: targetAgentId, answer: answer.trim() } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `ask_agent network error: ${msg.slice(0, 200)}` };
  }
}


function collectStringValues(obj: Record<string, unknown>): string[] {
  const result: string[] = [];
  const visit = (val: unknown): void => {
    if (typeof val === "string") result.push(val);
    else if (Array.isArray(val)) val.forEach(visit);
    else if (val !== null && typeof val === "object") Object.values(val as Record<string, unknown>).forEach(visit);
  };
  visit(obj);
  return result;
}

/**
 * Execute a named tool on behalf of an agent.
 *
 * Runs the governance gate (checkToolGovernance) BEFORE dispatch.
 * If governance denies the call, returns an error immediately without
 * reaching the tool implementation. Never throws.
 */
export async function executeToolCall(
  agentId:  string,
  toolName: string,
  params:   Record<string, unknown>,
  ctx:      ToolCallContext,
): Promise<ToolCallResult> {
  const callerCtx = ctx.callerContext ?? { role: "operator" as const };
  const gov = checkToolGovernance({ agentId, toolName, params, callerContext: callerCtx, db: ctx.db });
  if (!gov.allowed) {
    return { success: false, error: gov.reason ?? "Tool call denied by governance" };
  }

  const bouncerCfg = getBouncerConfig(ctx.db);
  if (bouncerCfg.enabled) {
    const allStrings = collectStringValues(params);
    for (const str of allStrings) {
      const scan = scanForSensitiveData(str, bouncerCfg.sensitivity);
      if (scan.detected) {
        const labels = scan.matches.map((m) => m.label).join(", ");
        logger.warn("bouncer_tool_scan", `Sensitive data in tool params: ${labels}`, {
          metadata: { agent_id: agentId, tool: toolName, labels },
        });
        recordAuditEvent({
          type:      "TOOL_CALL",
          agentId,
          toolName,
          allowed:   false,
          reason:    `Bouncer: sensitive data detected (${labels})`,
          paramKeys: Object.keys(params),
          timestamp: new Date().toISOString(),
        });
        return {
          success: false,
          error: `Sensitive data detected in tool parameters (${labels}). Remove credentials before retrying.`,
        };
      }
    }
  }

  switch (toolName) {
    case "list_agents":        return toolListAgents();
    case "list_divisions":     return toolListDivisions();
    case "create_agent_role":  return toolCreateAgentRole(params, ctx.workDir, agentId, ctx.db);
    case "update_agent_role":  return toolUpdateAgentRole(params, ctx.workDir, agentId, ctx.db);
    case "create_division":    return toolCreateDivision(params, ctx.workDir, agentId);
    case "update_division":    return toolUpdateDivision(params, ctx.workDir, agentId);
    case "ask_agent":          return toolAskAgent(params, agentId, ctx);
    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}


/**
 * Return OpenAI-compatible tool definitions for an agent's authorized tools.
 *
 * When `agentContext` and `accessRules` are provided, tools are filtered by
 * tier, division, and classification (ARC-102) in addition to the grant set.
 * Without context, only the grant set is checked (backward-compatible).
 */
export function getToolDefinitions(
  agentId:      string,
  agentContext?: AgentVisibilityContext,
  accessRules?:  ToolAccess[],
): Array<Record<string, unknown>> {
  const allowed = getAllowedTools(agentId);

  const canSee = (toolName: string): boolean =>
    agentContext !== undefined
      ? isToolVisibleForAgent(toolName, agentContext, allowed, accessRules ?? [])
      : allowed.has(toolName);

  const defs: Array<Record<string, unknown>> = [];

  if (canSee("list_agents")) {
    defs.push({
      type: "function",
      function: {
        name:        "list_agents",
        description: "List all available agents in this SIDJUA installation.",
        parameters:  { type: "object", properties: {} },
      },
    });
  }

  if (canSee("list_divisions")) {
    defs.push({
      type: "function",
      function: {
        name:        "list_divisions",
        description: "List all divisions with their budgets and member agents.",
        parameters:  { type: "object", properties: {} },
      },
    });
  }

  if (canSee("create_agent_role")) {
    defs.push({
      type: "function",
      function: {
        name:        "create_agent_role",
        description: "Create a new agent role YAML definition file.",
        parameters: {
          type:       "object",
          required:   ["role_id", "name"],
          properties: {
            role_id:      { type: "string",  description: "Lowercase slug e.g. 'data-analyst'" },
            name:         { type: "string",  description: "Human-readable name" },
            description:  { type: "string",  description: "What this agent does" },
            tier:         { type: "number",  enum: [1, 2, 3], description: "Capability tier" },
            division:     { type: "string",  description: "Division this agent belongs to" },
            capabilities: { type: "array",   items: { type: "string" }, description: "Capabilities list" },
            icon:         { type: "string",  description: "Lucide icon name e.g. 'users'" },
          },
        },
      },
    });
  }

  if (canSee("update_agent_role")) {
    defs.push({
      type: "function",
      function: {
        name:        "update_agent_role",
        description: "Update an existing agent role YAML definition. Only the fields you pass are changed.",
        parameters: {
          type:       "object",
          required:   ["role_id"],
          properties: {
            role_id:      { type: "string",  description: "Slug of the role to update e.g. 'data-analyst'" },
            name:         { type: "string",  description: "New human-readable name" },
            description:  { type: "string",  description: "New description of what this agent does" },
            tier:         { type: "number",  enum: [1, 2, 3], description: "New capability tier" },
            division:     { type: "string",  description: "New division this agent belongs to" },
            model:        { type: "string",  description: "Preferred LLM model identifier" },
            system_prompt: { type: "string", description: "Custom system prompt override" },
          },
        },
      },
    });
  }

  if (canSee("create_division")) {
    defs.push({
      type: "function",
      function: {
        name:        "create_division",
        description: "Create a new division (organizational unit) with a budget.",
        parameters: {
          type:       "object",
          required:   ["id", "name"],
          properties: {
            id:              { type: "string",  description: "Lowercase slug e.g. 'engineering'" },
            name:            { type: "string",  description: "Human-readable name" },
            description:     { type: "string",  description: "What this division handles" },
            daily_limit_usd: { type: "number",  description: "Daily budget limit in USD" },
            monthly_cap_usd: { type: "number",  description: "Monthly budget cap in USD" },
            protected:       { type: "boolean", description: "If true, division cannot be deleted" },
          },
        },
      },
    });
  }

  if (canSee("update_division")) {
    defs.push({
      type: "function",
      function: {
        name:        "update_division",
        description: "Update an existing division's metadata. Only the fields you pass are changed. Run sidjua apply afterwards to activate.",
        parameters: {
          type:       "object",
          required:   ["id"],
          properties: {
            id:         { type: "string",  description: "Division slug to update e.g. 'engineering'" },
            name:       { type: "string",  description: "New human-readable name" },
            description: { type: "string", description: "New description of what this division handles" },
            scope:      { type: "string",  description: "New scope identifier" },
            active:     { type: "boolean", description: "Set to false to deactivate this division" },
            head_role:  { type: "string",  description: "New head role slug" },
            head_agent: { type: "string",  description: "New head agent ID (e.g. 'hr-t1')" },
          },
        },
      },
    });
  }

  if (canSee("ask_agent")) {
    defs.push({
      type: "function",
      function: {
        name:        "ask_agent",
        description: "Ask another agent a question for cross-agent collaboration.",
        parameters: {
          type:       "object",
          required:   ["agent_id", "question"],
          properties: {
            agent_id: { type: "string", description: "Target agent ID e.g. 'hr', 'guide', 'finance'" },
            question: { type: "string", description: "The question to ask the target agent" },
          },
        },
      },
    });
  }

  return defs;
}


export interface AgentToolRouteServices {
  workDir: string;
  db?:     Database | null;
}

/** Register POST /api/v1/agents/:agentId/tool-call */
export function registerAgentToolRoutes(
  app:      Hono,
  services: AgentToolRouteServices,
): void {
  const { workDir, db } = services;

  app.post("/api/v1/agents/:agentId/tool-call", requireScope("agent"), async (c) => {
    const agentId = c.req.param("agentId");

    let agentExists = false;
    try {
      const roles = loadDefaultRoles();
      agentExists = roles.some((r) => r.id === agentId);
    } catch (_loadErr: unknown) { /* ignore */ }
    if (!agentExists) {
      throw SidjuaError.from("CHAT-002", `Agent "${agentId}" not found`);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch (_parseErr: unknown) {
      throw SidjuaError.from("CHAT-001", "Request body must be valid JSON");
    }

    const toolName = body["tool"];
    const params   = (typeof body["parameters"] === "object" && body["parameters"] !== null)
      ? body["parameters"] as Record<string, unknown>
      : {};
    const depth    = typeof body["depth"] === "number" ? body["depth"] : 0;

    if (typeof toolName !== "string" || toolName.trim() === "") {
      throw SidjuaError.from("CHAT-001", "tool is required");
    }

    // V1.0: all authenticated REST callers receive operator role.
    // V1.1: derive from scoped token (ARC-201).
    const ctx: ToolCallContext = {
      workDir,
      db:            db ?? null,
      depth,
      callerContext: { role: "operator" },
    };
    const result = await executeToolCall(agentId, toolName, params, ctx);

    if (!result.success) {
      return c.json({ success: false, error: result.error }, 400);
    }

    return c.json({ success: true, data: result.data });
  });
}
