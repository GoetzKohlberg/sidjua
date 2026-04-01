// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Default role and division loader.
 *
 * Reads YAML definition files from the bundled defaults directories and
 * returns typed objects.  Validates required fields and throws descriptive
 * errors on malformed files so build-time failures surface clearly.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join }                       from "node:path";
import { fileURLToPath }              from "node:url";
import { parse as parseYaml }         from "yaml";
import type { ProviderCatalog }       from "./provider-types.js";


export interface RecommendedModel {
  min_quality: string;
  suggested:   string;
}

export interface RoleToolConfig {
  internal: string[];  // internal tool names (e.g. "system_health")
  mcp:      string[];  // MCP server tool names (populated dynamically by HR Agent)
}

export interface AgentRole {
  id:                string;
  name:              string;
  tier:              1 | 2 | 3;
  division:          string;
  description:       string;
  icon:              string;
  domains:           string[];
  status:            "active" | "inactive";
  capabilities:      string[];
  recommended_model: RecommendedModel;
  tools:             RoleToolConfig;
}

export interface DivisionBudget {
  daily_limit_usd: number;
  monthly_cap_usd: number;
}

export interface Division {
  id:          string;
  name:        string;
  protected:   boolean;
  description: string;
  budget:      DivisionBudget;
  agents:      string[];
}

/** A ready-to-render starter agent definition (GUI-friendly shape). */
export interface StarterAgent {
  id:           string;
  name:         string;
  description:  string;
  icon:         string;
  tier:         1 | 2 | 3;
  division:     string;
  domains:      string[];
  capabilities: string[];
  status:       "active" | "inactive";
}


// Resolve relative to this file so the paths work in both dev (src/) and
// production (dist/) as long as the YAML files are deployed alongside the JS.
const BASE_DIR = fileURLToPath(new URL(".", import.meta.url));


function requireString(obj: Record<string, unknown>, key: string, file: string): string {
  const val = obj[key];
  if (typeof val !== "string" || val.trim() === "") {
    throw new Error(`[defaults/loader] Missing or empty required field "${key}" in ${file}`);
  }
  return val;
}

function requireNumber(obj: Record<string, unknown>, key: string, file: string): number {
  const val = obj[key];
  if (typeof val !== "number") {
    throw new Error(`[defaults/loader] Missing or non-numeric required field "${key}" in ${file}`);
  }
  return val;
}

function requireStringArray(obj: Record<string, unknown>, key: string, file: string): string[] {
  const val = obj[key];
  if (!Array.isArray(val) || val.some((v) => typeof v !== "string")) {
    throw new Error(`[defaults/loader] Field "${key}" must be a non-empty string array in ${file}`);
  }
  return val as string[];
}

function validateTier(val: unknown, file: string): 1 | 2 | 3 {
  if (val !== 1 && val !== 2 && val !== 3) {
    throw new Error(`[defaults/loader] Field "tier" must be 1, 2, or 3 in ${file}`);
  }
  return val;
}

function validateStatus(val: unknown, file: string): "active" | "inactive" {
  if (val !== "active" && val !== "inactive") {
    throw new Error(`[defaults/loader] Field "status" must be "active" or "inactive" in ${file}`);
  }
  return val;
}


function parseToolConfig(role: Record<string, unknown>, file: string): RoleToolConfig {
  const raw = role["tools"];
  if (raw === undefined || raw === null) return { internal: [], mcp: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    // Warn but don't crash — default to empty
    return { internal: [], mcp: [] };
  }
  const t = raw as Record<string, unknown>;
  const internal = Array.isArray(t["internal"])
    ? (t["internal"] as unknown[]).filter((v) => typeof v === "string") as string[]
    : [];
  const mcp = Array.isArray(t["mcp"])
    ? (t["mcp"] as unknown[]).filter((v) => typeof v === "string") as string[]
    : [];
  void file; // path kept for future validation logging
  return { internal, mcp };
}


function parseRoleFile(filePath: string): AgentRole {
  const raw  = readFileSync(filePath, "utf-8");
  const doc  = parseYaml(raw) as Record<string, unknown>;
  const role = doc["role"] as Record<string, unknown> | undefined;

  if (!role || typeof role !== "object") {
    throw new Error(`[defaults/loader] YAML file must have a top-level "role" key: ${filePath}`);
  }

  const recommended = role["recommended_model"] as Record<string, unknown> | undefined;
  if (!recommended || typeof recommended !== "object") {
    throw new Error(`[defaults/loader] Missing "recommended_model" in ${filePath}`);
  }

  return {
    id:           requireString(role, "id",           filePath),
    name:         requireString(role, "name",         filePath),
    tier:         validateTier(role["tier"],           filePath),
    division:     requireString(role, "division",     filePath),
    description:  requireString(role, "description",  filePath),
    icon:         requireString(role, "icon",         filePath),
    domains:      requireStringArray(role, "domains", filePath),
    status:       validateStatus(role["status"],      filePath),
    capabilities: requireStringArray(role, "capabilities", filePath),
    recommended_model: {
      min_quality: requireString(recommended, "min_quality", filePath),
      suggested:   requireString(recommended, "suggested",   filePath),
    },
    tools: parseToolConfig(role, filePath),
  };
}


function parseDivisionFile(filePath: string): Division {
  const raw  = readFileSync(filePath, "utf-8");
  const doc  = parseYaml(raw) as Record<string, unknown>;
  const div  = doc["division"] as Record<string, unknown> | undefined;

  if (!div || typeof div !== "object") {
    throw new Error(`[defaults/loader] YAML file must have a top-level "division" key: ${filePath}`);
  }

  const budget = div["budget"] as Record<string, unknown> | undefined;
  if (!budget || typeof budget !== "object") {
    throw new Error(`[defaults/loader] Missing "budget" in ${filePath}`);
  }

  const protected_ = div["protected"];
  if (typeof protected_ !== "boolean") {
    throw new Error(`[defaults/loader] Field "protected" must be a boolean in ${filePath}`);
  }

  return {
    id:          requireString(div, "id",          filePath),
    name:        requireString(div, "name",        filePath),
    protected:   protected_,
    description: requireString(div, "description", filePath),
    agents:      requireStringArray(div, "agents", filePath),
    budget: {
      daily_limit_usd: requireNumber(budget, "daily_limit_usd", filePath),
      monthly_cap_usd: requireNumber(budget, "monthly_cap_usd", filePath),
    },
  };
}


/**
 * Load all role YAML files from `src/defaults/roles/`.
 * Throws a descriptive error if any file is missing a required field.
 */
export function loadDefaultRoles(): AgentRole[] {
  const rolesDir = join(BASE_DIR, "roles");
  const files    = readdirSync(rolesDir).filter((f) => f.endsWith(".yaml"));
  return files.map((f) => parseRoleFile(join(rolesDir, f)));
}

/**
 * Load all division YAML files from `src/defaults/divisions/`.
 * Throws a descriptive error if any file is missing a required field.
 */
export function loadDefaultDivisions(): Division[] {
  const divisionsDir = join(BASE_DIR, "divisions");
  const files        = readdirSync(divisionsDir).filter((f) => f.endsWith(".yaml"));
  return files.map((f) => parseDivisionFile(join(divisionsDir, f)));
}

/**
 * Return the 6 starter agent definitions in GUI-friendly shape.
 * Ordered canonically: guide, hr, it, auditor, finance, librarian.
 */
export function getStarterAgents(): StarterAgent[] {
  const CANONICAL_ORDER = ["guide", "hr", "it", "auditor", "finance", "librarian"];
  const roles = loadDefaultRoles();
  const byId  = new Map(roles.map((r) => [r.id, r]));

  return CANONICAL_ORDER
    .map((id) => byId.get(id))
    .filter((r): r is AgentRole => r !== undefined)
    .map((r): StarterAgent => ({
      id:           r.id,
      name:         r.name,
      description:  r.description,
      icon:         r.icon,
      tier:         r.tier,
      division:     r.division,
      domains:      r.domains,
      capabilities: r.capabilities,
      status:       r.status,
    }));
}

/**
 * Return the system starter division definition.
 * Throws if the system division YAML is missing or malformed.
 */
export function getSystemDivision(): Division {
  const divs   = loadDefaultDivisions();
  const system = divs.find((d) => d.id === "system");
  if (!system) {
    throw new Error("[defaults/loader] system.yaml division not found");
  }
  return system;
}

/**
 * Load a knowledge file by filename from `src/defaults/knowledge/`.
 * Returns the file content as a string, or throws if not found.
 */
export function loadKnowledgeFile(filename: string): string {
  const knowledgeDir = join(BASE_DIR, "knowledge");
  const filePath     = join(knowledgeDir, filename);
  return readFileSync(filePath, "utf-8");
}

/**
 * Build the system prompt for a given agent.
 *
 * For the Guide agent: loads guide-system-prompt.md + guide-complete-handbook.md.
 * For all agents: appends agent-team-reference.md.
 * For non-Guide agents: auto-generates from role definition.
 */
export function buildSystemPrompt(role: AgentRole): string {
  const teamRef = loadKnowledgeFile("agent-team-reference.md");

  const identityBlock = [
    `You are ${role.name}, a SIDJUA agent in the ${role.division} division.`,
    `Your role: ${role.description}`,
    "",
    "CRITICAL RESPONSE RULES:",
    "1. NEVER volunteer your model name (DeepSeek, Llama, Claude, etc.) unless the user EXPLICITLY asks 'what model are you' or 'which AI are you'. In that case, be honest.",
    "2. Introduce yourself ONLY by your SIDJUA role name and function, e.g. 'Ich bin der Bibliothekar und verwalte die Wissensbasis.'",
    "3. Keep responses focused on the user's actual question. Do not add meta-commentary about your capabilities or limitations unless directly relevant.",
    "",
  ].join("\n");

  if (role.id === "guide") {
    const guidePrompt = loadKnowledgeFile("guide-system-prompt.md");
    const handbook    = loadKnowledgeFile("guide-complete-handbook.md");

    // Simple token estimate: ~3 chars per token; limit handbook to 4000 tokens
    const maxChars = 4000 * 3;
    const handbookTruncated = handbook.length > maxChars
      ? handbook.slice(0, maxChars) + "\n\n[Handbook truncated for context window]"
      : handbook;

    return identityBlock + [
      guidePrompt,
      "",
      "=== SIDJUA Handbook (your knowledge base) ===",
      "",
      handbookTruncated,
      "",
      "=== Your Team ===",
      "",
      teamRef,
      "",
      "=== Inter-Agent Collaboration ===",
      "",
      "You can consult other agents using the `ask_agent` tool. Provide `agent_id` and `question`.",
    ].join("\n");
  }

  if (role.id === "hr") {
    const hrTools = loadKnowledgeFile("hr-tool-reference.md");

    const caps = role.capabilities.map((c) => `- ${c}`).join("\n");
    return identityBlock + [
      "Your role scope (these describe your DOMAIN OF EXPERTISE, NOT available tools):",
      caps,
      "",
      "IMPORTANT: Only use tools that are explicitly provided to you in this conversation.",
      "If you do not have a tool for something, say so honestly — do NOT invent or hallucinate tool names.",
      "If asked about a capability you cannot perform yet, explain that the feature is planned for a future version.",
      "",
      `You belong to the ${role.division} division.`,
      "",
      "Respond helpfully and professionally.",
      "",
      "=== Your Team ===",
      "",
      teamRef,
      "",
      "=== Tool Reference ===",
      "",
      hrTools,
      "",
      "MANDATORY WORKFLOW — follow this for EVERY agent creation request:",
      "1. FIRST call `list_agents` to see existing agents",
      "2. THEN ask the user clarifying questions: What should the agent do? What name? Which division? What tier?",
      "3. ONLY after the user confirms the details, call `create_agent_role` with the full definition",
      "4. NEVER create an agent with generic defaults. Always gather requirements first.",
      "5. If the user gives a vague request like 'create an agent', ask what kind of agent they need.",
    ].join("\n");
  }

  if (role.id === "it") {
    const itKnowledge = loadKnowledgeFile("it-knowledge.md");
    const caps = role.capabilities.map((c) => `- ${c}`).join("\n");
    return identityBlock + [
      "Your role scope (these describe your DOMAIN OF EXPERTISE, NOT available tools):",
      caps,
      "",
      "IMPORTANT: Only use tools that are explicitly provided to you in this conversation.",
      "If you do not have a tool for something, say so honestly — do NOT invent or hallucinate tool names.",
      "If asked about a capability you cannot perform yet, explain that the feature is planned for a future version.",
      "",
      "=== Knowledge Reference ===",
      "",
      itKnowledge,
      "",
      "=== Your Team ===",
      "",
      teamRef,
      "",
      "=== Inter-Agent Collaboration ===",
      "",
      "You can consult other agents using the `ask_agent` tool. Provide `agent_id` and `question`.",
    ].join("\n");
  }

  if (role.id === "auditor") {
    const auditorKnowledge = loadKnowledgeFile("auditor-knowledge.md");
    const caps = role.capabilities.map((c) => `- ${c}`).join("\n");
    return identityBlock + [
      "Your role scope (these describe your DOMAIN OF EXPERTISE, NOT available tools):",
      caps,
      "",
      "IMPORTANT: Only use tools that are explicitly provided to you in this conversation.",
      "If you do not have a tool for something, say so honestly — do NOT invent or hallucinate tool names.",
      "If asked about a capability you cannot perform yet, explain that the feature is planned for a future version.",
      "",
      "=== Knowledge Reference ===",
      "",
      auditorKnowledge,
      "",
      "=== Your Team ===",
      "",
      teamRef,
      "",
      "=== Inter-Agent Collaboration ===",
      "",
      "You can consult other agents using the `ask_agent` tool. Provide `agent_id` and `question`.",
    ].join("\n");
  }

  if (role.id === "finance") {
    const financeKnowledge = loadKnowledgeFile("finance-knowledge.md");
    const caps = role.capabilities.map((c) => `- ${c}`).join("\n");
    return identityBlock + [
      "Your role scope (these describe your DOMAIN OF EXPERTISE, NOT available tools):",
      caps,
      "",
      "IMPORTANT: Only use tools that are explicitly provided to you in this conversation.",
      "If you do not have a tool for something, say so honestly — do NOT invent or hallucinate tool names.",
      "If asked about a capability you cannot perform yet, explain that the feature is planned for a future version.",
      "",
      "=== Knowledge Reference ===",
      "",
      financeKnowledge,
      "",
      "=== Your Team ===",
      "",
      teamRef,
      "",
      "=== Inter-Agent Collaboration ===",
      "",
      "You can consult other agents using the `ask_agent` tool. Provide `agent_id` and `question`.",
    ].join("\n");
  }

  if (role.id === "librarian") {
    const librarianKnowledge = loadKnowledgeFile("librarian-knowledge.md");
    const caps = role.capabilities.map((c) => `- ${c}`).join("\n");
    return identityBlock + [
      "Your role scope (these describe your DOMAIN OF EXPERTISE, NOT available tools):",
      caps,
      "",
      "IMPORTANT: Only use tools that are explicitly provided to you in this conversation.",
      "If you do not have a tool for something, say so honestly — do NOT invent or hallucinate tool names.",
      "If asked about a capability you cannot perform yet, explain that the feature is planned for a future version.",
      "",
      "=== Knowledge Reference ===",
      "",
      librarianKnowledge,
      "",
      "=== Your Team ===",
      "",
      teamRef,
      "",
      "=== Inter-Agent Collaboration ===",
      "",
      "You can consult other agents using the `ask_agent` tool. Provide `agent_id` and `question`.",
      "",
      "CURRENT STATUS: Your knowledge management tools (search, ingest, archive) are not yet implemented in V1.0.1.",
      "If asked to search, ingest, or manage documents, explain honestly that these features are coming in a future version.",
      "You CAN still help users with document organization advice, search strategies, and knowledge management planning.",
    ].join("\n");
  }

  // Auto-generate for all other agents
  const caps = role.capabilities.map((c) => `- ${c}`).join("\n");
  return identityBlock + [
    "Your role scope (these describe your DOMAIN OF EXPERTISE, NOT available tools):",
    caps,
    "",
    "IMPORTANT: Only use tools that are explicitly provided to you in this conversation.",
    "If you do not have a tool for something, say so honestly — do NOT invent or hallucinate tool names.",
    "If asked about a capability you cannot perform yet, explain that the feature is planned for a future version.",
    "",
    `You belong to the ${role.division} division.`,
    "",
    "Respond helpfully and professionally. If a request is outside your capabilities, suggest which agent might be better suited.",
    "",
    "=== Your Team ===",
    "",
    teamRef,
    "",
    "=== Inter-Agent Collaboration ===",
    "",
    "You can consult other agents using the `ask_agent` tool. Provide `agent_id` and `question`.",
  ].join("\n");
}

/**
 * Load the approved-providers catalog from the bundled JSON file.
 * Throws a descriptive error if the file is missing or malformed.
 */
export function loadApprovedProviders(): ProviderCatalog {
  const filePath = join(BASE_DIR, "approved-providers.json");
  const raw      = readFileSync(filePath, "utf-8");
  const catalog  = JSON.parse(raw) as ProviderCatalog;

  if (!catalog || !Array.isArray(catalog.providers)) {
    throw new Error("[defaults/loader] approved-providers.json must have a providers array");
  }

  for (const p of catalog.providers) {
    if (typeof p.id !== "string" || p.id.trim() === "") {
      throw new Error("[defaults/loader] Each provider must have a non-empty string id");
    }
  }

  return catalog;
}

/**
 * Return the absolute path to the package-bundled divisions directory.
 * Correct in both dev (src/defaults/divisions/) and production (dist/divisions/).
 */
export function getDefaultDivisionsDir(): string {
  return join(BASE_DIR, "divisions");
}
