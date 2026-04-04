// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — Module Scanner
 *
 * Scans the {workDir}/modules/ directory for installed MCP modules.
 * Each module has a module.yaml describing its MCP server + governance defaults.
 * Invalid or malformed modules are skipped with a warning.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join }           from "node:path";
import { parse as yamlParse } from "yaml";
import { createLogger }   from "../logger.js";
import type { ModuleDefinition, InstalledModule } from "./types.js";

const logger = createLogger("module-scanner");

const MODULE_YAML    = "module.yaml";
/** Allowed module name pattern: lowercase alphanumeric with hyphens, 2-64 chars. */
const NAME_PATTERN   = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/**
 * M15: Characters forbidden in stdio command/args strings.
 * Null bytes, line terminators, and shell metacharacters are all rejected
 * so a crafted module.yaml cannot achieve command injection or argument splitting.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CMD_CHARS = /[\0\r\n\u2028\u2029`$(){}|;&<>]/;

/**
 * M15: Characters forbidden in env values declared inside module.yaml.
 * Same set as UNSAFE_CMD_CHARS — env values may be passed to child processes.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_ENV_VALUE_CHARS = /[\r\n\u2028\u2029`$(){}|;&<>]/;

/**
 * Scan the modules directory and return all valid installed modules.
 * Returns an empty array if the directory does not exist.
 */
export function scanModules(modulesDir: string): InstalledModule[] {
  if (!existsSync(modulesDir)) {
    logger.info("modules_dir_missing", "Modules directory not found — no modules loaded", {
      metadata: { path: modulesDir },
    });
    return [];
  }

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(modulesDir, { withFileTypes: true });
  } catch (err: unknown) {
    logger.warn("modules_dir_read_error", "Failed to read modules directory", {
      metadata: { path: modulesDir, error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }

  const modules: InstalledModule[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const modulePath = join(modulesDir, entry.name);
    const yamlPath   = join(modulePath, MODULE_YAML);

    if (!existsSync(yamlPath)) {
      logger.debug("module_no_yaml", "Module directory has no module.yaml — skipping", {
        metadata: { path: modulePath },
      });
      continue;
    }

    try {
      const raw    = readFileSync(yamlPath, "utf-8");
      let parsed: unknown;
      try {
        parsed = yamlParse(raw);
      } catch (err: unknown) {
        throw new Error(`YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
      const definition = validateModuleDefinition(parsed, entry.name);
      const isNpm = existsSync(join(modulePath, "node_modules"));

      modules.push({
        name:       definition.name,
        path:       modulePath,
        definition,
        source:     isNpm ? "npm" : "local",
      });
    } catch (err: unknown) {
      logger.warn("module_parse_error", "Module skipped due to validation error", {
        metadata: {
          module: entry.name,
          error:  err instanceof Error ? err.message : String(err),
        },
      });
      // Continue with other modules
    }
  }

  logger.info("modules_scanned", "Module scan complete", {
    metadata: { count: modules.length, dir: modulesDir },
  });
  return modules;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * M15: Validate env key/value pairs declared in module.yaml.
 * Throws if any value contains characters that could enable injection attacks.
 */
function validateModuleEnvValues(rawEnv: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    const val = String(v);
    if (UNSAFE_ENV_VALUE_CHARS.test(val)) {
      throw new Error(`Unsafe characters in env value for key "${k}"`);
    }
    result[k] = val;
  }
  return result;
}

/** Strictly validate a parsed module.yaml object. Throws on any violation. */
function validateModuleDefinition(raw: unknown, dirName: string): ModuleDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("module.yaml is empty or not an object");
  }

  const def = raw as Record<string, unknown>;

  // Name
  const name = def["name"];
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid module name: "${String(name)}". Must be lowercase alphanumeric with hyphens, 2-64 chars.`,
    );
  }
  if (name !== dirName) {
    logger.warn("module_name_mismatch", "module.yaml name does not match directory name", {
      metadata: { yaml: name, directory: dirName },
    });
    // Use yaml name — warn only
  }

  // Version
  if (typeof def["version"] !== "string") {
    throw new Error(`Missing or invalid "version" field`);
  }

  // Description
  if (typeof def["description"] !== "string") {
    throw new Error(`Missing or invalid "description" field`);
  }

  // MCP section
  const mcp = def["mcp"];
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
    throw new Error(`Missing "mcp" section`);
  }
  const mcpObj = mcp as Record<string, unknown>;

  if (mcpObj["transport"] !== "stdio" && mcpObj["transport"] !== "sse") {
    throw new Error(`Invalid transport: "${String(mcpObj["transport"])}". Must be "stdio" or "sse".`);
  }
  if (mcpObj["transport"] === "stdio" && typeof mcpObj["command"] !== "string") {
    throw new Error(`STDIO transport requires a "command" field`);
  }
  if (mcpObj["transport"] === "sse" && typeof mcpObj["url"] !== "string") {
    throw new Error(`SSE transport requires a "url" field`);
  }

  // M15: Path traversal + injection check on command/args
  if (mcpObj["transport"] === "stdio") {
    const command = String(mcpObj["command"]);
    const rawArgs = mcpObj["args"];
    const args    = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    for (const part of [command, ...args]) {
      if (part.includes("..")) {
        throw new Error(`Path traversal detected in command/args: "${part}"`);
      }
      if (UNSAFE_CMD_CHARS.test(part)) {
        throw new Error(`Unsafe characters in command/args: "${part}"`);
      }
    }
  }

  // Governance defaults
  const gov = def["governance_defaults"];
  if (!gov || typeof gov !== "object" || Array.isArray(gov)) {
    throw new Error(`Missing "governance_defaults" section`);
  }
  const govObj = gov as Record<string, unknown>;

  if (!Array.isArray(govObj["allowed_divisions"])) {
    throw new Error(`governance_defaults.allowed_divisions must be an array`);
  }
  if (!Array.isArray(govObj["allowed_tiers"])) {
    throw new Error(`governance_defaults.allowed_tiers must be an array`);
  }
  if (typeof govObj["max_calls_per_minute"] !== "number") {
    throw new Error(`governance_defaults.max_calls_per_minute must be a number`);
  }
  if (!Array.isArray(govObj["forbidden_patterns"])) {
    throw new Error(`governance_defaults.forbidden_patterns must be an array`);
  }
  if (typeof govObj["classification_ceiling"] !== "string") {
    throw new Error(`governance_defaults.classification_ceiling must be a string`);
  }
  if (typeof govObj["budget_per_call"] !== "number") {
    throw new Error(`governance_defaults.budget_per_call must be a number`);
  }

  // Build the validated definition
  const rawArgs = mcpObj["args"];
  const rawEnv  = mcpObj["env"];

  return {
    name:        name,
    version:     String(def["version"]),
    description: String(def["description"]),
    author:      typeof def["author"] === "string" ? def["author"] : "unknown",
    type:        def["type"] === "native" ? "native" : "mcp-wrapper",
    mcp: {
      transport: mcpObj["transport"] as "stdio" | "sse",
      ...(typeof mcpObj["command"] === "string" ? { command: mcpObj["command"] }  : {}),
      ...(Array.isArray(rawArgs)                ? { args: rawArgs.map(String) }   : {}),
      ...(typeof mcpObj["url"] === "string"     ? { url: mcpObj["url"] }          : {}),
      ...(rawEnv !== null && typeof rawEnv === "object" && !Array.isArray(rawEnv)
        ? { env: validateModuleEnvValues(rawEnv as Record<string, unknown>) }
        : {}),
    },
    governance_defaults: {
      allowed_divisions:      (govObj["allowed_divisions"]  as unknown[]).map(String),
      allowed_tiers:          (govObj["allowed_tiers"]       as unknown[]).map(String),
      max_calls_per_minute:   Number(govObj["max_calls_per_minute"]),
      forbidden_patterns:     (govObj["forbidden_patterns"]  as unknown[]).map(String),
      classification_ceiling: String(govObj["classification_ceiling"]),
      budget_per_call:        Number(govObj["budget_per_call"]),
    },
    ...(Array.isArray(def["tools"])
      ? {
          tools: (def["tools"] as Array<Record<string, unknown>>).map((t) => ({
            name:        String(t["name"]        ?? ""),
            description: String(t["description"] ?? ""),
            ...(t["requires_approval"] === true ? { requires_approval: true } : {}),
          })),
        }
      : {}),
  };
}
