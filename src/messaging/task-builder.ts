// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V1.1: TaskBuilder
 *
 * Converts a MessageEnvelope into a UserTaskInput.
 * Principle: NO interpretation, NO NLP, NO classification.
 * Message text = task description, 1:1 pass-through.
 * Division is derived from channel routing config → user default → "general".
 */

import type { MessageEnvelope, UserMapping, UserTaskInput, TaskBridgeConfig } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("task-builder");


export class TaskBuilder {
  constructor(private readonly config: TaskBridgeConfig) {}

  /**
   * Build a UserTaskInput from an envelope and mapped user.
   * Message text is used verbatim as the task description.
   */
  build(envelope: MessageEnvelope, user: UserMapping): UserTaskInput {
    const division = this._getDivision(envelope, user);

    // Validate division is non-empty — tasks without a division cannot be assigned
    if (!division || division.trim() === "") {
      logger.warn("task-builder", "Task has no division — using 'general' as fallback", {
        metadata: { instance_id: envelope.instance_id, user_id: user.sidjua_user_id },
      });
    }

    logger.info("task-builder", "Building task from message", {
      metadata: {
        instance_id: envelope.instance_id,
        channel:     envelope.channel,
        chat_id:     envelope.metadata.chat_id,
        division,
        user_id:     user.sidjua_user_id,
      },
    });

    return {
      description:    envelope.content.text,
      priority:       this.config.defaults.priority,
      division,
      budget_usd:     this.config.defaults.budget_usd,
      ttl_seconds:    this.config.defaults.ttl_seconds,
      callerDivision: user.default_division ?? division,
      callerRole:     user.role,
      source_metadata: {
        source_channel:     envelope.channel,
        source_instance_id: envelope.instance_id,
        source_message_id:  envelope.id,
        source_chat_id:     envelope.metadata.chat_id,
        source_user:        user.sidjua_user_id,
        ...(envelope.content.attachments !== undefined
          ? { attachments: envelope.content.attachments }
          : {}),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve division for the task:
   *   1. Channel-specific routing from config (channel → chat_id → division)
   *   2. User's default_division from UserMapping
   *   3. Fallback: "general"
   */
  private _getDivision(envelope: MessageEnvelope, user: UserMapping): string {
    const channelRoutes = this.config.channel_routing[envelope.channel];
    if (channelRoutes !== undefined) {
      const routed = channelRoutes[envelope.metadata.chat_id];
      if (routed !== undefined) return routed;
    }
    if (user.default_division !== undefined && user.default_division !== "") {
      return user.default_division;
    }
    return "general";
  }
}
