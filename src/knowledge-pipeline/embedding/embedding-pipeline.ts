// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: EmbeddingPipeline
 * Orchestrates: parse → chunk → embed → store.
 * Async, batched, with progress tracking.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../../utils/db.js";
import type { Embedder, Chunker, Parser, EmbedProgress, Chunk } from "../types.js";
import { countTokens } from "../types.js";
import { createLogger, type Logger } from "../../core/logger.js";
import { chunkLimit, splitText } from "./chunk-splitter.js";
import type { MemoryWal } from "../wal/memory-wal.js";
import { checkDimensionCompatibility } from "../dimension-check.js";
import type { VectorStore, VectorPoint } from "../vector-store/vector-store.js";
import { SqliteVectorStore } from "../vector-store/sqlite-vector-store.js";

const _logger = createLogger("embedding-pipeline");

export interface EmbeddingPipelineOptions {
  collection_id: string;
  source_file: string;
  chunk_size_tokens?: number;
  chunk_overlap_tokens?: number;
  onProgress?: (progress: EmbedProgress) => void;
  /** Optional WAL for crash-safe writes. When set, each chunk write is logged
   *  as "pending" before DB write and "committed" after. */
  wal?: MemoryWal;
}

export class EmbeddingPipeline {
  private readonly vectorStore: VectorStore;

  constructor(
    private readonly db: Database,
    private readonly parser: Parser,
    private readonly chunker: Chunker,
    private readonly embedder: Embedder,
    private readonly logger: Logger = createLogger("embedding-pipeline"),
    vectorStore?: VectorStore,
  ) {
    this.vectorStore = vectorStore ?? new SqliteVectorStore(db);
  }

  async ingest(
    content: Buffer | string,
    options: EmbeddingPipelineOptions,
  ): Promise<{ chunks_written: number; tokens_total: number; chunks_failed: number }> {
    this.logger.info("ingestion_started", "Starting ingestion", {
      metadata: { collection_id: options.collection_id, source_file: options.source_file },
    });

    // Guard against dimension mismatch before any work is done
    checkDimensionCompatibility(this.db, options.collection_id, this.embedder.dimensions);

    // Parse
    const doc = await this.parser.parse(content, options.source_file);

    // Chunk
    const chunks = this.chunker.chunk(doc, {
      collection_id: options.collection_id,
      source_file: options.source_file,
      ...(options.chunk_size_tokens !== undefined
        ? { chunk_size_tokens: options.chunk_size_tokens }
        : {}),
      ...(options.chunk_overlap_tokens !== undefined
        ? { chunk_overlap_tokens: options.chunk_overlap_tokens }
        : {}),
    });

    if (chunks.length === 0) {
      this.logger.warn("no_chunks_produced", "No chunks produced", {
        metadata: { source_file: options.source_file },
      });
      return { chunks_written: 0, tokens_total: 0, chunks_failed: 0 };
    }

    // Expand chunks that exceed the embedder's token limit
    const limit = chunkLimit(this.embedder.maxTokens);
    const expandedChunks = this._expandChunks(chunks, limit);

    const progress: EmbedProgress = { total: expandedChunks.length, completed: 0, failed: 0 };
    options.onProgress?.(progress);

    // Build token-budget batches: sum(countTokens) per batch ≤ embedder.maxTokens,
    // capped at 100 chunks per call regardless.
    const batches = this._buildTokenBatches(expandedChunks, this.embedder.maxTokens, 100);

    const insertChunk = this.db.prepare<
      [string, string, string, string, number, number, string, number | null, string, string, string],
      void
    >(`
      INSERT OR REPLACE INTO knowledge_chunks
        (id, collection_id, source_file, content, token_count, position,
         section_path, page_number, preceding_context, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let tokensTotal = 0;
    let batchStart = 0;

    for (const batch of batches) {
      const i = batchStart;
      batchStart += batch.length;

      let embeddings: Float32Array[];
      try {
        embeddings = await this.embedder.embed(batch.map((c) => c.content));
      } catch (err) {
        // Batch failed — retry each chunk individually, splitting further if needed
        this.logger.warn("batch_failed_retrying", "Batch failed, retrying chunk-by-chunk", {
          metadata: {
            error: err instanceof Error ? err.message : String(err),
            batch_start: i,
            batch_size: batch.length,
          },
        });
        for (const chunk of batch) {
          const r = await this._embedWithFallbackSplit(chunk, Math.floor(limit / 2), options.wal);
          progress.completed += r.written;
          progress.failed    += r.failed;
          tokensTotal        += r.tokensAdded;
          options.onProgress?.(progress);
        }
        continue;
      }

      // Write chunks to DB in a transaction, collect vector points for upsert
      const walIds: string[] = [];
      if (options.wal) {
        for (const chunk of batch) {
          walIds.push(await options.wal.appendPending("chunk_write", chunk.collection_id, chunk.id));
        }
      }

      const points: VectorPoint[] = [];
      this.db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j]!;
          const embedding = embeddings[j]!;

          insertChunk.run(
            chunk.id,
            chunk.collection_id,
            chunk.source_file,
            chunk.content,
            chunk.token_count,
            chunk.position,
            JSON.stringify(chunk.section_path),
            chunk.page_number ?? null,
            chunk.preceding_context,
            JSON.stringify(chunk.metadata),
            chunk.created_at,
          );

          points.push({ id: chunk.id, vector: embedding });
          tokensTotal += chunk.token_count;
        }
      })();

      // Upsert vectors via the configured vector store (SQLite or Qdrant)
      await this.vectorStore.upsert(options.collection_id, points);

      if (options.wal) {
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j]!;
          await options.wal.markCommitted(walIds[j]!, "chunk_write", chunk.collection_id, chunk.id);
        }
      }

      progress.completed += batch.length;
      options.onProgress?.(progress);
    }

    // Rebuild FTS5 index for this collection
    try {
      this.db.exec(`
        INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('rebuild')
      `);
    } catch (e: unknown) {
      _logger.debug("embedding-pipeline", "FTS index rebuild failed — index may be stale", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    }

    // Update collection chunk_count and total_tokens
    this.db.prepare<[number, number, string, string], void>(`
      UPDATE knowledge_collections
      SET chunk_count = chunk_count + ?,
          total_tokens = total_tokens + ?,
          status = 'indexed',
          updated_at = ?
      WHERE id = ?
    `).run(expandedChunks.length, tokensTotal, new Date().toISOString(), options.collection_id);

    this.logger.info("ingestion_complete", "Ingestion complete", {
      metadata: {
        collection_id: options.collection_id,
        chunks_written: expandedChunks.length - progress.failed,
        tokens_total: tokensTotal,
      },
    });

    return { chunks_written: expandedChunks.length - progress.failed, tokens_total: tokensTotal, chunks_failed: progress.failed };
  }

  /**
   * Tries to embed a single chunk. On failure, splits to `fallbackLimit` and
   * retries each part individually (one API call per part). Gives up on a part
   * only if embedding still fails after splitting.
   * Returns { written, failed, tokensAdded }.
   */
  private async _embedWithFallbackSplit(
    chunk: Chunk,
    fallbackLimit: number,
    wal?: MemoryWal,
  ): Promise<{ written: number; failed: number; tokensAdded: number }> {
    // Try the chunk as-is (single-item batch)
    try {
      const [embedding] = await this.embedder.embed([chunk.content]);
      await this._writeOne(chunk, embedding!, wal);
      return { written: 1, failed: 0, tokensAdded: chunk.token_count };
    } catch (e: unknown) {
      // Single chunk failed — split further and retry each part
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger.warn("chunk_failed_splitting", `Single chunk failed (${errMsg}), splitting further`, {
        metadata: { chunk_id: chunk.id, fallback_limit: fallbackLimit },
      });
      const parts = splitText(chunk.content, fallbackLimit);
      let written = 0;
      let failed  = 0;
      let tokensAdded = 0;
      for (let idx = 0; idx < parts.length; idx++) {
        const sub: Chunk = {
          ...chunk,
          id:           randomUUID(),
          content:      parts[idx]!,
          token_count:  countTokens(parts[idx]!),
          section_path: [...chunk.section_path, `emergency${idx + 1}`],
          metadata:     {
            ...chunk.metadata,
            split_from:      chunk.id,
            split_part:      idx + 1,
            split_total:     parts.length,
            emergency_split: true,
          },
        };
        try {
          const [emb] = await this.embedder.embed([sub.content]);
          await this._writeOne(sub, emb!, wal);
          written++;
          tokensAdded += sub.token_count;
        } catch (finalErr) {
          this.logger.error("chunk_emergency_split_failed", "Chunk failed even after emergency split", {
            metadata: {
              chunk_id: sub.id,
              error: finalErr instanceof Error ? finalErr.message : String(finalErr),
            },
          });
          failed++;
        }
      }
      return { written, failed, tokensAdded };
    }
  }

  /** Writes a single chunk + embedding to the DB (no transaction — used for retry path). */
  private async _writeOne(chunk: Chunk, embedding: Float32Array, wal?: MemoryWal): Promise<void> {
    this.db.prepare<
      [string, string, string, string, number, number, string, number | null, string, string, string],
      void
    >(`INSERT OR REPLACE INTO knowledge_chunks
        (id, collection_id, source_file, content, token_count, position,
         section_path, page_number, preceding_context, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      chunk.id, chunk.collection_id, chunk.source_file, chunk.content,
      chunk.token_count, chunk.position,
      JSON.stringify(chunk.section_path),
      chunk.page_number ?? null,
      chunk.preceding_context,
      JSON.stringify(chunk.metadata),
      chunk.created_at,
    );
    const walId = wal !== undefined ? await wal.appendPending("chunk_write", chunk.collection_id, chunk.id) : undefined;
    await this.vectorStore.upsert(chunk.collection_id, [{ id: chunk.id, vector: embedding }]);
    if (walId !== undefined) await wal!.markCommitted(walId, "chunk_write", chunk.collection_id, chunk.id);
  }

  /**
   * Groups chunks into batches where the estimated token sum per batch stays
   * within maxTokens (and never exceeds maxChunks per call).
   * This prevents "total tokens in request > limit" API errors that occur when
   * many small chunks are batched together.
   */
  private _buildTokenBatches(chunks: Chunk[], maxTokens: number, maxChunks: number): Chunk[][] {
    const batches: Chunk[][] = [];
    let current: Chunk[] = [];
    let currentTokens = 0;

    for (const chunk of chunks) {
      const t = countTokens(chunk.content);
      if (current.length >= maxChunks || (current.length > 0 && currentTokens + t > maxTokens)) {
        batches.push(current);
        current = [chunk];
        currentTokens = t;
      } else {
        current.push(chunk);
        currentTokens += t;
      }
    }

    if (current.length > 0) batches.push(current);
    return batches;
  }

  /**
   * Splits chunks that exceed the embedder token limit into smaller parts.
   * Original chunks are kept as-is (ID preserved) if they fit; oversized chunks
   * get new UUIDs with a _partN suffix in their section_path metadata.
   */
  private _expandChunks(chunks: Chunk[], limit: number): Chunk[] {
    const result: Chunk[] = [];
    for (const chunk of chunks) {
      if (countTokens(chunk.content) <= limit) {
        result.push(chunk);
        continue;
      }
      const parts = splitText(chunk.content, limit);
      this.logger.info("chunk_split_for_token_limit", "Chunk split for token limit", {
        metadata: { original_id: chunk.id, parts: parts.length, limit },
      });
      parts.forEach((part, idx) => {
        result.push({
          ...chunk,
          id: randomUUID(),
          content: part,
          token_count: countTokens(part),
          section_path: [...chunk.section_path, `part${idx + 1}`],
          metadata: { ...chunk.metadata, split_from: chunk.id, split_part: idx + 1, split_total: parts.length },
        });
      });
    }
    return result;
  }
}
