// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — MCP Server Lifecycle Manager (P341)
 *
 * Manages on-demand start/stop, idle timeout, and LRU eviction for MCP servers.
 * All actual adapter connect/disconnect goes through ToolManager.
 */

import { createLogger }         from "../core/logger.js";
import type { ToolManager }     from "./tool-manager.js";
import type { McpServerEntry, McpSettings } from "./mcp-config.js";

const logger = createLogger("mcp-lifecycle");


type ServerStatus = "stopped" | "starting" | "running" | "error";

interface ServerState {
  entry:        McpServerEntry;
  status:       ServerStatus;
  lastActivity: number;   // ms since epoch, or 0 if never active
}


export class McpLifecycleManager {
  private readonly servers      = new Map<string, ServerState>();
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly toolManager: ToolManager,
    private readonly settings:    McpSettings,
  ) {}

  // ---------------------------------------------------------------------------
  // registerServers
  // ---------------------------------------------------------------------------

  /**
   * Register server entries from config (does NOT start them).
   * Idempotent: re-registering an existing id overwrites the entry but preserves status.
   */
  registerServers(entries: McpServerEntry[]): void {
    for (const entry of entries) {
      const existing = this.servers.get(entry.id);
      this.servers.set(entry.id, {
        entry,
        status:       existing?.status ?? "stopped",
        lastActivity: existing?.lastActivity ?? 0,
      });
      logger.info("mcp_server_registered", "MCP server registered", {
        metadata: { id: entry.id, name: entry.name },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // startServer
  // ---------------------------------------------------------------------------

  /**
   * Start a server on demand. Enforces max_concurrent_servers by stopping the
   * LRU (least recently used) running server when the limit is reached.
   *
   * No-op if the server is already running.
   * Throws if the server ID is unknown.
   */
  async startServer(serverId: string): Promise<void> {
    const state = this.servers.get(serverId);
    if (state === undefined) throw new Error(`McpLifecycleManager: unknown server '${serverId}'`);
    if (state.status === "running") return;

    // Enforce concurrent server limit — stop LRU if needed
    const running = [...this.servers.values()].filter((s) => s.status === "running");
    if (running.length >= this.settings.max_concurrent_servers) {
      const sorted = [...this.servers.entries()]
        .filter(([, s]) => s.status === "running")
        .sort(([, a], [, b]) => a.lastActivity - b.lastActivity);
      const lru = sorted[0];
      if (lru !== undefined) {
        await this.stopServer(lru[0]);
      }
    }

    state.status = "starting";
    try {
      await this.toolManager.start(serverId);
      state.status       = "running";
      state.lastActivity = Date.now();
      logger.info("mcp_server_started", "MCP server started", { metadata: { id: serverId } });
    } catch (err) {
      state.status = "error";
      logger.warn("mcp_server_start_failed", "MCP server start failed", {
        metadata: { id: serverId, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // stopServer
  // ---------------------------------------------------------------------------

  /** Stop a running server. No-op if already stopped. */
  async stopServer(serverId: string): Promise<void> {
    const state = this.servers.get(serverId);
    if (state === undefined || state.status !== "running") return;

    try {
      await this.toolManager.stop(serverId);
      state.status = "stopped";
      logger.info("mcp_server_stopped", "MCP server stopped", { metadata: { id: serverId } });
    } catch (err) {
      logger.warn("mcp_server_stop_failed", "MCP server stop failed", {
        metadata: { id: serverId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // touch / idle watcher
  // ---------------------------------------------------------------------------

  /** Record activity for a server to reset its idle timeout. */
  touch(serverId: string): void {
    const state = this.servers.get(serverId);
    if (state !== undefined) {
      state.lastActivity = Date.now();
    }
  }

  /** Start the idle-check loop (runs every 30s). Idempotent. */
  startIdleWatcher(): void {
    if (this.idleCheckTimer !== null) return;

    this.idleCheckTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, state] of this.servers) {
        if (state.status !== "running") continue;
        const idleMs  = now - state.lastActivity;
        const limitMs = (state.entry.max_idle_seconds ?? this.settings.idle_timeout_seconds) * 1000;
        if (idleMs > limitMs) {
          logger.info("mcp_server_idle_stop", "Stopping idle MCP server", {
            metadata: { id, idle_ms: idleMs },
          });
          this.stopServer(id).catch(() => { /* already logged inside stopServer */ });
        }
      }
    }, 30_000);
  }

  /** Stop the idle-check loop. */
  stopIdleWatcher(): void {
    if (this.idleCheckTimer !== null) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // getStatus
  // ---------------------------------------------------------------------------

  /** Return a snapshot of all registered servers and their current status. */
  getStatus(): Record<string, { name: string; status: ServerStatus; lastActivity: number }> {
    const result: Record<string, { name: string; status: ServerStatus; lastActivity: number }> = {};
    for (const [id, state] of this.servers) {
      result[id] = {
        name:         state.entry.name,
        status:       state.status,
        lastActivity: state.lastActivity,
      };
    }
    return result;
  }

  /** Number of currently running servers. */
  runningCount(): number {
    return [...this.servers.values()].filter((s) => s.status === "running").length;
  }
}
