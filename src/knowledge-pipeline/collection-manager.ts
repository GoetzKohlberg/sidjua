// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: CollectionManager
 * CRUD for knowledge collections. Reindex trigger. Status transitions.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Database } from "../utils/db.js";
import type {
  KnowledgeCollection,
  CreateCollectionInput,
  CollectionConfig,
  CollectionStatus,
} from "./types.js";
import { createLogger, type Logger } from "../core/logger.js";

const _logger = createLogger("collection-manager");

interface CollectionRow {
  id: string;
  name: string;
  description: string;
  scope_json: string;
  classification: string;
  config_yaml: string;
  chunk_count: number;
  total_tokens: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export class CollectionManager {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger = createLogger("collection-manager"),
  ) {}

  create(input: CreateCollectionInput): KnowledgeCollection {
    const now = new Date().toISOString();
    const config: CollectionConfig = {
      id: input.id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      scope: input.scope,
      ingestion: {
        chunking_strategy: input.ingestion?.chunking_strategy ?? "semantic",
        chunk_size_tokens: input.ingestion?.chunk_size_tokens ?? 500,
        chunk_overlap_tokens: input.ingestion?.chunk_overlap_tokens ?? 50,
        embedding_model: input.ingestion?.embedding_model ?? "text-embedding-3-small",
        embedding_provider: input.ingestion?.embedding_provider ?? "openai",
        language: input.ingestion?.language ?? "en",
        update_policy: input.ingestion?.update_policy ?? "manual",
      },
      retrieval: {
        default_top_k: input.retrieval?.default_top_k ?? 5,
        similarity_threshold: input.retrieval?.similarity_threshold ?? 0.7,
        reranking: input.retrieval?.reranking ?? true,
        mmr_diversity: input.retrieval?.mmr_diversity ?? 0.3,
      },
    };

    const configYaml = stringifyYaml(config);
    const scopeJson = JSON.stringify(input.scope);

    this.db
      .prepare<[string, string, string, string, string, string, string, string], void>(`
      INSERT INTO knowledge_collections
        (id, name, description, scope_json, classification, config_yaml, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        input.id,
        input.name,
        input.description ?? "",
        scopeJson,
        input.scope.classification,
        configYaml,
        now,
        now,
      );

    this.logger.info("knowledge_collection_created", "Knowledge collection created", { metadata: { id: input.id } });
    return this.getById(input.id)!;
  }

  getById(id: string): KnowledgeCollection | undefined {
    const row = this.db
      .prepare<[string], CollectionRow>("SELECT * FROM knowledge_collections WHERE id = ?")
      .get(id);
    if (row === undefined) return undefined;
    return this._rowToCollection(row);
  }

  list(): KnowledgeCollection[] {
    const rows = this.db
      .prepare<[], CollectionRow>(
        "SELECT * FROM knowledge_collections ORDER BY created_at DESC",
      )
      .all();
    return rows.map((r) => this._rowToCollection(r));
  }

  updateStatus(id: string, status: CollectionStatus): void {
    const now = new Date().toISOString();
    this.db
      .prepare<[string, string, string], void>(`
      UPDATE knowledge_collections SET status = ?, updated_at = ? WHERE id = ?
    `)
      .run(status, now, id);
  }

  markForReindex(id: string): void {
    this.updateStatus(id, "needs_reindex");
  }

  delete(id: string): void {
    // Delete associated data
    this.db.transaction(() => {
      // Get all chunk IDs for this collection
      const chunks = this.db
        .prepare<[string], { id: string }>(
          "SELECT id FROM knowledge_chunks WHERE collection_id = ?",
        )
        .all(id);

      for (const chunk of chunks) {
        this.db
          .prepare<[string], void>("DELETE FROM knowledge_vectors WHERE chunk_id = ?")
          .run(chunk.id);
      }
      this.db
        .prepare<[string], void>("DELETE FROM knowledge_chunks WHERE collection_id = ?")
        .run(id);
      this.db
        .prepare<[string], void>("DELETE FROM knowledge_collections WHERE id = ?")
        .run(id);
    })();

    // Rebuild FTS
    try {
      this.db.exec("INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('rebuild')");
    } catch (e: unknown) {
      _logger.debug("collection-manager", "FTS index rebuild failed — index may be stale", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    }

    this.logger.info("knowledge_collection_deleted", "Knowledge collection deleted", { metadata: { id } });
  }

  private _rowToCollection(row: CollectionRow): KnowledgeCollection {
    const scope = JSON.parse(row.scope_json) as KnowledgeCollection["scope"];
    let config: CollectionConfig;
    try {
      config = parseYaml(row.config_yaml) as CollectionConfig;
    } catch (e: unknown) {
      _logger.warn("collection-manager", "Collection config YAML malformed — using defaults", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      config = {
        id: row.id,
        name: row.name,
        scope,
        ingestion: {
          chunking_strategy: "semantic",
          chunk_size_tokens: 500,
          chunk_overlap_tokens: 50,
          embedding_model: "text-embedding-3-small",
          embedding_provider: "openai",
        },
        retrieval: {
          default_top_k: 5,
          similarity_threshold: 0.7,
          reranking: true,
          mmr_diversity: 0.3,
        },
      };
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scope,
      config,
      chunk_count: row.chunk_count,
      total_tokens: row.total_tokens,
      status: row.status as CollectionStatus,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
