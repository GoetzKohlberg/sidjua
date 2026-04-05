// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.7: Tool Manager
 *
 * Lifecycle management for tool adapters: start, stop, health-check,
 * startAll, stopAll, and adapter injection for testing.
 */

import type { Database } from "../utils/db.js";
import type {
  ToolAdapter,
  ToolDefinition,
  ToolCapability,
  McpToolConfig,
  RestToolConfig,
  ShellToolConfig,
  FilesystemToolConfig,
  ComputerUseToolConfig,
  DatabaseToolConfig,
  AdbToolConfig,
  CompositeToolConfig,
} from "./types.js";
import type { ToolRegistry } from "./tool-registry.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("tool-manager");
import { McpAdapter } from "./adapters/mcp-adapter.js";
import { RestAdapter } from "./adapters/rest-adapter.js";
import { ShellAdapter } from "./adapters/shell-adapter.js";
import { FilesystemAdapter } from "./adapters/filesystem-adapter.js";
import { ComputerUseAdapter } from "./adapters/computer-use-adapter.js";
import { DatabaseAdapter } from "./adapters/database-adapter.js";
import { AdbAdapter } from "./adapters/adb-adapter.js";
import { CompositeAdapter } from "./adapters/composite-adapter.js";


export class ToolManager {
  private readonly adapters = new Map<string, ToolAdapter>();

  constructor(
    private readonly db: Database,
    private readonly registry: ToolRegistry,
  ) {
    // db is retained for potential future direct queries (audit, etc.)
    void this.db;
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  /**
   * Start a tool: build its adapter, connect, and mark it active in the DB.
   */
  async start(toolId: string): Promise<void> {
    const tool = this.registry.getById(toolId);

    const caps = this.registry.getCapabilities(toolId);
    const adapter = this.createAdapter(tool, caps);

    this.registry.updateStatus(toolId, "starting");

    try {
      await adapter.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.registry.updateStatus(toolId, "error", undefined, msg);
      throw err;
    }

    this.adapters.set(toolId, adapter);
    this.registry.updateStatus(toolId, "active");
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /**
   * Stop a running tool: disconnect its adapter and mark it inactive.
   */
  async stop(toolId: string): Promise<void> {
    this.registry.updateStatus(toolId, "stopping");

    const adapter = this.adapters.get(toolId);
    if (adapter !== undefined) {
      try {
        await adapter.disconnect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("tool_stop_error", `Error stopping tool ${toolId}`, { metadata: { tool_id: toolId, error: msg } });
      }
      this.adapters.delete(toolId);
    }

    this.registry.updateStatus(toolId, "inactive");
  }

  // -------------------------------------------------------------------------
  // healthCheck
  // -------------------------------------------------------------------------

  /**
   * Health-check a tool. Returns false if the tool is not running or
   * the adapter reports unhealthy.
   */
  async healthCheck(toolId: string): Promise<boolean> {
    const adapter = this.adapters.get(toolId);
    if (adapter === undefined) {
      return false;
    }

    try {
      return await adapter.healthCheck();
    } catch (e: unknown) {
      logger.warn("tool-manager", "Tool adapter health check failed — adapter may be unavailable", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // startAll
  // -------------------------------------------------------------------------

  /**
   * Start all tools whose DB status is 'active'.
   * Logs and continues on individual failures.
   */
  async startAll(): Promise<void> {
    const activeTools = this.registry.list("active");

    for (const tool of activeTools) {
      // Skip tools already running in-process
      if (this.adapters.has(tool.id)) {
        continue;
      }

      try {
        await this.start(tool.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("tool_start_failed", `Failed to start tool ${tool.id}`, { metadata: { tool_id: tool.id, error: msg } });
      }
    }
  }

  // -------------------------------------------------------------------------
  // stopAll
  // -------------------------------------------------------------------------

  /**
   * Stop all currently running tools (those present in the in-process adapter map).
   */
  async stopAll(): Promise<void> {
    const toolIds = [...this.adapters.keys()];

    for (const toolId of toolIds) {
      try {
        await this.stop(toolId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("tool_stop_failed", `Failed to stop tool ${toolId}`, { metadata: { tool_id: toolId, error: msg } });
      }
    }
  }

  // -------------------------------------------------------------------------
  // getAdapter
  // -------------------------------------------------------------------------

  /**
   * Get the running adapter for a tool, or undefined if not running.
   */
  getAdapter(toolId: string): ToolAdapter | undefined {
    return this.adapters.get(toolId);
  }

  // -------------------------------------------------------------------------
  // registerAdapter
  // -------------------------------------------------------------------------

  /**
   * Register an external adapter (e.g. a mock) without going through start().
   * Used for testing and dependency injection.
   */
  registerAdapter(toolId: string, adapter: ToolAdapter): void {
    this.adapters.set(toolId, adapter);
  }

  // -------------------------------------------------------------------------
  // Private: createAdapter
  // -------------------------------------------------------------------------

  /**
   * Factory method — constructs the appropriate adapter class for a tool.
   * Composite adapters require sub-tools to already be running in this.adapters.
   */
  private createAdapter(
    tool: ToolDefinition,
    caps: ToolCapability[],
  ): ToolAdapter {
    switch (tool.type) {
      case "mcp":
        return new McpAdapter(tool.id, tool.config as McpToolConfig, caps);

      case "rest":
        return new RestAdapter(tool.id, tool.config as RestToolConfig, caps);

      case "shell":
        return new ShellAdapter(tool.id, tool.config as ShellToolConfig, caps);

      case "filesystem":
        return new FilesystemAdapter(
          tool.id,
          tool.config as FilesystemToolConfig,
          caps,
        );

      case "computer_use":
        return new ComputerUseAdapter(
          tool.id,
          tool.config as ComputerUseToolConfig,
          caps,
        );

      case "database":
        return new DatabaseAdapter(
          tool.id,
          tool.config as DatabaseToolConfig,
          caps,
        );

      case "adb":
        return new AdbAdapter(tool.id, tool.config as AdbToolConfig, caps);

      case "composite": {
        const compositeConfig = tool.config as CompositeToolConfig;

        // Build the sub-adapters map from already-running adapters
        const subAdaptersMap = new Map<string, ToolAdapter>();
        for (const subId of compositeConfig.sub_tools) {
          const sub = this.adapters.get(subId);
          if (sub !== undefined) {
            subAdaptersMap.set(subId, sub);
          }
        }

        return new CompositeAdapter(tool.id, compositeConfig, subAdaptersMap, caps);
      }

      case "internal": {
        // Internal tools are bootstrapped at startup via registerInternalTool(),
        // not loaded from the DB.  This case is unreachable in normal operation.
        throw new Error(
          `ToolManager: type "internal" cannot be loaded from DB — use registerInternalTool() instead`,
        );
      }

      default: {
        // Exhaustiveness guard — TypeScript will flag unhandled ToolType values
        const exhaustiveCheck: never = tool.type;
        throw new Error(`ToolManager: unknown tool type: ${String(exhaustiveCheck)}`);
      }
    }
  }
}
