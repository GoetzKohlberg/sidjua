// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9: SynthesisCollector
 *
 * Tracks sub-task completion and triggers parent synthesis when all children
 * are done. Bridges Phase 7 (TaskStore) and Phase 8 (AgentLoop).
 *
 * When all children complete → emits SYNTHESIS_READY event with all child
 * management summaries → parent AgentLoop enters SYNTHESIS mode.
 */

import type { Database } from "../utils/db.js";
import type { Task } from "../tasks/types.js";
import { TaskStore } from "../tasks/store.js";
import { TaskEventBus } from "../tasks/event-bus.js";
import type {
  ChildSummary,
  SynthesisStatus,
  TreeStatus,
  PartialFailureAction,
} from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("synthesis");


export class SynthesisCollector {
  private readonly store: TaskStore;

  constructor(
    private readonly db: Database,
    private readonly eventBus: TaskEventBus,
  ) {
    this.store = new TaskStore(db);
  }

  // ---------------------------------------------------------------------------
  // registerResult
  // ---------------------------------------------------------------------------

  /**
   * Called when a child task completes (DONE or FAILED).
   *
   * 1. Increment parent's sub_tasks_received counter in DB
   * 2. Check if all siblings are done
   * 3. If YES → return ready=true with child summaries
   * 4. If NO  → return ready=false with remaining count
   */
  registerResult(completedTask: Task): SynthesisStatus {
    if (completedTask.parent_id === null) {
      // Root task — no parent to notify
      return {
        ready:             false,
        parent_task_id:    completedTask.id,
        total_children:    0,
        completed_children: 0,
        remaining:         0,
        child_summaries:   [],
      };
    }

    const parent = this.store.get(completedTask.parent_id);
    if (parent === null) {
      logger.warn("synthesis", "Parent task not found for completed child", { metadata: {
        child_id:  completedTask.id,
        parent_id: completedTask.parent_id,
      } });
      return {
        ready:             false,
        parent_task_id:    completedTask.parent_id,
        total_children:    0,
        completed_children: 0,
        remaining:         0,
        child_summaries:   [],
      };
    }

    // Increment sub_tasks_received on parent
    const newReceived = parent.sub_tasks_received + 1;
    this.store.update(parent.id, { sub_tasks_received: newReceived });

    const totalChildren   = parent.sub_tasks_expected;
    const completedChildren = newReceived;
    const remaining        = Math.max(0, totalChildren - completedChildren);

    logger.debug("synthesis", "Sub-task result registered", { metadata: {
      parent_id:  parent.id,
      completed:  completedChildren,
      total:      totalChildren,
      remaining,
    } });

    if (completedChildren >= totalChildren && totalChildren > 0) {
      // All children done — collect summaries
      const children = this.store.getByParent(parent.id);
      const summaries = children.map((c): ChildSummary => ({
        task_id:     c.id,
        title:       c.title,
        summary:     c.result_summary ?? "(no summary)",
        confidence:  c.confidence ?? 0,
        result_file: c.result_file ?? "",
        status:      c.status === "DONE" ? "DONE" : "FAILED",
      }));

      return {
        ready:              true,
        parent_task_id:     parent.id,
        total_children:     totalChildren,
        completed_children: completedChildren,
        remaining:          0,
        child_summaries:    summaries,
      };
    }

    return {
      ready:              false,
      parent_task_id:     parent.id,
      total_children:     totalChildren,
      completed_children: completedChildren,
      remaining,
      child_summaries:    [],
    };
  }

  // ---------------------------------------------------------------------------
  // triggerParentSynthesis
  // ---------------------------------------------------------------------------

  /**
   * All children complete → notify parent agent to synthesize.
   *
   * Writes SYNTHESIS_READY event to EventBus so the parent's AgentLoop
   * can enter SYNTHESIS mode.
   */
  async triggerParentSynthesis(
    parentTaskId: string,
    childSummaries: ChildSummary[],
  ): Promise<void> {
    const parent = this.store.get(parentTaskId);
    if (parent === null) {
      logger.warn("synthesis", "Cannot trigger synthesis: parent not found", { metadata: { parentTaskId } });
      return;
    }

    // Update parent status to REVIEW
    this.store.update(parentTaskId, { status: "REVIEW" });

    await this.eventBus.emitTask({
      event_type:    "SYNTHESIS_READY",
      task_id:       parentTaskId,
      parent_task_id: parent.parent_id,
      agent_from:    "orchestrator",
      agent_to:      parent.assigned_agent,
      division:      parent.division,
      data: {
        parent_task_id:  parentTaskId,
        child_summaries: childSummaries,
        total_children:  childSummaries.length,
      },
    });

    logger.info("synthesis", "Triggered parent synthesis", { metadata: {
      parent_id:   parentTaskId,
      agent:       parent.assigned_agent,
      child_count: childSummaries.length,
    } });
  }

  // ---------------------------------------------------------------------------
  // getTreeStatus
  // ---------------------------------------------------------------------------

  /**
   * Returns completion status for the entire task tree rooted at root_task_id.
   */
  getTreeStatus(rootTaskId: string): TreeStatus {
    const allTasks = this.store.getByRoot(rootTaskId);

    const byStatus: Record<string, number> = {};
    const byTier: Record<number, { total: number; done: number }> = {};

    let totalTokens = 0;
    let totalCost   = 0;

    for (const task of allTasks) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;

      if (!byTier[task.tier]) byTier[task.tier] = { total: 0, done: 0 };
      byTier[task.tier]!.total++;
      if (task.status === "DONE") byTier[task.tier]!.done++;

      totalTokens += task.token_used;
      totalCost   += task.cost_used;
    }

    const totalTasks    = allTasks.length;
    const doneTasks     = byStatus["DONE"] ?? 0;
    const failedTasks   = byStatus["FAILED"] ?? 0;
    const cancelledTasks = byStatus["CANCELLED"] ?? 0;
    const terminalTasks = doneTasks + failedTasks + cancelledTasks;
    const completion    = totalTasks === 0 ? 0 : terminalTasks / totalTasks;

    return {
      root_task_id:          rootTaskId,
      total_tasks:           totalTasks,
      by_status:             byStatus,
      by_tier:               byTier,
      estimated_completion:  completion,
      total_tokens:          totalTokens,
      total_cost:            totalCost,
    };
  }

  // ---------------------------------------------------------------------------
  // handlePartialFailure
  // ---------------------------------------------------------------------------

  /**
   * One child failed but others succeeded.
   *
   * Default V1 policy:
   *   - If failed child has retries remaining → WAIT
   *   - If retries exhausted → SYNTHESIZE_PARTIAL
   */
  handlePartialFailure(parentTaskId: string, failedChildId: string): PartialFailureAction {
    const failedChild = this.store.get(failedChildId);
    if (failedChild === null) return "SYNTHESIZE_PARTIAL";

    // Check skill.md tolerance from parent metadata
    const parent = this.store.get(parentTaskId);
    const tolerance = parent?.metadata?.["partial_failure_tolerance"];
    if (tolerance === "cancel") return "CANCEL_ALL";
    if (tolerance === "synthesize") return "SYNTHESIZE_PARTIAL";

    // Default: WAIT if retries remain, SYNTHESIZE_PARTIAL otherwise
    if (failedChild.retry_count < failedChild.max_retries) {
      return "WAIT";
    }
    return "SYNTHESIZE_PARTIAL";
  }
}
