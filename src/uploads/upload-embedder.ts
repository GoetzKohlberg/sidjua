// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P353 — UploadEmbedder: connects extracted upload text to the knowledge
 * embedding pipeline.
 *
 * After ExtractionService marks an upload as 'done', UploadEmbedder ingests
 * the extracted text into the 'uploads' knowledge collection using the
 * configured Embedder.  If no embedder is configured (embedder === null),
 * all embed calls are skipped silently.
 *
 * Storage: SQLite knowledge_chunks + knowledge_vectors (Float32Array BLOB),
 * same tables used by the knowledge pipeline — NOT Qdrant.
 * The uploads.qdrant_point_ids column stores the SQLite chunk IDs.
 */

import type { Database }     from '../utils/db.js';
import type { Embedder }     from '../knowledge-pipeline/types.js';
import type { UploadStore }  from './upload-store.js';
import { EmbeddingPipeline } from '../knowledge-pipeline/embedding/embedding-pipeline.js';
import { MarkdownParser }    from '../knowledge-pipeline/parsers/markdown-parser.js';
import { SemanticChunker }   from '../knowledge-pipeline/chunkers/semantic-chunker.js';
import { CollectionManager } from '../knowledge-pipeline/collection-manager.js';
import { runKnowledgeMigrations } from '../knowledge-pipeline/migration.js';
import { splitText }         from '../knowledge-pipeline/embedding/chunk-splitter.js';
import { createLogger }      from '../core/logger.js';

const logger = createLogger('upload-embedder');

const DEFAULT_COLLECTION_ID = 'uploads';

export interface UploadEmbedderServices {
  uploadStore: UploadStore;
  db:          Database;
  embedder:    Embedder | null;
  collectionId?: string;
  emitEvent?:  (event: Record<string, unknown>) => void;
}

export class UploadEmbedder {
  private readonly uploadStore:  UploadStore;
  private readonly db:           Database;
  private readonly embedder:     Embedder | null;
  private readonly collectionId: string;
  private readonly emitEvent:    ((event: Record<string, unknown>) => void) | undefined;

  constructor(services: UploadEmbedderServices) {
    this.uploadStore  = services.uploadStore;
    this.db           = services.db;
    this.embedder     = services.embedder;
    this.collectionId = services.collectionId ?? DEFAULT_COLLECTION_ID;
    this.emitEvent    = services.emitEvent;
  }

  /**
   * Embed extracted text from a single upload into the knowledge collection.
   * No-ops silently when: no embedder configured, upload not found, already
   * embedded, or extraction not yet complete.
   */
  async embedUpload(uploadId: string): Promise<void> {
    if (!this.embedder) {
      logger.info('embed_skip', `No embedder configured — skipping ${uploadId}`, {});
      return;
    }

    const upload = this.uploadStore.getById(uploadId);
    if (!upload) {
      logger.warn('embed_skip', `Upload ${uploadId} not found`, {});
      return;
    }

    if (upload.embedded) {
      logger.info('embed_skip', `Upload ${uploadId} already embedded`, {});
      return;
    }

    if (upload.extraction_status !== 'done' || !upload.extracted_text) {
      logger.info('embed_skip', `Upload ${uploadId} not extracted yet`, {});
      return;
    }

    try {
      // Ensure knowledge pipeline tables exist (idempotent)
      runKnowledgeMigrations(this.db);

      // Ensure the uploads collection exists
      const cm = new CollectionManager(this.db);
      if (!cm.getById(this.collectionId)) {
        cm.create({
          id:          this.collectionId,
          name:        'File Uploads',
          description: 'Extracted text from uploaded files',
          scope:       { classification: 'INTERNAL' },
          ingestion:   {
            chunking_strategy:   'semantic',
            chunk_size_tokens:   500,
            chunk_overlap_tokens: 50,
            embedding_model:     '',
            embedding_provider:  '',
          },
        });
      }

      // Use upload ID in source_file to guarantee uniqueness across uploads
      const sourceFile = `uploads/${uploadId}/${upload.filename}`;

      const pipeline = new EmbeddingPipeline(
        this.db,
        new MarkdownParser(),
        new SemanticChunker(),
        this.embedder,
      );

      const result = await pipeline.ingest(upload.extracted_text, {
        collection_id: this.collectionId,
        source_file:   sourceFile,
      });

      if (result.chunks_written === 0 && result.chunks_failed > 0) {
        throw new Error(
          `All ${result.chunks_failed} chunk(s) failed to embed for ${upload.filename}`,
        );
      }

      // Retrieve the chunk IDs we just wrote
      const chunkIds = (
        this.db
          .prepare<[string, string], { id: string }>(
            `SELECT id FROM knowledge_chunks
             WHERE collection_id = ? AND source_file = ?
             ORDER BY position ASC`,
          )
          .all(this.collectionId, sourceFile)
      ).map((r) => r.id);

      this.uploadStore.updateEmbedding(uploadId, chunkIds);

      logger.info('embed_done', `Embedded ${chunkIds.length} chunks for ${upload.filename}`, {
        metadata: { uploadId, chunkCount: chunkIds.length },
      });

      this.emitEvent?.({
        type: 'embedding_complete',
        data: {
          upload_id:   uploadId,
          agent_id:    upload.agent_id,
          filename:    upload.filename,
          chunk_count: chunkIds.length,
          status:      'done',
        },
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      logger.error('embed_failed', `Failed to embed ${upload.filename}: ${errorMsg}`, {
        metadata: { uploadId, error: errorMsg },
      });

      this.emitEvent?.({
        type: 'embedding_complete',
        data: {
          upload_id: uploadId,
          agent_id:  upload.agent_id,
          filename:  upload.filename,
          status:    'failed',
          error:     errorMsg,
        },
      });
    }
  }

  /**
   * Re-embed all uploads that have extracted text but are not yet embedded.
   * Called on boot to process uploads that completed extraction before an
   * embedder was configured.
   */
  async embedPending(): Promise<number> {
    if (!this.embedder) return 0;

    // Query uploads with extraction done but not yet embedded
    const rows = (
      this.db
        .prepare<[], { id: string }>(
          `SELECT id FROM uploads
           WHERE extraction_status = 'done'
             AND embedded = 0
             AND extracted_text IS NOT NULL
           ORDER BY uploaded_at ASC`,
        )
        .all()
    );

    for (const row of rows) {
      await this.embedUpload(row.id);
    }
    return rows.length;
  }
}

/**
 * Splits text into chunks of at most `maxChunkTokens` tokens.
 * Delegates to the knowledge pipeline's chunk-splitter so upload chunking
 * uses the same boundaries as the rest of the pipeline.
 */
export function chunkText(text: string, maxChunkTokens: number): string[] {
  return splitText(text, maxChunkTokens);
}
