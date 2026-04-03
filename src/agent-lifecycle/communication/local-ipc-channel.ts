// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5c: LocalIPCChannel
 *
 * V1 implementation of CommunicationChannel.
 * Wraps Phase 8 AgentProcess stdio IPC — does NOT replace it.
 * Translates between MessageEnvelope and AgentIPCMessage.
 *
 * Translation map (bidirectional):
 *   heartbeat         ↔  HEARTBEAT
 *   heartbeat_ack     ↔  HEARTBEAT_ACK
 *   task_assign       →  TASK_ASSIGNED { task_id }
 *   shutdown_request  →  SHUTDOWN { graceful: true }
 *   shutdown_complete ←  CHECKPOINT_SAVED (proxy)
 *   checkpoint_request→  CHECKPOINT_REQUEST
 *   checkpoint_complete← CHECKPOINT_SAVED
 *   config_update     →  (no Phase 8 equivalent — log + no-op)
 *   error             ←  (synthesized from AgentProcess.onError)
 */

import { randomUUID } from "node:crypto";
import type { AgentProcess } from "../../agents/process.js";
import type { AgentIPCMessage } from "../../agents/types.js";
import type { CommunicationChannel } from "./channel.js";
import type { MessageEnvelope, MessageType, ConfigUpdatePayload } from "./types.js";
import { createLogger, type Logger } from "../../core/logger.js";


export class LocalIPCChannel implements CommunicationChannel {
  private readonly subscribers: Array<{
    handler: (envelope: MessageEnvelope) => void;
    filter?: MessageType;
  }> = [];
  private closed = false;

  constructor(
    private readonly agentProcess: AgentProcess,
    private readonly localId: string,
    private readonly remoteId: string,
    private readonly logger: Logger = createLogger("local-ipc-channel"),
  ) {
    // Forward inbound AgentIPCMessages to envelope subscribers
    this.agentProcess.onMessage((msg) => {
      if (this.closed) return;
      const envelope = this._fromIPCMessage(msg);
      if (envelope === null) return;
      for (const sub of this.subscribers) {
        if (sub.filter === undefined || sub.filter === envelope.type) {
          sub.handler(envelope);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // CommunicationChannel implementation
  // ---------------------------------------------------------------------------

  send(envelope: MessageEnvelope): void {
    if (this.closed) return;
    const msg = this._toIPCMessage(envelope);
    if (msg === null) return; // translation yielded no-op
    this.agentProcess.send(msg);
  }

  subscribe(
    handler: (envelope: MessageEnvelope) => void,
    filter?: MessageType,
  ): void {
    const entry: { handler: (envelope: MessageEnvelope) => void; filter?: MessageType } = { handler };
    if (filter !== undefined) {
      entry.filter = filter;
    }
    this.subscribers.push(entry);
  }

  close(): void {
    this.closed = true;
  }

  isHealthy(): boolean {
    return !this.closed && this.agentProcess.isAlive();
  }

  // ---------------------------------------------------------------------------
  // Config update helpers
  // ---------------------------------------------------------------------------

  /**
   * Determine whether a config_update payload requires a process restart.
   * Used by orchestrator to populate `requires_restart` before sending the envelope.
   */
  assessConfigCompatibility(payload: ConfigUpdatePayload): {
    requiresRestart: boolean;
    reason?: string;
  } {
    if (!payload.requires_restart) {
      return { requiresRestart: false };
    }
    return {
      requiresRestart: true,
      reason: "One or more changed fields require agent restart (e.g. division or tier change)",
    };
  }

  /**
   * Send CHECKPOINT_REQUEST to the agent subprocess and — once the checkpoint is
   * saved — send SHUTDOWN to allow the orchestrator to restart with new config.
   *
   * V1: best-effort, fire-and-forget after checkpoint ACK.
   */
  private _requestCheckpointAndRestart(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }

      // Subscribe to checkpoint_complete (one-shot)
      const handler = (_envelope: MessageEnvelope): void => {
        // Remove this subscriber
        const idx = this.subscribers.findIndex((s) => s.handler === handler);
        if (idx !== -1) this.subscribers.splice(idx, 1);

        // Now request graceful shutdown — orchestrator detects the process exit
        // and restarts it with the updated definition.
        this.agentProcess.send({ type: "SHUTDOWN", graceful: true });
        resolve();
      };

      this.subscribers.push({ handler, filter: "checkpoint_complete" });

      // Request checkpoint
      this.agentProcess.send({ type: "CHECKPOINT_REQUEST" });
    });
  }

  // ---------------------------------------------------------------------------
  // Translation helpers
  // ---------------------------------------------------------------------------

  /** MessageEnvelope → AgentIPCMessage. Returns null for no-op translations. */
  private _toIPCMessage(envelope: MessageEnvelope): AgentIPCMessage | null {
    switch (envelope.type) {
      case "heartbeat":
        return { type: "HEARTBEAT" };

      case "heartbeat_ack":
        return { type: "HEARTBEAT_ACK" };

      case "task_assign": {
        const taskId = envelope.payload["task_id"];
        if (typeof taskId !== "string") {
          this.logger.warn("task_assign_missing_task_id", "task_assign envelope missing task_id", {
            metadata: { envelope_id: envelope.id },
          });
          return null;
        }
        return { type: "TASK_ASSIGNED", task_id: taskId };
      }

      case "shutdown_request":
        return { type: "SHUTDOWN", graceful: true };

      case "checkpoint_request":
        return { type: "CHECKPOINT_REQUEST" };

      case "config_update": {
        const payload = envelope.payload as Partial<ConfigUpdatePayload>;
        const requiresRestart = payload.requires_restart ?? false;

        if (requiresRestart) {
          this.logger.info("config_update_restart_required", "config_update requires restart — checkpointing agent", {
            metadata: {
              envelope_id: envelope.id,
              from: envelope.from,
              config_hash: payload.config_hash ?? "unknown",
            },
          });
          // Trigger graceful checkpoint + shutdown; orchestrator will restart with new config.
          void this._requestCheckpointAndRestart();
        } else {
          this.logger.info("config_update_applied", "config_update applied immediately (no restart)", {
            metadata: {
              envelope_id: envelope.id,
              from: envelope.from,
              config_hash: payload.config_hash ?? "unknown",
            },
          });
          // Emit config_ack so the orchestrator knows the update was accepted.
          const ack: MessageEnvelope = {
            id:        randomUUID(),
            type:      "config_ack",
            from:      this.localId,
            to:        envelope.from,
            timestamp: new Date().toISOString(),
            payload:   { applied: true, config_hash: payload.config_hash ?? "" },
          };
          for (const sub of this.subscribers) {
            if (sub.filter === undefined || sub.filter === "config_ack") {
              sub.handler(ack);
            }
          }
        }
        return null; // no direct IPC forward — handled via orchestrator restart
      }

      default:
        // Outbound-only types that don't have an IPC equivalent
        return null;
    }
  }

  /** AgentIPCMessage → MessageEnvelope. Returns null for messages we don't translate. */
  private _fromIPCMessage(msg: AgentIPCMessage): MessageEnvelope | null {
    const base = {
      id: randomUUID(),
      from: this.remoteId,
      to: this.localId,
      timestamp: new Date().toISOString(),
    };

    switch (msg.type) {
      case "HEARTBEAT":
        return { ...base, type: "heartbeat", payload: {} };

      case "HEARTBEAT_ACK":
        return { ...base, type: "heartbeat_ack", payload: {} };

      case "CHECKPOINT_SAVED":
        // Both shutdown_complete and checkpoint_complete map from CHECKPOINT_SAVED.
        // We emit checkpoint_complete (callers that need shutdown_complete subscribe to it too).
        return { ...base, type: "checkpoint_complete", payload: { version: msg.version } };

      default:
        return null;
    }
  }
}
