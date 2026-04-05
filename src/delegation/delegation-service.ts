// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Delegation Bridge: DelegationService
 *
 * Handles the full lifecycle of an inter-agent delegation:
 *   1. Policy check (DelegationPolicyResolver)
 *   2. Budget check (parent task has enough remaining)
 *   3. Subtask creation in TaskStore with type="delegation" + parent_id
 *   4. Event emission (delegation_created)
 *   5. Tracking via in-memory map for status queries
 */

import { randomUUID } from "node:crypto";
import type { DelegationRequest, DelegationConfig } from "./types.js";
import { DEFAULT_DELEGATION_CONFIG } from "./types.js";
import type { DelegationPolicyResolver } from "./policy-resolver.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("delegation-service");


export interface TaskStoreLike {
  get(taskId: string): {
    id: string;
    root_id: string | null;
    cost_budget: number;
    cost_used: number;
    token_budget: number;
    division: string;
    tier: number;
    classification: string;
    sub_tasks_expected: number;
  } | null;
  create(input: {
    type: "delegation";
    parent_id: string;
    root_id: string;
    division: string;
    tier: 1 | 2 | 3;
    title: string;
    description: string;
    assigned_agent: string;
    priority: number;
    classification: string;
    token_budget: number;
    cost_budget: number;
    ttl_seconds: number;
    sub_tasks_expected: number;
    metadata?: Record<string, unknown>;
  }): { id: string };
  update(taskId: string, fields: { sub_tasks_expected?: number }): { id: string };
}

export interface EventBusLike {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
}

export interface AgentRegistryLike {
  getById(agentId: string): { division: string } | null | undefined;
}


export interface ActiveDelegation {
  request:        DelegationRequest;
  subtask_id:     string;
  status:         "pending" | "completed" | "failed" | "timeout";
  created_at:     string;
  completed_at?:  string;
  result_summary?: string;
  cost_usd?:      number;
}


export class DelegationService {
  /** In-memory tracking of all active delegations by subtask ID. */
  private readonly _active = new Map<string, ActiveDelegation>();

  private readonly config: DelegationConfig;
  private readonly agentRegistry: AgentRegistryLike;

  constructor(
    private readonly taskStore:       TaskStoreLike,
    private readonly eventBus:        EventBusLike,
    private readonly policyResolver:  DelegationPolicyResolver,
    agentRegistry: AgentRegistryLike,
    config: Partial<DelegationConfig> = {},
  ) {
    // Belt-and-suspenders runtime guard — division isolation cannot be enforced without a registry
    if (!agentRegistry) {
      throw new Error(
        "DelegationService requires agentRegistry — division isolation cannot be enforced without it",
      );
    }
    this.agentRegistry = agentRegistry;
    this.config = { ...DEFAULT_DELEGATION_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // delegate
  // ---------------------------------------------------------------------------

  /**
   * Create a delegated subtask from source agent to target agent.
   *
   * Returns { success: true, subtask_id } on success or { success: false, error } on failure.
   */
  async delegate(request: DelegationRequest): Promise<{
    success:    boolean;
    subtask_id?: string;
    error?:     string;
  }> {
    // 0. Self-delegation guard — an agent cannot delegate to itself
    if (request.source_agent_id === request.target_agent_id) {
      logger.warn("delegation-service", "Self-delegation rejected", {
        metadata: { agent: request.source_agent_id },
      });
      return { success: false, error: "self_delegation_not_allowed" };
    }

    // 0b. Circular delegation guard — prevent A→B→A cycles
    if (this._wouldCreateCycle(request.source_agent_id, request.target_agent_id)) {
      logger.warn("delegation-service", "Circular delegation rejected", {
        metadata: { source: request.source_agent_id, target: request.target_agent_id },
      });
      return { success: false, error: "circular_delegation_not_allowed" };
    }

    // 1. Policy check
    const check = this.policyResolver.canDelegate(
      request.source_agent_id,
      request.target_agent_id,
    );
    if (!check.allowed) {
      const reason = check.reason ?? "policy_denied";
      this.eventBus.emit("delegation_rejected", { request, reason });
      logger.warn("delegation-service", "Delegation rejected by policy", {
        metadata: { source: request.source_agent_id, target: request.target_agent_id, reason },
      });
      return { success: false, error: reason };
    }

    // 2. Depth limit — reject if the chain from root to this point already
    //    equals or exceeds the configured max_depth.
    const currentDepth = this._computeChainDepth(request.parent_task_id);
    if (currentDepth >= this.config.max_depth) {
      logger.warn("delegation-service", "Delegation depth limit exceeded", {
        metadata: {
          parent_task_id: request.parent_task_id,
          current_depth:  currentDepth,
          max_depth:      this.config.max_depth,
        },
      });
      return { success: false, error: "max_depth_exceeded" };
    }

    // 3. Load parent task for budget + division inheritance
    const parentTask = this.taskStore.get(request.parent_task_id);
    if (parentTask === null) {
      return { success: false, error: "parent_task_not_found" };
    }

    // A2: Division isolation — target agent must be in the same division as the parent task
    // agentRegistry is required (P274 A3) so this check always runs
    const targetAgent = this.agentRegistry.getById(request.target_agent_id);
    if (targetAgent != null && targetAgent.division !== parentTask.division) {
      logger.warn("delegation-service", "Delegation blocked: cross-division not allowed", {
        metadata: {
          source_division: parentTask.division,
          target_agent:    request.target_agent_id,
          target_division: targetAgent.division,
        },
      });
      return { success: false, error: "division_mismatch" };
    }

    // 4. Budget check: requested budget must not exceed allowed share of remaining parent budget
    const parentRemaining = parentTask.cost_budget - parentTask.cost_used;
    const maxAllowed      = parentRemaining * this.config.budget_share_max;
    if (request.budget_usd > maxAllowed) {
      logger.warn("delegation-service", "Delegation budget exceeds allowed share", {
        metadata: {
          requested:   request.budget_usd,
          max_allowed: maxAllowed,
          parent_remaining: parentRemaining,
        },
      });
      return { success: false, error: "insufficient_budget" };
    }

    // 5. Subtask count limit
    const existingActive = [...this._active.values()].filter(
      (d) => d.request.parent_task_id === request.parent_task_id && d.status === "pending",
    ).length;
    if (existingActive >= this.config.max_subtasks_per_task) {
      return { success: false, error: "max_subtasks_exceeded" };
    }

    // 6. Create subtask in TaskStore
    const tokenBudget = Math.floor(parentTask.token_budget * this.config.budget_share_max);
    const ttlSeconds  = this.config.default_timeout_seconds;

    const subtask = this.taskStore.create({
      type:              "delegation",
      parent_id:         request.parent_task_id,
      root_id:           parentTask.root_id ?? parentTask.id, // propagate root for nested delegations
      division:          parentTask.division,
      tier:              Math.min(parentTask.tier + 1, 3) as 1 | 2 | 3,
      title:             request.description.slice(0, 80),
      description:       request.description,
      assigned_agent:    request.target_agent_id,
      priority:          request.priority,
      classification:    parentTask.classification,
      token_budget:      tokenBudget,
      cost_budget:       request.budget_usd,
      ttl_seconds:       ttlSeconds,
      sub_tasks_expected: 0,
    });

    // 7. Update parent sub_tasks_expected counter
    this.taskStore.update(request.parent_task_id, {
      sub_tasks_expected: parentTask.sub_tasks_expected + 1,
    });

    // 8. Track in memory
    const delegation: ActiveDelegation = {
      request,
      subtask_id:  subtask.id,
      status:      "pending",
      created_at:  new Date().toISOString(),
    };
    this._active.set(subtask.id, delegation);

    // 9. Emit event
    this.eventBus.emit("delegation_created", {
      type:       "delegation_created",
      request,
      subtask_id: subtask.id,
    });

    logger.info("delegation-service", "Delegation created", {
      metadata: {
        subtask_id:       subtask.id,
        source_agent_id:  request.source_agent_id,
        target_agent_id:  request.target_agent_id,
        parent_task_id:   request.parent_task_id,
        budget_usd:       request.budget_usd,
      },
    });

    return { success: true, subtask_id: subtask.id };
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /** Get status of a specific subtask delegation. */
  getStatus(subtaskId: string): ActiveDelegation | undefined {
    return this._active.get(subtaskId);
  }

  /** Get all active (pending) delegations for a parent task. */
  getPendingByParent(parentTaskId: string): ActiveDelegation[] {
    return [...this._active.values()].filter(
      (d) => d.request.parent_task_id === parentTaskId && d.status === "pending",
    );
  }

  /** Get all delegations (any status) for display in `sidjua delegation status`. */
  getAllDelegations(): ActiveDelegation[] {
    return [...this._active.values()];
  }

  // ---------------------------------------------------------------------------
  // Result recording (called by ResultAggregator)
  // ---------------------------------------------------------------------------

  /** Mark a subtask delegation as completed. */
  markCompleted(subtaskId: string, resultSummary: string, costUsd: number): void {
    const delegation = this._active.get(subtaskId);
    if (delegation === undefined) return;

    delegation.status        = "completed";
    delegation.completed_at  = new Date().toISOString();
    delegation.result_summary = resultSummary;
    delegation.cost_usd      = costUsd;

    this.eventBus.emit("delegation_completed", {
      type: "delegation_completed",
      result: {
        subtask_id:      subtaskId,
        parent_task_id:  delegation.request.parent_task_id,
        target_agent_id: delegation.request.target_agent_id,
        status:          "completed",
        result_summary:  resultSummary,
        cost_usd:        costUsd,
        duration_ms:     0,
        completed_at:    delegation.completed_at!,
      },
    });
  }

  /** Mark a subtask delegation as failed. */
  markFailed(subtaskId: string, error: string): void {
    const delegation = this._active.get(subtaskId);
    if (delegation === undefined) return;

    delegation.status       = "failed";
    delegation.completed_at = new Date().toISOString();
    delegation.result_summary = error;

    this.eventBus.emit("delegation_failed", {
      type: "delegation_failed",
      result: {
        subtask_id:      subtaskId,
        parent_task_id:  delegation.request.parent_task_id,
        target_agent_id: delegation.request.target_agent_id,
        status:          "failed",
        result_summary:  error,
        cost_usd:        0,
        duration_ms:     0,
        completed_at:    delegation.completed_at!,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Timeout check (called from daemon heartbeat)
  // ---------------------------------------------------------------------------

  /** Mark delegations past their timeout as "timeout". Returns IDs timed out. */
  checkTimeouts(): string[] {
    const now = Date.now();
    const timedOut: string[] = [];

    for (const [subtaskId, delegation] of this._active.entries()) {
      if (delegation.status !== "pending") continue;

      const ageMs  = now - new Date(delegation.created_at).getTime();
      const limitMs = this.config.default_timeout_seconds * 1000;

      if (ageMs > limitMs) {
        delegation.status       = "timeout";
        delegation.completed_at = new Date().toISOString();
        timedOut.push(subtaskId);

        this.eventBus.emit("delegation_timeout", {
          type:           "delegation_timeout",
          subtask_id:     subtaskId,
          parent_task_id: delegation.request.parent_task_id,
        });

        logger.warn("delegation-service", "Delegation timed out", {
          metadata: {
            subtask_id: subtaskId,
            age_ms:     ageMs,
            limit_ms:   limitMs,
          },
        });
      }
    }

    return timedOut;
  }

  /** Generate unique delegation request ID. */
  static newRequestId(): string {
    return randomUUID();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true if delegating from sourceAgent to targetAgent would create
   * a cycle in the active delegation graph (A→B→A, A→B→C→A, etc.).
   *
   * Walks the in-memory active delegations from targetAgent outward: if any
   * reachable target is sourceAgent, the delegation would be circular.
   */
  private _wouldCreateCycle(sourceAgent: string, targetAgent: string): boolean {
    const visited = new Set<string>();
    const queue = [targetAgent];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === sourceAgent) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const d of this._active.values()) {
        if (d.status === "pending" && d.request.source_agent_id === current) {
          queue.push(d.request.target_agent_id);
        }
      }
    }
    return false;
  }

  /**
   * Count how many delegation hops separate parentTaskId from the root task.
   *
   * Walks the active delegation map upward: if parentTaskId is itself the
   * subtask_id of a delegation, it is one hop below its parent, and so on.
   * Stops when no matching delegation is found (reached root).
   */
  private _computeChainDepth(parentTaskId: string): number {
    let depth = 0;
    let currentId: string | null = parentTaskId;
    const seen = new Set<string>();

    while (currentId !== null && !seen.has(currentId)) {
      seen.add(currentId);
      const parentDelegation = [...this._active.values()].find(
        (d) => d.subtask_id === currentId,
      );
      if (parentDelegation === undefined) break; // reached root task
      depth++;
      currentId = parentDelegation.request.parent_task_id;
    }
    return depth;
  }

  // ---------------------------------------------------------------------------
  // P270 B4: State persistence
  // ---------------------------------------------------------------------------

  /**
   * Persist all active delegation records to SQLite.
   * Call on server shutdown so delegations survive restarts.
   */
  persistDelegations(db: import("../utils/db.js").Database): void {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS active_delegations (
          subtask_id     TEXT PRIMARY KEY,
          request        TEXT NOT NULL,
          status         TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          completed_at   TEXT,
          result_summary TEXT,
          cost_usd       REAL
        )
      `);
      const upsert = db.prepare<[string, string, string, string, string | null, string | null, number | null], void>(
        "INSERT OR REPLACE INTO active_delegations (subtask_id, request, status, created_at, completed_at, result_summary, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const run = db.transaction(() => {
        for (const [subtaskId, d] of this._active) {
          upsert.run(
            subtaskId,
            JSON.stringify(d.request),
            d.status,
            d.created_at,
            d.completed_at ?? null,
            d.result_summary ?? null,
            d.cost_usd ?? null,
          );
        }
      });
      run();
    } catch (e: unknown) {
      logger.warn("delegation-service", "persistDelegations failed — non-fatal", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  /**
   * Restore active delegation records from SQLite into the in-memory map.
   * Call on startup. Returns number of delegations restored.
   */
  restoreDelegations(db: import("../utils/db.js").Database): number {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS active_delegations (
          subtask_id     TEXT PRIMARY KEY,
          request        TEXT NOT NULL,
          status         TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          completed_at   TEXT,
          result_summary TEXT,
          cost_usd       REAL
        )
      `);
      const rows = db.prepare<[], {
        subtask_id: string; request: string; status: string; created_at: string;
        completed_at: string | null; result_summary: string | null; cost_usd: number | null;
      }>(
        "SELECT subtask_id, request, status, created_at, completed_at, result_summary, cost_usd FROM active_delegations",
      ).all();
      for (const row of rows) {
        try {
          const delegation: ActiveDelegation = {
            request:    JSON.parse(row.request) as import("./types.js").DelegationRequest,
            subtask_id: row.subtask_id,
            status:     row.status as ActiveDelegation["status"],
            created_at: row.created_at,
            ...(row.completed_at   !== null ? { completed_at:   row.completed_at }   : {}),
            ...(row.result_summary !== null ? { result_summary: row.result_summary } : {}),
            ...(row.cost_usd       !== null ? { cost_usd:       row.cost_usd }       : {}),
          };
          this._active.set(row.subtask_id, delegation);
        } catch (_e) { /* skip malformed rows */ }
      }
      return rows.length;
    } catch (e: unknown) {
      logger.warn("delegation-service", "restoreDelegations failed — starting fresh", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
      return 0;
    }
  }
}
