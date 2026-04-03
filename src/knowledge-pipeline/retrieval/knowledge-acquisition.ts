// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: KnowledgeAcquisitionManager
 * 3-step fallback: (1) local query, (2) web search, (3) escalate.
 */

import type {
  AgentAccessContext,
  KnowledgeAcquisitionResult,
  KnowledgeAcquisitionStep,
  RetrievalResult,
} from "../types.js";
import type { KnowledgeAction } from "./knowledge-action.js";
import { createLogger, type Logger } from "../../core/logger.js";

export interface AcquisitionOptions {
  /** Minimum results from step 1 to skip step 2. Default: 1. */
  min_local_results?: number;
  /** Whether web search is available. Default: false (V1). */
  web_search_available?: boolean;
  top_k?: number;
}

export class KnowledgeAcquisitionManager {
  constructor(
    private readonly knowledgeAction: KnowledgeAction,
    private readonly logger: Logger = createLogger("knowledge-acquisition"),
  ) {}

  async acquire(
    agent: AgentAccessContext,
    query: string,
    options: AcquisitionOptions = {},
  ): Promise<KnowledgeAcquisitionResult> {
    const minLocal = options.min_local_results ?? 1;
    const webAvailable = options.web_search_available ?? false;
    const topK = options.top_k ?? 5;

    const steps: KnowledgeAcquisitionStep[] = [];
    let finalResults: RetrievalResult[] = [];

    // Step 1: Local query
    this.logger.debug("knowledge_acquisition_step1", "KnowledgeAcquisition Step 1: local query", {
      metadata: { agent_id: agent.agent_id, query },
    });

    const localResult = await this.knowledgeAction.query(agent, query, { top_k: topK });
    const step1: KnowledgeAcquisitionStep = {
      step: 1,
      type: "local_query",
      query,
      result: localResult.results,
      success: localResult.results.length >= minLocal,
    };
    steps.push(step1);

    if (localResult.results.length >= minLocal) {
      finalResults = localResult.results;
      return {
        agent_id: agent.agent_id,
        query,
        steps_attempted: steps,
        final_results: finalResults,
        escalated: false,
      };
    }

    // Step 2: Web search (if available)
    if (webAvailable) {
      this.logger.debug("knowledge_acquisition_step2", "KnowledgeAcquisition Step 2: web search", {
        metadata: { agent_id: agent.agent_id, query },
      });

      const step2: KnowledgeAcquisitionStep = {
        step: 2,
        type: "web_search",
        query,
        result: [],
        success: false,
        blocked: true,
        block_reason: "Web search tool not yet configured (Phase 10.7)",
      };
      steps.push(step2);
    }

    // Step 3: Escalate
    this.logger.info(
      "knowledge_acquisition_step3",
      "KnowledgeAcquisition Step 3: escalating to supervisor",
      {
        metadata: { agent_id: agent.agent_id, query },
      },
    );

    const step3: KnowledgeAcquisitionStep = {
      step: 3,
      type: "escalate",
      query,
      result: [],
      success: false, // Actual escalation handled by orchestrator
    };
    steps.push(step3);

    return {
      agent_id: agent.agent_id,
      query,
      steps_attempted: steps,
      final_results: [],
      escalated: true,
    };
  }
}
