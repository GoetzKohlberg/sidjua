// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: KnowledgeAction
 * Integrates knowledge retrieval with the Pre-Action Pipeline.
 * Knowledge queries are ACTIONS — audited, budgeted, governed.
 */

import type { Database } from "../../utils/db.js";
import type { AgentAccessContext, RetrievalResult, RetrievalOptions } from "../types.js";
import { ScopeChecker } from "./scope-checker.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { Reranker } from "./reranker.js";
import { MMRDiversifier } from "./mmr-diversifier.js";
import { CollectionManager } from "../collection-manager.js";
import { createLogger, type Logger } from "../../core/logger.js";

export interface KnowledgeQueryOptions extends RetrievalOptions {
  /** Target collection IDs (if specified). Otherwise query all accessible collections. */
  collection_ids?: string[];
  mmr_lambda?: number;
  similarity_threshold?: number;
}

export interface KnowledgeQueryResult {
  results: RetrievalResult[];
  collections_queried: string[];
  collections_blocked: string[];
  cost_usd: number;
}

export class KnowledgeAction {
  private readonly scopeChecker = new ScopeChecker();
  private readonly reranker = new Reranker();
  private readonly diversifier = new MMRDiversifier();

  constructor(
    private readonly db: Database,
    private readonly retriever: HybridRetriever,
    private readonly collectionManager: CollectionManager,
    private readonly logger: Logger = createLogger("knowledge-action"),
  ) {}

  async query(
    agent: AgentAccessContext,
    query: string,
    options: KnowledgeQueryOptions = {},
  ): Promise<KnowledgeQueryResult> {
    // Determine which collections to query
    let targetCollections = this.collectionManager.list();
    if (options.collection_ids !== undefined && options.collection_ids.length > 0) {
      targetCollections = targetCollections.filter((c) =>
        options.collection_ids!.includes(c.id),
      );
    }

    // Scope check
    const accessible = this.scopeChecker.filterAccessible(targetCollections, agent);
    const blockedIds = targetCollections
      .filter((c) => !accessible.some((a) => a.id === c.id))
      .map((c) => c.id);

    if (accessible.length === 0) {
      this.logger.warn("no_accessible_collections", "No accessible collections for agent", {
        metadata: { agent_id: agent.agent_id },
      });
      return {
        results: [],
        collections_queried: [],
        collections_blocked: blockedIds,
        cost_usd: 0,
      };
    }

    const accessibleIds = accessible.map((c) => c.id);

    // Run hybrid retrieval
    const retrievalOptions: RetrievalOptions = {
      top_k: 20, // retrieve more, then rerank/diversify
      collection_ids: accessibleIds,
      similarity_threshold: 0.0, // apply threshold after reranking
    };

    const rawResults = await this.retriever.retrieve(query, retrievalOptions);

    // Rerank
    const reranked = this.reranker.rerank(rawResults, {
      threshold: options.similarity_threshold ?? 0.0,
      top_k: 20,
    });

    // Diversify
    const diversified = this.diversifier.diversify(reranked, {
      lambda: options.mmr_lambda ?? 0.7,
      top_k: options.top_k ?? 5,
    });

    // Audit log
    const topScore = diversified[0]?.score ?? null;
    const now = new Date().toISOString();
    const costUsd = 0.0; // Embedding query cost negligible for V1

    for (const cid of accessibleIds) {
      try {
        this.db
          .prepare<[string, string, string, number, number | null, number, string], void>(`
          INSERT INTO knowledge_access_log
            (agent_id, collection_id, query, chunks_returned, top_score, cost_usd, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
          .run(agent.agent_id, cid, query, diversified.length, topScore, costUsd, now);
      } catch (e: unknown) {
        // Access log write is non-fatal — pipeline continues — but log for diagnosis
        const errMsg = e instanceof Error ? e.message : String(e);
        this.logger.warn("access_log_write_failed", `Access log write failed: ${errMsg}`, { metadata: { collection_id: cid } });
      }
    }

    return {
      results: diversified,
      collections_queried: accessibleIds,
      collections_blocked: blockedIds,
      cost_usd: costUsd,
    };
  }
}
