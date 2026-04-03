// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — Module Installer
 *
 * Handles `sidjua module add <package>` — installs an npm-based MCP server
 * as a SIDJUA module with a generated module.yaml.
 *
 * Security: npm install always uses --ignore-scripts to prevent postinstall
 * from running arbitrary code.
 */

import { execSync }                                   from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join }                                        from "node:path";
import { createLogger }                                from "../logger.js";

const logger = createLogger("module-installer");

const NPM_TIMEOUT_MS = 120_000; // 2 minutes

/** Allowed module name pattern: lowercase alphanumeric with hyphens, 2-64 chars. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export interface InstallResult {
  success:     boolean;
  moduleName:  string;
  path:        string;
  error?:      string;
}

/**
 * Install an npm-based MCP server as a SIDJUA module.
 * Creates modules/{name}/ with node_modules and a generated module.yaml.
 *
 * SECURITY: Uses --ignore-scripts to prevent postinstall from running arbitrary code.
 */
export function installModule(packageName: string, modulesDir: string): InstallResult {
  const moduleName = deriveModuleName(packageName);
  const modulePath = join(modulesDir, moduleName);

  if (existsSync(modulePath)) {
    return {
      success:    false,
      moduleName,
      path:       modulePath,
      error:      `Module "${moduleName}" already exists at ${modulePath}. Remove it first.`,
    };
  }

  try {
    mkdirSync(modulePath, { recursive: true });

    // Minimal package.json for npm install
    writeFileSync(
      join(modulePath, "package.json"),
      JSON.stringify({ name: `sidjua-module-${moduleName}`, private: true }, null, 2),
      "utf-8",
    );

    // SECURITY: --ignore-scripts prevents postinstall from running arbitrary code
    const cmd = `npm install --ignore-scripts --save ${packageName}`;
    logger.info("module_installing", "Installing MCP module via npm", {
      metadata: { package: packageName, path: modulePath },
    });

    execSync(cmd, {
      cwd:     modulePath,
      timeout: NPM_TIMEOUT_MS,
      stdio:   "pipe",
      env: {
        ...process.env,
        npm_config_fund:  "false",
        npm_config_audit: "false",
      },
    });

    // Generate module.yaml with sensible governance defaults
    const moduleYaml = generateModuleYaml(moduleName, packageName);
    writeFileSync(join(modulePath, "module.yaml"), moduleYaml, "utf-8");

    logger.info("module_installed", "MCP module installed successfully", {
      metadata: { module: moduleName, package: packageName },
    });
    return { success: true, moduleName, path: modulePath };

  } catch (err: unknown) {
    // Best-effort cleanup on failure
    try {
      rmSync(modulePath, { recursive: true, force: true });
    } catch (_err) { /* cleanup-ignore: directory removal is best-effort */ }

    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn("module_install_failed", "MCP module installation failed", {
      metadata: { package: packageName, error: errMsg },
    });
    return { success: false, moduleName, path: modulePath, error: errMsg };
  }
}

/**
 * Remove an installed module.
 * Returns false if the module is not found or the name is invalid.
 */
export function removeModule(moduleName: string, modulesDir: string): boolean {
  if (!NAME_PATTERN.test(moduleName)) {
    logger.warn("module_invalid_name", "Attempted to remove module with invalid name", {
      metadata: { name: moduleName },
    });
    return false;
  }
  const modulePath = join(modulesDir, moduleName);
  if (!existsSync(modulePath)) {
    logger.warn("module_not_found", "Module not found for removal", {
      metadata: { name: moduleName, path: modulePath },
    });
    return false;
  }
  rmSync(modulePath, { recursive: true, force: true });
  logger.info("module_removed", "MCP module removed", { metadata: { name: moduleName } });
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive a clean module name from an npm package name.
 *
 * @anthropic/mcp-server-github → github
 * mcp-server-custom             → custom
 * my-package                    → my-package
 */
export function deriveModuleName(packageName: string): string {
  let name = packageName;

  // Strip npm scope (@org/...)
  if (name.startsWith("@")) {
    name = name.split("/").pop() ?? name;
  }

  // Strip common prefixes
  for (const prefix of ["mcp-server-", "mcp-", "sidjua-module-"]) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
    }
  }

  // Sanitize
  name = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!name || name.length < 2) name = "module";
  return name;
}

function generateModuleYaml(name: string, packageName: string): string {
  return `name: ${name}
version: 1.0.0
description: "MCP server: ${packageName}"
author: "auto-installed"
type: mcp-wrapper

mcp:
  transport: stdio
  command: npx
  args: ["-y", "${packageName}"]

governance_defaults:
  allowed_divisions: ["*"]
  allowed_tiers: ["T2", "T3"]
  max_calls_per_minute: 20
  forbidden_patterns: []
  classification_ceiling: "INTERNAL"
  budget_per_call: 0
`;
}
