// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P354 — ConversationUploadTracker
 *
 * Manages upload context messages for agent conversations.
 * Data is always read live from the DB so the agent sees the latest
 * extraction status on every request — no extra wiring needed.
 */

import { createLogger }     from '../core/logger.js';
import type { UploadStore } from './upload-store.js';
import { buildUploadContext, type UploadContextMessage } from './upload-context.js';

const logger = createLogger('conv-uploads');

export class ConversationUploadTracker {
  constructor(private readonly uploadStore: UploadStore) {}

  /**
   * Get all upload context messages for a conversation.
   * Called by the chat route when assembling the agent's context window.
   */
  getUploadContextMessages(conversationId: string): UploadContextMessage[] {
    const uploads = this.uploadStore.getByConversationId(conversationId);
    logger.info('upload_context', `${uploads.length} upload(s) for conversation ${conversationId}`, {});
    return uploads.map(buildUploadContext);
  }

  /**
   * Get upload context messages for an agent when no conversation_id is set.
   * Falls back to the most-recent uploads for the agent.
   */
  getAgentUploadContextMessages(agentId: string, limit = 10): UploadContextMessage[] {
    const uploads = this.uploadStore.getByAgentId(agentId, limit);
    return uploads.map(buildUploadContext);
  }

  /**
   * Get a single upload's context message (for real-time injection).
   */
  getUploadContextMessage(uploadId: string): UploadContextMessage | null {
    const upload = this.uploadStore.getById(uploadId);
    return upload ? buildUploadContext(upload) : null;
  }
}
