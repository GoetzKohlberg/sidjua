// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — create_composite_tool internal tool
 *
 * Creates a CompositeToolConfig that wraps MCP + REST sub-tools with a chosen
 * strategy (fallback/parallel/round_robin). Registers the logical tool in
 * ToolRegistry + ToolManager. Updates agent role YAMLs with the logical_id only
 * (sub-tool IDs are implementation details hidden from agents).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join }                                    from "node:path";
import { fileURLToPath }                           from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { InternalToolDef }                    from "../adapters/internal-adapter.js";
import type { ToolRegistry }                       from "../tool-registry.js";
import type { ToolManager }                        from "../tool-manager.js";
import { CompositeAdapter }                        from "../adapters/composite-adapter.js";
import type { CompositeToolConfig, ToolCapability } from "../types.js";
import { createLogger }                            from "../../core/logger.js";

const logger = createLogger("composite-tool-creator");


// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

let _registry: ToolRegistry | null  = null;
let _manager:  ToolManager  | null  = null;
let _rolesDir: string | undefined;

export function setCompositeRegistry(r: ToolRegistry | null): void  { _registry = r; }
export function setCompositeManager(m: ToolManager | null): void    { _manager  = m; }
export function setCompositeRolesDir(d: string | undefined): void   { _rolesDir = d; }


function getRolesDir(): string {
  if (_rolesDir !== undefined) return _rolesDir;
  const base = fileURLToPath(new URL(".", import.meta.url));
  // src/tool-integration/internal/ → src/defaults/roles/
  return join(base, "..", "..", "..", "src", "defaults", "roles");
}


// ---------------------------------------------------------------------------
// Role YAML helper
// ---------------------------------------------------------------------------

/**
 * Add `toolId` to the `tools.mcp` list in a role YAML.
 * Idempotent — skips duplicates.
 */
function addToolToRoleYaml(roleId: string, toolId: string): boolean {
  const rolesDir = getRolesDir();
  const filePath = join(rolesDir, `${roleId}.yaml`);
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
    logger.warn("composite_creator_role_update_failed", "Failed to update role YAML", {
      metadata: { roleId, toolId, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}


// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const createCompositeToolTool: InternalToolDef = {
  id:                "internal-create-composite-tool",
  name:              "create_composite_tool",
  description:       "Create a composite tool that wraps MCP + REST sub-tools with automatic fallback",
  callerRestriction: "orchestrator",
  capabilities: [{
    name:              "create",
    description:       "Create a CompositeAdapter that routes calls to sub-tools in preference order. Strategy 'fallback' tries each sub-tool in sequence; 'parallel' runs all simultaneously; 'round_robin' distributes load.",
    risk_level:        "medium",
    requires_approval: false,
    input_schema: {
      type: "object",
      properties: {
        logical_id: {
          type:        "string",
          description: 'Logical tool ID visible to agents (e.g. "github"). Replaces individual sub-tool references.',
        },
        mcp_tool_id: {
          type:        "string",
          description: 'ID of the MCP tool in ToolRegistry (e.g. "github-mcp"). Optional if rest_tool_id provided.',
        },
        rest_tool_id: {
          type:        "string",
          description: 'ID of the REST tool in ToolRegistry (e.g. "github-rest"). Optional if mcp_tool_id provided.',
        },
        strategy: {
          type:    "string",
          enum:    ["fallback", "parallel", "round_robin"],
          default: "fallback",
          description: "Sub-tool selection strategy. 'fallback' is recommended for MCP+REST resilience.",
        },
        prefer: {
          type:    "string",
          enum:    ["mcp", "rest"],
          default: "mcp",
          description: "Which sub-tool to try first (only relevant for 'fallback' and 'round_robin' strategies).",
        },
        role_ids: {
          type:        "array",
          items:       { type: "string" },
          description: "Role IDs to assign the logical tool to. Replaces direct MCP/REST references.",
        },
      },
      required:             ["logical_id"],
      additionalProperties: false,
    },
    output_schema: { type: "object" },
  }],

  execute: async (params) => {
    const logicalId   = String(params["logical_id"] ?? "").trim();
    const mcpToolId   = params["mcp_tool_id"]  != null ? String(params["mcp_tool_id"]).trim()  : undefined;
    const restToolId  = params["rest_tool_id"] != null ? String(params["rest_tool_id"]).trim()  : undefined;
    const strategy    = (params["strategy"] as "fallback" | "parallel" | "round_robin") ?? "fallback";
    const prefer      = (params["prefer"] as "mcp" | "rest") ?? "mcp";
    const roleIds     = Array.isArray(params["role_ids"])
      ? (params["role_ids"] as unknown[]).map(String)
      : [];

    if (!logicalId) {
      return { error: "logical_id is required" };
    }
    if (!mcpToolId && !restToolId) {
      return { error: "At least one of mcp_tool_id or rest_tool_id is required" };
    }

    if (_registry === null || _manager === null) {
      return { error: "ToolRegistry and ToolManager must be configured (setCompositeRegistry / setCompositeManager)" };
    }

    // Build sub_tools in preference order
    const subTools: string[] = [];
    if (prefer === "mcp") {
      if (mcpToolId)  subTools.push(mcpToolId);
      if (restToolId) subTools.push(restToolId);
    } else {
      if (restToolId) subTools.push(restToolId);
      if (mcpToolId)  subTools.push(mcpToolId);
    }

    // Validate sub-tools exist in ToolManager
    const missingTools: string[] = [];
    for (const subId of subTools) {
      const adapter = _manager.getAdapter(subId);
      if (adapter === undefined) {
        missingTools.push(subId);
      }
    }
    if (missingTools.length > 0) {
      logger.warn("composite_creator_missing_subtool", "Some sub-tools are not registered in ToolManager — continuing", {
        metadata: { logicalId, missingTools },
      });
    }

    // Build CompositeToolConfig
    const compositeConfig: CompositeToolConfig = {
      type:      "composite",
      sub_tools: subTools,
      strategy,
    };

    // Merge capabilities from all available sub-adapters (dedup by name)
    const seen = new Set<string>();
    const mergedCaps: ToolCapability[] = [];
    for (const subId of subTools) {
      const adapter = _manager.getAdapter(subId);
      if (adapter === undefined) continue;
      for (const cap of adapter.getCapabilities()) {
        if (!seen.has(cap.name)) {
          seen.add(cap.name);
          // Assign logical_id as the tool_id in the capability
          mergedCaps.push({ ...cap, tool_id: logicalId });
        }
      }
    }

    // Register in ToolRegistry (idempotent)
    let registryCreated = false;
    let existing = false;
    try {
      _registry.getById(logicalId);
      existing = true;
    } catch (_err) {
      // Not found — create
    }

    if (!existing) {
      try {
        _registry.create({
          id:   logicalId,
          name: logicalId,
          type: "composite",
          config: compositeConfig,
          capabilities: mergedCaps.map(({ id: _id, tool_id: _tid, ...rest }) => rest),
        });
        registryCreated = true;
      } catch (err) {
        return {
          error: `Failed to register composite tool in registry: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Build sub-adapter map and register CompositeAdapter in ToolManager
    const subAdapterMap = new Map<string, import("../types.js").ToolAdapter>();
    for (const subId of subTools) {
      const adapter = _manager.getAdapter(subId);
      if (adapter !== undefined) {
        subAdapterMap.set(subId, adapter);
      }
    }

    const compositeAdapter = new CompositeAdapter(logicalId, compositeConfig, subAdapterMap, mergedCaps);
    _manager.registerAdapter(logicalId, compositeAdapter);

    // Update role YAMLs with logical_id only (never sub-tool IDs)
    const assignedRoles: string[] = [];
    const failedRoles:   string[] = [];
    for (const roleId of roleIds) {
      const ok = addToolToRoleYaml(roleId, logicalId);
      if (ok) assignedRoles.push(roleId);
      else    failedRoles.push(roleId);
    }

    logger.info("composite_tool_created", "Composite tool created", {
      metadata: {
        logicalId,
        subTools,
        strategy,
        prefer,
        roles: assignedRoles,
        mergedCapabilities: mergedCaps.length,
      },
    });

    const result: Record<string, unknown> = {
      success:             true,
      logical_id:          logicalId,
      sub_tools:           subTools,
      strategy,
      prefer,
      capabilities:        mergedCaps.length,
      registry_created:    registryCreated,
      assigned_to_roles:   assignedRoles,
      note: `Agents with roles [${assignedRoles.join(", ")}] will see '${logicalId}' only. Sub-tool routing is handled automatically.`,
    };

    if (failedRoles.length > 0) {
      result["failed_roles"] = failedRoles;
    }
    if (missingTools.length > 0) {
      result["warning"] = `Sub-tools not yet active in ToolManager: ${missingTools.join(", ")}. Register them first.`;
    }

    return result;
  },
};
