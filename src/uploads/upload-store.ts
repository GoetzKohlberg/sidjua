// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P351 — UploadStore: SQLite persistence for file upload metadata.
 */

import { randomUUID } from 'node:crypto';
import Database        from 'better-sqlite3';
import { createLogger } from '../core/logger.js';

const logger = createLogger('uploads');

export interface UploadRecord {
  id:                string;
  agent_id:          string;
  conversation_id:   string | null;
  filename:          string;
  mimetype:          string;
  size_bytes:        number;
  file_path:         string;
  extracted_text:    string | null;
  extraction_status: 'pending' | 'processing' | 'done' | 'failed';
  embedded:          boolean;
  qdrant_point_ids:  string | null;
  uploaded_at:       string;
  uploaded_by:       string;
}

export interface CreateUploadInput {
  agent_id:         string;
  conversation_id?: string;
  filename:         string;
  mimetype:         string;
  size_bytes:       number;
  file_path:        string;
}

export class UploadStore {
  constructor(private readonly db: InstanceType<typeof Database>) {}

  create(input: CreateUploadInput): UploadRecord {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO uploads (id, agent_id, conversation_id, filename, mimetype, size_bytes, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.agent_id,
      input.conversation_id ?? null,
      input.filename,
      input.mimetype,
      input.size_bytes,
      input.file_path,
    );
    logger.info('upload_created', `Upload record created: ${id}`, {
      metadata: { agentId: input.agent_id, filename: input.filename },
    });
    return this.getById(id)!;
  }

  getById(id: string): UploadRecord | null {
    const row = this.db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  getByAgentId(agentId: string, limit = 50): UploadRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM uploads WHERE agent_id = ? ORDER BY uploaded_at DESC LIMIT ?`,
    ).all(agentId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  getByConversationId(conversationId: string): UploadRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM uploads WHERE conversation_id = ? ORDER BY uploaded_at ASC`,
    ).all(conversationId) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Return all uploads whose extraction_status is pending or processing. */
  getPending(): UploadRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM uploads WHERE extraction_status IN ('pending', 'processing') ORDER BY uploaded_at ASC`,
    ).all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  updateExtractionStatus(
    id: string,
    status: UploadRecord['extraction_status'],
    extractedText?: string,
  ): void {
    if (extractedText !== undefined) {
      this.db.prepare(
        `UPDATE uploads SET extraction_status = ?, extracted_text = ? WHERE id = ?`,
      ).run(status, extractedText, id);
    } else {
      this.db.prepare(
        `UPDATE uploads SET extraction_status = ? WHERE id = ?`,
      ).run(status, id);
    }
  }

  updateEmbedding(id: string, pointIds: string[]): void {
    this.db.prepare(
      `UPDATE uploads SET embedded = 1, qdrant_point_ids = ? WHERE id = ?`,
    ).run(JSON.stringify(pointIds), id);
  }

  private mapRow(row: Record<string, unknown>): UploadRecord {
    return {
      id:                row['id'] as string,
      agent_id:          row['agent_id'] as string,
      conversation_id:   (row['conversation_id'] as string | null) ?? null,
      filename:          row['filename'] as string,
      mimetype:          row['mimetype'] as string,
      size_bytes:        row['size_bytes'] as number,
      file_path:         row['file_path'] as string,
      extracted_text:    (row['extracted_text'] as string | null) ?? null,
      extraction_status: (row['extraction_status'] as UploadRecord['extraction_status']) ?? 'pending',
      embedded:          Boolean(row['embedded']),
      qdrant_point_ids:  (row['qdrant_point_ids'] as string | null) ?? null,
      uploaded_at:       row['uploaded_at'] as string,
      uploaded_by:       (row['uploaded_by'] as string) ?? 'user',
    };
  }
}
