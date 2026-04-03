// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — MCP Server Config Loader (P341)
 *
 * Loads/saves mcp-servers.yaml. Provides typed config for McpLifecycleManager.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createLogger } from "../core/logger.js";
import { McpServerEntrySchema, parseAndValidateYamlSafe } from "../core/schemas/index.js";

const logger = createLogger("mcp-config");


export interface McpServerEntry {
  id:                           string;
  name:                         string;
  command:                      string;
  args?:                        string[];
  env?:                         Record<string, string>;
  auto_start?:                  boolean;
  max_idle_seconds?:            number;
  health_check_interval_seconds?: number;
}

export interface McpSettings {
  max_concurrent_servers:          number;
  default_timeout_ms:              number;
  idle_timeout_seconds:            number;
  health_check_interval_seconds:   number;
  auto_restart_on_crash:           boolean;
  config_path:                     string;
}

export interface McpConfig {
  servers:  McpServerEntry[];
  settings: McpSettings;
}

const DEFAULT_SETTINGS: McpSettings = {
  max_concurrent_servers:        3,
  default_timeout_ms:            30_000,
  idle_timeout_seconds:          300,
  health_check_interval_seconds: 60,
  auto_restart_on_crash:         true,
  config_path:                   "./config/mcp-servers.yaml",
};


export function loadMcpConfig(configPath?: string): McpConfig {
  const path = configPath ?? DEFAULT_SETTINGS.config_path;

  if (!existsSync(path)) {
    logger.info("mcp_config_missing", "No MCP config found — using defaults", { metadata: { path } });
    return { servers: [], settings: { ...DEFAULT_SETTINGS } };
  }

  try {
    const raw    = readFileSync(path, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;

    if (parsed === null || typeof parsed !== "object") {
      logger.warn("mcp_config_empty", "MCP config is empty — using defaults", { metadata: { path } });
      return { servers: [], settings: { ...DEFAULT_SETTINGS } };
    }

    // Validate each server entry individually; skip invalid ones (preserve old filter behaviour)
    const rawServers = Array.isArray(parsed["servers"]) ? parsed["servers"] as unknown[] : [];
    const servers: McpServerEntry[] = rawServers.flatMap((entry) => {
      const r = parseAndValidateYamlSafe(McpServerEntrySchema, entry);
      return r.success ? [r.data as McpServerEntry] : [];
    });

    const rawSettings = typeof parsed["settings"] === "object" && parsed["settings"] !== null
      ? parsed["settings"] as Record<string, unknown>
      : {};

    return {
      servers,
      settings: { ...DEFAULT_SETTINGS, ...rawSettings } as McpSettings,
    };
  } catch (err) {
    logger.warn("mcp_config_load_error", "Failed to load MCP config — using defaults", {
      metadata: { path, error: err instanceof Error ? err.message : String(err) },
    });
    return { servers: [], settings: { ...DEFAULT_SETTINGS } };
  }
}


export function saveMcpConfig(config: McpConfig, configPath?: string): void {
  const path    = configPath ?? config.settings.config_path;
  const content = stringifyYaml(config, { lineWidth: 120 });
  writeFileSync(path, content, "utf-8");
}


function isValidServerEntry(entry: unknown): entry is McpServerEntry {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return typeof e["id"] === "string" && typeof e["name"] === "string" && typeof e["command"] === "string";
}
