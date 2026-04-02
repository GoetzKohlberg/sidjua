// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P356: QdrantVectorStore
 * VectorStore implementation backed by a self-hosted Qdrant instance.
 * Each SIDJUA knowledge collection maps to one Qdrant collection.
 */

import type { VectorPoint, VectorSearchResult, VectorStore } from "./vector-store.js";
import { QdrantClient } from "./qdrant-client.js";

export class QdrantVectorStore implements VectorStore {
  readonly backend = "qdrant" as const;

  constructor(private readonly client: QdrantClient) {}

  async upsert(collectionId: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    const vectorSize = points[0]!.vector.length;
    await this.client.ensureCollection(collectionId, vectorSize);
    await this.client.upsertPoints(
      collectionId,
      points.map((p) => ({ id: p.id, vector: Array.from(p.vector) })),
    );
  }

  async search(
    collectionId: string,
    queryVector: Float32Array,
    topK: number,
  ): Promise<VectorSearchResult[]> {
    const vectorSize = queryVector.length;
    await this.client.ensureCollection(collectionId, vectorSize);
    return await this.client.searchPoints(
      collectionId,
      Array.from(queryVector),
      topK,
    );
  }

  async delete(collectionId: string, chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    await this.client.deletePoints(collectionId, chunkIds);
  }
}
