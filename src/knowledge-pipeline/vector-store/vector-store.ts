// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P356: VectorStore interface
 * Abstracts over SQLite brute-force and Qdrant vector search backends.
 */

/** A single vector point to be stored. */
export interface VectorPoint {
  /** Chunk ID — used as the point identifier in the vector store. */
  id: string;
  /** Float32 embedding vector. */
  vector: Float32Array;
}

/** A search result from the vector store. */
export interface VectorSearchResult {
  /** Chunk ID that matched the query. */
  id: string;
  /** Similarity score (higher = more similar). */
  score: number;
}

/**
 * Abstraction over a vector storage and similarity search backend.
 *
 * Implementations:
 *  - SqliteVectorStore  — brute-force cosine in SQLite (default, no deps)
 *  - QdrantVectorStore  — delegates to a self-hosted Qdrant instance
 */
export interface VectorStore {
  /** Identifies the backend in use. */
  readonly backend: "sqlite" | "qdrant";

  /**
   * Upsert (insert or replace) a batch of vector points for a collection.
   * Idempotent — re-upserting the same IDs overwrites existing vectors.
   */
  upsert(collectionId: string, points: VectorPoint[]): Promise<void>;

  /**
   * Find the `topK` most similar vectors to `queryVector` in a collection.
   * Returns results sorted by descending score.
   */
  search(collectionId: string, queryVector: Float32Array, topK: number): Promise<VectorSearchResult[]>;

  /**
   * Delete specific chunk IDs from the vector store for a collection.
   * No-ops if the IDs do not exist.
   */
  delete(collectionId: string, chunkIds: string[]): Promise<void>;
}
