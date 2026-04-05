// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13c: ExecutionBridge
 *
 * Thin glue layer that makes the existing Orchestrator (Phase 9) accessible
 * from CLI commands and REST API. Does NOT duplicate Orchestrator logic —
 * delegates entirely to existing Phase 7-9 components.
 *
 * Flow:
 *   submitTask → TaskStore.create → emitTask(TASK_CREATED) → Orchestrator picks up
 *   getTaskStatus → TaskStore + getByRoot aggregation
 *   waitForCompletion → poll TaskStore every 2 s
 *   getTaskTree → recursive TaskStore.getByParent traversal
 */

import { createLogger }    from "../core/logger.js";
import { SidjuaError }     from "../core/error-codes.js";
import { TaskStore }       from "../tasks/store.js";
import { TaskManager }     from "../tasks/task-manager.js";
import { getSanitizer }    from "../core/input-sanitizer.js";
import { TaskEventBus }    from "../tasks/event-bus.js";
import { TaskAdmissionGate } from "./task-admission-gate.js";
import type { Database }   from "../utils/db.js";
import type { Task }       from "../tasks/types.js";
import type { UserTaskInput as MessagingTaskInput, AcceptResult, SubmitResult } from "../messaging/types.js";

const logger = createLogger("execution-bridge");


export interface UserTaskInput {
  description:    string;
  priority?:      number;       // 1-10, default 5
  division?:      string;       // target division, default: "general"
  budget_tokens?: number;       // max tokens across all agents
  budget_usd?:    number;       // max USD across all agents
  ttl_seconds?:   number;       // task timeout
  /** Pin task to a specific agent ID at creation time (e.g., from webhook :agentId param). */
  assigned_agent?: string;
  /** CallerContext division — enforces cross-division isolation in the admission gate. */
  callerDivision?: string;
  /** CallerContext role — "admin" bypasses cross-division check. */
  callerRole?:     string;
}

export interface TaskHandle {
  task_id:        string;
  assigned_agent: string | null;
  assigned_tier:  number;
  status:         string;
  created_at:     string;
}

export interface TaskExecutionStatus {
  task_id:              string;
  status:               string;
  depth:                number;
  total_sub_tasks:      number;
  completed_sub_tasks:  number;
  total_tokens_used:    number;
  total_cost_usd:       number;
  elapsed_ms:           number;
  current_agent?:       string;
  current_turn?:        number;
}

export interface TaskResult {
  task_id:        string;
  status:         string;
  result_summary: string | null;
  result_file:    string | null;
  confidence:     number | null;
  total_tokens:   number;
  total_cost_usd: number;
  elapsed_ms:     number;
  error?:         string;
}

export interface TaskTreeNode {
  task_id:      string;
  title:        string;
  status:       string;
  agent?:       string;
  tier?:        number;
  turns_taken?: number;
  tokens_used?: number;
  cost_usd?:    number;
  children:     TaskTreeNode[];
}


export class ExecutionBridge {
  private readonly store:    TaskStore;
  private readonly eventBus: TaskEventBus;

  constructor(private readonly db: Database, eventBus?: TaskEventBus) {
    this.store    = new TaskStore(db);
    this.eventBus = eventBus ?? new TaskEventBus(db);
  }

  // ---------------------------------------------------------------------------
  // submitTask
  // ---------------------------------------------------------------------------

  /**
   * Submit a user task and start it through the full agent hierarchy.
   * Creates a root task in TaskStore and emits TASK_CREATED for the Orchestrator.
   */
  async submitTask(input: UserTaskInput): Promise<TaskHandle> {
    if (!input.description || input.description.trim() === "") {
      throw SidjuaError.from("EXEC-003", "description must be a non-empty string");
    }

    const tokenBudget = input.budget_tokens ?? 100_000;
    const costBudget  = input.budget_usd    ?? 10.0;

    if (tokenBudget < 0 || costBudget < 0) {
      throw SidjuaError.from("EXEC-003", "budget values must be non-negative");
    }

    const division = input.division ?? "general";
    const ttl      = input.ttl_seconds ?? 300;

    // Governance admission gate — must pass before task creation
    const gate = new TaskAdmissionGate(this.db);
    const admission = gate.admitTask({
      description: input.description,
      division,
      budget_usd:  costBudget,
      caller:      "api",
      ...(input.callerDivision !== undefined && { callerDivision: input.callerDivision }),
      ...(input.callerRole     !== undefined && { callerRole:     input.callerRole }),
    });
    if (!admission.admitted) {
      throw SidjuaError.from("EXEC-003", `Task denied by governance: ${admission.reason}`);
    }
    if (!gate.verifyAndConsumeToken(admission.token)) {
      throw SidjuaError.from("EXEC-003", "Admission token expired — please retry");
    }

    // Route through TaskManager for input sanitization
    const manager = new TaskManager(this.store, getSanitizer());
    const task = manager.createTask({
      title:        input.description.slice(0, 80),
      description:  input.description,
      division,
      type:         "root",
      tier:         1,
      token_budget: tokenBudget,
      cost_budget:  costBudget,
      ttl_seconds:  ttl,
      ...(input.assigned_agent !== undefined && { assigned_agent: input.assigned_agent }),
    });

    // Emit TASK_CREATED so the Orchestrator picks it up on its next event loop
    await this.eventBus.emitTask({
      event_type:     "TASK_CREATED",
      task_id:        task.id,
      parent_task_id: null,
      agent_from:     null,
      agent_to:       null,
      division,
      data:           { source: "execution-bridge", priority: input.priority ?? 5 },
    });

    logger.info("task_submitted", `Submitted task: ${task.id}`, {
      metadata: { task_id: task.id, division, token_budget: tokenBudget, cost_budget: costBudget },
    });

    return {
      task_id:        task.id,
      assigned_agent: task.assigned_agent,
      assigned_tier:  task.tier,
      status:         task.status,
      created_at:     task.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // getTaskStatus
  // ---------------------------------------------------------------------------

  /**
   * Get live status of a running task tree by aggregating all tasks in the tree.
   */
  async getTaskStatus(taskId: string): Promise<TaskExecutionStatus> {
    const root = this.store.get(taskId);
    if (root === null) {
      throw SidjuaError.from("EXEC-004", `Task not found: ${taskId}`);
    }

    const allTasks = this.store.getByRoot(taskId);

    const totalSubTasks     = allTasks.filter((t) => t.id !== taskId).length;
    const completedSubTasks = allTasks.filter(
      (t) => t.id !== taskId && (t.status === "DONE" || t.status === "FAILED" || t.status === "CANCELLED"),
    ).length;

    const totalTokens = allTasks.reduce((sum, t) => sum + t.token_used, 0);
    const totalCost   = allTasks.reduce((sum, t) => sum + t.cost_used,  0);

    const depth  = this._computeTreeDepth(allTasks, taskId);
    const elapsedMs = root.started_at !== null
      ? Date.now() - new Date(root.started_at).getTime()
      : 0;

    // Find currently running task (deepest RUNNING task in the tree)
    const running = allTasks.filter((t) => t.status === "RUNNING");
    const currentAgent = running.length > 0 ? running[running.length - 1]!.assigned_agent ?? undefined : undefined;

    return {
      task_id:             taskId,
      status:              root.status,
      depth,
      total_sub_tasks:     totalSubTasks,
      completed_sub_tasks: completedSubTasks,
      total_tokens_used:   totalTokens,
      total_cost_usd:      totalCost,
      elapsed_ms:          elapsedMs,
      ...(currentAgent !== undefined && { current_agent: currentAgent }),
    };
  }

  // ---------------------------------------------------------------------------
  // waitForCompletion
  // ---------------------------------------------------------------------------

  /**
   * Poll for task completion. Resolves when task reaches a terminal state.
   */
  async waitForCompletion(taskId: string, timeout_ms = 300_000): Promise<TaskResult> {
    const TERMINAL = new Set(["DONE", "FAILED", "ESCALATED", "CANCELLED"]);
    const deadline = Date.now() + timeout_ms;
    const POLL_MS  = 2_000;

    let root = this.store.get(taskId);
    if (root === null) {
      throw SidjuaError.from("EXEC-004", `Task not found: ${taskId}`);
    }

    const startedAt = root.started_at !== null
      ? new Date(root.started_at).getTime()
      : Date.now();

    while (!TERMINAL.has(root.status)) {
      if (Date.now() >= deadline) {
        const elapsed = Date.now() - startedAt;
        return {
          task_id:        taskId,
          status:         root.status,
          result_summary: root.result_summary,
          result_file:    root.result_file,
          confidence:     root.confidence,
          total_tokens:   root.token_used,
          total_cost_usd: root.cost_used,
          elapsed_ms:     elapsed,
          error:          `Timeout after ${timeout_ms}ms`,
        };
      }

      await sleep(POLL_MS);
      root = this.store.get(taskId) ?? root;
    }

    const allTasks   = this.store.getByRoot(taskId);
    const totalTokens = allTasks.reduce((s, t) => s + t.token_used, 0);
    const totalCost   = allTasks.reduce((s, t) => s + t.cost_used,  0);
    const elapsed     = root.completed_at !== null
      ? new Date(root.completed_at).getTime() - startedAt
      : Date.now() - startedAt;

    logger.info("task_completed", `Task ${taskId} reached terminal state: ${root.status}`, {
      metadata: { task_id: taskId, status: root.status, total_tokens: totalTokens, total_cost: totalCost },
    });

    return {
      task_id:        taskId,
      status:         root.status,
      result_summary: root.result_summary,
      result_file:    root.result_file,
      confidence:     root.confidence,
      total_tokens:   totalTokens,
      total_cost_usd: totalCost,
      elapsed_ms:     elapsed,
      ...(root.status !== "DONE" && { error: `Task ended with status: ${root.status}` }),
    };
  }

  // ---------------------------------------------------------------------------
  // getTaskTree
  // ---------------------------------------------------------------------------

  /**
   * Recursively build task delegation tree from TaskStore parent-child relationships.
   */
  async getTaskTree(taskId: string): Promise<TaskTreeNode> {
    const root = this.store.get(taskId);
    if (root === null) {
      throw SidjuaError.from("EXEC-004", `Task not found: ${taskId}`);
    }

    return this._buildTreeNode(root);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _buildTreeNode(task: Task): TaskTreeNode {
    const children  = this.store.getByParent(task.id);
    const metadata  = task.metadata as Record<string, unknown>;
    const turnsTaken = typeof metadata["turns_taken"] === "number"
      ? metadata["turns_taken"] as number
      : undefined;

    return {
      task_id:     task.id,
      title:       task.title,
      status:      task.status,
      tier:        task.tier,
      tokens_used: task.token_used,
      cost_usd:    task.cost_used,
      children:    children.map((c) => this._buildTreeNode(c)),
      ...(task.assigned_agent != null    && { agent:       task.assigned_agent }),
      ...(turnsTaken          !== undefined && { turns_taken: turnsTaken }),
    };
  }

  private _computeTreeDepth(tasks: Task[], rootId: string): number {
    // Build parent→children map
    const childMap = new Map<string | null, string[]>();
    for (const t of tasks) {
      const key = t.parent_id;
      if (!childMap.has(key)) childMap.set(key, []);
      childMap.get(key)!.push(t.id);
    }

    function depth(id: string): number {
      const kids = childMap.get(id) ?? [];
      if (kids.length === 0) return 0;
      return 1 + Math.max(...kids.map(depth));
    }

    return depth(rootId);
  }

  // ---------------------------------------------------------------------------
  // Messaging task submission (P222)
  // ---------------------------------------------------------------------------

  /**
   * Submit a task originating from a messaging channel.
   * Stores source_metadata and optional governance_override in the task record.
   * Returns AcceptResult with a MessagingTaskHandle on success.
   * Callers (MessageToTaskBridge) are responsible for running governance checks
   * before calling this method; submitTaskWithOverride skips that check.
   */
  async submitMessageTask(input: MessagingTaskInput): Promise<AcceptResult> {
    const tokenBudget = 100_000;
    const costBudget  = input.budget_usd ?? 10.0;
    const division    = input.division ?? "general";
    const ttl         = input.ttl_seconds ?? 300;

    // Governance admission gate — must pass before task creation
    const gate = new TaskAdmissionGate(this.db);
    const admission = gate.admitTask({
      description: input.description,
      division,
      budget_usd:  costBudget,
      caller:      "messaging",
      ...(input.callerDivision !== undefined && { callerDivision: input.callerDivision }),
      ...(input.callerRole     !== undefined && { callerRole:     input.callerRole }),
    });
    if (!admission.admitted) {
      throw SidjuaError.from("EXEC-003", `Task denied by governance: ${admission.reason}`);
    }
    if (!gate.verifyAndConsumeToken(admission.token)) {
      throw SidjuaError.from("EXEC-003", "Admission token expired — please retry");
    }

    const manager = new TaskManager(this.store, getSanitizer());
    const task = manager.createTask({
      title:              input.description.slice(0, 80),
      description:        input.description,
      division,
      type:               "root",
      tier:               1,
      token_budget:       tokenBudget,
      cost_budget:        costBudget,
      ttl_seconds:        ttl,
      priority:           input.priority,
      source_metadata:    input.source_metadata,
      ...(input.governance_override !== undefined
        ? { governance_override: input.governance_override }
        : {}),
    });

    await this.eventBus.emitTask({
      event_type:     "TASK_CREATED",
      task_id:        task.id,
      parent_task_id: null,
      agent_from:     null,
      agent_to:       null,
      division,
      data: {
        source:    "messaging",
        source_channel:  input.source_metadata.source_channel,
        source_user:     input.source_metadata.source_user,
        priority:        input.priority,
      },
    });

    logger.info("message_task_submitted", `Submitted message task: ${task.id}`, {
      metadata: {
        task_id:        task.id,
        division,
        source_channel: input.source_metadata.source_channel,
        source_user:    input.source_metadata.source_user,
      },
    });

    return {
      blocked: false,
      handle: {
        id:          task.id,
        description: input.description,
        agent_id:    task.assigned_agent,
        budget_usd:  costBudget,
        status:      task.status,
      },
    };
  }

  /**
   * Re-submit a task that was previously blocked by governance, now carrying
   * a governance_override flag. Admission gate is bypassed — the override is
   * audited via the governance_override field stored on the task record.
   */
  async submitTaskWithOverride(input: MessagingTaskInput): Promise<SubmitResult> {
    const tokenBudget = 100_000;
    const costBudget  = input.budget_usd ?? 10.0;
    const division    = input.division ?? "general";
    const ttl         = input.ttl_seconds ?? 300;

    // Admission gate deliberately skipped — caller has already obtained a governance override.
    const manager = new TaskManager(this.store, getSanitizer());
    const task = manager.createTask({
      title:           input.description.slice(0, 80),
      description:     input.description,
      division,
      type:            "root",
      tier:            1,
      token_budget:    tokenBudget,
      cost_budget:     costBudget,
      ttl_seconds:     ttl,
      priority:        input.priority,
      source_metadata: input.source_metadata,
      ...(input.governance_override !== undefined
        ? { governance_override: input.governance_override }
        : {}),
    });

    await this.eventBus.emitTask({
      event_type:     "TASK_CREATED",
      task_id:        task.id,
      parent_task_id: null,
      agent_from:     null,
      agent_to:       null,
      division,
      data: {
        source:         "messaging-override",
        source_channel: input.source_metadata.source_channel,
        source_user:    input.source_metadata.source_user,
        priority:       input.priority,
      },
    });

    logger.info("override_task_submitted", `Submitted override task: ${task.id}`, {
      metadata: {
        task_id:        task.id,
        division,
        source_channel: input.source_metadata.source_channel,
        source_user:    input.source_metadata.source_user,
      },
    });

    return {
      blocked: false,
      handle: {
        id:          task.id,
        description: input.description,
        agent_id:    task.assigned_agent,
        budget_usd:  costBudget,
        status:      task.status,
      },
    };
  }

  /**
   * Cancel a task and all its sub-tasks, enforcing division isolation.
   *
   * Callers in the same division or with role "admin" may cancel.
   * Returns the number of tasks cancelled, or throws EXEC-003 (forbidden) / EXEC-004 (not found).
   */
  async cancelTask(
    taskId: string,
    callerCtx: { division: string | undefined; role: string | undefined },
  ): Promise<{ cancelled: number }> {
    const task = this.store.get(taskId);
    if (task === null) {
      throw SidjuaError.from("EXEC-004", `Task not found: ${taskId}`);
    }

    // Division isolation: only admin or same-division callers may cancel
    if (
      callerCtx.role !== "admin" &&
      callerCtx.division !== undefined &&
      task.division !== callerCtx.division
    ) {
      logger.warn("task_cancel_cross_division", "Task cancel blocked: cross-division attempt", {
        metadata: {
          taskId,
          taskDivision:   task.division,
          callerDivision: callerCtx.division,
          callerRole:     callerCtx.role,
        },
      });
      throw SidjuaError.from(
        "EXEC-003",
        `Not allowed to cancel task in division "${task.division}" from division "${callerCtx.division}"`,
      );
    }

    const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED", "ESCALATED"]);
    const allTasks = this.store.getByRoot(taskId);
    let cancelled  = 0;

    for (const t of allTasks) {
      if (!TERMINAL.has(t.status)) {
        this.store.update(t.id, { status: "CANCELLED" });
        cancelled++;
      }
    }

    await this.eventBus.emitTask({
      event_type:     "TASK_FAILED",
      task_id:        taskId,
      parent_task_id: null,
      agent_from:     "api",
      agent_to:       null,
      division:       task.division,
      data:           { reason: "user_cancelled", cancelled_count: cancelled },
    });

    logger.info("task_cancelled", `Cancelled task ${taskId} and ${cancelled - 1} sub-tasks`, {
      metadata: { task_id: taskId, cancelled, caller_division: callerCtx.division },
    });

    return { cancelled };
  }

  /**
   * Enforce tree-level budget: stop all RUNNING tasks in the tree if exceeded.
   */
  async enforceBudget(taskId: string, budgetUsd: number): Promise<boolean> {
    const allTasks  = this.store.getByRoot(taskId);
    const totalCost = allTasks.reduce((s, t) => s + t.cost_used, 0);

    if (totalCost < budgetUsd) return false; // not exceeded

    logger.warn("budget_exhausted", `Tree budget exceeded for task ${taskId}`, {
      metadata: { task_id: taskId, total_cost: totalCost, budget: budgetUsd },
    });

    // Mark all non-terminal tasks as CANCELLED
    for (const t of allTasks) {
      if (!["DONE", "FAILED", "CANCELLED", "ESCALATED"].includes(t.status)) {
        this.store.update(t.id, { status: "CANCELLED" });
      }
    }

    await this.eventBus.emitTask({
      event_type:     "BUDGET_EXHAUSTED",
      task_id:        taskId,
      parent_task_id: null,
      agent_from:     "execution-bridge",
      agent_to:       null,
      division:       allTasks[0]?.division ?? "general",
      data:           { total_cost_usd: totalCost, budget_usd: budgetUsd },
    });

    return true;
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
