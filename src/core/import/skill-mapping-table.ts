// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — OpenClaw → MCP skill mapping table.
 *
 * Static lookup table mapping OpenClaw skill names to known MCP server
 * npm packages. Used during import to auto-generate mcp-servers.yaml entries.
 */

import type { SkillMapping } from "./types.js";

const SKILL_MAPPINGS: Record<string, Omit<SkillMapping, "openclawName">> = {
  // ── Direct equivalents ────────────────────────────────────────────────────
  "skill-filesystem":      { mcpPackage: "@anthropic/mcp-server-filesystem",   status: "direct",  notes: "Path scoping via governance" },
  "file-manager":          { mcpPackage: "@anthropic/mcp-server-filesystem",   status: "direct",  notes: "Path scoping via governance" },
  "skill-github":          { mcpPackage: "@anthropic/mcp-server-github",       status: "direct",  notes: "Token via secrets provider" },
  "github":                { mcpPackage: "@anthropic/mcp-server-github",       status: "direct",  notes: "Token via secrets provider" },
  "skill-brave-search":    { mcpPackage: "@anthropic/mcp-server-brave-search", status: "direct",  notes: "API key required" },
  "web-search":            { mcpPackage: "@anthropic/mcp-server-brave-search", status: "direct",  notes: "API key required" },
  "skill-google-calendar": { mcpPackage: "google-calendar-mcp",                status: "direct",  notes: "OAuth setup needed" },
  "skill-gmail":           { mcpPackage: "google-gmail-mcp",                   status: "direct",  notes: "OAuth setup needed" },
  "skill-slack":           { mcpPackage: "@anthropic/mcp-server-slack",        status: "direct",  notes: "Bot token via secrets" },
  "skill-sqlite":          { mcpPackage: "@anthropic/mcp-server-sqlite",       status: "direct",  notes: "DB path via governance" },
  "skill-puppeteer":       { mcpPackage: "@anthropic/mcp-server-puppeteer",    status: "direct",  notes: "Headless browser" },
  "skill-fetch":           { mcpPackage: "@anthropic/mcp-server-fetch",        status: "direct",  notes: "URL governance applies" },
  "skill-git":             { mcpPackage: "@anthropic/mcp-server-git",          status: "direct",  notes: "Repo path scoped" },
  "skill-notion":          { mcpPackage: "notion-mcp",                         status: "direct",  notes: "Integration token needed" },
  "skill-todoist":         { mcpPackage: "todoist-mcp",                        status: "direct",  notes: "API token needed" },
  "skill-linear":          { mcpPackage: "linear-mcp",                         status: "direct",  notes: "API key needed" },
  "skill-postgres":        { mcpPackage: "@anthropic/mcp-server-postgres",     status: "direct",  notes: "Connection string via secrets" },
  "skill-memory":          { mcpPackage: "@anthropic/mcp-server-memory",       status: "direct",  notes: "Knowledge graph storage" },

  // ── Partial equivalents ───────────────────────────────────────────────────
  "skill-home-assistant":  { mcpPackage: "homeassistant-mcp",                  status: "partial", notes: "Different API version" },

  // ── No direct equivalent ──────────────────────────────────────────────────
  "skill-spotify":         { mcpPackage: null, status: "none", notes: "No MCP equivalent — REST wrapper needed" },
  "skill-trading":         { mcpPackage: null, status: "none", notes: "Custom module required" },
  "skill-voice":           { mcpPackage: null, status: "none", notes: "TTS/STT as external service" },
  "calculator":            { mcpPackage: null, status: "none", notes: "LLM native capability" },
  "translator":            { mcpPackage: null, status: "none", notes: "LLM native capability" },
};

/** Strip common OpenClaw package prefixes and normalize to lowercase. */
function normalizeSkillName(raw: string): string {
  return raw.toLowerCase()
    .replace(/^@[^/]+\//, "")      // strip npm scope
    .replace(/^openclaw-/, "")
    .replace(/^clawhub-/, "");
}

/**
 * Look up the MCP mapping for an OpenClaw skill name.
 * Tries exact match first, then substring/superstring match.
 */
export function lookupSkillMapping(skillName: string): SkillMapping {
  const normalized = normalizeSkillName(skillName);

  // Exact match
  const exact = SKILL_MAPPINGS[normalized];
  if (exact) return { openclawName: skillName, ...exact };

  // Substring match
  for (const [key, value] of Object.entries(SKILL_MAPPINGS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return { openclawName: skillName, ...value };
    }
  }

  return {
    openclawName: skillName,
    mcpPackage:   null,
    status:       "none",
    notes:        "Custom skill — manual migration to Module SDK required",
  };
}

/** Map a list of skill names → SkillMapping array. */
export function lookupAllSkills(skillNames: string[]): SkillMapping[] {
  return skillNames.map(lookupSkillMapping);
}
