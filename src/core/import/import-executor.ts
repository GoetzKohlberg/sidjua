// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — OpenClaw import executor.
 *
 * Two public functions:
 *   analyzeInstallation() — read-only analysis + validation
 *   executeImport()       — write SIDJUA config from parsed installation
 *
 * Secret handling: channel tokens are extracted from YAML config, stored
 * via the SecretsProvider, and referenced as `${secrets:key}` in the
 * generated adapter YAML files.
 *
 * Error policy: a failure in one component does NOT abort the import.
 * All errors are collected in ImportResult.errors.
 */

import * as fs   from "node:fs";
import * as path from "node:path";
import { createLogger } from "../logger.js";
import { validateOpenClawPath } from "./openclaw-validators.js";
import {
  parseAgentsMd,
  parseSoulMd,
  parseMemoryMd,
  parseHeartbeatMd,
  parseConfigYaml,
  parseClawHub,
} from "./openclaw-parser.js";
import {
  mapAgentToYaml,
  mapSoulToSkillMd,
  mapMemoriesToJson,
  mapHeartbeatsToSchedulerYaml,
  mapChannelsToAdapterYaml,
  mapSkillsToMcpConfig,
} from "./openclaw-mappers.js";
import { lookupAllSkills } from "./skill-mapping-table.js";
import type {
  OpenClawInstallation,
  ImportResult,
  OpenClawAgent,
  OpenClawMemory,
  OpenClawHeartbeat,
  OpenClawChannel,
  OpenClawSkill,
} from "./types.js";
import type { SecretsProvider } from "../../types/apply.js";

const logger = createLogger("import-executor");

// ---------------------------------------------------------------------------
// analyzeInstallation
// ---------------------------------------------------------------------------

/**
 * Read and parse an OpenClaw installation directory.
 * Read-only — does NOT write any files.
 */
export async function analyzeInstallation(installPath: string): Promise<OpenClawInstallation> {
  const validation = validateOpenClawPath(installPath);
  const resolved   = validation.path;
  const errors     = [...validation.errors];

  if (!validation.valid) {
    return {
      path:             resolved,
      agents:           [],
      soul:             null,
      memories:         [],
      heartbeats:       [],
      skills:           [],
      channels:         [],
      validationErrors: errors,
    };
  }

  // Helper: read file content or empty string
  function readFile(filename: string): string {
    const full = path.join(resolved, filename);
    if (!fs.existsSync(full)) return "";
    try {
      return fs.readFileSync(full, "utf8");
    } catch (err) {
      errors.push(`Could not read ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      return "";
    }
  }

  // Parse agents
  let agents: OpenClawAgent[] = [];
  try {
    agents = parseAgentsMd(readFile("AGENTS.md"));
  } catch (err) {
    errors.push(`AGENTS.md parse error: ${err instanceof Error ? err.message : String(err)}`);
    logger.debug("import-executor", "AGENTS.md parse failed", { metadata: { error: String(err) } });
  }

  // Parse soul
  let soul = null;
  try {
    const soulContent = readFile("SOUL.md");
    if (soulContent) soul = parseSoulMd(soulContent);
  } catch (err) {
    errors.push(`SOUL.md parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Parse memories
  let memories: OpenClawMemory[] = [];
  try {
    memories = parseMemoryMd(readFile("MEMORY.md"));
  } catch (err) {
    errors.push(`MEMORY.md parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Parse heartbeats
  let heartbeats: OpenClawHeartbeat[] = [];
  try {
    heartbeats = parseHeartbeatMd(readFile("HEARTBEAT.md"));
  } catch (err) {
    errors.push(`HEARTBEAT.md parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Parse channels
  let channels: OpenClawChannel[] = [];
  try {
    const configContent = readFile("config.yaml") || readFile(".env");
    if (configContent) channels = parseConfigYaml(configContent);
  } catch (err) {
    errors.push(`config.yaml parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Parse skills
  let skills: OpenClawSkill[] = [];
  try {
    skills = parseClawHub(path.join(resolved, ".clawhub"));
  } catch (err) {
    errors.push(`.clawhub parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    path:             resolved,
    agents,
    soul,
    memories,
    heartbeats,
    skills,
    channels,
    validationErrors: errors,
  };
}

// ---------------------------------------------------------------------------
// executeImport
// ---------------------------------------------------------------------------

/** Write content to a file, creating parent directories as needed. */
function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Convert a parsed OpenClaw installation to SIDJUA config files.
 *
 * Execution order: agents → skills → memories → skill mapping → heartbeats → channels
 *
 * A failure in any component is recorded in errors but does NOT stop the
 * remaining components from being processed.
 */
export async function executeImport(
  installation:    OpenClawInstallation,
  workDir:         string,
  secretsProvider: SecretsProvider | null,
): Promise<ImportResult> {
  const result: ImportResult = {
    agentsCreated:      [],
    skillsMapped:       { direct: 0, partial: 0, none: 0 },
    memoriesImported:   0,
    channelsConfigured: [],
    heartbeatsCreated:  0,
    notMigrated:        [],
    errors:             [...installation.validationErrors],
  };

  const primaryAgent = installation.agents[0];

  // ── 1. Agents ────────────────────────────────────────────────────────────
  for (const agent of installation.agents) {
    try {
      const yaml      = mapAgentToYaml(agent);
      const safeName  = agent.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const agentPath = path.join(workDir, "agents", "definitions", `${safeName}.yaml`);
      writeFile(agentPath, yaml);
      result.agentsCreated.push(agent.name);
      logger.debug("import-executor", "Agent definition written", { metadata: { name: agent.name } });
    } catch (err) {
      const msg = `Agent ${agent.name}: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      result.notMigrated.push({ item: `agent:${agent.name}`, reason: msg });
    }
  }

  // ── 2. Skills (soul → system prompt) ─────────────────────────────────────
  if (installation.soul !== null) {
    const targetAgent = primaryAgent ?? { name: "assistant" };
    try {
      const md        = mapSoulToSkillMd(installation.soul, targetAgent.name);
      const safeName  = targetAgent.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const skillPath = path.join(workDir, "agents", "skills", `${safeName}.md`);
      writeFile(skillPath, md);
    } catch (err) {
      result.errors.push(`SOUL.md → skill: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 3. Memories ───────────────────────────────────────────────────────────
  if (installation.memories.length > 0) {
    try {
      const json     = mapMemoriesToJson(installation.memories);
      const memPath  = path.join(workDir, "import-data", "memories.json");
      writeFile(memPath, json);
      result.memoriesImported = installation.memories.length;
    } catch (err) {
      result.errors.push(`Memories export: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 4. Skill mapping ──────────────────────────────────────────────────────
  const skillNames = installation.skills.map((s) => s.name);
  if (skillNames.length > 0) {
    try {
      const mappings = lookupAllSkills(skillNames);
      for (const m of mappings) {
        if (m.status === "direct") result.skillsMapped.direct++;
        else if (m.status === "partial") result.skillsMapped.partial++;
        else {
          result.skillsMapped.none++;
          result.notMigrated.push({ item: `skill:${m.openclawName}`, reason: m.notes });
        }
      }
      const mcpYaml  = mapSkillsToMcpConfig(mappings);
      const mcpPath  = path.join(workDir, "import-data", "mcp-servers-import.yaml");
      writeFile(mcpPath, mcpYaml);
    } catch (err) {
      result.errors.push(`Skill mapping: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 5. Heartbeats ─────────────────────────────────────────────────────────
  if (installation.heartbeats.length > 0) {
    const agentName = primaryAgent?.name ?? "assistant";
    try {
      const yaml    = mapHeartbeatsToSchedulerYaml(installation.heartbeats, agentName);
      const hbPath  = path.join(workDir, "import-data", "scheduler-import.yaml");
      writeFile(hbPath, yaml);
      result.heartbeatsCreated = installation.heartbeats.length;
    } catch (err) {
      result.errors.push(`Heartbeats: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 6. Channels ───────────────────────────────────────────────────────────
  if (installation.channels.length > 0) {
    const adapterFiles = mapChannelsToAdapterYaml(installation.channels);
    for (const af of adapterFiles) {
      try {
        // Store extracted secrets via provider
        if (af.secrets && secretsProvider !== null) {
          await secretsProvider.ensureNamespace("import");
          for (const [key, value] of Object.entries(af.secrets)) {
            await secretsProvider.set("import", key, value);
            logger.debug("import-executor", "Stored channel secret via provider", {
              metadata: { key },   // log key name only — NEVER value
            });
          }
        } else if (af.secrets && secretsProvider === null) {
          // No secrets provider — note in errors but don't fail
          result.errors.push(
            `Channel ${af.filename}: secrets detected but no provider available — ` +
            `store manually: ${Object.keys(af.secrets).join(", ")}`,
          );
        }

        const chPath = path.join(workDir, "import-data", "channels", af.filename);
        writeFile(chPath, af.content);
        result.channelsConfigured.push(af.filename);
      } catch (err) {
        const msg = `Channel ${af.filename}: ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(msg);
        result.notMigrated.push({ item: `channel:${af.filename}`, reason: msg });
      }
    }
  }

  logger.debug("import-executor", "Import complete", {
    metadata: {
      agents:    result.agentsCreated.length,
      memories:  result.memoriesImported,
      heartbeats: result.heartbeatsCreated,
      channels:  result.channelsConfigured.length,
      errors:    result.errors.length,
    },
  });

  return result;
}
