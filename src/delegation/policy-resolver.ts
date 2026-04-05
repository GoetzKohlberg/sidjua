// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Delegation Bridge: Policy Resolver
 *
 * Resolves per-agent delegation policies using agent tier + division from
 * AgentRegistry and the core tier rules from DelegationEngine.
 *
 * Rules:
 *   - T1 and T2 agents may delegate to agents in same or child divisions
 *   - T3 agents cannot delegate (execution tier only)
 *   - Delegation respects tier order: may only delegate to equal or lower tier
 *     (T1→T2, T1→T3, T2→T3; T3→anything NOT allowed)
 *   - max_depth is always 1 in V1.0
 */

import type { DelegationPolicy, DelegationConfig } from "./types.js";
import { DEFAULT_DELEGATION_CONFIG } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("delegation-policy");


export interface AgentRegistryLike {
  getById(id: string): { id: string; tier: number; division: string; status: string } | undefined;
  list(filters?: { status?: string }): Array<{ id: string; tier: number; division: string; status: string }>;
}


export class DelegationPolicyResolver {
  private readonly config: DelegationConfig;

  constructor(
    private readonly agentRegistry: AgentRegistryLike,
    config: Partial<DelegationConfig> = {},
  ) {
    this.config = { ...DEFAULT_DELEGATION_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // resolvePolicy
  // ---------------------------------------------------------------------------

  /**
   * Return the DelegationPolicy for the given agent.
   *
   * T3 agents get an empty can_delegate_to list (blocked from delegating).
   * T1/T2 agents can delegate to active agents at their tier or lower.
   */
  resolvePolicy(agentId: string): DelegationPolicy {
    const agent = this.agentRegistry.getById(agentId);

    if (agent === undefined) {
      logger.warn("delegation-policy", "Agent not found — returning no-delegation policy", {
        metadata: { agent_id: agentId },
      });
      return {
        agent_id:         agentId,
        can_delegate_to:  [],
        max_subtasks:     0,
        max_depth:        this.config.max_depth,
        budget_share_max: this.config.budget_share_max,
        require_approval: this.config.require_approval,
      };
    }

    // T3 workers cannot delegate
    if (agent.tier >= 3) {
      return {
        agent_id:         agentId,
        can_delegate_to:  [],
        max_subtasks:     0,
        max_depth:        this.config.max_depth,
        budget_share_max: this.config.budget_share_max,
        require_approval: this.config.require_approval,
      };
    }

    // T1/T2 can delegate to active agents in the same division with tier >= source tier.
    // Cross-division delegation is not allowed (division isolation boundary).
    const candidates = this.agentRegistry
      .list({ status: "active" })
      .filter((a) => a.id !== agentId && a.tier >= agent.tier && a.division === agent.division);

    return {
      agent_id:         agentId,
      can_delegate_to:  candidates.map((a) => a.id),
      max_subtasks:     this.config.max_subtasks_per_task,
      max_depth:        this.config.max_depth,
      budget_share_max: this.config.budget_share_max,
      require_approval: this.config.require_approval,
    };
  }

  // ---------------------------------------------------------------------------
  // canDelegate
  // ---------------------------------------------------------------------------

  /**
   * Check whether source agent is allowed to delegate to target agent.
   *
   * Returns { allowed: true } or { allowed: false, reason: '...' }.
   */
  canDelegate(
    sourceAgentId: string,
    targetAgentId: string,
  ): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { allowed: false, reason: "delegation_disabled" };
    }

    const source = this.agentRegistry.getById(sourceAgentId);
    if (source === undefined) {
      return { allowed: false, reason: `source_agent_not_found:${sourceAgentId}` };
    }

    const target = this.agentRegistry.getById(targetAgentId);
    if (target === undefined) {
      return { allowed: false, reason: `target_agent_not_found:${targetAgentId}` };
    }

    // T3 cannot delegate
    if (source.tier >= 3) {
      return { allowed: false, reason: "source_tier_too_low" };
    }

    // Cannot delegate upward (to lower tier number = higher authority)
    if (target.tier < source.tier) {
      return { allowed: false, reason: "cannot_delegate_upward" };
    }

    // Cannot self-delegate
    if (sourceAgentId === targetAgentId) {
      return { allowed: false, reason: "cannot_self_delegate" };
    }

    logger.debug("delegation-policy", "Delegation allowed", {
      metadata: { source: sourceAgentId, target: targetAgentId, source_tier: source.tier, target_tier: target.tier },
    });

    return { allowed: true };
  }

  // ---------------------------------------------------------------------------
  // listDelegatableAgents
  // ---------------------------------------------------------------------------

  /**
   * List all agents the given agent may delegate to, filtered by division if provided.
   */
  listDelegatableAgents(
    sourceAgentId: string,
    divisionFilter?: string,
  ): Array<{ id: string; tier: number; division: string }> {
    const policy = this.resolvePolicy(sourceAgentId);

    return this.agentRegistry
      .list({ status: "active" })
      .filter((a) => policy.can_delegate_to.includes(a.id))
      .filter((a) => divisionFilter === undefined || a.division === divisionFilter)
      .map((a) => ({ id: a.id, tier: a.tier, division: a.division }));
  }
}
