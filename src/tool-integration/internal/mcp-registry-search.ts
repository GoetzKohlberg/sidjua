// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P344: search_mcp_registry internal tool
 *
 * Queries the official MCP Registry API. Falls back to the local seed catalog
 * when the registry is unavailable (offline / low-bandwidth).
 */

import { createRequire } from "node:module";
import type { InternalToolDef } from "../adapters/internal-adapter.js";
import { createLogger }         from "../../core/logger.js";
import { detectChinaBundle }    from "./china-detection.js";

const logger      = createLogger("mcp-registry");
const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";

// ---------------------------------------------------------------------------
// Seed catalog helpers
// ---------------------------------------------------------------------------

interface SeedEntry {
  id:      string;
  name:    string;
  package: string;
  tags:    string[];
}

interface SeedCatalog {
  version: string;
  updated: string;
  global:  SeedEntry[];
  china:   SeedEntry[];
}

function loadSeedCatalog(): SeedCatalog {
  const req = createRequire(import.meta.url);
  return req("../../defaults/mcp-seed.json") as SeedCatalog;
}

function searchSeedCatalog(query: string): Array<Record<string, unknown>> {
  let catalog: SeedCatalog;
  try {
    catalog = loadSeedCatalog();
  } catch {
    return [];
  }

  const q       = query.toLowerCase();
  const entries = detectChinaBundle()
    ? [...catalog.global, ...catalog.china]
    : catalog.global;

  return entries
    .filter((e) =>
      e.name.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      e.tags.some((t) => t.includes(q)),
    )
    .map((e) => ({
      name:            e.name,
      description:     `MCP server for ${e.name}`,
      version:         "latest",
      repository:      undefined,
      install_command: `npx -y ${e.package}`,
      author:          "MCP Community",
      tags:            e.tags,
    }));
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const searchMcpRegistryTool: InternalToolDef = {
  id:          "internal-search-mcp-registry",
  name:        "search_mcp_registry",
  description: "Search the official MCP Registry for tool servers by keyword",
  capabilities: [{
    name:        "search_registry",
    description: "Search MCP Registry API for servers matching a query. Returns server name, description, install command, version.",
    risk_level:  "low",
    requires_approval: false,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type:        "string",
          description: 'Search query (e.g. "google sheets", "github", "slack")',
        },
        limit: {
          type:        "number",
          description: "Max results (default 10)",
          default:     10,
        },
      },
      required:              ["query"],
      additionalProperties:  false,
    },
    output_schema: { type: "object" },
  }],

  execute: async (params) => {
    const query = String(params["query"] ?? "").trim();
    const limit = Math.min(Number(params["limit"]) || 10, 25);

    if (query.length === 0) {
      return { error: "query is required and must not be empty" };
    }

    try {
      const url = `${REGISTRY_URL}?search=${encodeURIComponent(query)}&limit=${limit}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "SIDJUA-Agent-OS/1.0" },
        signal:  AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        logger.warn("mcp_registry_error", "Registry returned non-200 status", {
          metadata: { status: res.status, query },
        });
        return { error: `Registry returned ${res.status}`, query };
      }

      const data    = await res.json() as Record<string, unknown>;
      const rawList = (
        Array.isArray(data["servers"]) ? data["servers"] :
        Array.isArray(data["results"]) ? data["results"] :
        []
      ) as Array<Record<string, unknown>>;

      const servers = rawList.slice(0, limit).map((s) => ({
        name:            String(s["name"] ?? ""),
        description:     String(s["description"] ?? ""),
        version:         String(s["version"] ?? "latest"),
        repository:      s["repository"] ?? s["repo"],
        install_command: String(s["install_command"] ?? `npx -y ${String(s["package"] ?? s["name"] ?? "")}`),
        author:          s["author"],
        tags:            Array.isArray(s["tags"]) ? s["tags"] : [],
      }));

      return { query, count: servers.length, servers };
    } catch (err) {
      logger.warn("mcp_registry_unreachable", "Registry unavailable — falling back to seed catalog", {
        metadata: { query, error: err instanceof Error ? err.message : String(err) },
      });

      const fallback = searchSeedCatalog(query);
      return {
        error:    "Registry unavailable — showing seed catalog matches",
        query,
        fallback: true,
        count:    fallback.length,
        servers:  fallback,
      };
    }
  },
};
