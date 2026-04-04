// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — search_rest_catalog internal tool
 *
 * Searches the local REST API catalog for services by keyword or capability terms.
 * Mirror of mcp-registry-search.ts for the REST side.
 */

import { readFileSync }           from "node:fs";
import { createRequire }          from "node:module";
import type { InternalToolDef }   from "../adapters/internal-adapter.js";
import { createLogger }           from "../../core/logger.js";

const logger = createLogger("rest-catalog-search");


interface RestCatalogCapability {
  name:   string;
  method: string;
  path:   string;
  risk:   string;
}

export interface RestCatalogEntry {
  id:                string;
  name:              string;
  base_url:          string;
  docs_url:          string;
  auth_type:         string;
  auth_env_key:      string;
  auth_header_name?: string;
  tags:              string[];
  mcp_equivalent?:   string;
  core_capabilities: RestCatalogCapability[];
}

interface RestApiCatalog {
  version:  string;
  updated:  string;
  services: RestCatalogEntry[];
}


/** Injectable catalog path for tests. */
let _catalogPath: string | undefined;
export function setRestCatalogPath(p: string | undefined): void { _catalogPath = p; }


function loadCatalog(): RestApiCatalog {
  // Test override: load from custom path using readFileSync + JSON.parse
  if (_catalogPath !== undefined) {
    try {
      const raw = readFileSync(_catalogPath, "utf-8");
      return JSON.parse(raw) as RestApiCatalog;
    } catch (err) {
      logger.warn("rest_catalog_load_error", "Failed to load catalog from custom path", {
        metadata: { path: _catalogPath, error: String(err) },
      });
      return { version: "0", updated: "", services: [] };
    }
  }

  // Default: resolve bundled JSON via createRequire
  const req = createRequire(import.meta.url);
  try {
    return req("../../defaults/rest-api-catalog.json") as RestApiCatalog;
  } catch (err) {
    logger.warn("rest_catalog_missing", "REST API catalog not found", {
      metadata: { error: String(err) },
    });
    return { version: "0", updated: "", services: [] };
  }
}


export const searchRestCatalogTool: InternalToolDef = {
  id:          "internal-search-rest-catalog",
  name:        "search_rest_catalog",
  description: "Search the local REST API catalog for SaaS services by keyword or capability",
  capabilities: [{
    name:              "search_catalog",
    description:       "Search the REST API catalog by service name, tag, or capability keyword. Returns service name, base URL, auth type, capabilities list.",
    risk_level:        "low",
    requires_approval: false,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type:        "string",
          description: 'Search query (e.g. "github", "search", "payments")',
        },
        limit: {
          type:        "number",
          description: "Max results (default 10)",
          default:     10,
        },
      },
      required:             ["query"],
      additionalProperties: false,
    },
    output_schema: { type: "object" },
  }],

  execute: async (params) => {
    const query = String(params["query"] ?? "").trim().toLowerCase();
    const limit = Math.min(Number(params["limit"]) || 10, 25);

    if (query.length === 0) {
      return { error: "query is required and must not be empty" };
    }

    let catalog: RestApiCatalog;
    try {
      catalog = loadCatalog();
    } catch (err) {
      logger.warn("rest_catalog_load_failed", "Failed to load REST API catalog", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return { error: "Failed to load REST API catalog", query };
    }

    const results = catalog.services
      .filter((s) =>
        s.name.toLowerCase().includes(query) ||
        s.id.toLowerCase().includes(query) ||
        s.tags.some((t) => t.includes(query)) ||
        s.core_capabilities.some((c) => c.name.includes(query)),
      )
      .slice(0, limit)
      .map((s) => ({
        id:             s.id,
        name:           s.name,
        base_url:       s.base_url,
        docs_url:       s.docs_url,
        auth_type:      s.auth_type,
        auth_env_key:   s.auth_env_key,
        mcp_equivalent: s.mcp_equivalent,
        tags:           s.tags,
        capabilities:   s.core_capabilities.map((c) => ({
          name:   c.name,
          method: c.method,
          path:   c.path,
          risk:   c.risk,
        })),
        note: `Use register_rest_tool with catalog_id="${s.id}" to activate`,
      }));

    return {
      query,
      count:    results.length,
      services: results,
    };
  },
};
