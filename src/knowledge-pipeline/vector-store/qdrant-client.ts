// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P356: QdrantClient
 * Thin REST client for a self-hosted Qdrant vector database.
 * Uses the native fetch() API; zero npm dependencies.
 *
 * OUTBOUND FETCH RULE exception: Qdrant is internal infrastructure
 * (self-hosted Docker container), not a user-supplied URL.
 */

export interface QdrantSearchHit {
  id: string | number;
  score: number;
}

interface QdrantSearchResponse {
  result: QdrantSearchHit[];
}

export class QdrantClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * Ensure a Qdrant collection exists. Creates it with the given vector size
   * and Cosine distance if it does not already exist. Idempotent.
   */
  async ensureCollection(name: string, vectorSize: number): Promise<void> {
    const url = `${this.baseUrl}/collections/${encodeURIComponent(name)}`;
    const checkRes = await fetch(url);
    if (checkRes.ok) return; // collection already exists
    if (checkRes.status !== 404) {
      throw new Error(
        `Qdrant: unexpected status checking collection "${name}": ${checkRes.status}`,
      );
    }
    // Create collection
    const createRes = await fetch(url, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ vectors: { size: vectorSize, distance: "Cosine" } }),
    });
    if (!createRes.ok) {
      const body = await createRes.text().catch(() => "");
      throw new Error(
        `Qdrant: failed to create collection "${name}": ${createRes.status} ${body}`,
      );
    }
  }

  /**
   * Upsert vector points into a collection.
   * Points must have a UUID `id` and a `vector` array.
   */
  async upsertPoints(
    collectionName: string,
    points: Array<{ id: string; vector: number[] }>,
  ): Promise<void> {
    if (points.length === 0) return;
    const res = await fetch(
      `${this.baseUrl}/collections/${encodeURIComponent(collectionName)}/points`,
      {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ points }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Qdrant: upsertPoints failed for "${collectionName}": ${res.status} ${body}`,
      );
    }
  }

  /**
   * Perform an ANN search in a collection.
   * Returns top-K results sorted by descending score.
   */
  async searchPoints(
    collectionName: string,
    vector: number[],
    topK: number,
  ): Promise<Array<{ id: string; score: number }>> {
    const res = await fetch(
      `${this.baseUrl}/collections/${encodeURIComponent(collectionName)}/points/search`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ vector, top: topK, with_payload: false }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Qdrant: searchPoints failed for "${collectionName}": ${res.status} ${body}`,
      );
    }
    const data = (await res.json()) as QdrantSearchResponse;
    return data.result.map((h) => ({ id: String(h.id), score: h.score }));
  }

  /**
   * Delete points by ID from a collection.
   * IDs must be UUIDs (same as chunk_id values used during upsert).
   */
  async deletePoints(collectionName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const res = await fetch(
      `${this.baseUrl}/collections/${encodeURIComponent(collectionName)}/points/delete`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ points: ids }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Qdrant: deletePoints failed for "${collectionName}": ${res.status} ${body}`,
      );
    }
  }
}
