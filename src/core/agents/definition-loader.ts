/**
 * SIDJUA — Agent Definition Loader
 *
 * Loads agent YAML definitions from agents/definitions/ and skill Markdown
 * files from agents/skills/.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { parse as parseYaml } from "yaml";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentBudget {
  daily_usd: number;
  per_task_usd: number;
}

export interface AgentGovernance {
  classification_ceiling: string;
  requires_human_approval?: string[];
  allowed_tools?: string[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  division: string;
  model: string;
  capabilities: string[];
  mcp_servers?: string[];
  budget: AgentBudget;
  governance?: AgentGovernance;
  can_delegate_to?: string[];
  skills?: string[];
}

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Loads all agent YAML definitions from a directory.
 * Non-YAML files and files that fail to parse are silently skipped.
 */
export async function loadAgentDefinitions(
  defsDir: string,
): Promise<AgentDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(defsDir);
  } catch {
    return [];
  }

  const definitions: AgentDefinition[] = [];

  for (const entry of entries) {
    if (extname(entry) !== ".yaml" && extname(entry) !== ".yml") continue;

    const filePath = join(defsDir, entry);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;

      const raw = await readFile(filePath, "utf8");
      const parsed = parseYaml(raw) as unknown;

      if (!isAgentDefinition(parsed)) continue;
      definitions.push(parsed);
    } catch {
      // Malformed YAML or unreadable file — skip
    }
  }

  return definitions;
}

/**
 * Loads the Markdown content of a named skill file.
 * Returns `null` if the file does not exist or cannot be read.
 *
 * Looks for `<skillName>.md` in `skillsDir`.
 */
export async function loadSkillContent(
  skillsDir: string,
  skillName: string,
): Promise<string | null> {
  // Strip any directory traversal for safety
  const safeName = basename(skillName);
  const filePath = join(skillsDir, `${safeName}.md`);

  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// ─── Type guard ──────────────────────────────────────────────────────────────

function isAgentDefinition(value: unknown): value is AgentDefinition {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;

  return (
    typeof obj["id"] === "string" &&
    typeof obj["name"] === "string" &&
    (obj["tier"] === 1 || obj["tier"] === 2 || obj["tier"] === 3) &&
    typeof obj["division"] === "string" &&
    typeof obj["model"] === "string" &&
    Array.isArray(obj["capabilities"]) &&
    typeof obj["budget"] === "object" &&
    obj["budget"] !== null &&
    typeof (obj["budget"] as Record<string, unknown>)["daily_usd"] === "number" &&
    typeof (obj["budget"] as Record<string, unknown>)["per_task_usd"] === "number"
  );
}
