// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — OpenClaw file parsers.
 *
 * Each function reads a raw string (or path for .clawhub/) and returns
 * the parsed intermediate representation. All parsers are pure — no side
 * effects, no file I/O except parseClawHub which reads the skill directory.
 *
 * Error policy: malformed sections are skipped with a debug log; the
 * remaining sections are still returned so a partial import is possible.
 */

import * as fs   from "node:fs";
import * as path from "node:path";
import { createLogger } from "../logger.js";
import type {
  OpenClawAgent,
  OpenClawSoul,
  OpenClawMemory,
  OpenClawHeartbeat,
  OpenClawChannel,
  OpenClawSkill,
} from "./types.js";

const logger = createLogger("openclaw-parser");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the value after the first colon on a line, trimmed. */
function extractField(lines: string[], ...keys: string[]): string | undefined {
  for (const line of lines) {
    for (const key of keys) {
      const pattern = new RegExp(`^${key}\\s*:\\s*(.+)$`, "i");
      const m = pattern.exec(line.trim());
      if (m?.[1]) return m[1].trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. parseAgentsMd
// ---------------------------------------------------------------------------

/**
 * Parse AGENTS.md → array of OpenClawAgent objects.
 *
 * Supports `## AgentName` or `# Agent: AgentName` section headers.
 * Falls back to a single "assistant" agent when no headers are found.
 */
export function parseAgentsMd(content: string): OpenClawAgent[] {
  if (content.trim() === "") return [];

  // Split into sections on ## or # Agent:
  const sections = content.split(/\n(?=##? (?:Agent:\s*)?)/i).filter(Boolean);

  // If only one section with no header, treat entire content as one agent
  const hasHeaders = /^##? /im.test(content);
  if (!hasHeaders) {
    const lines = content.split("\n");
    const model        = extractField(lines, "model") ?? "claude-sonnet-4-6";
    const provider     = extractField(lines, "provider");
    const capLine      = extractField(lines, "capabilities", "capability");
    const capabilities = capLine ? capLine.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return [{ name: "assistant", model, ...(provider ? { provider } : {}), capabilities }];
  }

  const agents: OpenClawAgent[] = [];

  for (const section of sections) {
    const lines = section.split("\n");
    if (lines.length === 0) continue;

    // Extract name from header line
    const header = lines[0] ?? "";
    const nameMatch = /^##? (?:Agent:\s*)?(.+)$/i.exec(header.trim());
    if (!nameMatch) continue;
    const name = nameMatch[1]!.trim();
    if (!name) continue;

    // Try to parse optional YAML frontmatter within section
    let model        = "claude-sonnet-4-6";
    let provider: string | undefined;
    let capabilities: string[] = [];

    const fmMatch = /^---\n([\s\S]+?)\n---/m.exec(section);
    if (fmMatch) {
      try {
        // Minimal key:value YAML parsing (avoid full yaml dep in parser)
        const fmLines = fmMatch[1]!.split("\n");
        model        = extractField(fmLines, "model") ?? model;
        provider     = extractField(fmLines, "provider");
        const capLine = extractField(fmLines, "capabilities");
        if (capLine) capabilities = capLine.split(",").map((s) => s.trim()).filter(Boolean);
      } catch (err) {
        logger.debug("openclaw-parser", "YAML frontmatter parse failed in agent section", {
          metadata: { name, error: err instanceof Error ? err.message : String(err) },
        });
      }
    } else {
      model        = extractField(lines, "model") ?? model;
      provider     = extractField(lines, "provider");
      const capLine = extractField(lines, "capabilities", "capability");
      if (capLine) capabilities = capLine.split(",").map((s) => s.trim()).filter(Boolean);
    }

    agents.push({ name, model, ...(provider ? { provider } : {}), capabilities });
  }

  return agents;
}

// ---------------------------------------------------------------------------
// 2. parseSoulMd
// ---------------------------------------------------------------------------

const GERMAN_KEYWORDS = ["du ", "ich ", "bitte ", "danke ", "sind ", "haben ", "werden "];

/**
 * Parse SOUL.md → system prompt representation.
 */
export function parseSoulMd(content: string): OpenClawSoul {
  const rawText = content.trim();
  if (rawText === "") {
    return { rawText: "", personalityTraits: [] };
  }

  const personalityTraits: string[] = [];
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (/^you (are|speak|think|act|respond|answer)/i.test(trimmed)) {
      personalityTraits.push(trimmed);
    }
  }

  const lower = rawText.toLowerCase();
  const germanScore = GERMAN_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  const language = germanScore >= 2 ? "de" : "en";

  return { rawText, personalityTraits, language };
}

// ---------------------------------------------------------------------------
// 3. parseMemoryMd
// ---------------------------------------------------------------------------

function classifyMemory(text: string): "fact" | "preference" | "conversation" {
  const lower = text.toLowerCase();
  // Check conversation signals before preference signals (text may contain both)
  if (/\b(said|told|asked|mentioned|conversation|remember when)\b/.test(lower)) return "conversation";
  if (/\bon \d{4}[-/]\d{2}/.test(lower)) return "conversation";
  if (/\b(prefer|prefers|like|likes|want|wants|favorite|favourite)\b/.test(lower)) return "preference";
  return "fact";
}

/**
 * Parse MEMORY.md → list of memory entries with type and category.
 */
export function parseMemoryMd(content: string): OpenClawMemory[] {
  if (content.trim() === "") return [];

  const memories: OpenClawMemory[] = [];
  const sections = content.split(/\n(?=## )/);

  for (const section of sections) {
    const lines = section.split("\n");
    const headerLine = lines[0] ?? "";
    const categoryMatch = /^##? (.+)$/.exec(headerLine.trim());
    const category = categoryMatch ? categoryMatch[1]!.trim() : "general";

    for (const line of lines.slice(1)) {
      const itemMatch = /^[-*]\s+(.+)$/.exec(line.trim());
      if (!itemMatch) continue;
      const content = itemMatch[1]!.trim();
      if (!content) continue;
      memories.push({ type: classifyMemory(content), category, content });
    }

    // Also pick up plain non-list lines that are substantial
    if (!lines.slice(1).some((l) => /^[-*]\s/.test(l.trim()))) {
      for (const line of lines.slice(1)) {
        const trimmed = line.trim();
        if (trimmed.length > 10 && !trimmed.startsWith("#")) {
          memories.push({ type: classifyMemory(trimmed), category, content: trimmed });
        }
      }
    }
  }

  return memories;
}

// ---------------------------------------------------------------------------
// 4. parseHeartbeatMd
// ---------------------------------------------------------------------------

/**
 * Convert natural language schedule strings to cron expressions.
 * Returns the original string unchanged if conversion fails.
 */
function naturalToCron(raw: string): string {
  const s = raw.trim().toLowerCase();

  // "daily HH:MM" or "daily at HH:MM"
  const daily = /^daily\s+(?:at\s+)?(\d{1,2}):(\d{2})$/.exec(s);
  if (daily) return `${parseInt(daily[2]!, 10)} ${parseInt(daily[1]!, 10)} * * *`;

  // "weekly monday HH:MM" / "weekly on monday at HH:MM"
  const weekly = /^weekly\s+(?:on\s+)?(\w+)\s+(?:at\s+)?(\d{1,2}):(\d{2})$/.exec(s);
  if (weekly) {
    const dayMap: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    };
    const day = dayMap[weekly[1]!];
    if (day !== undefined) return `${parseInt(weekly[3]!, 10)} ${parseInt(weekly[2]!, 10)} * * ${day}`;
  }

  // "friday HH:MM"
  const dayTime = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(?:at\s+)?(\d{1,2}):(\d{2})$/.exec(s);
  if (dayTime) {
    const dayMap: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    };
    const day = dayMap[dayTime[1]!];
    if (day !== undefined) return `${parseInt(dayTime[3]!, 10)} ${parseInt(dayTime[2]!, 10)} * * ${day}`;
  }

  // "hourly" / "every hour"
  if (/^(?:hourly|every\s+hour)$/.test(s)) return "0 * * * *";

  // Already looks like a cron expression (5 or 6 space-separated tokens)
  if (/^[\d*/,\-\s]+$/.test(s) && s.trim().split(/\s+/).length >= 5) return raw.trim();

  logger.debug("openclaw-parser", "Could not parse schedule as cron — storing raw", {
    metadata: { raw },
  });
  return raw.trim();
}

/**
 * Parse HEARTBEAT.md → list of scheduled heartbeat entries.
 */
export function parseHeartbeatMd(content: string): OpenClawHeartbeat[] {
  if (content.trim() === "") return [];

  const heartbeats: OpenClawHeartbeat[] = [];
  const sections = content.split(/\n(?=## )/);

  for (const section of sections) {
    const lines = section.split("\n");
    const headerLine = lines[0] ?? "";
    const nameMatch = /^##? (.+)$/.exec(headerLine.trim());
    const name = nameMatch ? nameMatch[1]!.trim() : "heartbeat";

    const rawSchedule = extractField(lines, "schedule") ?? "";
    const action      = extractField(lines, "action") ?? lines.filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("schedule") && !l.startsWith("action")).map((l) => l.trim()).join(" ");

    if (!rawSchedule && !action) continue;

    const schedule = rawSchedule ? naturalToCron(rawSchedule) : "0 9 * * 1";
    heartbeats.push({ name, schedule, action: action.slice(0, 500) });
  }

  return heartbeats;
}

// ---------------------------------------------------------------------------
// 5. parseConfigYaml
// ---------------------------------------------------------------------------

/** Detect if a string value looks like a secret (token, key, password). */
function looksLikeSecret(value: string): boolean {
  if (value.length < 16) return false;
  if (/^(sk-|bot|EAA|xox[bporas]-|ghp_|ghs_|glpat-|AIza)/.test(value)) return true;
  if (/^[A-Za-z0-9+/=]{32,}$/.test(value) && value.length >= 32) return true;
  return false;
}

/**
 * Parse config.yaml → list of channel configurations.
 * Secret-looking values are kept in config for caller to handle.
 */
export function parseConfigYaml(content: string): OpenClawChannel[] {
  if (content.trim() === "") return [];

  let parsed: unknown;
  try {
    // Minimal YAML parsing: only support simple key: value and nested sections
    parsed = minimalYamlParse(content);
  } catch (err) {
    logger.debug("openclaw-parser", "config.yaml parse failed", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];

  const channels: OpenClawChannel[] = [];
  const obj = parsed as Record<string, unknown>;

  // Look for a top-level "channels:" section
  const channelsSection = obj["channels"];
  if (typeof channelsSection === "object" && channelsSection !== null && !Array.isArray(channelsSection)) {
    for (const [channelType, channelConf] of Object.entries(channelsSection as Record<string, unknown>)) {
      if (typeof channelConf !== "object" || channelConf === null) continue;
      const config: Record<string, string> = {};
      for (const [k, v] of Object.entries(channelConf as Record<string, unknown>)) {
        if (typeof v === "string") config[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") config[k] = String(v);
      }
      channels.push({ type: channelType, config });
    }
    return channels;
  }

  // Fall back: detect known channel env-var patterns in flat structure
  const channelTokens: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string") continue;
    const lower = k.toLowerCase();
    let channelType = "unknown";
    if (lower.includes("telegram")) channelType = "telegram";
    else if (lower.includes("discord")) channelType = "discord";
    else if (lower.includes("slack")) channelType = "slack";
    else if (lower.includes("whatsapp")) channelType = "whatsapp";
    else if (lower.includes("email") || lower.includes("smtp")) channelType = "email";
    else continue;

    if (!channelTokens[channelType]) channelTokens[channelType] = {};
    channelTokens[channelType]![k] = v;
  }

  for (const [type, config] of Object.entries(channelTokens)) {
    channels.push({ type, config });
  }

  return channels;
}

// ---------------------------------------------------------------------------
// 6. parseClawHub
// ---------------------------------------------------------------------------

/**
 * Parse .clawhub/ directory → list of installed OpenClaw skills.
 */
export function parseClawHub(clawHubPath: string): OpenClawSkill[] {
  if (!fs.existsSync(clawHubPath)) return [];

  const skills: OpenClawSkill[] = [];

  // Try installed.json / registry.json first
  const installedPaths = [
    path.join(clawHubPath, "installed.json"),
    path.join(clawHubPath, "registry.json"),
  ];

  let installedNames: string[] = [];
  for (const installedPath of installedPaths) {
    if (!fs.existsSync(installedPath)) continue;
    try {
      const raw = fs.readFileSync(installedPath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (_err) {
        logger.debug("openclaw-parser", "installed.json parse failed — scanning dirs", {
          metadata: { path: installedPath },
        });
        break;
      }
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === "string") installedNames.push(entry);
          else if (typeof entry === "object" && entry !== null) {
            const nameField = (entry as Record<string, unknown>)["name"];
            if (typeof nameField === "string") installedNames.push(nameField);
          }
        }
      } else if (typeof parsed === "object" && parsed !== null) {
        installedNames = Object.keys(parsed as Record<string, unknown>);
      }
      break;
    } catch (err) {
      logger.debug("openclaw-parser", "Could not read installed.json", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Read skill directories
  const skillsDir = path.join(clawHubPath, "skills");
  let skillDirs: string[] = [];
  if (fs.existsSync(skillsDir)) {
    try {
      skillDirs = fs.readdirSync(skillsDir).filter((d) => {
        try { return fs.statSync(path.join(skillsDir, d)).isDirectory(); } catch (_err) { return false; }
      });
    } catch (err) {
      logger.debug("openclaw-parser", "Could not read skills dir", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Merge: installed names + discovered dirs
  const allNames = new Set([...installedNames, ...skillDirs]);

  for (const skillName of allNames) {
    const skillPath = path.join(skillsDir, skillName);
    let description: string | undefined;
    let version: string | undefined;
    let tools: string[] | undefined;

    // Read package.json if present
    const pkgPath = path.join(skillPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const raw = fs.readFileSync(pkgPath, "utf8");
        let pkg: unknown;
        try {
          pkg = JSON.parse(raw);
        } catch (_err) {
          logger.debug("openclaw-parser", "Skill package.json parse failed", {
            metadata: { skill: skillName },
          });
        }
        if (typeof pkg === "object" && pkg !== null) {
          const p = pkg as Record<string, unknown>;
          if (typeof p["description"] === "string") description = p["description"];
          if (typeof p["version"] === "string") version = p["version"];
        }
      } catch (err) {
        logger.debug("openclaw-parser", "Could not read skill package.json", {
          metadata: { skill: skillName, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    // Read SKILL.md if present
    const skillMdPath = path.join(skillPath, "SKILL.md");
    if (fs.existsSync(skillMdPath)) {
      try {
        const md = fs.readFileSync(skillMdPath, "utf8");
        if (!description) {
          const descMatch = /^#+ .+\n+(.+)/m.exec(md);
          if (descMatch) description = descMatch[1]!.trim().slice(0, 200);
        }
        // Extract tool names from `## Tools` or `### Tools` section
        const toolsMatch = /^##+ tools?\n([\s\S]+?)(?=^##|\z)/im.exec(md);
        if (toolsMatch) {
          tools = toolsMatch[1]!
            .split("\n")
            .map((l) => { const m = /^[-*]\s+`?(\w[\w-]*)/.exec(l.trim()); return m?.[1]; })
            .filter((t): t is string => t !== undefined);
        }
      } catch (err) {
        logger.debug("openclaw-parser", "Could not read SKILL.md", {
          metadata: { skill: skillName, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    skills.push({
      name: skillName,
      ...(description !== undefined ? { description } : {}),
      ...(version    !== undefined ? { version }     : {}),
      ...(tools      !== undefined ? { tools }       : {}),
    });
  }

  // Also add skills from installed.json that have no directory
  for (const name of installedNames) {
    if (!skills.some((s) => s.name === name)) {
      skills.push({ name });
    }
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (key: value + indented sections)
// ---------------------------------------------------------------------------

/**
 * Minimal YAML parser supporting up to 3 levels of nesting.
 * Handles: key: value, section headers (no value), and nested subsections.
 * Does NOT handle anchors, aliases, multi-line values, or arrays.
 */
function minimalYamlParse(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");

  // State tracking
  let depth0Key: string | null = null;           // top-level section key
  let depth0Obj: Record<string, unknown> = {};   // top-level section value
  let depth1Key: string | null = null;           // nested subsection key
  let depth1Obj: Record<string, string> = {};    // nested subsection value

  function flushDepth1(): void {
    if (depth1Key !== null && depth0Key !== null) {
      depth0Obj[depth1Key] = depth1Obj;
      depth1Key = null;
      depth1Obj = {};
    }
  }

  function flushDepth0(): void {
    flushDepth1();
    if (depth0Key !== null) {
      result[depth0Key] = depth0Obj;
      depth0Key = null;
      depth0Obj = {};
    }
  }

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent  = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    const trimmed = line.trim();
    const kv = /^([\w][\w.-]*):\s*(.*)$/.exec(trimmed);
    if (!kv) continue;

    const key   = kv[1]!;
    const value = kv[2]!.trim().replace(/^["']|["']$/g, "");

    if (indent === 0) {
      flushDepth0();
      if (value === "") {
        depth0Key = key;
        depth0Obj = {};
      } else {
        result[key] = value;
      }
    } else if (indent >= 2 && indent < 4) {
      // Depth 1 — inside a top-level section
      flushDepth1();
      if (depth0Key === null) continue;
      if (value === "") {
        depth1Key = key;
        depth1Obj = {};
      } else {
        depth0Obj[key] = value;
      }
    } else if (indent >= 4) {
      // Depth 2 — inside a nested subsection
      if (depth1Key === null || depth0Key === null) continue;
      depth1Obj[key] = value;
    }
  }

  flushDepth0();
  return result;
}

// Re-export looksLikeSecret for use in mappers
export { looksLikeSecret };
