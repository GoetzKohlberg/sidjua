// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Integration Gateway: MCP Protocol Bridge (P341)
 *
 * Bridges Integration Gateway action calls to MCP (Model Context Protocol)
 * tool invocations.
 *
 * Two execution paths:
 *   1. ToolManager path (primary): resolves the running McpAdapter from ToolManager
 *      and delegates the call.  On-demand server start is handled by the optional
 *      McpLifecycleManager.
 *   2. mcpClientFactory path (legacy/test): backwards-compatible path for callers
 *      that provide a custom client factory.
 *
 * If neither path is configured the bridge throws `MCP_NOT_IMPLEMENTED`.
 */

import { createLogger }          from "../../core/logger.js";
import { IntegrationError }      from "../errors.js";
import type { ToolManager }      from "../../tool-integration/tool-manager.js";
import type { McpLifecycleManager } from "../../tool-integration/mcp-lifecycle.js";

const logger = createLogger("mcp-bridge");


export interface McpBridgeRequest {
  /** Name of the MCP server (from adapter definition, e.g. "filesystem-mcp") */
  server_name: string;
  /** MCP tool name to call */
  tool_name: string;
  /** Arguments passed to the MCP tool */
  arguments: Record<string, unknown>;
  /** Request correlation ID */
  request_id: string;
  /** Timeout for the MCP tool call */
  timeout_ms: number;
}

export interface McpBridgeResult {
  success: boolean;
  result: unknown;
  error?: string;
  execution_ms: number;
}


export class McpBridge {
  /**
   * Create an McpBridge.
   *
   * @param mcpClientFactory   Legacy: optional factory returning a configured MCP client
   * @param toolManager        Primary: ToolManager holding running McpAdapters
   * @param lifecycleManager   Optional: starts servers on-demand before executing
   */
  constructor(
    private readonly mcpClientFactory?:  (serverName: string) => Promise<McpClient | null>,
    private readonly toolManager?:       ToolManager,
    private readonly lifecycleManager?:  McpLifecycleManager,
  ) {}

  /**
   * Execute an MCP tool call.
   *
   * Tries ToolManager path first (when toolManager is injected), then falls back
   * to mcpClientFactory.  Throws `MCP_NOT_IMPLEMENTED` if neither is available.
   */
  async execute(request: McpBridgeRequest): Promise<McpBridgeResult> {
    const start = Date.now();

    // ---------------------------------------------------------------------------
    // Path 1: ToolManager path (P341 wiring)
    // ---------------------------------------------------------------------------
    if (this.toolManager !== undefined) {
      try {
        // On-demand server start
        if (this.lifecycleManager !== undefined) {
          await this.lifecycleManager.startServer(request.server_name);
          this.lifecycleManager.touch(request.server_name);
        }

        const adapter = this.toolManager.getAdapter(request.server_name);
        if (adapter === undefined) {
          return {
            success:      false,
            result:       null,
            error:        `MCP server '${request.server_name}' not found in ToolManager`,
            execution_ms: Date.now() - start,
          };
        }

        logger.debug("mcp_bridge_call", `Calling '${request.tool_name}' on '${request.server_name}'`, {
          metadata: { request_id: request.request_id, server: request.server_name, tool: request.tool_name },
        });

        const toolResult = await adapter.execute({
          tool_id:    request.server_name,
          capability: request.tool_name,
          params:     request.arguments,
          agent_id:   "system",
        });

        return {
          success:      toolResult.success,
          result:       toolResult.data ?? null,
          ...(toolResult.error !== undefined ? { error: toolResult.error } : {}),
          execution_ms: toolResult.duration_ms,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("mcp_bridge_error", `MCP tool call failed: ${msg}`, {
          metadata: { request_id: request.request_id, server: request.server_name },
        });
        return {
          success:      false,
          result:       null,
          error:        msg,
          execution_ms: Date.now() - start,
        };
      }
    }

    // ---------------------------------------------------------------------------
    // Path 2: legacy mcpClientFactory path
    // ---------------------------------------------------------------------------
    if (this.mcpClientFactory !== undefined) {
      const client = await this.mcpClientFactory(request.server_name);
      if (client !== null) {
        try {
          logger.debug("mcp-bridge", `Calling tool '${request.tool_name}' on server '${request.server_name}'`, {
            metadata: { requestId: request.request_id, server: request.server_name, tool: request.tool_name },
          });
          const result = await client.callTool(request.tool_name, request.arguments, request.timeout_ms);
          return {
            success:      true,
            result,
            execution_ms: Date.now() - start,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.warn("mcp-bridge", `MCP tool call failed: ${msg}`, {
            metadata: { requestId: request.request_id, server: request.server_name, tool: request.tool_name },
          });
          return {
            success:      false,
            result:       null,
            error:        msg,
            execution_ms: Date.now() - start,
          };
        }
      }
    }

    // No client configured
    logger.warn("mcp-bridge", "MCP bridge called but no client factory configured", {
      metadata: { requestId: request.request_id, server: request.server_name },
    });
    throw new IntegrationError(
      `MCP bridge: no client configured for server '${request.server_name}'. ` +
      "Wire McpBridge with a toolManager or mcpClientFactory to enable MCP protocol support.",
      "MCP_NOT_IMPLEMENTED",
      request.server_name,
      request.tool_name,
    );
  }
}


/**
 * Minimal surface the bridge needs from a MCP client (legacy path).
 * The existing McpAdapter in src/tool-integration/adapters/mcp-adapter.ts
 * implements a superset of this interface.
 */
export interface McpClient {
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}
