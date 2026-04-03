// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9.5: BackpressureMonitor
 *
 * Per-agent capacity tracking and routing recommendations.
 * Entirely in-memory — no DB persistence needed.
 * Reconstructed from DB state (pipeline_queue counts) on startup.
 *
 * Decision logic:
 *   utilization < 0.8  → "accept"   (deliver immediately)
 *   utilization < 1.0  → "queue"    (queue, deliver when slot opens)
 *   utilization >= 1.0 → "redirect" (find different agent)
 *
 * Also considers queue_pressure:
 *   If agent queue > 80% of max_queue_size_per_agent → "redirect"
 *   even if utilization < 1.0 (agent is accepting but falling behind)
 */

import type { PipelineConfig, BackpressureStatus, BackpressureRecommendation } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("pipeline-backpressure");


interface AgentCapacity {
  agent_id: string;
  capacity: number;   // max_concurrent_tasks from AgentDefinition
  active:   number;   // currently running tasks
  queued:   number;   // tasks waiting in pipeline for this agent
}


export class BackpressureMonitor {
  private readonly agents = new Map<string, AgentCapacity>();

  constructor(private readonly config: PipelineConfig) {}

  // ---------------------------------------------------------------------------
  // Agent registration
  // ---------------------------------------------------------------------------

  /**
   * Register an agent with its capacity. Must be called before any other
   * operations for this agent. Idempotent.
   */
  registerAgent(agent_id: string, capacity: number): void {
    if (!this.agents.has(agent_id)) {
      this.agents.set(agent_id, { agent_id, capacity, active: 0, queued: 0 });
    }
  }

  /**
   * Initialize capacity counts from DB state (called on startup).
   */
  initFromCounts(agent_id: string, active: number, queued: number): void {
    const existing = this.agents.get(agent_id);
    if (existing !== undefined) {
      existing.active = active;
      existing.queued = queued;
    }
  }

  // ---------------------------------------------------------------------------
  // Core query
  // ---------------------------------------------------------------------------

  /**
   * Get full backpressure status for an agent.
   */
  getStatus(agent_id: string): BackpressureStatus {
    const cap = this.agents.get(agent_id);
    if (cap === undefined) {
      // Unknown agent — default conservative status
      return {
        agent_id,
        capacity:       0,
        active:         0,
        queued:         0,
        utilization:    1.0,
        queue_pressure: 1.0,
        accepting:      false,
        recommendation: "redirect",
      };
    }

    const utilization    = cap.capacity > 0 ? cap.active / cap.capacity : 1.0;
    const queue_pressure = cap.queued / this.config.max_queue_size_per_agent;
    const recommendation = this.computeRecommendation(utilization, queue_pressure);

    return {
      agent_id:       cap.agent_id,
      capacity:       cap.capacity,
      active:         cap.active,
      queued:         cap.queued,
      utilization,
      queue_pressure,
      accepting:      utilization < 1.0,
      recommendation,
    };
  }

  /**
   * Returns routing recommendation for this agent.
   */
  shouldAccept(agent_id: string): BackpressureRecommendation {
    return this.getStatus(agent_id).recommendation;
  }

  // ---------------------------------------------------------------------------
  // Capacity updates
  // ---------------------------------------------------------------------------

  /** Called when an agent accepts a task. Increments active count. */
  onTaskAccepted(agent_id: string): void {
    const cap = this.agents.get(agent_id);
    if (cap === undefined) return;
    cap.active = Math.min(cap.active + 1, cap.capacity);
    // Decrement queued count since the task moved from queued → active
    cap.queued = Math.max(0, cap.queued - 1);
    logger.debug("backpressure", "Task accepted", { metadata: {
      agent_id,
      active: cap.active,
      capacity: cap.capacity,
    } });
  }

  /** Called when a task is added to an agent's queue (not yet active). */
  onTaskQueued(agent_id: string): void {
    const cap = this.agents.get(agent_id);
    if (cap === undefined) return;
    cap.queued++;
  }

  /** Called when a task completes. Decrements active count. */
  onTaskCompleted(agent_id: string): void {
    const cap = this.agents.get(agent_id);
    if (cap === undefined) return;
    cap.active = Math.max(0, cap.active - 1);
    logger.debug("backpressure", "Task completed", { metadata: {
      agent_id,
      active: cap.active,
    } });
  }

  /** Called when a task fails. Decrements active count. */
  onTaskFailed(agent_id: string): void {
    const cap = this.agents.get(agent_id);
    if (cap === undefined) return;
    cap.active = Math.max(0, cap.active - 1);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Return agent IDs where utilization >= 1.0 or queue_pressure > 0.8.
   */
  getOverloadedAgents(): string[] {
    return [...this.agents.values()]
      .filter((cap) => {
        const util  = cap.capacity > 0 ? cap.active / cap.capacity : 1.0;
        const qp    = cap.queued / this.config.max_queue_size_per_agent;
        return util >= 1.0 || qp > 0.8;
      })
      .map((cap) => cap.agent_id);
  }

  /**
   * Return agent IDs with zero active tasks and zero queued tasks.
   * Optionally filter by tier (passed as tier metadata on AgentInstance).
   */
  getIdleAgents(agentTiers?: Map<string, number>, tier?: number): string[] {
    return [...this.agents.values()]
      .filter((cap) => {
        if (cap.active > 0 || cap.queued > 0) return false;
        if (tier !== undefined && agentTiers !== undefined) {
          return agentTiers.get(cap.agent_id) === tier;
        }
        return true;
      })
      .map((cap) => cap.agent_id);
  }

  /** Count of registered agents. */
  agentCount(): number {
    return this.agents.size;
  }

  /** Count accepting agents (utilization < 1.0). */
  acceptingCount(): number {
    return [...this.agents.values()].filter((cap) => {
      return cap.capacity > 0 && cap.active < cap.capacity;
    }).length;
  }

  /** Count agents at full capacity. */
  atCapacityCount(): number {
    return [...this.agents.values()].filter((cap) => {
      return cap.capacity > 0 && cap.active >= cap.capacity;
    }).length;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private computeRecommendation(
    utilization:    number,
    queue_pressure: number,
  ): BackpressureRecommendation {
    // Queue pressure threshold takes priority
    if (queue_pressure > 0.8) return "redirect";

    if (utilization >= 1.0)  return "redirect";
    if (utilization >= 0.8)  return "queue";
    return "accept";
  }
}
