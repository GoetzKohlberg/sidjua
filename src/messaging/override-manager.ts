// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V1.1: OverrideManager
 *
 * Manages the lifecycle of governance-blocked tasks that a user may override.
 *
 * Flow:
 *   1. MessageToTaskBridge calls registerBlock() when governance blocks a task
 *   2. User replies with an override phrase
 *   3. Bridge calls isOverrideResponse() to detect it
 *   4. Bridge calls processOverride() to re-submit with governance_override flag
 *   5. processOverride() validates constraints (non-overrideable, expiry, admin) and
 *      submits via executionBridge.submitTaskWithOverride()
 */

import type {
  MessageEnvelope,
  UserMapping,
  UserTaskInput,
  BlockResult,
  SubmitResult,
  PendingOverride,
  TaskBridgeConfig,
  AuditLog,
  AcceptResult,
} from "./types.js";
import type { ResponseRouter } from "./response-router.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("override-manager");


const OVERRIDE_PHRASES: ReadonlySet<string> = new Set([
  "freigabe erteilen",
  "freigabe",
  "override",
  "ich erteile freigabe",
  "genehmigt",
  "approved",
  "approve",
  "grant override",
  "confirm",
  "bestätigt",
  "ja, ausführen",
  "execute anyway",
]);


export interface ExecutionBridgeLike {
  submitTaskWithOverride(input: UserTaskInput): Promise<SubmitResult>;
}


export class OverrideManager {
  private readonly pending = new Map<string, PendingOverride>();

  constructor(
    private readonly config:          TaskBridgeConfig,
    private readonly executionBridge: ExecutionBridgeLike,
    private readonly responseRouter:  ResponseRouter,
    private readonly auditLog:        AuditLog,
  ) {}

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Store a blocked task so the user can override it within the window.
   * Overwrites any existing pending override for the same conversation context.
   */
  registerBlock(
    envelope:  MessageEnvelope,
    user:      UserMapping,
    task:      UserTaskInput,
    block:     BlockResult,
  ): void {
    if (!this.config.override.enabled) return;

    const key  = this._key(envelope);
    const now  = new Date();
    const expires = new Date(now.getTime() + this.config.override.window_seconds * 1000);

    const overrideable =
      block.overrideable &&
      !this.config.override.non_overrideable_rules.includes(block.rule);

    this.pending.set(key, {
      original_task:     task,
      original_envelope: envelope,
      block_reason:      block.reason,
      block_rule:        block.rule,
      overrideable,
      user,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });

    logger.info("override-manager", "Block registered", {
      metadata: { key, rule: block.rule, overrideable, expires_at: expires.toISOString() },
    });
  }

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the envelope text matches a known override phrase AND
   * there is a pending override for this conversation context.
   */
  isOverrideResponse(envelope: MessageEnvelope): boolean {
    const key = this._key(envelope);
    if (!this.pending.has(key)) return false;
    const normalized = envelope.content.text.toLowerCase().trim();
    return OVERRIDE_PHRASES.has(normalized);
  }

  // ---------------------------------------------------------------------------
  // Processing
  // ---------------------------------------------------------------------------

  /**
   * Process an override response:
   *   1. Validate non-overrideable rule
   *   2. Validate expiry window
   *   3. Validate admin requirement
   *   4. Re-submit task with governance_override flag
   *   5. Audit the override
   *   6. Clean up pending entry
   */
  async processOverride(envelope: MessageEnvelope, user: UserMapping): Promise<void> {
    const key      = this._key(envelope);
    const override = this.pending.get(key);
    if (override === undefined) return;

    // 1. Non-overrideable rule
    if (!override.overrideable) {
      await this.responseRouter.sendDirectMessage(
        envelope,
        `Regel "${override.block_rule}" ist nicht überschreibbar. Task bleibt blockiert.`,
      );
      this.pending.delete(key);
      return;
    }

    // 2. Expiry window
    if (new Date() >= new Date(override.expires_at)) {
      await this.responseRouter.sendDirectMessage(
        envelope,
        "Override-Fenster abgelaufen. Bitte Task erneut senden.",
      );
      this.pending.delete(key);
      return;
    }

    // 3. Admin-only override rules
    if (this.config.override.require_admin_for_override.includes(override.block_rule)) {
      if (user.role !== "admin") {
        await this.responseRouter.sendDirectMessage(
          envelope,
          `Override für Regel "${override.block_rule}" erfordert Admin-Berechtigung.`,
        );
        this.pending.delete(key);
        return;
      }
    }

    // 4. Re-submit with full governance bypass flag.
    //    bypass_all: true signals that the entire governance pipeline is skipped
    //    for this submission — this is not a rule-scoped exception but a complete
    //    override authorised by the user above.
    const taskWithOverride: UserTaskInput = {
      ...override.original_task,
      governance_override: {
        user_id:               user.sidjua_user_id,
        override_at:           new Date().toISOString(),
        original_block_reason: override.block_reason,
        original_block_rule:   override.block_rule,
        bypass_all:            true,
      },
    };

    // 5. Audit
    this.auditLog.log("USER_OVERRIDE", {
      user:             user.sidjua_user_id,
      rule:             override.block_rule,
      reason:           override.block_reason,
      task_description: override.original_task.description.slice(0, 200),
    });

    const result = await this.executionBridge.submitTaskWithOverride(taskWithOverride);

    if (!result.blocked) {
      const accepted = result as AcceptResult;
      await this.responseRouter.sendTaskAccepted(envelope, accepted.handle, true);
    }

    // 6. Clean up
    this.pending.delete(key);
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Remove all pending overrides whose window has elapsed. Returns count removed. */
  cleanupExpired(): number {
    const now = new Date();
    let cleaned = 0;
    for (const [key, override] of this.pending) {
      if (now >= new Date(override.expires_at)) {
        this.pending.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info("override-manager", "Cleaned up expired overrides", { metadata: { cleaned } });
    }
    return cleaned;
  }

  /** Number of active pending overrides. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ---------------------------------------------------------------------------
  // Key derivation
  // ---------------------------------------------------------------------------

  /**
   * Unique key per conversation context: instance_id + chat_id + platform_user_id.
   * Ensures overrides are scoped to one user in one chat on one adapter instance.
   */
  private _key(envelope: MessageEnvelope): string {
    return `${envelope.instance_id}:${envelope.metadata.chat_id}:${envelope.sender.platform_id}`;
  }
}
