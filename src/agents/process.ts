// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 8: AgentProcess
 *
 * Spawns and manages a single agent subprocess using child_process.fork().
 * Each agent runs in isolation — a crash doesn't affect other agents or
 * the main process.
 *
 * IPC protocol:
 *   Parent → child: INIT, TASK_ASSIGNED, EVENT, PAUSE, RESUME, SHUTDOWN,
 *                   CHECKPOINT_REQUEST, STATUS_REQUEST
 *   Child → parent: HEARTBEAT, HEARTBEAT_ACK, CHECKPOINT_SAVED,
 *                   STATUS_RESPONSE, COST_UPDATE
 *
 * Subprocess entry point: agent-worker.ts (compiled: agent-worker.js)
 */

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentDefinition, AgentState, AgentIPCMessage, ProcessOptions, Checkpoint } from "./types.js";
import type { HeartbeatMonitor } from "./heartbeat.js";
import { createLogger, type Logger } from "../core/logger.js";


const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER_PATH = join(__dirname, "agent-worker.js");


export class AgentProcess {
  private child: ChildProcess | null = null;
  private readonly _messageCallbacks: Array<(msg: AgentIPCMessage) => void> = [];
  private readonly _exitCallbacks: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private _state: AgentState;

  constructor(
    private readonly definition: AgentDefinition,
    private readonly options: ProcessOptions,
    private readonly heartbeatMonitor?: HeartbeatMonitor,
    private readonly logger: Logger = createLogger("agent-process"),
  ) {
    this._state = buildInitialAgentState(definition);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Fork the agent worker subprocess and send the INIT message.
   * Resolves once the process is spawned (not when agent is ready).
   */
  async spawn(checkpoint?: Checkpoint): Promise<void> {
    if (this.child !== null && this.isAlive()) {
      throw new Error(`Agent ${this.definition.id} is already running`);
    }

    const workerPath = this.options.workerPath ?? DEFAULT_WORKER_PATH;

    const memFlag = `--max-old-space-size=${this.options.maxMemoryMB ?? 512}`;
    const execArgv = [memFlag, ...(this.options.execArgv ?? [])];

    this.child = fork(workerPath, [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      execArgv,
      silent: false,
    });

    this._state.pid = this.child.pid ?? null;
    this._state.started_at = new Date().toISOString();
    this._state.status = "IDLE";

    // Register with heartbeat monitor
    if (this.heartbeatMonitor !== undefined) {
      this.heartbeatMonitor.register(this.definition.id);
    }

    // Handle incoming messages
    this.child.on("message", (raw) => {
      const msg = raw as AgentIPCMessage;
      this._handleChildMessage(msg);
    });

    // Handle process exit
    this.child.on("exit", (code, signal) => {
      this.logger.warn("agent_subprocess_exited", "Agent subprocess exited", {
        metadata: { agent_id: this.definition.id, pid: this._state.pid, code, signal },
      });

      if (this._state.status !== "STOPPED") {
        this._state.status = "CRASHED";
      }
      this._state.pid = null;

      // Unregister from heartbeat monitor
      if (this.heartbeatMonitor !== undefined) {
        this.heartbeatMonitor.unregister(this.definition.id);
      }

      for (const cb of this._exitCallbacks) {
        cb(code, signal as NodeJS.Signals | null);
      }
    });

    // Handle errors
    this.child.on("error", (err) => {
      this.logger.error("agent_subprocess_error", "Agent subprocess error", {
        metadata: { agent_id: this.definition.id, error: err.message },
      });
      this._state.status = "CRASHED";
    });

    // Send INIT message
    const initMsg: AgentIPCMessage = checkpoint !== undefined
      ? { type: "INIT", definition: this.definition, checkpoint }
      : { type: "INIT", definition: this.definition };

    this.send(initMsg);

    this.logger.info("agent_subprocess_spawned", "Agent subprocess spawned", {
      metadata: { agent_id: this.definition.id, pid: this._state.pid, worker_path: workerPath },
    });
  }

  /**
   * Shut down the agent subprocess.
   * graceful=true: send SHUTDOWN message, wait 5s, then SIGTERM/SIGKILL.
   * graceful=false: SIGKILL immediately.
   */
  async shutdown(graceful: boolean): Promise<void> {
    if (this.child === null) return;

    this._state.status = "STOPPED";

    if (graceful) {
      this.send({ type: "SHUTDOWN", graceful: true });
      // Wait up to 5s for clean exit
      await this._waitForExit(5_000);
    }

    if (this.isAlive()) {
      this.child.kill("SIGTERM");
      await this._waitForExit(3_000);
    }

    if (this.isAlive()) {
      this.child.kill("SIGKILL");
    }

    this.logger.info("agent_subprocess_shutdown", "Agent subprocess shut down", {
      metadata: { agent_id: this.definition.id, graceful },
    });
  }

  /**
   * Restart the subprocess, optionally from a checkpoint.
   * Kills existing process first (if alive), then spawns a new one.
   */
  async restart(fromCheckpoint?: Checkpoint): Promise<void> {
    this._state.restart_count++;
    this._state.status = "RESTARTING";

    if (this.isAlive()) {
      this.child!.kill("SIGKILL");
      await this._waitForExit(3_000);
    }

    this.child = null;
    await this.spawn(fromCheckpoint);
  }

  // ---------------------------------------------------------------------------
  // Communication
  // ---------------------------------------------------------------------------

  /** Send a message to the child process via IPC. */
  send(message: AgentIPCMessage): void {
    if (this.child === null || !this.isAlive()) {
      this.logger.warn("send_message_not_alive", "Cannot send message — subprocess not alive", {
        metadata: { agent_id: this.definition.id, msg_type: message.type },
      });
      return;
    }
    this.child.send(message);
  }

  /** Register a callback for messages received from the child. */
  onMessage(callback: (message: AgentIPCMessage) => void): void {
    this._messageCallbacks.push(callback);
  }

  /** Register a callback for when the subprocess exits. */
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this._exitCallbacks.push(callback);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Returns true if the subprocess is currently running. */
  isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** Returns the subprocess PID, or null if not running. */
  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Returns the current agent state snapshot. */
  getState(): AgentState {
    return { ...this._state };
  }

  /** Update internal state from a STATUS_RESPONSE message. */
  updateFromStatus(state: AgentState): void {
    this._state = { ...state, pid: this._state.pid };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _handleChildMessage(msg: AgentIPCMessage): void {
    switch (msg.type) {
      case "HEARTBEAT":
        this._state.last_heartbeat = new Date().toISOString();
        if (this.heartbeatMonitor !== undefined) {
          this.heartbeatMonitor.recordHeartbeat(this.definition.id);
        }
        // Acknowledge
        this.send({ type: "HEARTBEAT_ACK" });
        break;

      case "STATUS_RESPONSE":
        this.updateFromStatus(msg.state);
        break;

      case "CHECKPOINT_SAVED":
        this._state.last_checkpoint = new Date().toISOString();
        break;

      case "COST_UPDATE":
        this._state.current_hour_cost += msg.cost_usd;
        this._state.total_cost_usd += msg.cost_usd;
        this._state.total_tokens_used += msg.tokens;
        break;

      default:
        break;
    }

    // Forward to all registered callbacks
    for (const cb of this._messageCallbacks) {
      cb(msg);
    }
  }

  private _waitForExit(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.isAlive()) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        resolve();
      }, timeoutMs);

      this.child!.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}


function buildInitialAgentState(definition: AgentDefinition): AgentState {
  return {
    agent_id: definition.id,
    status: "STOPPED",
    pid: null,
    started_at: null,
    last_heartbeat: null,
    last_checkpoint: null,
    active_tasks: [],
    waiting_tasks: [],
    queued_tasks: 0,
    total_tokens_used: 0,
    total_cost_usd: 0,
    restart_count: 0,
    current_hour_cost: 0,
    hour_start: new Date().toISOString(),
    error_log: [],
  };
}
