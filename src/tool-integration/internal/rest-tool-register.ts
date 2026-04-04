// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — register_rest_tool internal tool
 *
 * Registers a REST API tool from the catalog, stores credentials via SecretsService,
 * appends to rest-tools.yaml, and mounts the adapter in ToolManager.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join }                                    from "node:path";
import { fileURLToPath }                           from "node:url";
import { readFileSync as fsReadFileSync }           from "node:fs";
import { createRequire }                           from "node:module";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { InternalToolDef }                    from "../adapters/internal-adapter.js";
import { loadRestToolsConfig, saveRestToolsConfig, type RestToolEntry, type RestToolCapabilityEntry } from "../rest-config.js";
import type { RestToolFactory }                    from "../rest-tool-factory.js";
import { createLogger }                            from "../../core/logger.js";
import { validateSafeId }                          from "../../utils/path-security.js";

const logger = createLogger("rest-tool-register");


// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/** Injectable secret store function — set at bootstrap time. */
let _storeSecret: ((key: string, value: string) => void) | null = null;
export function setRestSecretStore(fn: ((key: string, value: string) => void) | null): void {
  _storeSecret = fn;
}

/** Injectable config path for rest-tools.yaml (for testing). */
let _configPath: string | undefined;
export function setRestRegisterConfigPath(p: string | undefined): void { _configPath = p; }

/** Injectable catalog path (for testing). */
let _catalogPath: string | undefined;
export function setRestRegisterCatalogPath(p: string | undefined): void { _catalogPath = p; }

/** Injectable roles directory (for testing). */
let _rolesDir: string | undefined;
export function setRestRegisterRolesDir(d: string | undefined): void { _rolesDir = d; }

/** Injectable RestToolFactory instance (set at bootstrap time). */
let _factory: RestToolFactory | null = null;
export function setRestToolFactory(f: RestToolFactory | null): void { _factory = f; }


function getRolesDir(): string {
  if (_rolesDir !== undefined) return _rolesDir;
  const base = fileURLToPath(new URL(".", import.meta.url));
  // src/tool-integration/internal/ → src/defaults/roles/
  return join(base, "..", "..", "..", "src", "defaults", "roles");
}


// ---------------------------------------------------------------------------
// Catalog loading
// ---------------------------------------------------------------------------

interface RestCatalogCapability {
  name:   string;
  method: string;
  path:   string;
  risk:   string;
}

interface RestCatalogEntry {
  id:                string;
  name:              string;
  base_url:          string;
  docs_url?:         string;
  auth_type:         string;
  auth_env_key:      string;
  auth_header_name?: string;
  tags?:             string[];
  mcp_equivalent?:   string;
  core_capabilities: RestCatalogCapability[];
}

interface RestApiCatalog {
  version:  string;
  services: RestCatalogEntry[];
}

function loadCatalogEntry(catalogId: string): RestCatalogEntry | null {
  let catalog: RestApiCatalog;

  if (_catalogPath !== undefined) {
    try {
      const raw = fsReadFileSync(_catalogPath, "utf-8");
      catalog = JSON.parse(raw) as RestApiCatalog;
    } catch (err) {
      logger.warn("rest_catalog_load_error", "Failed to load catalog from custom path", {
        metadata: { error: String(err) },
      });
      return null;
    }
  } else {
    const req = createRequire(import.meta.url);
    try {
      catalog = req("../../defaults/rest-api-catalog.json") as RestApiCatalog;
    } catch (err) {
      logger.warn("rest_catalog_missing", "REST API catalog not found", {
        metadata: { error: String(err) },
      });
      return null;
    }
  }

  return catalog.services.find((s) => s.id === catalogId) ?? null;
}


// ---------------------------------------------------------------------------
// Role YAML update helper
// ---------------------------------------------------------------------------

/**
 * Add `toolId` to the `tools.mcp` list in a role YAML file (composite/REST tools
 * are stored in the same `tools.mcp` list as MCP servers for agent visibility).
 * Idempotent — skips if already present.
 */
function addToolToRoleYaml(roleId: string, toolId: string): boolean {
  const rolesDir = getRolesDir();
  let safeRoleId: string;
  try {
    safeRoleId = validateSafeId(roleId);
  } catch (_err) {
    logger.warn("rest_register_invalid_role_id", "Invalid roleId — rejecting role YAML update", {
      metadata: { roleId },
    });
    return false;
  }
  const filePath = join(rolesDir, `${safeRoleId}.yaml`);
  if (!existsSync(filePath)) return false;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const doc = parseYaml(raw) as Record<string, unknown>;
    const role = doc["role"] as Record<string, unknown> | undefined;
    if (role === undefined) return false;

    let tools = role["tools"] as Record<string, unknown> | undefined;
    if (tools === undefined || typeof tools !== "object") {
      tools = { internal: [], mcp: [] };
      role["tools"] = tools;
    }

    const mcp = Array.isArray(tools["mcp"]) ? (tools["mcp"] as string[]) : [];
    if (!mcp.includes(toolId)) {
      mcp.push(toolId);
      tools["mcp"] = mcp;
    }

    writeFileSync(filePath, stringifyYaml(doc, { lineWidth: 120 }), "utf-8");
    return true;
  } catch (err) {
    logger.warn("rest_register_role_update_failed", "Failed to update role YAML", {
      metadata: { roleId, toolId, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}


// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const registerRestToolTool: InternalToolDef = {
  id:                "internal-register-rest-tool",
  name:              "register_rest_tool",
  description:       "Register a REST API tool from the catalog, store credentials, and activate the adapter",
  callerRestriction: "orchestrator",
  capabilities: [{
    name:              "register",
    description:       "Register a service from the REST API catalog. Stores API key, appends to rest-tools.yaml, and activates the adapter.",
    risk_level:        "medium",
    requires_approval: false,
    input_schema: {
      type: "object",
      properties: {
        catalog_id: {
          type:        "string",
          description: 'Catalog service ID (e.g. "github", "slack"). Use search_rest_catalog to find valid IDs.',
        },
        tool_id: {
          type:        "string",
          description: 'Custom tool ID. Defaults to "{catalog_id}-rest" (e.g. "github-rest").',
        },
        credentials: {
          type:                 "object",
          description:          "API credentials keyed by the catalog auth_env_key (e.g. { GITHUB_TOKEN: \"ghp_...\" })",
          additionalProperties: { type: "string" },
        },
        base_url: {
          type:        "string",
          description: "Override base URL. Defaults to catalog base_url.",
        },
        assign_to_roles: {
          type:        "array",
          items:       { type: "string" },
          description: 'Role IDs to add this tool to (e.g. ["dev-agent"]). Optional.',
        },
      },
      required:             ["catalog_id"],
      additionalProperties: false,
    },
    output_schema: { type: "object" },
  }],

  execute: async (params) => {
    const catalogId = String(params["catalog_id"] ?? "").trim();
    if (!catalogId) {
      return { error: "catalog_id is required" };
    }

    // Look up catalog
    const entry = loadCatalogEntry(catalogId);
    if (entry === null) {
      return { error: `Catalog entry not found: ${catalogId}. Use search_rest_catalog to find valid IDs.` };
    }

    const toolId   = String(params["tool_id"] ?? `${catalogId}-rest`).trim();
    const baseUrl  = String(params["base_url"] ?? entry.base_url).trim();

    // Load existing config to check for duplicates
    const config = loadRestToolsConfig(_configPath);
    if (config.tools.some((t) => t.id === toolId)) {
      return { error: `REST tool '${toolId}' is already registered`, existing: true };
    }

    // Store credentials and build auth block
    const creds = params["credentials"];
    const credMap: Record<string, string> =
      creds !== null && typeof creds === "object" && !Array.isArray(creds)
        ? (creds as Record<string, string>)
        : {};

    let authBlock: RestToolEntry["auth"];
    const credKey = entry.auth_env_key;
    const credValue = credMap[credKey] ?? "";

    if (credValue) {
      const secretKey = `rest_${toolId}_${credKey}`;
      if (_storeSecret !== null) {
        _storeSecret(secretKey, credValue);
        const secretRef = `secret:${secretKey}`;

        switch (entry.auth_type) {
          case "bearer":
            authBlock = { type: "bearer", token: secretRef };
            break;
          case "basic":
            authBlock = { type: "basic", username: secretRef };
            break;
          case "header":
            authBlock = { type: "header", header_name: entry.auth_header_name ?? credKey, header_value: secretRef };
            break;
        }
      } else {
        // Fallback: store directly when no SecretsService is available
        switch (entry.auth_type) {
          case "bearer":
            authBlock = { type: "bearer", token: credValue };
            break;
          case "basic":
            authBlock = { type: "basic", username: credValue };
            break;
          case "header":
            authBlock = { type: "header", header_name: entry.auth_header_name ?? credKey, header_value: credValue };
            break;
        }
      }
    }

    // Build capabilities from catalog
    const capabilities: RestToolCapabilityEntry[] = entry.core_capabilities.map((cap) => ({
      name:              cap.name,
      description:       `${cap.method} ${cap.path}`,
      risk_level:        (cap.risk as "low" | "medium" | "high" | "critical") ?? "low",
      requires_approval: cap.risk === "high" || cap.risk === "critical",
      method:            cap.method as RestToolCapabilityEntry["method"],
      path_template:     cap.path,
    }));

    // Build and append the new RestToolEntry
    const newEntry: RestToolEntry = {
      id:   toolId,
      name: entry.name,
      base_url: baseUrl,
      capabilities,
      ...(authBlock !== undefined ? { auth: authBlock } : {}),
    };

    config.tools.push(newEntry);
    saveRestToolsConfig(config, _configPath);

    // Register adapter via factory (if available)
    if (_factory !== null) {
      try {
        _factory.registerTool(newEntry);
      } catch (err) {
        logger.warn("rest_register_adapter_failed", "Failed to register REST adapter (tool saved to config)", {
          metadata: { toolId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    // Assign to roles (optional)
    const assignedRoles: string[] = [];
    const failedRoles:   string[] = [];
    const roleList = params["assign_to_roles"];
    if (Array.isArray(roleList)) {
      for (const roleId of roleList) {
        const ok = addToolToRoleYaml(String(roleId), toolId);
        if (ok) assignedRoles.push(String(roleId));
        else    failedRoles.push(String(roleId));
      }
    }

    logger.info("rest_tool_registered", "REST tool registered from catalog", {
      metadata: { toolId, catalogId, base_url: baseUrl, capabilities: capabilities.length },
    });

    const result: Record<string, unknown> = {
      success:      true,
      tool_id:      toolId,
      catalog_id:   catalogId,
      name:         entry.name,
      base_url:     baseUrl,
      capabilities: capabilities.length,
      assigned_to_roles: assignedRoles,
      note: `REST tool '${toolId}' registered. Use create_composite_tool to pair with an MCP equivalent.`,
    };

    if (failedRoles.length > 0) {
      result["failed_roles"] = failedRoles;
    }

    return result;
  },
};
