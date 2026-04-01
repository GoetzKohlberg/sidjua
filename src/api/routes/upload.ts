// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P351 — Upload API routes
 *
 *   POST /api/v1/chat/:agentId/upload   — multipart file upload
 *   GET  /api/v1/chat/:agentId/uploads  — list uploads for an agent
 *   GET  /api/v1/uploads/:uploadId      — single upload metadata
 */

import type { Hono }    from 'hono';
import { createLogger } from '../../core/logger.js';
import { requireScope } from '../middleware/require-scope.js';
import type { UploadStore }        from '../../uploads/upload-store.js';
import type { FileStorage }         from '../../uploads/file-storage.js';
import { detectMimeType }           from '../../uploads/file-storage.js';
import type { ExtractionService }   from '../../uploads/extraction-service.js';

const logger = createLogger('upload-api');

export interface UploadRouteServices {
  uploadStore:        UploadStore;
  fileStorage:        FileStorage;
  /** Optional: triggers async text extraction after upload. */
  extractionService?: ExtractionService;
  /** Optional callback: emit an SSE event after upload completes. */
  emitEvent?:         (event: Record<string, unknown>) => void;
}

export function registerUploadRoutes(app: Hono, services: UploadRouteServices): void {
  const { uploadStore, fileStorage, extractionService, emitEvent } = services;

  /**
   * POST /api/v1/chat/:agentId/upload
   * Multipart form-data with field "file"; optional "conversation_id".
   * Returns { upload_id, filename, size_bytes, mimetype, extraction_status }.
   */
  app.post('/api/v1/chat/:agentId/upload', requireScope('operator'), async (c) => {
    const agentId = c.req.param('agentId');

    try {
      const body           = await c.req.parseBody();
      const file           = body['file'];
      const conversationId = typeof body['conversation_id'] === 'string'
        ? body['conversation_id']
        : undefined;

      if (!file || typeof file === 'string') {
        return c.json({
          error: { code: 'UPLOAD-400', message: 'File required (multipart field "file")' },
        }, 400);
      }

      const arrayBuf = await (file as File).arrayBuffer();
      const buffer   = Buffer.from(arrayBuf);
      const filename = (file as File).name ?? 'upload';
      const mimetype = detectMimeType(filename);

      const validationError = fileStorage.validate(filename, mimetype, buffer.length);
      if (validationError) {
        return c.json({
          error: { code: 'UPLOAD-422', message: validationError },
        }, 422);
      }

      const filePath = fileStorage.store(agentId, filename, buffer);

      const record = uploadStore.create({
        agent_id:        agentId,
        conversation_id: conversationId,
        filename,
        mimetype,
        size_bytes:      buffer.length,
        file_path:       filePath,
      });

      if (emitEvent !== undefined) {
        emitEvent({
          type: 'upload_complete',
          data: {
            upload_id:  record.id,
            agent_id:   agentId,
            filename:   record.filename,
            size_bytes: record.size_bytes,
            mimetype:   record.mimetype,
          },
        });
      }

      logger.info('upload_complete', `Uploaded ${filename} (${buffer.length} bytes) for agent ${agentId}`, {
        metadata: { agentId, uploadId: record.id },
      });

      // Fire-and-forget: extract text asynchronously after returning the response
      if (extractionService !== undefined) {
        void extractionService.processUpload(record.id).catch((err: unknown) => {
          logger.error('extraction_trigger_failed', `Background extraction failed for ${record.id}`, {
            metadata: { error: err instanceof Error ? err.message : String(err) },
          });
        });
      }

      return c.json({
        upload_id:         record.id,
        filename:          record.filename,
        size_bytes:        record.size_bytes,
        mimetype:          record.mimetype,
        extraction_status: record.extraction_status,
      }, 201);
    } catch (err: unknown) {
      logger.error('upload_failed', 'Upload failed', {
        metadata: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({
        error: { code: 'UPLOAD-500', message: 'Upload failed' },
      }, 500);
    }
  });

  /**
   * GET /api/v1/chat/:agentId/uploads
   * Returns the most recent 50 uploads for the given agent.
   */
  app.get('/api/v1/chat/:agentId/uploads', requireScope('readonly'), (c) => {
    const agentId = c.req.param('agentId');

    const uploads = uploadStore.getByAgentId(agentId);
    return c.json({
      uploads: uploads.map((u) => ({
        id:                u.id,
        filename:          u.filename,
        size_bytes:        u.size_bytes,
        mimetype:          u.mimetype,
        extraction_status: u.extraction_status,
        embedded:          u.embedded,
        uploaded_at:       u.uploaded_at,
      })),
    });
  });

  /**
   * GET /api/v1/uploads/:uploadId
   * Returns full metadata for a single upload.
   */
  app.get('/api/v1/uploads/:uploadId', requireScope('readonly'), (c) => {
    const uploadId = c.req.param('uploadId') ?? '';
    const upload   = uploadStore.getById(uploadId);
    if (!upload) {
      return c.json({ error: { code: 'UPLOAD-404', message: 'Upload not found' } }, 404);
    }
    return c.json(upload);
  });
}
