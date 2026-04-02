// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: HybridRetriever
 * Vector (cosine top-20) + BM25/FTS5 (top-20) → RRF merge.
 */

import type { Database } from "../../utils/db.js";
import type { Embedder, RetrievalResult, RetrievalOptions, Chunk } from "../types.js";
import { logger as defaultLogger, type Logger } from "../../utils/logger.js";
import { createLogger } from "../../core/logger.js";
import type { VectorStore } from "../vector-store/vector-store.js";
import { SqliteVectorStore } from "../vector-store/sqlite-vector-store.js";

const _logger = createLogger("hybrid-retriever");

const RRF_K = 60;
const VECTOR_TOP_K = 20;
const BM25_TOP_K = 20;

interface ChunkRow {
  id: string;
  collection_id: string;
  source_file: string;
  content: string;
  token_count: number;
  position: number;
  section_path: string;
  page_number: number | null;
  preceding_context: string;
  metadata: string;
  created_at: string;
}

interface Bm25Row extends ChunkRow {
  score: number;
}

export class HybridRetriever {
  private readonly vectorStore: VectorStore;

  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
    private readonly logger: Logger = defaultLogger,
    vectorStore?: VectorStore,
  ) {
    this.vectorStore = vectorStore ?? new SqliteVectorStore(db);
  }

  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievalResult[]> {
    const topK = options.top_k ?? 5;
    const threshold = options.similarity_threshold ?? 0.0;
    const collectionIds = options.collection_ids;

    // 1. Embed query (falls back to BM25-only if embedder unavailable)
    let vectorResults: RetrievalResult[] = [];
    try {
      const [queryEmbedding] = await this.embedder.embed([query]);
      if (queryEmbedding !== undefined) {
        // 2. Vector search — apply similarity threshold here (cosine scores are 0..1)
        vectorResults = (await this._vectorSearch(queryEmbedding, collectionIds, VECTOR_TOP_K))
          .filter((r) => r.score >= threshold);
      }
    } catch (err) {
      this.logger.warn(
        "SYSTEM",
        `Vector search unavailable (${err instanceof Error ? err.message : String(err)}); falling back to BM25-only search.`,
      );
    }

    // 3. BM25 / FTS5 search
    const bm25Results = this._bm25Search(query, collectionIds, BM25_TOP_K);

    // 4. RRF merge
    const merged = this._rrfMerge(vectorResults, bm25Results);

    // 5. Return top-k (RRF scores are ~0.01–0.03 — do NOT apply cosine threshold here)
    return merged.slice(0, topK);
  }

  private async _vectorSearch(
    queryVec: Float32Array,
    collectionIds: string[] | undefined,
    topK: number,
  ): Promise<RetrievalResult[]> {
    // Determine which collections to search
    let targetCollections: string[];
    if (collectionIds !== undefined && collectionIds.length > 0) {
      targetCollections = collectionIds;
    } else {
      try {
        const rows = this.db
          .prepare<[], { id: string }>("SELECT id FROM knowledge_collections")
          .all();
        targetCollections = rows.map((r) => r.id);
      } catch (_err) {
        targetCollections = [];
      }
      if (targetCollections.length === 0) return [];
    }

    // Search each collection and collect raw hits
    const allHits: Array<{ id: string; score: number }> = [];
    for (const collId of targetCollections) {
      try {
        const hits = await this.vectorStore.search(collId, queryVec, topK);
        allHits.push(...hits);
      } catch (err) {
        _logger.debug(
          "hybrid-retriever",
          `Vector search failed for collection "${collId}"`,
          { metadata: { error: err instanceof Error ? err.message : String(err) } },
        );
      }
    }

    if (allHits.length === 0) return [];

    // Sort by score descending, take topK
    allHits.sort((a, b) => b.score - a.score);
    const topHits = allHits.slice(0, topK);

    // Fetch chunk metadata from SQLite by IDs
    const placeholders = topHits.map(() => "?").join(",");
    const chunkRows = this.db
      .prepare<string[], ChunkRow>(
        `SELECT id, collection_id, source_file, content, token_count, position,
                section_path, page_number, preceding_context, metadata, created_at
         FROM knowledge_chunks WHERE id IN (${placeholders})`,
      )
      .all(...topHits.map((h) => h.id));

    const scoreMap = new Map(topHits.map((h) => [h.id, h.score]));
    const chunkMap = new Map(chunkRows.map((r) => [r.id, r]));

    return topHits
      .filter((h) => chunkMap.has(h.id))
      .map((h) => ({
        chunk: this._rowToChunk(chunkMap.get(h.id)!),
        score: scoreMap.get(h.id) ?? 0,
      }));
  }

  private _bm25Search(
    query: string,
    collectionIds: string[] | undefined,
    topK: number,
  ): RetrievalResult[] {
    let sql = `
      SELECT kc.id, kc.collection_id, kc.source_file, kc.content,
             kc.token_count, kc.position, kc.section_path,
             kc.page_number, kc.preceding_context, kc.metadata, kc.created_at,
             bm25(knowledge_chunks_fts) AS score
      FROM knowledge_chunks_fts
      JOIN knowledge_chunks kc ON knowledge_chunks_fts.rowid = kc.rowid
      WHERE knowledge_chunks_fts MATCH ?
    `;
    const params: (string | number)[] = [this._sanitizeFtsQuery(query)];

    if (collectionIds !== undefined && collectionIds.length > 0) {
      sql += ` AND kc.collection_id IN (${collectionIds.map(() => "?").join(",")})`;
      params.push(...collectionIds);
    }
    sql += ` ORDER BY score LIMIT ?`;
    params.push(topK);

    try {
      const rows = this.db.prepare<(string | number)[], Bm25Row>(sql).all(...params);

      // BM25 scores from FTS5 are negative (lower = better match); normalize to [0,1]
      const minScore = rows.length > 0 ? Math.min(...rows.map((r) => r.score)) : 0;
      const range = minScore < 0 ? Math.abs(minScore) : 1;

      return rows.map((row) => ({
        chunk: this._rowToChunk(row),
        score: range > 0 ? (row.score - minScore) / range : 0.5,
      }));
    } catch (e: unknown) {
      _logger.debug("hybrid-retriever", "FTS search failed — falling back to vector-only results", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      return [];
    }
  }

  private _rrfMerge(
    vectorResults: RetrievalResult[],
    bm25Results: RetrievalResult[],
  ): RetrievalResult[] {
    const scores = new Map<string, { chunk: Chunk; rrfScore: number }>();

    const addRanked = (results: RetrievalResult[]) => {
      results.forEach((r, rank) => {
        const existing = scores.get(r.chunk.id);
        const rrfContrib = 1 / (RRF_K + rank + 1);
        if (existing !== undefined) {
          existing.rrfScore += rrfContrib;
        } else {
          scores.set(r.chunk.id, { chunk: r.chunk, rrfScore: rrfContrib });
        }
      });
    };

    addRanked(vectorResults);
    addRanked(bm25Results);

    return Array.from(scores.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .map(({ chunk, rrfScore }) => ({ chunk, score: rrfScore }));
  }

  private _sanitizeFtsQuery(query: string): string {
    // Escape special FTS5 characters
    return query
      .replace(/['"*()^]/g, " ")
      .trim()
      .split(/\s+/)
      .join(" AND ");
  }

  private _rowToChunk(row: ChunkRow): Chunk {
    const chunk: Chunk = {
      id: row.id,
      collection_id: row.collection_id,
      source_file: row.source_file,
      content: row.content,
      token_count: row.token_count,
      position: row.position,
      section_path: JSON.parse(row.section_path) as string[],
      preceding_context: row.preceding_context,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      created_at: row.created_at,
    };
    if (row.page_number !== null) {
      chunk.page_number = row.page_number;
    }
    return chunk;
  }
}
