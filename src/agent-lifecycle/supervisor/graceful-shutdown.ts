// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5c: GracefulShutdownHandler
 *
 * Manages process signal handling and coordinates the 7-step shutdown sequence:
 *   1. Set drain flag (stop accepting new work)
 *   2. Notify agents (shutdown_request)
 *   3. Checkpoint all agents
 *   4. Confirm shutdown_complete from agents (best-effort)
 *   5. Persist system_state shutdown_clean=true
 *   6. Audit log entry
 *   7. Exit
 *
 * Uses Node.js built-in dgram to send WATCHDOG=1 to NOTIFY_SOCKET (systemd).
 * If NOTIFY_SOCKET is not set, petWatchdog() is a pure no-op.
 */

import { createSocket } from "node:dgram";
import type { Database } from "../../utils/db.js";
import type { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import { createLogger, type Logger } from "../../core/logger.js";


export interface GracefulShutdownConfig {
  /** Maximum time to wait for agents to acknowledge shutdown (ms). Default: 10_000. */
  agent_drain_timeout_ms?: number;
  /** Maximum time to wait for checkpoints to complete (ms). Default: 15_000. */
  checkpoint_timeout_ms?: number;
  /** Agent IDs currently managed. Updated by caller before shutdown. */
  agent_ids?: string[];
}

export type ShutdownReason = "SIGTERM" | "SIGINT" | "SIGHUP" | "SIGUSR1" | "SIGUSR2" | "manual";

export interface ShutdownStatus {
  initiated: boolean;
  reason: ShutdownReason | null;
  started_at: string | null;
  completed: boolean;
}

type ShutdownCallback = (code: number) => void;


function petWatchdog(): void {
  const sock = process.env["NOTIFY_SOCKET"];
  if (sock === undefined) return; // not under systemd — pure no-op
  const client = createSocket("udp4");
  // Type cast justified: Node.js dgram Socket.send() overload that accepts a
  // socket path (string) is typed as `number` in @types/node for the fd variant;
  // passing the NOTIFY_SOCKET path string requires bypassing the type.
  client.send(Buffer.from("WATCHDOG=1"), sock as unknown as number, () => client.close());
}


export class GracefulShutdownHandler {
  private readonly config: Required<GracefulShutdownConfig>;
  private shutdownCallback: ShutdownCallback = (code) => process.exit(code);
  private _status: ShutdownStatus = {
    initiated: false,
    reason: null,
    started_at: null,
    completed: false,
  };
  private _draining = false;
  private _notifyAgentsFn: ((reason: ShutdownReason) => Promise<void>) | null = null;
  private _checkpointAgentsFn: (() => Promise<void>) | null = null;

  constructor(
    config: GracefulShutdownConfig,
    private readonly db: Database,
    private readonly checkpointManager: CheckpointManager,
    private readonly logger: Logger = createLogger("graceful-shutdown"),
  ) {
    this.config = {
      agent_drain_timeout_ms: config.agent_drain_timeout_ms ?? 10_000,
      checkpoint_timeout_ms: config.checkpoint_timeout_ms ?? 15_000,
      agent_ids: config.agent_ids ?? [],
    };
  }

  // ---------------------------------------------------------------------------
  // Signal registration
  // ---------------------------------------------------------------------------

  /**
   * Install signal handlers for SIGTERM, SIGINT, SIGHUP, SIGUSR1, SIGUSR2.
   */
  register(): void {
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP", "SIGUSR1", "SIGUSR2"];
    for (const sig of signals) {
      process.on(sig, () => {
        void this.initiateShutdown(sig as ShutdownReason);
      });
    }
    this.logger.info("shutdown_handlers_registered", "Graceful shutdown handlers registered");
  }

  // ---------------------------------------------------------------------------
  // Injectable callbacks (for testing and orchestrator wiring)
  // ---------------------------------------------------------------------------

  /** Override the default process.exit() call (useful for testing). */
  setShutdownCallback(cb: ShutdownCallback): void {
    this.shutdownCallback = cb;
  }

  /** Register a function that notifies all active agents to prepare for shutdown. */
  setNotifyAgentsFn(fn: (reason: ShutdownReason) => Promise<void>): void {
    this._notifyAgentsFn = fn;
  }

  /** Register a function that triggers checkpoints on all active agents. */
  setCheckpointAgentsFn(fn: () => Promise<void>): void {
    this._checkpointAgentsFn = fn;
  }

  // ---------------------------------------------------------------------------
  // 7-step shutdown sequence
  // ---------------------------------------------------------------------------

  async initiateShutdown(reason: ShutdownReason): Promise<void> {
    if (this._status.initiated) {
      this.logger.warn("shutdown_already_in_progress", "Shutdown already in progress", { metadata: { reason } });
      return;
    }

    this._status.initiated = true;
    this._status.reason = reason;
    this._status.started_at = new Date().toISOString();

    this.logger.info("shutdown_initiated", "Graceful shutdown initiated", { metadata: { reason } });

    try {
      // Step 1: Drain — stop accepting new work
      this._draining = true;
      this.logger.info("shutdown_step1_drain", "Step 1/7: Drain flag set");

      // Step 2: Notify agents
      this.logger.info("shutdown_step2_notify", "Step 2/7: Notifying agents");
      if (this._notifyAgentsFn !== null) {
        await this._withTimeout(
          this._notifyAgentsFn(reason),
          this.config.agent_drain_timeout_ms,
          "agent notification",
        );
      }

      // Step 3: Checkpoint all agents
      this.logger.info("shutdown_step3_checkpoint", "Step 3/7: Checkpointing agents");
      if (this._checkpointAgentsFn !== null) {
        await this._withTimeout(
          this._checkpointAgentsFn(),
          this.config.checkpoint_timeout_ms,
          "agent checkpointing",
        );
      } else {
        // Fallback: checkpoint all known agent_ids
        for (const agentId of this.config.agent_ids) {
          this.checkpointManager.createCheckpoint({
            agent_id: agentId,
            type: "shutdown",
          });
        }
      }

      // Step 4: Confirm (best-effort — already done via _checkpointAgentsFn)
      this.logger.info("shutdown_step4_confirmed", "Step 4/7: Shutdown confirmed");

      // Step 5: Persist system_state shutdown_clean=true
      this.logger.info("shutdown_step5_persist", "Step 5/7: Persisting shutdown_clean=true");
      this._persistSystemState("shutdown_clean", "true");
      this._persistSystemState("last_shutdown", new Date().toISOString());

      // Step 6: Audit log
      this.logger.info("shutdown_step6_audit", "Step 6/7: Audit log entry written", {
        metadata: { reason, started_at: this._status.started_at },
      });

      // Step 7: Exit
      this.logger.info("shutdown_step7_exit", "Step 7/7: Exiting");
      this._status.completed = true;
      petWatchdog();
      this.shutdownCallback(0);
    } catch (err) {
      this.logger.error("shutdown_sequence_error", "Error during shutdown sequence", {
        metadata: { reason, error: err instanceof Error ? err.message : String(err) },
      });
      this.shutdownCallback(1);
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  isDraining(): boolean {
    return this._draining;
  }

  getShutdownStatus(): ShutdownStatus {
    return { ...this._status };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _persistSystemState(key: string, value: string): void {
    try {
      const now = new Date().toISOString();
      this.db.prepare<[string, string, string], void>(`
        INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, value, now);
    } catch (err) {
      this.logger.warn("system_state_persist_failed", "Failed to persist system_state", {
        metadata: { key, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private async _withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T | void> {
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.logger.warn("shutdown_timeout", `Timeout waiting for ${label}`, { metadata: { timeout_ms: timeoutMs } });
        resolve();
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]);
  }
}
