// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * list-documents — list ingested documents in the knowledge base.
 * Agent: Librarian (CKO)
 * Table: knowledge_chunks (grouped by source_file for distinct documents)
 */

import type { InternalToolDef } from "../adapters/internal-adapter.js";
import type { Database }        from "../../utils/db.js";

let _db: Database | null = null;
export function setDocumentsToolDb(db: Database): void { _db = db; }

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

export const listDocumentsTool: InternalToolDef = {
  id:          "internal-list-documents",
  name:        "list_documents",
  description: "List ingested documents and their chunks in the knowledge base",
  capabilities: [
    {
      name:              "list_docs",
      description:       "Returns list of distinct source files with chunk count, collection, and creation date",
      risk_level:        "low",
      requires_approval: false,
      input_schema: {
        type: "object",
        properties: {
          collection_id: { type: "string", description: "Filter by collection ID" },
          source_file:   { type: "string", description: "Filter by source file name (partial match)" },
          since:         { type: "string", description: "Filter by creation date (ISO)" },
          limit:         { type: "number", description: "Max results (default 50, max 200)", default: 50 },
        },
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    if (!_db) return { error: "Database not initialized" };

    try {
      if (!tableExists(_db, "knowledge_chunks")) {
        return { count: 0, documents: [], note: "knowledge_chunks table not found — run `sidjua apply`" };
      }

      const whereFilters:  string[]  = [];
      const whereValues:   unknown[] = [];
      const havingFilters: string[]  = [];
      const havingValues:  unknown[] = [];

      // Non-aggregate filters belong in WHERE (evaluated before GROUP BY).
      if (params["collection_id"]) { whereFilters.push("collection_id = ?");    whereValues.push(params["collection_id"]); }
      if (params["source_file"])   { whereFilters.push("source_file LIKE ?");   whereValues.push(`%${params["source_file"]}%`); }
      // Aggregate filter — must stay in HAVING (evaluated after GROUP BY).
      if (params["since"])         { havingFilters.push("MIN(created_at) >= ?"); havingValues.push(params["since"]); }

      const whereClause  = whereFilters.length  > 0 ? "WHERE "  + whereFilters.join(" AND ")  : "";
      const havingClause = havingFilters.length > 0 ? "HAVING " + havingFilters.join(" AND ") : "";
      const limit = Math.min(Number(params["limit"]) || 50, 200);

      const rows = _db
        .prepare(
          `SELECT source_file,
                  collection_id,
                  COUNT(*)        AS chunk_count,
                  SUM(token_count) AS total_tokens,
                  MIN(created_at) AS first_ingested
           FROM knowledge_chunks
           ${whereClause}
           GROUP BY source_file, collection_id
           ${havingClause}
           ORDER BY first_ingested DESC
           LIMIT ?`,
        )
        .all(...whereValues, ...havingValues, limit);

      return { count: rows.length, documents: rows };
    } catch (err: unknown) {
      return { error: "Query failed", detail: err instanceof Error ? err.message : String(err) };
    }
  },
};
