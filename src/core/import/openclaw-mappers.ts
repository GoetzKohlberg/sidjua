// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — OpenClaw → SIDJUA config mappers.
 *
 * Each function takes a parsed OpenClaw intermediate type and returns
 * SIDJUA config content as a string (YAML, Markdown, or JSON).
 * No file I/O — callers write the returned strings to disk.
 *
 * Secret handling: mapChannelsToAdapterYaml() returns detected secret values
 * in the `secrets` property so callers can store them via the secrets
 * provider and write `${secrets:key}` references into the YAML.
 */

import type {
  OpenClawAgent,
  OpenClawSoul,
  OpenClawMemory,
  OpenClawHeartbeat,
  OpenClawChannel,
  SkillMapping,
} from "./types.js";
import { looksLikeSecret } from "./openclaw-parser.js";

// ---------------------------------------------------------------------------
// 5.1 mapAgentToYaml
// ---------------------------------------------------------------------------

/**
 * Generate SIDJUA agent definition YAML for agents/definitions/{name}.yaml.
 */
export function mapAgentToYaml(agent: OpenClawAgent): string {
  const safeName = agent.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const caps = agent.capabilities.length > 0
    ? agent.capabilities.map((c) => `  - "${c}"`).join("\n")
    : '  - "general"';

  return `# Auto-generated from OpenClaw import. Review and adjust before use.
id: "${safeName}"
name: "${agent.name} (imported)"
tier: "T3"
division: "hr"
model: "${agent.model}"
${agent.provider ? `provider: "${agent.provider}"\n` : ""}capabilities:
${caps}

budget:
  daily_limit_usd: 5.00
  per_task_limit_usd: 0.50

governance:
  allowed_divisions: ["*"]
  allowed_tiers: ["T1", "T2", "T3"]
  max_calls_per_minute: 30
  classification_ceiling: "INTERNAL"
`.trim();
}

// ---------------------------------------------------------------------------
// 5.2 mapSoulToSkillMd
// ---------------------------------------------------------------------------

/**
 * Generate Markdown for agents/skills/{name}.md from a SOUL.md.
 */
export function mapSoulToSkillMd(soul: OpenClawSoul, agentName: string): string {
  const safeName = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  const traitsSection = soul.personalityTraits.length > 0
    ? `\n## Personality\n\n${soul.personalityTraits.map((t) => `- ${t}`).join("\n")}\n`
    : "";

  return `# ${agentName} — Imported System Prompt

> Auto-generated from OpenClaw import. Review before deploying this agent.

## Governance Context

This agent operates under SIDJUA governance. All tool calls are subject to
the assigned tier, division, and budget limits defined in the agent YAML.
The system prompt below was imported from the source installation.

${traitsSection}
## System Prompt

<!-- Agent identifier used for routing: ${safeName} -->

${soul.rawText}
`.trim();
}

// ---------------------------------------------------------------------------
// 5.3 mapMemoriesToJson
// ---------------------------------------------------------------------------

/**
 * Generate JSON array for import-data/memories.json.
 */
export function mapMemoriesToJson(memories: OpenClawMemory[]): string {
  const now = new Date().toISOString();
  const records = memories.map((m) => ({
    type:      m.type,
    category:  m.category,
    content:   m.content,
    importedAt: now,
  }));
  return JSON.stringify(records, null, 2);
}

// ---------------------------------------------------------------------------
// 5.4 mapHeartbeatsToSchedulerYaml
// ---------------------------------------------------------------------------

/**
 * Generate governance/scheduler.yaml content from heartbeat entries.
 */
export function mapHeartbeatsToSchedulerYaml(
  heartbeats: OpenClawHeartbeat[],
  agentName: string,
): string {
  const safeName = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  if (heartbeats.length === 0) {
    return `# No heartbeat tasks imported for agent: ${safeName}\nschedules: []\n`;
  }

  const entries = heartbeats.map((hb) => {
    const safeTaskName = hb.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    return `  - name: "${safeTaskName}"
    agent: "${safeName}"
    cron: "${hb.schedule}"
    task: "${hb.action.replace(/"/g, "'").slice(0, 200)}"
    budget_limit_usd: 0.10
    max_tool_calls: 5`;
  }).join("\n");

  return `# Auto-generated scheduler config. Review cron expressions before enabling.
schedules:
${entries}
`;
}

// ---------------------------------------------------------------------------
// 5.5 mapChannelsToAdapterYaml
// ---------------------------------------------------------------------------

export interface ChannelAdapterFile {
  filename: string;
  content: string;
  /** Secret values extracted from config. Keys = secret names, values = raw values. */
  secrets?: Record<string, string>;
}

const CHANNEL_ADAPTER_MAP: Record<string, string> = {
  telegram:  "telegram",
  discord:   "discord",
  slack:     "slack",
  whatsapp:  "whatsapp",
  email:     "email",
};

/**
 * Generate per-channel adapter YAML files.
 * Detected secret values are extracted into the `secrets` return property;
 * the YAML content contains `${secrets:key_name}` references instead.
 */
export function mapChannelsToAdapterYaml(channels: OpenClawChannel[]): ChannelAdapterFile[] {
  return channels.map((ch, idx) => {
    const adapterType = CHANNEL_ADAPTER_MAP[ch.type] ?? ch.type;
    const filename    = `${adapterType}-adapter.yaml`;
    const extracted:  Record<string, string> = {};
    const configLines: string[] = [];

    for (const [k, v] of Object.entries(ch.config)) {
      const secretKey = `${adapterType}_${k.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
      if (looksLikeSecret(v)) {
        extracted[secretKey] = v;
        configLines.push(`  ${k}: "\${secrets:${secretKey}}"`);
      } else {
        configLines.push(`  ${k}: "${v.replace(/"/g, "'")}"`);
      }
    }

    const content = `# Auto-generated channel adapter config. Index: ${idx + 1}.
# Secrets referenced as \${secrets:key} — stored via SIDJUA secrets provider.
adapter: "${adapterType}"
enabled: false
config:
${configLines.join("\n")}
`.trim();

    return {
      filename,
      content,
      ...(Object.keys(extracted).length > 0 ? { secrets: extracted } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// 5.6 mapSkillsToMcpConfig
// ---------------------------------------------------------------------------

/**
 * Generate mcp-servers.yaml snippet for skills with direct or partial mappings.
 */
export function mapSkillsToMcpConfig(mappings: SkillMapping[]): string {
  const applicable = mappings.filter((m) => m.mcpPackage !== null);
  if (applicable.length === 0) {
    return "# No direct or partial MCP skill mappings found.\n";
  }

  const entries = applicable.map((m) => {
    const serverName = m.openclawName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const statusNote = m.status === "partial" ? " # PARTIAL — verify compatibility" : "";
    return `  ${serverName}:${statusNote}
    transport: stdio
    command: npx
    args:
      - "-y"
      - "${m.mcpPackage}"
    governance:
      allowed_divisions: ["*"]
      allowed_tiers: ["T1", "T2", "T3"]
      max_calls_per_minute: 20
      budget_per_call: 0.001
      classification_ceiling: INTERNAL
      forbidden_patterns: []
    # ${m.notes}`;
  }).join("\n");

  return `# Auto-generated MCP server entries from OpenClaw skill import.
# Review tokens/secrets before enabling. Disabled by default.
servers:
${entries}
`;
}
