// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9: WorkDistributor
 *
 * Selects the best agent instance for a given task.
 * Selection algorithm: tier → division → capabilities → availability → score.
 */

import type { Task } from "../tasks/types.js";
import type {
  AgentInstance,
  WorkAssignment,
  AgentLoad,
  RebalanceResult,
} from "./types.js";
import { createLogger } from "../core/logger.js";
import type { DivisionPolicy } from "../core/governance/division-policy.js";

const logger = createLogger("distributor");


export class WorkDistributor {
  /**
   * Select the best available agent for a task.
   *
   * Filters:
   *   1. Correct tier
   *   2. Division access (exact match — no "general" bypass per P270)
   *   3. Has all required capabilities (from task.metadata.capabilities_required)
   *   4. Status is not "crashed" or "restarting"
   *   5. active_task_count < max_concurrent_tasks
   *
   * Scoring (lower = better):
   *   - Idle agents preferred over busy
   *   - Fewer active tasks preferred (load balancing)
   *   - More completed tasks preferred (experience heuristic)
   *
   * Returns null if no agent available (task queued for next iteration).
   */
  assignTask(task: Task, agents: AgentInstance[]): WorkAssignment | null {
    let candidates = agents.filter((a) => this.isEligible(a, task));

    if (candidates.length === 0) {
      logger.debug("distributor", "No eligible agents for task", { metadata: {
        task_id:  task.id,
        tier:     task.tier,
        division: task.division,
        total:    agents.length,
      } });
      return null;
    }

    const alternativesConsidered = candidates.length;

    // Score candidates (lower score = better)
    const scored = candidates.map((a) => ({ agent: a, score: this.score(a) }));
    scored.sort((a, b) => a.score - b.score);
    const best = scored[0]!.agent;

    return {
      task_id:                  task.id,
      agent_id:                 best.definition.id,
      reason:                   this.assignmentReason(best),
      alternatives_considered:  alternativesConsidered,
    };
  }

  /**
   * Find a same-tier peer for consultation.
   *
   * Criteria:
   *   - Same tier as requesting agent
   *   - Different agent than requester
   *   - Not overloaded (status !== "overloaded")
   *   - Not crashed or restarting
   */
  findPeer(requestingAgentId: string, task: Task, agents: AgentInstance[]): AgentInstance | null {
    const requestingAgent = agents.find((a) => a.definition.id === requestingAgentId);
    if (requestingAgent === undefined) return null;

    const peers = agents.filter(
      (a) =>
        a.definition.id !== requestingAgentId &&
        a.definition.tier === requestingAgent.definition.tier &&
        a.status !== "crashed" &&
        a.status !== "restarting" &&
        a.status !== "overloaded" &&
        a.active_task_count < a.definition.max_concurrent_tasks,
    );

    if (peers.length === 0) return null;

    // Prefer idle peers, then lowest load
    peers.sort((a, b) => this.score(a) - this.score(b));
    return peers[0]!;
  }

  /**
   * Returns current load metrics for an agent.
   */
  getAgentLoad(agentId: string, agents: AgentInstance[]): AgentLoad | null {
    const agent = agents.find((a) => a.definition.id === agentId);
    if (agent === undefined) return null;

    return {
      agent_id:              agentId,
      active_tasks:          agent.active_task_count,
      max_tasks:             agent.definition.max_concurrent_tasks,
      utilization:           agent.active_task_count / Math.max(1, agent.definition.max_concurrent_tasks),
      tokens_used_this_hour: 0, // from AgentProcess state (read-only view here)
      cost_used_this_hour:   0,
    };
  }

  /**
   * Check all agents for load imbalance.
   * Advisory only in V1 — logs recommendation, does not auto-reassign.
   */
  rebalance(agents: AgentInstance[]): RebalanceResult {
    // Group by tier
    const byTier = new Map<number, AgentInstance[]>();
    for (const a of agents) {
      const tier = a.definition.tier;
      const list = byTier.get(tier) ?? [];
      list.push(a);
      byTier.set(tier, list);
    }

    const recommendations: RebalanceResult["recommendations"] = [];

    for (const [, tierAgents] of byTier) {
      if (tierAgents.length < 2) continue;

      const maxLoad = Math.max(...tierAgents.map((a) => a.active_task_count));
      const minLoad = Math.min(...tierAgents.map((a) => a.active_task_count));

      if (maxLoad - minLoad >= 3) {
        // Significant imbalance
        const overloaded = tierAgents.filter((a) => a.active_task_count >= maxLoad);
        const underloaded = tierAgents.filter((a) => a.active_task_count <= minLoad);

        for (const busy of overloaded) {
          for (const idle of underloaded) {
            recommendations.push({
              task_id:    "(next-available)",
              from_agent: busy.definition.id,
              to_agent:   idle.definition.id,
              reason:     `Load imbalance: ${busy.active_task_count} vs ${idle.active_task_count} active tasks`,
            });
          }
        }
      }
    }

    if (recommendations.length > 0) {
      logger.info("distributor", "Load rebalance recommendations", { metadata: { count: recommendations.length } });
    }

    return {
      imbalanced:       recommendations.length > 0,
      recommendations,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private isEligible(agent: AgentInstance, task: Task): boolean {
    // Tier
    if (agent.definition.tier !== task.tier) return false;

    // Division access: agent's division must exactly match task's division
    // The "general" bypass has been removed — hard boundary enforcement (P270)
    if (agent.definition.division !== task.division) {
      const policy = this.getCrossDivisionPolicy(agent.definition.division, task.division);
      if (policy === null || !policy.allowed) {
        logger.debug("distributor", "DIVISION_BLOCK: agent division mismatch", { metadata: {
          agent_id:  agent.definition.id,
          agent_div: agent.definition.division,
          task_div:  task.division,
          task_id:   task.id,
        } });
        return false;
      }
    }

    // Capabilities: check task.metadata.capabilities_required if present
    const required = task.metadata["capabilities_required"];
    if (Array.isArray(required)) {
      const agentCaps = new Set(agent.definition.capabilities);
      for (const cap of required) {
        if (typeof cap === "string" && !agentCaps.has(cap)) return false;
      }
    }

    // Availability
    if (agent.status === "crashed" || agent.status === "restarting") return false;
    if (agent.active_task_count >= agent.definition.max_concurrent_tasks) return false;

    return true;
  }

  /**
   * Returns a cross-division policy if one exists authorizing agentDiv to work on taskDiv.
   * V1.1: Always returns null (no cross-division policies loaded at runtime).
   * Future: will load from DivisionPolicy store.
   */
  private getCrossDivisionPolicy(
    _agentDiv: string,
    _taskDiv:  string,
  ): { allowed: boolean } | null {
    return null;
  }

  /** Lower score = better candidate. */
  private score(agent: AgentInstance): number {
    let score = 0;

    // Prefer idle agents
    if (agent.status === "idle") score -= 100;
    if (agent.status === "overloaded") score += 200;

    // Load balance: fewer active tasks is better
    score += agent.active_task_count * 10;

    // Experience: more completed tasks is better (small bonus)
    score -= Math.min(agent.total_tasks_completed, 50) * 0.1;

    return score;
  }

  private assignmentReason(agent: AgentInstance): string {
    if (agent.status === "idle") return `Agent ${agent.definition.id} is idle`;
    return `Agent ${agent.definition.id} has ${agent.active_task_count}/${agent.definition.max_concurrent_tasks} tasks`;
  }
}
