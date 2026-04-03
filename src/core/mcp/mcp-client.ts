// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP client: JSON-RPC 2.0 over STDIO and SSE transports.
 *
 * Security rules applied:
 *   - NEVER pass unsanitized user input as process args (args come from validated config only)
 *   - Secret references resolved by registry before reaching this class
 *   - Tool call arguments: only arg-hash logged, never full args
 *   - Max 3 auto-restarts on crash
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createLogger } from "../logger.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  McpServerConfig,
  McpGovernanceConfig,
  McpTool,
  McpToolResult,
  McpServerHealth,
  McpToolDefinition,
  ToolRiskLevel,
} from "./types.js";
import { DEFAULT_RISK_LEVELS } from "./types.js";

const logger = createLogger("mcp-client");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Pending request descriptor
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject:  (reason: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

export class McpClient {
  private readonly config: McpServerConfig;
  private readonly serverName: string;
  private childProcess: ChildProcess | null = null;
  private sseController: AbortController | null = null;
  private sseEndpointUrl: string | null = null;
  private requestId = 0;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private tools: McpToolDefinition[] = [];
  private health: McpServerHealth = "stopped";
  private restartCount = 0;
  private lastError: string | undefined;
  private buffer = "";

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.health = "starting";
    try {
      if (this.config.transport === "stdio") {
        await this.connectStdio();
      } else {
        await this.connectSse();
      }
      this.tools = await this.discoverTools();
      this.health = "healthy";
      this.restartCount = 0;
      logger.info("mcp_connected", "MCP server connected", {
        metadata: { server: this.serverName, transport: this.config.transport, toolCount: this.tools.length },
      });
    } catch (err: unknown) {
      this.health = "unhealthy";
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn("mcp_connect_failed", "MCP server connection failed", {
        metadata: { server: this.serverName, error: this.lastError },
      });
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (this.health !== "healthy") {
      throw new Error(`MCP server ${this.serverName} is ${this.health}`);
    }
    // SECURITY: log only the hash of args, never the full args (may contain secrets)
    const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
    logger.info("mcp_tool_call", "Calling MCP tool", {
      metadata: { server: this.serverName, tool: name, argsHash },
    });
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return result as McpToolResult;
  }

  async disconnect(): Promise<void> {
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP client disconnecting"));
    }
    this.pendingRequests.clear();

    if (this.config.transport === "stdio" && this.childProcess !== null) {
      this.sendNotification("notifications/cancelled");
      this.childProcess.kill("SIGTERM");
      const proc = this.childProcess;
      const killTimer = setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5_000);
      proc.once("exit", () => { clearTimeout(killTimer); });
      this.childProcess = null;
    } else if (this.config.transport === "sse" && this.sseController !== null) {
      this.sseController.abort();
      this.sseController = null;
      this.sseEndpointUrl = null;
    }

    this.health = "stopped";
    this.tools = [];
    logger.info("mcp_disconnected", "MCP server disconnected", { metadata: { server: this.serverName } });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Getters (used by McpRegistry)
  // ──────────────────────────────────────────────────────────────────────────

  getTools(): McpToolDefinition[] { return this.tools; }
  getHealth(): McpServerHealth    { return this.health; }
  getLastError(): string | undefined { return this.lastError; }
  getRestartCount(): number       { return this.restartCount; }
  getServerName(): string         { return this.serverName; }
  getTransport(): "stdio" | "sse" { return this.config.transport; }
  getGovernanceConfig(): McpGovernanceConfig { return this.config.governance; }

  // ──────────────────────────────────────────────────────────────────────────
  // STDIO Transport
  // ──────────────────────────────────────────────────────────────────────────

  private async connectStdio(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`STDIO transport requires 'command' for server: ${this.serverName}`);
    }
    const proc = spawn(this.config.command, this.config.args ?? [], {
      env:   { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.childProcess = proc;

    proc.on("error", (err) => {
      logger.warn("mcp_process_error", "MCP child process error", {
        metadata: { server: this.serverName, error: err.message },
      });
      // Reject all pending requests so callers don't wait for DEFAULT_TIMEOUT_MS
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingRequests.clear();
    });

    proc.on("exit", (code, signal) => {
      if (this.health !== "stopped") {
        logger.warn("mcp_process_exit", "MCP child process exited unexpectedly", {
          metadata: { server: this.serverName, code, signal },
        });
        void this.handleProcessCrash();
      }
    });

    if (proc.stderr !== null) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          logger.debug("mcp_server_stderr", "MCP server stderr", {
            metadata: { server: this.serverName, text: text.slice(0, 500) },
          });
        }
      });
    }

    if (proc.stdout === null) {
      throw new Error(`MCP server ${this.serverName}: child process stdout is null`);
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    // Initialize handshake
    await this.initialize();
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Last element may be partial — keep in buffer
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch (err: unknown) {
        logger.warn("mcp_parse_error", "Failed to parse MCP message", {
          metadata: { server: this.serverName, error: err instanceof Error ? err.message : String(err) },
        });
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: unknown): void {
    if (msg === null || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    // JSON-RPC response (has 'id')
    if (typeof m["id"] === "number") {
      const resp = m as unknown as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending !== undefined) {
        pending.resolve(resp);
      }
    }
    // Notification (no 'id') — ignore for now
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SSE Transport
  // ──────────────────────────────────────────────────────────────────────────

  private async connectSse(): Promise<void> {
    if (!this.config.url) {
      throw new Error(`SSE transport requires 'url' for server: ${this.serverName}`);
    }
    this.sseController = new AbortController();
    const signal = this.sseController.signal;

    const resp = await fetch(this.config.url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...(this.config.headers ?? {}),
      },
      signal,
    });

    if (!resp.ok) {
      throw new Error(`SSE connect failed: HTTP ${resp.status} from ${this.config.url}`);
    }
    if (resp.body === null) {
      throw new Error(`SSE connect failed: no body from ${this.config.url}`);
    }

    // Wait for the 'endpoint' event before proceeding
    const endpointUrl = await this.readSseEndpoint(resp.body, signal);
    this.sseEndpointUrl = endpointUrl;

    // Start background SSE reader
    void this.readSseStream(resp.body, signal);

    // Initialize handshake
    await this.initialize();
  }

  private async readSseEndpoint(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let eventType = "";
      let eventData = "";

      const onAbort = (): void => {
        reader.cancel().catch(() => { /* ignore */ });
        reject(new Error("SSE connection aborted"));
      };
      signal.addEventListener("abort", onAbort);

      const read = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) { reject(new Error("SSE stream ended before endpoint event")); return; }
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              eventData = line.slice(5).trim();
            } else if (line === "") {
              if (eventType === "endpoint" && eventData) {
                signal.removeEventListener("abort", onAbort);
                resolve(eventData);
                return;
              }
              eventType = "";
              eventData = "";
            }
          }
          read();
        }).catch((err: unknown) => {
          reject(new Error(err instanceof Error ? err.message : String(err)));
        });
      };
      read();
    });
  }

  private async readSseStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let eventType = "";
    let eventData = "";

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            eventData = line.slice(5).trim();
          } else if (line === "") {
            if (eventType === "message" && eventData) {
              let msg: unknown;
              try {
                msg = JSON.parse(eventData);
              } catch (err: unknown) {
                logger.warn("mcp_sse_parse", "Failed to parse SSE data", {
                  metadata: { server: this.serverName, error: err instanceof Error ? err.message : String(err) },
                });
              }
              if (msg !== undefined) this.handleMessage(msg);
            }
            eventType = "";
            eventData = "";
          }
        }
      }
    } catch (err: unknown) {
      if (!signal.aborted) {
        logger.warn("mcp_sse_read_error", "SSE read error", {
          metadata: { server: this.serverName, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  private async postToSseEndpoint(json: string): Promise<void> {
    if (this.sseEndpointUrl === null) return;
    const resp = await fetch(this.sseEndpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.headers ?? {}),
      },
      body: json,
    });
    if (!resp.ok) {
      logger.warn("mcp_sse_post_error", "SSE POST failed", {
        metadata: { server: this.serverName, status: resp.status },
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // JSON-RPC helpers
  // ──────────────────────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "sidjua", version: "1.1.0" },
    });
    this.sendNotification("notifications/initialized");
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    const request: JsonRpcRequest = params !== undefined
      ? { jsonrpc: "2.0", id, method, params }
      : { jsonrpc: "2.0", id, method };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${DEFAULT_TIMEOUT_MS}ms)`));
      }, DEFAULT_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (resp: JsonRpcResponse) => {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          if (resp.error !== undefined) {
            reject(new Error(`MCP error ${resp.error.code}: ${resp.error.message}`));
          } else {
            resolve(resp.result);
          }
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        },
        timer,
      });

      this.writeMessage(request);
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification: JsonRpcNotification = params !== undefined
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", method };
    this.writeMessage(notification);
  }

  private writeMessage(msg: JsonRpcRequest | JsonRpcNotification): void {
    const json = JSON.stringify(msg);
    if (this.config.transport === "stdio") {
      if (this.childProcess?.stdin?.writable === true) {
        this.childProcess.stdin.write(json + "\n");
      }
    } else if (this.config.transport === "sse" && this.sseEndpointUrl !== null) {
      this.postToSseEndpoint(json).catch((err: unknown) => {
        logger.warn("mcp_sse_post_failed", "SSE POST failed (write)", {
          metadata: { server: this.serverName, error: err instanceof Error ? err.message : String(err) },
        });
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tool Discovery
  // ──────────────────────────────────────────────────────────────────────────

  private async discoverTools(): Promise<McpToolDefinition[]> {
    const result = await this.sendRequest("tools/list") as { tools?: McpTool[] };
    const rawTools = result?.tools ?? [];
    return rawTools.map((tool) => {
      // Check per-server risk overrides first
      const override = this.config.governance?.tool_risk_overrides?.[tool.name];
      if (override !== undefined) {
        return { ...tool, riskLevel: override };
      }
      // Match by name prefix
      for (const [prefix, level] of Object.entries(DEFAULT_RISK_LEVELS)) {
        if (tool.name.startsWith(prefix)) {
          return { ...tool, riskLevel: level as ToolRiskLevel };
        }
      }
      return { ...tool, riskLevel: "medium" as ToolRiskLevel };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Crash Recovery
  // ──────────────────────────────────────────────────────────────────────────

  private async handleProcessCrash(): Promise<void> {
    this.health = "unhealthy";
    if (this.restartCount >= MAX_RESTARTS) {
      logger.warn("mcp_max_restarts", "MCP server reached max restart limit — staying unhealthy", {
        metadata: { server: this.serverName, restarts: this.restartCount },
      });
      return;
    }
    this.restartCount++;
    logger.info("mcp_restarting", "Restarting MCP server", {
      metadata: { server: this.serverName, attempt: this.restartCount },
    });
    await new Promise<void>((r) => setTimeout(r, RESTART_DELAY_MS));
    try {
      await this.connect();
    } catch (_err: unknown) {
      // connect() already logs
    }
  }
}
