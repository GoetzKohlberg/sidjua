// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P356: SqliteVectorStore
 * Brute-force cosine similarity over Float32Array BLOBs stored in SQLite.
 * Extracted from HybridRetriever (Phase 10.6) into the VectorStore abstraction.
 */

import type { Database } from "../../utils/db.js";
import type { VectorPoint, VectorSearchResult, VectorStore } from "./vector-store.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("sqlite-vector-store");

/** Row count threshold above which a performance warning is emitted on search. */
const LARGE_COLLECTION_WARN_THRESHOLD = 10_000;

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export class SqliteVectorStore implements VectorStore {
  readonly backend = "sqlite" as const;

  constructor(private readonly db: Database) {}

  async upsert(collectionId: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    const stmt = this.db.prepare<[string, string, Buffer], void>(
      `INSERT OR REPLACE INTO knowledge_vectors (chunk_id, collection_id, embedding) VALUES (?, ?, ?)`,
    );
    for (const point of points) {
      stmt.run(point.id, collectionId, Buffer.from(point.vector.buffer));
    }
  }

  async search(
    collectionId: string,
    queryVector: Float32Array,
    topK: number,
  ): Promise<VectorSearchResult[]> {
    const rows = this.db
      .prepare<[string], { chunk_id: string; embedding: Buffer }>(
        `SELECT chunk_id, embedding FROM knowledge_vectors WHERE collection_id = ?`,
      )
      .all(collectionId);

    if (rows.length === 0) return [];

    if (rows.length >= LARGE_COLLECTION_WARN_THRESHOLD) {
      logger.warn("vector_search_full_scan", "Full-scan vector search over large collection — consider migrating to Qdrant", {
        metadata: { collection_id: collectionId, row_count: rows.length },
      });
    }

    const scored = rows.map((row) => ({
      id:    row.chunk_id,
      score: cosineSimilarity(queryVector, bufferToFloat32Array(row.embedding)),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async delete(collectionId: string, chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const placeholders = chunkIds.map(() => "?").join(",");
    this.db
      .prepare<string[], void>(
        `DELETE FROM knowledge_vectors WHERE collection_id = ? AND chunk_id IN (${placeholders})`,
      )
      .run(collectionId, ...chunkIds);
  }
}
