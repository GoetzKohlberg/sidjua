// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P344: configure_mcp_server internal tool
 *
 * Configures credentials and role assignments for an installed MCP server.
 * Credentials are stored via an injectable SecretsProvider (or directly in the
 * config as a fallback when none is configured).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join }                                    from "node:path";
import { fileURLToPath }                           from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { InternalToolDef }                    from "../adapters/internal-adapter.js";
import { loadMcpConfig, saveMcpConfig }            from "../mcp-config.js";
import { createLogger }                            from "../../core/logger.js";

const logger = createLogger("mcp-configurator");

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/** Injectable secret store function — set at bootstrap time via SecretsProvider. */
let _storeSecret: ((key: string, value: string) => void) | null = null;
export function setSecretStore(fn: ((key: string, value: string) => void) | null): void {
  _storeSecret = fn;
}

/** Injectable config path (for testing). */
let _configPath: string | undefined;
export function setMcpConfiguratorConfigPath(p: string | undefined): void { _configPath = p; }

/** Injectable roles directory (for testing). */
let _rolesDir: string | undefined;
export function setMcpConfiguratorRolesDir(d: string | undefined): void { _rolesDir = d; }

function getRolesDir(): string {
  if (_rolesDir !== undefined) return _rolesDir;
  const base = fileURLToPath(new URL(".", import.meta.url));
  // Navigate from src/tool-integration/internal/ → src/defaults/roles/
  return join(base, "..", "..", "..", "src", "defaults", "roles");
}

// ---------------------------------------------------------------------------
// Role YAML update helper
// ---------------------------------------------------------------------------

/**
 * Add `serverId` to the `tools.mcp` list in a role YAML file.
 * Idempotent — skips if already present.
 * Returns true if the role file was found and updated.
 */
function addMcpToolToRole(roleId: string, serverId: string): boolean {
  const rolesDir  = getRolesDir();
  const filePath  = join(rolesDir, `${roleId}.yaml`);
  if (!existsSync(filePath)) return false;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const doc = parseYaml(raw) as Record<string, unknown>;
    const role = doc["role"] as Record<string, unknown> | undefined;
    if (!role) return false;

    let tools = role["tools"] as Record<string, unknown> | undefined;
    if (tools === undefined || typeof tools !== "object") {
      tools = { internal: [], mcp: [] };
      role["tools"] = tools;
    }

    const mcp = Array.isArray(tools["mcp"]) ? (tools["mcp"] as string[]) : [];
    if (!mcp.includes(serverId)) {
      mcp.push(serverId);
      tools["mcp"] = mcp;
    }

    writeFileSync(filePath, stringifyYaml(doc, { lineWidth: 120 }), "utf-8");
    return true;
  } catch (err) {
    logger.warn("mcp_configurator_role_update_failed", "Failed to update role YAML", {
      metadata: { roleId, serverId, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const configureMcpServerTool: InternalToolDef = {
  id:                "internal-configure-mcp-server",
  name:              "configure_mcp_server",
  description:       "Configure credentials and role assignments for an installed MCP server",
  callerRestriction: "orchestrator",
  capabilities: [{
    name:        "configure",
    description: "Set environment variables (credentials), assign to agent roles, and optionally auto-start the server.",
    risk_level:  "medium",
    requires_approval: false,
    input_schema: {
      type: "object",
      properties: {
        server_id: {
          type:        "string",
          description: "Server ID to configure",
        },
        env: {
          type:                 "object",
          description:          "Environment variables (credentials). Values stored in SecretsService.",
          additionalProperties: { type: "string" },
        },
        assign_to_roles: {
          type:        "array",
          items:       { type: "string" },
          description: 'Role IDs to grant access (e.g. ["finance", "it"])',
        },
        auto_start: {
          type:        "boolean",
          description: "Auto-start on SIDJUA boot",
          default:     false,
        },
      },
      required:             ["server_id"],
      additionalProperties: false,
    },
    output_schema: { type: "object" },
  }],

  execute: async (params) => {
    const server_id = String(params["server_id"] ?? "").trim();
    if (!server_id) {
      return { error: "server_id is required" };
    }

    const config = loadMcpConfig(_configPath);
    const entry  = config.servers.find((s) => s.id === server_id);
    if (entry === undefined) {
      return { error: `Server '${server_id}' not found. Install it first with install_mcp_server.` };
    }

    // Store credentials
    const envMap = params["env"];
    let credentialsStored = 0;
    if (envMap !== null && typeof envMap === "object" && !Array.isArray(envMap)) {
      for (const [key, value] of Object.entries(envMap as Record<string, unknown>)) {
        const strValue = String(value ?? "");
        if (_storeSecret !== null) {
          const secretKey = `mcp_${server_id}_${key}`;
          _storeSecret(secretKey, strValue);
          // Reference in config — resolved at server start time
          entry.env = entry.env ?? {};
          entry.env[key] = `secret:${secretKey}`;
        } else {
          // Fallback: store directly (less secure, but functional)
          entry.env = entry.env ?? {};
          entry.env[key] = strValue;
        }
        credentialsStored++;
      }
    }

    // auto_start
    const autoStart = params["auto_start"];
    if (typeof autoStart === "boolean") {
      entry.auto_start = autoStart;
    }

    saveMcpConfig(config, _configPath);

    // Assign to roles
    const assignedRoles: string[] = [];
    const failedRoles:   string[] = [];
    const roleList = params["assign_to_roles"];
    if (Array.isArray(roleList)) {
      for (const roleId of roleList) {
        const ok = addMcpToolToRole(String(roleId), server_id);
        if (ok) {
          assignedRoles.push(String(roleId));
        } else {
          failedRoles.push(String(roleId));
        }
      }
    }

    logger.info("mcp_server_configured", "MCP server configured", {
      metadata: {
        id:         server_id,
        roles:      assignedRoles,
        auto_start: entry.auto_start,
        credentials: credentialsStored,
      },
    });

    const result: Record<string, unknown> = {
      success:            true,
      server_id,
      credentials_stored: credentialsStored,
      assigned_to_roles:  assignedRoles,
      auto_start:         entry.auto_start ?? false,
    };

    if (failedRoles.length > 0) {
      result["failed_roles"] = failedRoles;
      result["note"] = `Could not find role YAML files for: ${failedRoles.join(", ")}`;
    } else if (assignedRoles.length > 0) {
      result["note"] = `Agents with roles [${assignedRoles.join(", ")}] can now use ${entry.name} tools.`;
    } else {
      result["note"] = "No role assignments made. Use assign_to_roles to grant agent access.";
    }

    return result;
  },
};
