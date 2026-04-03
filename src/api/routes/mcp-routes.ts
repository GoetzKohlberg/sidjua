// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP REST Routes (P374)
 *
 * GET  /api/v1/mcp/servers           — list registered MCP servers + health
 * GET  /api/v1/mcp/tools             — list all tools across all servers
 * GET  /api/v1/mcp/tools/:agentId    — list tools visible to a specific agent
 * POST /api/v1/mcp/servers/reload    — hot-reload mcp-servers.yaml (operator)
 * POST /api/v1/mcp/test/:serverName  — test-invoke a tool on a server (operator)
 */

import type { Hono } from "hono";
import { requireScope } from "../middleware/require-scope.js";
import { createLogger } from "../../core/logger.js";
import type { McpRegistry } from "../../core/mcp/mcp-registry.js";

const logger = createLogger("mcp-routes");

export interface McpRouteServices {
  mcpRegistry: McpRegistry;
}

export function registerMcpRoutes(app: Hono, services: McpRouteServices): void {
  const { mcpRegistry } = services;

  // ── GET /api/v1/mcp/servers ──────────────────────────────────────────────
  // Returns health + tool count for all registered MCP servers.
  app.get("/api/v1/mcp/servers", requireScope("operator"), (c) => {
    const servers = mcpRegistry.getStatus();
    return c.json({
      servers,
      total:   servers.length,
      healthy: servers.filter((s) => s.health === "healthy").length,
    });
  });

  // ── GET /api/v1/mcp/tools ────────────────────────────────────────────────
  // Returns all tools from all healthy servers (admin/operator view — no governance filter).
  app.get("/api/v1/mcp/tools", requireScope("operator"), (c) => {
    const tools = mcpRegistry.getAllTools();
    return c.json({ tools, total: tools.length });
  });

  // ── GET /api/v1/mcp/tools/:agentId ──────────────────────────────────────
  // Returns tools visible to a specific agent per governance rules.
  app.get("/api/v1/mcp/tools/:agentId", requireScope("operator"), async (c) => {
    const agentId  = c.req.param("agentId");
    const division = c.req.query("division") ?? "engineering";
    const tier     = c.req.query("tier")     ?? "T2";

    const tools = await mcpRegistry.getToolsForAgent(agentId, division, tier);
    return c.json({ agentId, division, tier, tools, total: tools.length });
  });

  // ── POST /api/v1/mcp/servers/reload ─────────────────────────────────────
  // Hot-reloads mcp-servers.yaml: shuts down all clients, re-reads config, reconnects.
  app.post("/api/v1/mcp/servers/reload", requireScope("operator"), async (c) => {
    logger.info("mcp_reload_requested", "MCP config reload requested via API", {});
    try {
      await mcpRegistry.reloadConfig();
      const servers = mcpRegistry.getStatus();
      return c.json({
        success: true,
        servers: servers.length,
        healthy: servers.filter((s) => s.health === "healthy").length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("mcp_reload_failed", "MCP config reload failed", { metadata: { error: msg } });
      return c.json({ success: false, error: msg }, 500);
    }
  });

  // ── POST /api/v1/mcp/test/:serverName ───────────────────────────────────
  // Calls a specific tool on a specific server for testing. Operator only.
  // Body: { toolName: string, args?: Record<string, unknown> }
  app.post("/api/v1/mcp/test/:serverName", requireScope("operator"), async (c) => {
    const serverName = c.req.param("serverName");
    let body: { toolName?: string; args?: Record<string, unknown> };
    try {
      body = await c.req.json() as { toolName?: string; args?: Record<string, unknown> };
    } catch (err: unknown) {
      void err;
      return c.json({ error: { code: "INPUT-001", message: "Invalid JSON body" } }, 400);
    }

    const toolName = body.toolName;
    if (typeof toolName !== "string" || toolName.trim() === "") {
      return c.json({ error: { code: "INPUT-002", message: "toolName is required" } }, 400);
    }

    // Verify the tool belongs to the requested server
    const serverInfo = mcpRegistry.getServerForTool(toolName);
    if (serverInfo === undefined) {
      return c.json({ error: { code: "MCP-001", message: `Tool not found: ${toolName}` } }, 404);
    }
    if (serverInfo.name !== serverName) {
      return c.json({
        error: { code: "MCP-002", message: `Tool "${toolName}" is not on server "${serverName}"` }
      }, 400);
    }

    try {
      const result = await mcpRegistry.callTool(toolName, body.args ?? {});
      return c.json({ success: true, toolName, serverName, result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("mcp_test_call_failed", "MCP test tool call failed", {
        metadata: { server: serverName, tool: toolName, error: msg },
      });
      return c.json({ success: false, error: msg }, 500);
    }
  });
}
