// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — REST Tool Config Loader (P389)
 *
 * Loads/saves rest-tools.yaml. Provides typed config for RestToolFactory.
 * Mirrors mcp-config.ts structure.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../core/logger.js";
import type { RestCapabilityRoute } from "./types.js";

const logger = createLogger("rest-config");


export interface RestToolCapabilityEntry {
  name:              string;
  description:       string;
  risk_level:        "low" | "medium" | "high" | "critical";
  requires_approval: boolean;
  method:            "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path_template:     string;
  input_schema?:     Record<string, unknown>;
  output_schema?:    Record<string, unknown>;
}

export interface RestToolEntry {
  id:           string;
  name:         string;
  base_url:     string;
  timeout_ms?:  number;
  auth?: {
    type:          "bearer" | "basic" | "header";
    token?:        string;
    username?:     string;
    password?:     string;
    header_name?:  string;
    header_value?: string;
  };
  capabilities: RestToolCapabilityEntry[];
}

export interface RestToolsConfig {
  tools: RestToolEntry[];
}


const DEFAULT_CONFIG_PATH = "./config/rest-tools.yaml";


export function loadRestToolsConfig(configPath?: string): RestToolsConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;

  if (!existsSync(path)) {
    logger.info("rest_config_missing", "No REST tools config found — using defaults", { metadata: { path } });
    return { tools: [] };
  }

  try {
    const raw    = readFileSync(path, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;

    if (parsed === null || typeof parsed !== "object") {
      logger.warn("rest_config_empty", "REST tools config is empty — using defaults", { metadata: { path } });
      return { tools: [] };
    }

    const rawTools = Array.isArray(parsed["tools"]) ? parsed["tools"] as unknown[] : [];
    const tools: RestToolEntry[] = rawTools.flatMap((entry) => {
      const validated = validateRestToolEntry(entry);
      if (validated === null) {
        logger.warn("rest_config_invalid_entry", "REST tool entry invalid — skipping", {
          metadata: { entry: JSON.stringify(entry).slice(0, 200) },
        });
        return [];
      }
      return [validated];
    });

    return { tools };
  } catch (err) {
    logger.warn("rest_config_load_error", "Failed to load REST tools config — using defaults", {
      metadata: { path, error: err instanceof Error ? err.message : String(err) },
    });
    return { tools: [] };
  }
}


function validateRestToolEntry(entry: unknown): RestToolEntry | null {
  if (entry === null || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;

  if (typeof e["id"] !== "string" || typeof e["name"] !== "string" || typeof e["base_url"] !== "string") {
    return null;
  }

  const rawCaps = Array.isArray(e["capabilities"]) ? e["capabilities"] as unknown[] : [];
  const capabilities: RestToolCapabilityEntry[] = rawCaps.flatMap((cap) => {
    const validated = validateCapabilityEntry(cap);
    return validated !== null ? [validated] : [];
  });

  type AuthBlock = NonNullable<RestToolEntry["auth"]>;
  const base: RestToolEntry = {
    id:           e["id"],
    name:         e["name"],
    base_url:     e["base_url"],
    capabilities,
  };
  if (typeof e["timeout_ms"] === "number") base.timeout_ms = e["timeout_ms"];
  if (e["auth"] !== null && typeof e["auth"] === "object") {
    const authObj = e["auth"] as AuthBlock;
    base.auth = authObj;
  }
  return base;
}


function validateCapabilityEntry(cap: unknown): RestToolCapabilityEntry | null {
  if (cap === null || typeof cap !== "object") return null;
  const c = cap as Record<string, unknown>;

  if (
    typeof c["name"]          !== "string" ||
    typeof c["description"]   !== "string" ||
    typeof c["method"]        !== "string" ||
    typeof c["path_template"] !== "string"
  ) {
    return null;
  }

  const VALID_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
  if (!VALID_METHODS.has(c["method"] as string)) return null;

  return {
    name:              c["name"],
    description:       c["description"],
    risk_level:        (c["risk_level"] as "low" | "medium" | "high" | "critical") ?? "low",
    requires_approval: typeof c["requires_approval"] === "boolean" ? c["requires_approval"] : false,
    method:            c["method"] as RestToolCapabilityEntry["method"],
    path_template:     c["path_template"],
    ...(c["input_schema"]  !== undefined ? { input_schema:  c["input_schema"]  as Record<string, unknown> } : {}),
    ...(c["output_schema"] !== undefined ? { output_schema: c["output_schema"] as Record<string, unknown> } : {}),
  };
}


/** Convert a RestToolCapabilityEntry to a RestCapabilityRoute for use in RestToolConfig.routes. */
export function toCapabilityRoute(entry: RestToolCapabilityEntry): RestCapabilityRoute {
  return { method: entry.method, path_template: entry.path_template };
}
