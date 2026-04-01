// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P344: install_mcp_server internal tool
 *
 * Installs an MCP server (npm or Docker), registers it in mcp-servers.yaml,
 * and returns installation status.
 */

import { execSync }                from "node:child_process";
import type { InternalToolDef }   from "../adapters/internal-adapter.js";
import { loadMcpConfig, saveMcpConfig, type McpServerEntry } from "../mcp-config.js";
import { createLogger }           from "../../core/logger.js";

const logger = createLogger("mcp-installer");

/** Injectable config path for tests — defaults to global mcp-servers.yaml location. */
let _configPath: string | undefined;
export function setMcpInstallerConfigPath(p: string | undefined): void { _configPath = p; }

export const installMcpServerTool: InternalToolDef = {
  id:          "internal-install-mcp-server",
  name:        "install_mcp_server",
  description: "Install an MCP server from the registry (npm or Docker)",
  capabilities: [{
    name:        "install",
    description: "Install an MCP server. Adds to mcp-servers.yaml.",
    risk_level:  "medium",
    requires_approval: false,
    input_schema: {
      type: "object",
      properties: {
        server_id: {
          type:        "string",
          description: 'Unique ID for this server (e.g. "github-mcp")',
        },
        name: {
          type:        "string",
          description: 'Display name (e.g. "GitHub")',
        },
        install_command: {
          type:        "string",
          description: 'npm package or Docker image (e.g. "@modelcontextprotocol/server-github")',
        },
        install_type: {
          type:    "string",
          enum:    ["npm", "docker"],
          default: "npm",
        },
      },
      required:             ["server_id", "name", "install_command"],
      additionalProperties: false,
    },
    output_schema: { type: "object" },
  }],

  execute: async (params) => {
    const server_id      = String(params["server_id"] ?? "").trim();
    const name           = String(params["name"] ?? "").trim();
    const install_command = String(params["install_command"] ?? "").trim();
    const install_type   = params["install_type"] === "docker" ? "docker" : "npm";

    if (!server_id || !name || !install_command) {
      return { error: "server_id, name, and install_command are required" };
    }

    // Check if already installed
    const config = loadMcpConfig(_configPath);
    if (config.servers.some((s) => s.id === server_id)) {
      return { error: `Server '${server_id}' already installed`, existing: true };
    }

    // Install
    try {
      if (install_type === "npm") {
        execSync(`npm install -g ${install_command}`, {
          timeout: 120_000,
          stdio:   "pipe",
        });
      } else {
        execSync(`docker pull ${install_command}`, {
          timeout: 300_000,
          stdio:   "pipe",
        });
      }
    } catch (err) {
      const detail  = err instanceof Error ? err.message : String(err);
      const command = install_type === "npm"
        ? `npm install -g ${install_command}`
        : `docker pull ${install_command}`;
      return { error: "Installation failed", detail, command };
    }

    // Register in config
    const entry: McpServerEntry = {
      id:      server_id,
      name,
      command: install_type === "npm" ? "npx" : "docker",
      args:    install_type === "npm"
        ? ["-y", install_command]
        : ["run", "--rm", "-i", install_command],
      env:        {},
      auto_start: false,
    };
    config.servers.push(entry);
    saveMcpConfig(config, _configPath);

    logger.info("mcp_server_installed", "MCP server installed", {
      metadata: { id: server_id, package: install_command, type: install_type },
    });

    return {
      success:         true,
      server_id,
      name,
      install_command,
      install_type,
      note:            "Server installed. Use configure_mcp_server to set credentials and assign to agent roles.",
    };
  },
};
