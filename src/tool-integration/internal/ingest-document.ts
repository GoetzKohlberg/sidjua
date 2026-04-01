// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * ingest-document — ingest text content into the knowledge base.
 * Agent: Librarian (CKO)
 * Risk: medium — writes to knowledge_chunks and knowledge_vectors.
 *
 * Requires an injectable ingest function wired to the knowledge pipeline.
 * The function should chunk, embed, and store the content.
 */

import type { InternalToolDef } from "../adapters/internal-adapter.js";

const MIN_CONTENT_LENGTH = 10;
const MAX_CONTENT_LENGTH = 500_000;

export interface IngestResult {
  chunkIds: string[];
}

export type IngestFn = (
  text: string,
  metadata: Record<string, string>,
) => Promise<IngestResult>;

let _ingestFn: IngestFn | null = null;
export function setIngestFn(fn: IngestFn): void { _ingestFn = fn; }

export const ingestDocumentTool: InternalToolDef = {
  id:          "internal-ingest-document",
  name:        "ingest_document",
  description: "Ingest text content into the knowledge base (chunk + embed into SQLite vectors)",
  capabilities: [
    {
      name:              "ingest",
      description:       "Chunks text and embeds into knowledge_vectors. Use for manual knowledge ingestion.",
      risk_level:        "medium",
      requires_approval: false,
      input_schema: {
        type: "object",
        properties: {
          title:   { type: "string",                     description: "Document title" },
          content: { type: "string",                     description: "Text content to ingest" },
          source:  { type: "string",                     description: "Source identifier (e.g. manual, upload, web)" },
          tags:    { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        },
        required:            ["title", "content"],
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    if (!_ingestFn) return { error: "Document ingestion pipeline not configured" };

    const title   = (params["title"]   as string) || "Untitled";
    const content = params["content"] as string;
    const source  = (params["source"]  as string) || "manual";
    const tagsRaw = params["tags"];
    const tags    = Array.isArray(tagsRaw) ? (tagsRaw as string[]).join(",") : "";

    if (!content || content.length < MIN_CONTENT_LENGTH) {
      return { error: `Content too short (min ${MIN_CONTENT_LENGTH} chars)` };
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return { error: `Content too long (max ${MAX_CONTENT_LENGTH.toLocaleString()} chars)` };
    }

    try {
      const result = await _ingestFn(content, {
        title,
        source,
        tags,
        ingested_at: new Date().toISOString(),
      });

      return {
        success:        true,
        title,
        source,
        content_length: content.length,
        chunks_created: result.chunkIds.length,
        chunk_ids:      result.chunkIds,
      };
    } catch (err: unknown) {
      return { error: "Ingestion failed", detail: err instanceof Error ? err.message : String(err) };
    }
  },
};
