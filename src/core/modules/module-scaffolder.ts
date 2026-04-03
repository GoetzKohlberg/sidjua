// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — Module Scaffolder
 *
 * Generates a starter template for custom MCP modules.
 * Creates modules/{name}/ with module.yaml, package.json, and a minimal
 * JSON-RPC 2.0 over STDIO MCP server in index.js.
 *
 * Security: templates contain only static declarations — no executable code
 * that runs on parse.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join }                                 from "node:path";
import { createLogger }                         from "../logger.js";

const logger = createLogger("module-scaffolder");

/** Allowed module name pattern: lowercase alphanumeric with hyphens, 2-64 chars. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export interface ScaffoldResult {
  success: boolean;
  path:    string;
  error?:  string;
}

/**
 * Scaffold a new custom MCP module in modules/{name}/.
 * Returns an error result if the name is invalid or the module already exists.
 */
export function scaffoldModule(name: string, modulesDir: string): ScaffoldResult {
  if (!NAME_PATTERN.test(name)) {
    return {
      success: false,
      path:    "",
      error:   `Invalid module name: "${name}". Use lowercase alphanumeric with hyphens, 2-64 chars.`,
    };
  }

  const modulePath = join(modulesDir, name);
  if (existsSync(modulePath)) {
    return {
      success: false,
      path:    modulePath,
      error:   `Module "${name}" already exists at ${modulePath}.`,
    };
  }

  try {
    mkdirSync(modulePath, { recursive: true });

    // module.yaml — governance + transport config
    writeFileSync(join(modulePath, "module.yaml"), buildModuleYaml(name), "utf-8");

    // package.json
    writeFileSync(
      join(modulePath, "package.json"),
      JSON.stringify({
        name:         `sidjua-module-${name}`,
        version:      "1.0.0",
        private:      true,
        type:         "module",
        dependencies: {},
      }, null, 2),
      "utf-8",
    );

    // index.js — minimal MCP server (JSON-RPC 2.0 over STDIO)
    writeFileSync(join(modulePath, "index.js"), buildIndexJs(name), "utf-8");

    logger.info("module_scaffolded", "New MCP module scaffolded", {
      metadata: { name, path: modulePath },
    });
    return { success: true, path: modulePath };

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, path: modulePath, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Template builders
// ---------------------------------------------------------------------------

function buildModuleYaml(name: string): string {
  return `name: ${name}
version: 1.0.0
description: "Custom MCP tool: ${name}"
author: "user"
type: mcp-wrapper

mcp:
  transport: stdio
  command: node
  args: ["./index.js"]

governance_defaults:
  allowed_divisions: ["*"]
  allowed_tiers: ["T2", "T3"]
  max_calls_per_minute: 10
  forbidden_patterns: []
  classification_ceiling: "INTERNAL"
  budget_per_call: 0

tools:
  - name: ${name}-action
    description: "Performs the ${name} action"
    requires_approval: false
`;
}

function buildIndexJs(name: string): string {
  // NOTE: template uses string literals only — no executable code runs on parse.
  return `#!/usr/bin/env node
/**
 * Minimal MCP Server for SIDJUA module: ${name}
 *
 * Communicates via JSON-RPC 2.0 over STDIO.
 * Implement your tool logic in the tools/call handler below.
 */

import { createInterface } from "node:readline";

const SERVER_INFO = {
  name: "${name}",
  version: "1.0.0",
};

const TOOLS = [
  {
    name: "${name}-action",
    description: "Performs the ${name} action",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Input for the action" },
      },
      required: ["input"],
    },
  },
];

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch (_err) {
    return; // ignore malformed input
  }

  const { id, method, params } = request;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  } else if (method === "tools/list") {
    respond(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments ?? {};

    if (toolName === "${name}-action") {
      // TODO: Implement your tool logic here
      respond(id, {
        content: [{ type: "text", text: \`Result for: \${args.input ?? "no input"}\` }],
      });
    } else {
      respondError(id, -32601, \`Unknown tool: \${toolName}\`);
    }
  } else if (method?.startsWith("notifications/")) {
    // Notifications have no id — do not respond
  } else if (id !== undefined) {
    respondError(id, -32601, \`Unknown method: \${method}\`);
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}
`;
}
