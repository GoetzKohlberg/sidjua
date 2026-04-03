// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — Module Registry Bridge
 *
 * Converts InstalledModule definitions into McpServerConfig objects
 * suitable for registering with McpRegistry.
 *
 * Also provides governance override merging: mcp-servers.yaml entries
 * for module-backed servers override the module.yaml governance_defaults.
 */

import type { InstalledModule }   from "./types.js";
import type { McpServerConfig, McpGovernanceConfig } from "../mcp/types.js";
import { join }                   from "node:path";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an InstalledModule into a McpServerConfig for the MCP registry.
 *
 * stdio modules: command resolved relative to module path.
 * sse modules: url passed through as-is.
 */
export function moduleToMcpConfig(module: InstalledModule): McpServerConfig {
  const def  = module.definition;
  const mcp  = def.mcp;
  const gov  = def.governance_defaults;

  const governance: McpGovernanceConfig = {
    allowed_divisions:      gov.allowed_divisions,
    allowed_tiers:          gov.allowed_tiers,
    max_calls_per_minute:   gov.max_calls_per_minute,
    forbidden_patterns:     gov.forbidden_patterns,
    classification_ceiling: gov.classification_ceiling,
    budget_per_call:        gov.budget_per_call,
  };

  if (mcp.transport === "stdio") {
    const command = mcp.command ?? "node";
    // Resolve relative command paths against module directory
    const resolvedCommand = command.startsWith("/") ? command : join(module.path, command);

    return {
      transport:   "stdio",
      command:     resolvedCommand,
      description: def.description,
      governance,
      ...(mcp.args !== undefined  ? { args: mcp.args }  : {}),
      ...(mcp.env  !== undefined  ? { env:  mcp.env  }  : {}),
    };
  }

  // SSE transport
  return {
    transport:   "sse",
    url:         mcp.url ?? "",
    description: def.description,
    governance,
    ...(mcp.env !== undefined ? { env: mcp.env } : {}),
  };
}

/**
 * Merge a YAML override config (from mcp-servers.yaml) on top of a
 * module-derived McpServerConfig.
 *
 * Override wins for every field it defines.
 * governance is merged field-by-field so partial overrides work.
 */
export function mergeGovernanceOverrides(
  base:     McpServerConfig,
  override: Partial<McpServerConfig>,
): McpServerConfig {
  const mergedGovernance: McpGovernanceConfig = {
    ...base.governance,
    ...(override.governance !== undefined ? override.governance : {}),
  };

  return {
    ...base,
    ...override,
    governance: mergedGovernance,
  };
}

/**
 * Build a Map of serverName → McpServerConfig from a list of installed modules.
 * Module name is used as the server name.
 */
export function buildModuleConfigMap(
  modules: InstalledModule[],
): Map<string, McpServerConfig> {
  const map = new Map<string, McpServerConfig>();
  for (const mod of modules) {
    map.set(mod.name, moduleToMcpConfig(mod));
  }
  return map;
}
