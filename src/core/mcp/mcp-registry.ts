// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP Registry: server lifecycle, config parsing, secret resolution, tool index.
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import { createLogger } from "../logger.js";
import { McpClient } from "./mcp-client.js";
import type {
  McpServerConfig,
  McpGovernanceConfig,
  McpTool,
  McpToolResult,
  McpServerStatus,
} from "./types.js";

const logger = createLogger("mcp-registry");

/** Pattern that matches ${secrets:key_name} references in string values */
const SECRET_PATTERN = /\$\{secrets:([^}]+)\}/g;

/** Glob-style pattern matcher for tool names */
export function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;
  // Simple suffix glob: "file_*" matches "file_read", "file_write"
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return false;
}

/** Raw YAML structure of a single server entry in mcp-servers.yaml */
type RawServerEntry = Record<string, unknown>;

export class McpRegistry {
  private readonly clients = new Map<string, McpClient>();
  private readonly toolIndex = new Map<string, string>(); // toolName → serverName
  private configPath: string | null = null;
  private readonly secretResolver: (ref: string) => string | undefined;

  constructor(secretResolver: (ref: string) => string | undefined) {
    this.secretResolver = secretResolver;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────────────────────────────────

  async initialize(configPath: string): Promise<void> {
    this.configPath = configPath;

    if (!existsSync(configPath)) {
      logger.info("mcp_no_config_file", "MCP config file not found — no servers configured", {
        metadata: { path: configPath },
      });
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch (err: unknown) {
      logger.warn("mcp_config_read_error", "Failed to read MCP config", {
        metadata: { path: configPath, error: err instanceof Error ? err.message : String(err) },
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = yamlParse(raw);
    } catch (err: unknown) {
      logger.warn("mcp_config_parse_error", "Failed to parse MCP config YAML", {
        metadata: { path: configPath, error: err instanceof Error ? err.message : String(err) },
      });
      return; // fail gracefully — no MCP servers, app still works
    }

    if (parsed === null || typeof parsed !== "object") {
      logger.info("mcp_config_empty", "MCP config is empty", { metadata: { path: configPath } });
      return;
    }

    const root = parsed as Record<string, unknown>;
    const servers = root["servers"];
    if (servers === null || servers === undefined || typeof servers !== "object" || Array.isArray(servers)) {
      logger.info("mcp_no_servers_configured", "No servers configured in MCP config", { metadata: { path: configPath } });
      return;
    }

    const serverMap = servers as Record<string, RawServerEntry>;

    for (const [name, rawConfig] of Object.entries(serverMap)) {
      try {
        const config = rawConfig as unknown as McpServerConfig;
        const resolved = this.resolveSecrets(config);
        this.validateConfig(name, resolved);
        const client = new McpClient(name, resolved);
        await client.connect();
        this.clients.set(name, client);

        for (const tool of client.getTools()) {
          if (this.toolIndex.has(tool.name)) {
            logger.warn("mcp_tool_name_conflict", "Tool name conflict — later server wins", {
              metadata: { tool: tool.name, existing: this.toolIndex.get(tool.name), replacing: name },
            });
          }
          this.toolIndex.set(tool.name, name);
        }
      } catch (err: unknown) {
        logger.warn("mcp_server_init_failed", "Failed to initialize MCP server — skipping", {
          metadata: { server: name, error: err instanceof Error ? err.message : String(err) },
        });
        // Continue with other servers
      }
    }

    logger.info("mcp_registry_initialized", "MCP registry initialized", {
      metadata: { servers: this.clients.size, tools: this.toolIndex.size },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Secret Resolution
  // ──────────────────────────────────────────────────────────────────────────

  private resolveSecrets(config: McpServerConfig): McpServerConfig {
    // Deep clone to avoid mutating the parsed YAML object
    const resolved: McpServerConfig = JSON.parse(JSON.stringify(config)) as McpServerConfig;

    const resolveValue = (value: string, field: string): string => {
      return value.replace(SECRET_PATTERN, (_match, secretKey: string) => {
        const secretValue = this.secretResolver(secretKey);
        if (secretValue === undefined) {
          throw new Error(`Secret not found: ${secretKey} (referenced in ${field})`);
        }
        return secretValue;
      });
    };

    if (resolved.env !== undefined) {
      for (const [key, val] of Object.entries(resolved.env)) {
        resolved.env[key] = resolveValue(val, `env.${key}`);
      }
    }
    if (resolved.headers !== undefined) {
      for (const [key, val] of Object.entries(resolved.headers)) {
        resolved.headers[key] = resolveValue(val, `headers.${key}`);
      }
    }
    return resolved;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Config Validation
  // ──────────────────────────────────────────────────────────────────────────

  private validateConfig(name: string, config: McpServerConfig): void {
    if (config.transport === "stdio") {
      if (!config.command || typeof config.command !== "string") {
        throw new Error(`MCP server "${name}": stdio transport requires "command"`);
      }
    } else if (config.transport === "sse") {
      if (!config.url || typeof config.url !== "string") {
        throw new Error(`MCP server "${name}": sse transport requires "url"`);
      }
    } else {
      throw new Error(`MCP server "${name}": unknown transport "${String(config.transport)}"`);
    }

    if (!config.governance || typeof config.governance !== "object") {
      throw new Error(`MCP server "${name}": "governance" section is required`);
    }

    const gov = config.governance;
    if (!Array.isArray(gov.allowed_divisions)) {
      throw new Error(`MCP server "${name}": governance.allowed_divisions must be an array`);
    }
    if (!Array.isArray(gov.allowed_tiers)) {
      throw new Error(`MCP server "${name}": governance.allowed_tiers must be an array`);
    }
    if (typeof gov.max_calls_per_minute !== "number") {
      throw new Error(`MCP server "${name}": governance.max_calls_per_minute must be a number`);
    }
    if (!Array.isArray(gov.forbidden_patterns)) {
      throw new Error(`MCP server "${name}": governance.forbidden_patterns must be an array`);
    }
    if (typeof gov.classification_ceiling !== "string") {
      throw new Error(`MCP server "${name}": governance.classification_ceiling must be a string`);
    }
    if (typeof gov.budget_per_call !== "number") {
      throw new Error(`MCP server "${name}": governance.budget_per_call must be a number`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tool Queries
  // ──────────────────────────────────────────────────────────────────────────

  async getToolsForAgent(agentId: string, division: string, tier: string): Promise<McpTool[]> {
    void agentId; // future: per-agent fine-grained policies
    const result: McpTool[] = [];
    for (const [, client] of this.clients) {
      if (client.getHealth() !== "healthy") continue;
      const gov = client.getGovernanceConfig();
      // Division check: "*" allows all
      if (!gov.allowed_divisions.includes("*") && !gov.allowed_divisions.includes(division)) continue;
      // Tier check
      if (!gov.allowed_tiers.includes(tier)) continue;
      // Add tools not blocked by forbidden patterns
      for (const tool of client.getTools()) {
        const isForbidden = gov.forbidden_patterns.some((pattern) =>
          matchToolPattern(tool.name, pattern),
        );
        if (!isForbidden) {
          result.push(tool);
        }
      }
    }
    return result;
  }

  getAllTools(): Array<{ name: string; server: string; description: string }> {
    const result: Array<{ name: string; server: string; description: string }> = [];
    for (const [toolName, serverName] of this.toolIndex) {
      const client = this.clients.get(serverName);
      if (client === undefined) continue;
      const tool = client.getTools().find((t) => t.name === toolName);
      result.push({
        name:        toolName,
        server:      serverName,
        description: tool?.description ?? "",
      });
    }
    return result;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const serverName = this.toolIndex.get(toolName);
    if (serverName === undefined) {
      throw new Error(`No MCP server registered for tool: ${toolName}`);
    }
    const client = this.clients.get(serverName);
    if (client === undefined) {
      throw new Error(`MCP server not found in registry: ${serverName}`);
    }
    return client.callTool(toolName, args);
  }

  getServerForTool(toolName: string): { name: string; governance: McpGovernanceConfig } | undefined {
    const serverName = this.toolIndex.get(toolName);
    if (serverName === undefined) return undefined;
    const client = this.clients.get(serverName);
    if (client === undefined) return undefined;
    return { name: serverName, governance: client.getGovernanceConfig() };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Status, Counts, Lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  getStatus(): McpServerStatus[] {
    const result: McpServerStatus[] = [];
    for (const [, client] of this.clients) {
      const lastError = client.getLastError();
      result.push({
        name:         client.getServerName(),
        transport:    client.getTransport(),
        health:       client.getHealth(),
        toolCount:    client.getTools().length,
        ...(lastError !== undefined ? { lastError } : {}),
        restartCount: client.getRestartCount(),
      });
    }
    return result;
  }

  get serverCount(): number { return this.clients.size; }
  get toolCount(): number   { return this.toolIndex.size; }

  async shutdown(): Promise<void> {
    for (const [, client] of this.clients) {
      try {
        await client.disconnect();
      } catch (err: unknown) {
        logger.warn("mcp_shutdown_error", "Error during MCP server disconnect", {
          metadata: { server: client.getServerName(), error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    this.clients.clear();
    this.toolIndex.clear();
    logger.info("mcp_registry_shutdown", "MCP registry shutdown complete", {});
  }

  async reloadConfig(): Promise<void> {
    if (this.configPath === null) return;
    const path = this.configPath;
    await this.shutdown();
    await this.initialize(path);
  }
}
