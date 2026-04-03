// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * search-knowledge-base — semantic + FTS search across the knowledge base.
 * Agent: Librarian (CKO)
 *
 * Knowledge is stored in SQLite (knowledge_chunks + knowledge_vectors),
 * not in Qdrant. An injectable search function allows the pipeline to provide
 * a vector-aware hybrid search; the tool falls back to FTS-only when no
 * search function is wired in.
 */

import type { InternalToolDef } from "../adapters/internal-adapter.js";
import type { Database }        from "../../utils/db.js";
import { createLogger }         from "../../core/logger.js";

const logger = createLogger("search-knowledge-base");

export interface KnowledgeSearchResult {
  chunk_id:      string;
  collection_id: string;
  source_file:   string;
  content:       string;
  score:         number;
}

export type KnowledgeSearchFn = (
  query: string,
  collection: string | undefined,
  limit: number,
) => Promise<KnowledgeSearchResult[]>;

let _searchFn: KnowledgeSearchFn | null = null;
let _db:       Database | null          = null;

export function setKnowledgeSearchFn(fn: KnowledgeSearchFn): void { _searchFn = fn; }
export function setKnowledgeSearchDb(db: Database): void          { _db = db; }

/** Built-in FTS fallback using knowledge_chunks_fts (BM25). */
async function ftsFallback(
  query: string,
  collection: string | undefined,
  limit: number,
  db: Database,
): Promise<KnowledgeSearchResult[]> {
  const wheres = ["knowledge_chunks_fts MATCH ?"];
  const values: unknown[] = [query];
  if (collection) { wheres.push("c.collection_id = ?"); values.push(collection); }
  values.push(limit);

  try {
    const rows = db
      .prepare(
        `SELECT c.id AS chunk_id, c.collection_id, c.source_file, c.content,
                bm25(knowledge_chunks_fts) AS score
         FROM knowledge_chunks_fts
         JOIN knowledge_chunks c ON c.rowid = knowledge_chunks_fts.rowid
         WHERE ${wheres.join(" AND ")}
         ORDER BY score
         LIMIT ?`,
      )
      .all(...values) as KnowledgeSearchResult[];
    return rows;
  } catch (err) {
    logger.warn("knowledge_search", "Failed to query knowledge base", { metadata: { error: String(err) } });
    return [];
  }
}

export const searchKnowledgeBaseTool: InternalToolDef = {
  id:          "internal-search-knowledge",
  name:        "search_knowledge_base",
  description: "Semantic + FTS search across the organizational knowledge base",
  capabilities: [
    {
      name:              "search",
      description:       "Search for documents, notes, and ingested content by semantic similarity or keyword",
      risk_level:        "low",
      requires_approval: false,
      input_schema: {
        type: "object",
        properties: {
          query:      { type: "string", description: "Search query (natural language)" },
          collection: { type: "string", description: "Collection ID or name (optional — searches all)" },
          limit:      { type: "number", description: "Max results (default 10, max 50)", default: 10 },
        },
        required:            ["query"],
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    const query      = params["query"] as string;
    const collection = params["collection"] as string | undefined;
    const limit      = Math.min(Number(params["limit"]) || 10, 50);

    if (!query || query.trim().length === 0) {
      return { error: "query is required" };
    }

    try {
      let results: KnowledgeSearchResult[];

      if (_searchFn) {
        results = await _searchFn(query, collection, limit);
      } else if (_db) {
        results = await ftsFallback(query, collection, limit, _db);
      } else {
        return { error: "Knowledge base search not configured" };
      }

      return { query, collection: collection ?? "all", count: results.length, results };
    } catch (err: unknown) {
      return { error: "Search failed", detail: err instanceof Error ? err.message : String(err) };
    }
  },
};
