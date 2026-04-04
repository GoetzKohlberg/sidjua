// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 7: TaskStateMachine
 *
 * Enforces valid state transitions. No task can skip states or transition
 * illegally. Every transition emits a TaskEvent and persists the change.
 *
 * Cancellation cascades to all children (recursive).
 */

import type { Task, TaskStatus, TaskEventType, TransitionContext } from "./types.js";
import type { TaskStore } from "./store.js";
import type { TaskEventBus } from "./event-bus.js";
import { getMetrics } from "../core/metrics/index.js";


const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  CREATED:   ["PENDING", "CANCELLED"],
  PENDING:   ["ASSIGNED", "CANCELLED"],
  ASSIGNED:  ["RUNNING", "CANCELLED"],
  RUNNING:   ["WAITING", "REVIEW", "DONE", "FAILED", "CANCELLED"],
  WAITING:   ["RUNNING", "FAILED", "CANCELLED"],
  REVIEW:    ["DONE", "FAILED", "ESCALATED"],
  FAILED:    ["PENDING", "ESCALATED", "CANCELLED"],
  ESCALATED: ["ASSIGNED"],
  DONE:      [],
  CANCELLED: [],
} as const;

// Map destination status → event type to emit
const STATUS_EVENT_TYPE: Readonly<Record<TaskStatus, TaskEventType>> = {
  CREATED:   "TASK_CREATED",
  PENDING:   "TASK_CREATED",
  ASSIGNED:  "TASK_ASSIGNED",
  RUNNING:   "TASK_STARTED",
  WAITING:   "TASK_PROGRESS",
  REVIEW:    "RESULT_READY",
  DONE:      "RESULT_READY",
  FAILED:    "TASK_FAILED",
  ESCALATED: "TASK_ESCALATED",
  CANCELLED: "TASK_CANCELLED",
} as const;


export class TaskStateMachine {
  constructor(
    private readonly store: TaskStore,
    private readonly eventBus: TaskEventBus,
  ) {}

  /**
   * Validate and execute a state transition.
   * Applies side effects, persists to DB, emits TaskEvent.
   * Cascades CANCELLED to all children.
   *
   * @throws Error if the transition is not valid.
   */
  async transition(
    task: Task,
    newStatus: TaskStatus,
    context?: TransitionContext,
  ): Promise<Task> {
    if (!this.isValidTransition(task.status, newStatus)) {
      throw new Error(
        `Invalid transition: ${task.status} → ${newStatus} (task ${task.id})`,
      );
    }

    const now = new Date().toISOString();
    const updates: Partial<Task> = { status: newStatus };

    // Apply side effects per destination status
    switch (newStatus) {
      case "PENDING":
        // no extra side effects; updated_at handled by store.update()
        break;

      case "ASSIGNED":
        if (context?.agent_id !== undefined) updates.assigned_agent = context.agent_id;
        break;

      case "RUNNING":
        updates.started_at = now;
        break;

      case "WAITING":
        // sub_tasks_expected should already be set by caller before transition
        break;

      case "DONE":
        updates.completed_at = now;
        if (context?.result_summary !== undefined) updates.result_summary = context.result_summary;
        if (context?.confidence !== undefined) updates.confidence = context.confidence;
        break;

      case "FAILED": {
        updates.retry_count = task.retry_count + 1;
        const meta = { ...task.metadata };
        if (context?.error_message !== undefined) meta["last_error"] = context.error_message;
        if (context?.reason !== undefined) meta["failure_reason"] = context.reason;
        updates.metadata = meta;
        break;
      }

      case "ESCALATED":
        updates.assigned_agent = null;
        break;

      case "CANCELLED":
        updates.completed_at = now;
        break;

      default:
        break;
    }

    const updated = this.store.update(task.id, updates);

    // Emit transition event
    await this.eventBus.emitTask({
      event_type: STATUS_EVENT_TYPE[newStatus],
      task_id: task.id,
      parent_task_id: task.parent_id,
      agent_from: context?.agent_id ?? task.assigned_agent,
      agent_to: updated.assigned_agent,
      division: task.division,
      data: {
        from_status: task.status,
        to_status: newStatus,
        ...(context?.reason !== undefined && { reason: context.reason }),
        ...(context?.error_message !== undefined && { error: context.error_message }),
        ...(context?.confidence !== undefined && { confidence: context.confidence }),
      },
    });

    // Prometheus metrics — record terminal transitions
    if (newStatus === "DONE" || newStatus === "FAILED" || newStatus === "ESCALATED") {
      getMetrics().agentTasksTotal.inc({
        agent:    task.assigned_agent ?? "unknown",
        division: task.division,
        status:   newStatus,
      });
    }

    // Cascade cancellation to children
    if (newStatus === "CANCELLED") {
      await this.cascadeCancel(task.id, context);
    }

    return updated;
  }

  /** Return the list of valid destination statuses from a given status. */
  validTransitions(status: TaskStatus): TaskStatus[] {
    return [...VALID_TRANSITIONS[status]];
  }

  /** Return true if the transition from → to is legal. */
  isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
    const allowed = VALID_TRANSITIONS[from];
    return (allowed as readonly string[]).includes(to);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async cascadeCancel(
    parentId: string,
    context?: TransitionContext,
  ): Promise<void> {
    const children = this.store.getByParent(parentId);
    for (const child of children) {
      if (child.status === "DONE" || child.status === "CANCELLED") continue;
      // Recursively transition each non-terminal child
      await this.transition(child, "CANCELLED", {
        reason: "Parent task cancelled",
        ...(context?.agent_id !== undefined && { agent_id: context.agent_id }),
      });
    }
  }
}
