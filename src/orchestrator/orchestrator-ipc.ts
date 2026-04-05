// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Orchestrator IPC Server
 *
 * Unix domain socket server for CLI → orchestrator command routing.
 * Extracted from OrchestratorProcess to keep orchestrator.ts focused on
 * lifecycle and event coordination.
 *
 * Security model:
 *   - Per-start 32-byte secret written to {socketDir}/ipc.token (mode 0o600)
 *   - Incoming requests must carry the matching token (timingSafeCompare)
 *   - Command whitelist — unknown commands are rejected before processing
 *   - Socket file created with umask 0o177 → mode 0o600
 */

import { createServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync, chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { timingSafeCompare }  from "../core/crypto-utils.js";
import { createLogger }       from "../core/logger.js";
import type { TaskStore }     from "../tasks/store.js";
import type { EscalationManager } from "./escalation.js";
import type { OrchestratorStatus, OrchestratorState } from "./types.js";
import type { AgentDaemonManager } from "../agent-lifecycle/daemon-manager.js";
import type { InboundMessageGateway } from "../messaging/inbound-gateway.js";
import type { AdapterRegistry } from "../messaging/adapter-registry.js";
import type { UserMappingStore } from "../messaging/user-mapping.js";
import type { AdapterInstanceConfig } from "../messaging/types.js";

const logger = createLogger("orchestrator");

// ---------------------------------------------------------------------------
// Public types (re-exported by orchestrator.ts for ipc-client.ts)
// ---------------------------------------------------------------------------

/** Filename for the IPC authentication token, placed alongside the socket file. */
export const IPC_TOKEN_FILENAME = "ipc.token";

export interface CLIRequest {
  command:    "stop" | "shutdown" | "pause" | "resume" | "submit_task" | "decide" | "health" |
              "daemon_status" | "daemon_start" | "daemon_stop" | "daemon_restart" |
              "messaging_status" | "messaging_start" | "messaging_stop" | "messaging_reload" |
              "messaging_adapters" | "messaging_map" | "messaging_unmap" | "messaging_mappings" |
              "delegation_status" | "delegation_history";
  payload:    Record<string, unknown>;
  request_id: string;
  /** IPC authentication token — must match the token in {socketDir}/ipc.token. */
  token?:     string;
}

export interface CLIResponse {
  request_id: string;
  success:    boolean;
  data:       Record<string, unknown>;
  error?:     string;
}

// ---------------------------------------------------------------------------
// Delegate interface
// ---------------------------------------------------------------------------

/**
 * The subset of OrchestratorProcess that OrchestratorIpcServer needs to call
 * back into the orchestrator for command dispatch.
 */
export interface OrchestratorIpcDelegate {
  getStatus(): OrchestratorStatus;
  stop(): Promise<void>;
  gracefulShutdown(drainTimeoutSec: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  readonly state: OrchestratorState;
  readonly store: TaskStore;
  readonly escalationManager: EscalationManager;
  readonly daemonManager: AgentDaemonManager | null;
  readonly messagingGateway: InboundMessageGateway | null;
  readonly messagingRegistry: AdapterRegistry | null;
  readonly messagingConfigs: AdapterInstanceConfig[] | null;
  readonly userMappingStore: UserMappingStore | null;
}

// ---------------------------------------------------------------------------
// OrchestratorIpcServer
// ---------------------------------------------------------------------------

/** Allowed IPC command types — reject unknown commands before processing. */
const ALLOWED_IPC_COMMANDS = new Set<CLIRequest["command"]>([
  "stop", "pause", "resume", "submit_task", "decide", "health",
  "daemon_status", "daemon_start", "daemon_stop", "daemon_restart",
  "messaging_status", "messaging_start", "messaging_stop", "messaging_reload",
  "messaging_adapters", "messaging_map", "messaging_unmap", "messaging_mappings",
  "delegation_status", "delegation_history",
]);

export class OrchestratorIpcServer {
  private _socketServer: NetServer | null = null;
  private _socketPath:   string | null    = null;
  private _ipcSecret:    string | null    = null;

  constructor(private readonly delegate: OrchestratorIpcDelegate) {}

  /**
   * Start the Unix domain socket server for CLI IPC.
   * Call this after start() to enable CLI commands (stop, pause, resume, health, decide).
   *
   * @param socketPath Filesystem path for the socket file (e.g. `.system/orchestrator.sock`)
   */
  startSocketServer(socketPath: string): void {
    // Remove stale socket file if present
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch (e: unknown) { void e; /* cleanup-ignore: socket file cleanup is best-effort */ }
    }

    // Ensure socket directory exists with owner-only (0o700) permissions.
    // For Unix domain sockets the containing directory's permissions control access —
    // other local users cannot connect to the socket if they cannot traverse the dir.
    const socketDir = dirname(socketPath);
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    try { chmodSync(socketDir, 0o700); } catch (e: unknown) { void e; /* cleanup-ignore: chmod socket dir best-effort */ }

    // Generate a 32-byte IPC secret and write it to {socketDir}/ipc.token
    // (mode 0o600). The CLI client reads this secret and includes it in every
    // request so unauthenticated local processes cannot control the orchestrator.
    const secretHex = randomBytes(32).toString("hex");
    this._ipcSecret  = secretHex;
    const tokenFilePath = join(socketDir, IPC_TOKEN_FILENAME);
    try {
      writeFileSync(tokenFilePath, secretHex, { encoding: "utf-8", mode: 0o600 });
      try { chmodSync(tokenFilePath, 0o600); } catch (_e) { /* best-effort */ }
    } catch (e: unknown) {
      logger.warn("ipc_secret_write_failed", "Failed to write IPC secret file — IPC auth disabled", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
      this._ipcSecret = null; // disable auth if secret write failed
    }

    this._socketPath   = socketPath;
    this._socketServer = createServer((socket: Socket) => {
      let buf = "";

      // Log each new connection to the audit trail so unexpected
      // connections from other local processes are visible in logs.
      logger.info("ipc_connection", "ipc_connection", { metadata: { socketPath } });

      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;

        const line = buf.slice(0, nl);
        buf        = buf.slice(nl + 1);

        let req: CLIRequest;
        try {
          req = JSON.parse(line) as CLIRequest;
        } catch (e: unknown) {
          logger.warn("orchestrator", "Invalid JSON from IPC client — skipping request", { metadata: { error: e instanceof Error ? e.message : String(e) } });
          const errResp: CLIResponse = {
            request_id: "unknown",
            success:    false,
            data:       {},
            error:      "Invalid JSON",
          };
          socket.write(JSON.stringify(errResp) + "\n");
          return;
        }

        // Verify the IPC secret using the canonical constant-time comparison
        // from crypto-utils (SHA-256 hash normalisation prevents length-based
        // timing leaks when secrets differ — never log the provided value).
        if (this._ipcSecret !== null) {
          const providedToken = typeof req.token === "string" ? req.token : "";
          const tokenOk = timingSafeCompare(this._ipcSecret, providedToken);
          if (!tokenOk) {
            logger.warn("orchestrator", "IPC authentication failed — rejecting request", {
              metadata: { command: req.command, request_id: req.request_id ?? "unknown" },
            });
            const authErr: CLIResponse = {
              request_id: req.request_id ?? "unknown",
              success:    false,
              data:       {},
              error:      "IPC_AUTH_FAILED",
            };
            socket.write(JSON.stringify(authErr) + "\n");
            socket.destroy();
            return;
          }
        }

        // Validate command type against whitelist before processing.
        if (!ALLOWED_IPC_COMMANDS.has(req.command)) {
          logger.warn("ipc_unknown_command", "ipc_unknown_command", { metadata: { command: req.command } });
          const errResp: CLIResponse = {
            request_id: req.request_id ?? "unknown",
            success:    false,
            data:       {},
            error:      `Unknown IPC command: ${req.command}`,
          };
          socket.write(JSON.stringify(errResp) + "\n");
          return;
        }

        this.handleSocketRequest(req).then((resp) => {
          socket.write(JSON.stringify(resp) + "\n");
        }).catch((err: unknown) => {
          const errResp: CLIResponse = {
            request_id: req.request_id,
            success:    false,
            data:       {},
            error:      String(err),
          };
          socket.write(JSON.stringify(errResp) + "\n");
        });
      });

      socket.on("error", () => {
        // ignore client disconnect errors
      });
    });

    // P272 Task 2: Set umask to 0o177 before creating the socket file so it is
    // created with mode 0o600 (0o777 & ~0o177 = 0o600) from the start, closing
    // the race window between listen() and the chmod in the callback.
    const prevUmask = process.umask(0o177);
    this._socketServer.listen(socketPath, () => {
      process.umask(prevUmask); // restore immediately after socket is created
      // Belt-and-suspenders: chmod in case the OS ignored umask
      try { chmodSync(socketPath, 0o600); } catch (_e) { /* best-effort on platforms without chmod */ }
      logger.info("ipc_socket_listening", "IPC socket listening", { metadata: { path: socketPath } });
    });
  }

  /** Stop the Unix domain socket server and remove the socket file. */
  stopSocketServer(): void {
    if (this._socketServer !== null) {
      this._socketServer.close();
      this._socketServer = null;
    }
    if (this._socketPath !== null && existsSync(this._socketPath)) {
      try { unlinkSync(this._socketPath); } catch (e: unknown) { void e; /* cleanup-ignore: socket file cleanup best-effort */ }
      this._socketPath = null;
    }
  }

  /** Handle an incoming IPC request from the CLI. */
  async handleSocketRequest(req: CLIRequest): Promise<CLIResponse> {
    const d = this.delegate;

    switch (req.command) {
      case "health": {
        const status = d.getStatus();
        return { request_id: req.request_id, success: true, data: { status } };
      }

      case "stop": {
        // Kick off stop in background; respond immediately
        void d.stop().finally(() => this.stopSocketServer());
        return { request_id: req.request_id, success: true, data: { message: "stopping" } };
      }

      case "shutdown": {
        // Graceful shutdown: drain in-flight tasks, flush WAL, then stop.
        const drainTimeout = (req.payload["drain_timeout"] as number | undefined) ?? 30;
        void d.gracefulShutdown(drainTimeout).finally(() => this.stopSocketServer());
        return { request_id: req.request_id, success: true, data: { message: "shutting_down" } };
      }

      case "pause": {
        await d.pause();
        return { request_id: req.request_id, success: true, data: { state: d.state } };
      }

      case "resume": {
        await d.resume();
        return { request_id: req.request_id, success: true, data: { state: d.state } };
      }

      case "decide": {
        const taskId   = req.payload["task_id"]  as string | undefined;
        const action   = req.payload["action"]   as string | undefined;
        const guidance = req.payload["guidance"] as string | undefined;
        const agentId  = req.payload["agent_id"] as string | undefined;
        const result   = req.payload["result"]   as string | undefined;

        if (taskId === undefined || action === undefined) {
          return {
            request_id: req.request_id,
            success:    false,
            data:       {},
            error:      "decide requires task_id and action",
          };
        }

        const task = d.store.get(taskId);
        if (task === null) {
          return {
            request_id: req.request_id,
            success:    false,
            data:       {},
            error:      `Task not found: ${taskId}`,
          };
        }

        const decision: import("./types.js").HumanDecision = {
          action: action as import("./types.js").HumanDecision["action"],
        };
        if (guidance !== undefined) decision.guidance     = guidance;
        if (agentId  !== undefined) decision.target_agent = agentId;
        if (result   !== undefined) decision.result       = result;

        d.escalationManager.handleHumanDecision(taskId, decision);

        return {
          request_id: req.request_id,
          success:    true,
          data:       { task_id: taskId, action },
        };
      }

      case "submit_task": {
        // Basic task submission via IPC (full impl in run.ts CLI command)
        return {
          request_id: req.request_id,
          success:    false,
          data:       {},
          error:      "submit_task not implemented via IPC in V1 — use TaskStore directly",
        };
      }

      case "daemon_status": {
        if (d.daemonManager === null) {
          return { request_id: req.request_id, success: true, data: { daemons: [] } };
        }
        const agentId = req.payload["agent_id"] as string | undefined;
        const daemons = agentId !== undefined
          ? (() => { const s = d.daemonManager!.getStatus(agentId); return s !== undefined ? [s] : []; })()
          : d.daemonManager.getAllStatuses();
        return { request_id: req.request_id, success: true, data: { daemons } };
      }

      case "daemon_start": {
        const agentId = req.payload["agent_id"] as string | undefined;
        if (agentId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "daemon_start requires agent_id" };
        }
        if (d.daemonManager === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Daemon manager not configured" };
        }
        const started = d.daemonManager.startAgent(agentId);
        if (!started) {
          return { request_id: req.request_id, success: false, data: {}, error: `Daemon already running for agent '${agentId}'` };
        }
        return { request_id: req.request_id, success: true, data: { agent_id: agentId, action: "started" } };
      }

      case "daemon_stop": {
        const agentId = req.payload["agent_id"] as string | undefined;
        if (agentId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "daemon_stop requires agent_id" };
        }
        if (d.daemonManager === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Daemon manager not configured" };
        }
        const stopped = await d.daemonManager.stopAgent(agentId);
        if (!stopped) {
          return { request_id: req.request_id, success: false, data: {}, error: `No daemon running for agent '${agentId}'` };
        }
        return { request_id: req.request_id, success: true, data: { agent_id: agentId, action: "stopped" } };
      }

      case "daemon_restart": {
        const agentId = req.payload["agent_id"] as string | undefined;
        if (agentId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "daemon_restart requires agent_id" };
        }
        if (d.daemonManager === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Daemon manager not configured" };
        }
        const restarted = await d.daemonManager.restartAgent(agentId);
        if (!restarted) {
          return { request_id: req.request_id, success: false, data: {}, error: `Agent '${agentId}' not found in registry` };
        }
        return { request_id: req.request_id, success: true, data: { agent_id: agentId, action: "restarted" } };
      }

      case "messaging_adapters": {
        if (d.messagingRegistry === null) {
          return { request_id: req.request_id, success: true, data: { adapters: [] } };
        }
        const adapters = d.messagingRegistry.getAvailableAdapters();
        return { request_id: req.request_id, success: true, data: { adapters } };
      }

      case "messaging_status": {
        if (d.messagingRegistry === null) {
          return { request_id: req.request_id, success: true, data: { instances: [] } };
        }
        const instanceId = req.payload["instance_id"] as string | undefined;
        if (instanceId !== undefined) {
          const inst = d.messagingRegistry.getInstance(instanceId);
          const instances = inst !== undefined
            ? [{ instanceId, channel: inst.channel, healthy: inst.isHealthy() }]
            : [];
          return { request_id: req.request_id, success: true, data: { instances } };
        }
        const instances = d.messagingRegistry.getAllInstances();
        return { request_id: req.request_id, success: true, data: { instances } };
      }

      case "messaging_start": {
        const instanceId = req.payload["instance_id"] as string | undefined;
        if (instanceId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "messaging_start requires instance_id" };
        }
        if (d.messagingRegistry === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        try {
          await d.messagingRegistry.startInstance(instanceId);
          return { request_id: req.request_id, success: true, data: { instance_id: instanceId, action: "started" } };
        } catch (e: unknown) {
          return { request_id: req.request_id, success: false, data: {}, error: String(e) };
        }
      }

      case "messaging_stop": {
        const instanceId = req.payload["instance_id"] as string | undefined;
        if (instanceId === undefined) {
          return { request_id: req.request_id, success: false, data: {}, error: "messaging_stop requires instance_id" };
        }
        if (d.messagingRegistry === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        try {
          await d.messagingRegistry.stopInstance(instanceId);
          return { request_id: req.request_id, success: true, data: { instance_id: instanceId, action: "stopped" } };
        } catch (e: unknown) {
          return { request_id: req.request_id, success: false, data: {}, error: String(e) };
        }
      }

      case "messaging_reload": {
        if (d.messagingGateway === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        // Stop all current instances, then restart with fresh config
        try {
          await d.messagingGateway.stop();
          if (d.messagingConfigs !== null) {
            await d.messagingGateway.start(d.messagingConfigs);
          }
          return { request_id: req.request_id, success: true, data: { reloaded: true } };
        } catch (e: unknown) {
          return { request_id: req.request_id, success: false, data: {}, error: String(e) };
        }
      }

      case "messaging_map": {
        if (d.userMappingStore === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        const { instance_id, platform_user_id, sidjua_user_id, role } = req.payload as {
          instance_id?: string; platform_user_id?: string; sidjua_user_id?: string; role?: string;
        };
        if (!instance_id || !platform_user_id || !sidjua_user_id) {
          return { request_id: req.request_id, success: false, data: {}, error: "messaging_map requires instance_id, platform_user_id, sidjua_user_id" };
        }
        const validRole = (["admin", "user", "viewer"] as const).includes(role as "admin" | "user" | "viewer")
          ? (role as "admin" | "user" | "viewer") : "user";
        await d.userMappingStore.mapUser(sidjua_user_id, instance_id, platform_user_id, validRole);
        return { request_id: req.request_id, success: true, data: { mapped: true } };
      }

      case "messaging_unmap": {
        if (d.userMappingStore === null) {
          return { request_id: req.request_id, success: false, data: {}, error: "Messaging not configured" };
        }
        const { instance_id, platform_user_id } = req.payload as {
          instance_id?: string; platform_user_id?: string;
        };
        if (!instance_id || !platform_user_id) {
          return { request_id: req.request_id, success: false, data: {}, error: "messaging_unmap requires instance_id, platform_user_id" };
        }
        await d.userMappingStore.unmapUser(instance_id, platform_user_id);
        return { request_id: req.request_id, success: true, data: { removed: true } };
      }

      case "messaging_mappings": {
        if (d.userMappingStore === null) {
          return { request_id: req.request_id, success: true, data: { mappings: [] } };
        }
        const sidjuaId = req.payload["sidjua_user_id"] as string | undefined;
        const mappings  = d.userMappingStore.listMappings(sidjuaId);
        return { request_id: req.request_id, success: true, data: { mappings } };
      }

      case "delegation_status": {
        return { request_id: req.request_id, success: true, data: { delegations: [] } };
      }

      case "delegation_history": {
        return { request_id: req.request_id, success: true, data: { delegations: [] } };
      }

      default: {
        return {
          request_id: req.request_id,
          success:    false,
          data:       {},
          error:      `Unknown command: ${(req as CLIRequest).command}`,
        };
      }
    }
  }
}
