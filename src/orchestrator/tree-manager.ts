// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9: TaskTreeManager
 *
 * Navigation and operations on the full task decomposition tree.
 * Wraps the Phase 7 TaskStore + TaskTree for orchestrator-level operations.
 */

import type { Database } from "../utils/db.js";
import type { Task, TaskStatus } from "../tasks/types.js";
import { TaskStore } from "../tasks/store.js";
import { TaskTree } from "../tasks/tree.js";
import { TaskEventBus } from "../tasks/event-bus.js";
import type { TaskTreeNode, CancelResult } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("tree-manager");

/** Terminal task states that cannot be changed by cancellation. */
const TERMINAL_STATUSES = new Set<TaskStatus>(["DONE", "FAILED", "CANCELLED"]);


/**
 * Orchestrator-level tree operations.
 *
 * Provides tree navigation (path, depth, siblings, leaves) and cascading
 * cancellation. All DB operations use better-sqlite3 synchronous API.
 */
export class TaskTreeManager {
  private readonly store: TaskStore;
  private readonly tree: TaskTree;

  constructor(
    private readonly db: Database,
    private readonly eventBus: TaskEventBus,
  ) {
    this.store = new TaskStore(db);
    this.tree  = new TaskTree(this.store);
  }

  // ---------------------------------------------------------------------------
  // Tree navigation
  // ---------------------------------------------------------------------------

  /**
   * Returns the full task tree as a nested structure rooted at root_task_id.
   * Used for visualization and status reporting.
   */
  getTree(rootTaskId: string): TaskTreeNode {
    const root = this.store.get(rootTaskId);
    if (root === null) {
      throw new Error(`Task not found: ${rootTaskId}`);
    }
    return this.buildNode(root, 0);
  }

  /** Build a TaskTreeNode recursively. */
  private buildNode(task: Task, depth: number): TaskTreeNode {
    const children = this.store.getByParent(task.id);
    return {
      task,
      depth,
      children: children.map((c) => this.buildNode(c, depth + 1)),
    };
  }

  /**
   * Returns the path from root to this task (breadcrumb).
   * [root_task, tier1_task, tier2_task, this_task]
   */
  getPath(taskId: string): Task[] {
    const ancestors = this.tree.getAncestors(taskId);
    const task      = this.store.get(taskId);
    if (task === null) return ancestors;
    return [...ancestors, task]; // breadcrumb includes self at end
  }

  /**
   * Returns depth of task in tree (root = 0).
   */
  getDepth(taskId: string): number {
    return this.tree.getDepth(taskId);
  }

  /**
   * Returns all tasks with the same parent_id (siblings including self).
   * Root tasks (no parent) return an empty array.
   */
  getSiblings(taskId: string): Task[] {
    const task = this.store.get(taskId);
    if (task === null || task.parent_id === null) return [];
    return this.store.getByParent(task.parent_id); // includes self
  }

  /**
   * Returns all leaf tasks (tasks with no children) in the tree.
   * These are the atomic execution units.
   */
  getLeafTasks(rootTaskId: string): Task[] {
    const allTasks = this.store.getByRoot(rootTaskId);
    const parentIds = new Set(
      allTasks.filter((t) => t.parent_id !== null).map((t) => t.parent_id as string),
    );
    return allTasks.filter((t) => !parentIds.has(t.id));
  }

  // ---------------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------------

  /**
   * Cascading cancellation of the entire tree starting from root_task_id.
   *
   * 1. Set root task status = CANCELLED
   * 2. Find all descendant tasks (recursive)
   * 3. For each in non-terminal state: set CANCELLED, emit event
   * 4. Log cancellation to audit trail
   */
  cancelTree(rootTaskId: string, reason: string): CancelResult {
    const root = this.store.get(rootTaskId);
    if (root === null) throw new Error(`Task not found: ${rootTaskId}`);
    return this.cancelFrom(root, reason);
  }

  /**
   * Cancel a specific branch of the tree (starting from a non-root task).
   * Parent task receives notification.
   */
  cancelSubTree(taskId: string, reason: string): CancelResult {
    const task = this.store.get(taskId);
    if (task === null) throw new Error(`Task not found: ${taskId}`);
    return this.cancelFrom(task, reason);
  }

  private cancelFrom(task: Task, reason: string): CancelResult {
    let cancelledCount = 0;
    let alreadyTerminal = 0;
    const tasksCancelled: string[] = [];

    // Collect all descendants (BFS)
    const toProcess: Task[] = [task];
    const visited = new Set<string>();

    const now = new Date().toISOString();

    while (toProcess.length > 0) {
      const current = toProcess.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);

      // Atomic status transition: only cancels tasks that are not already
      // in a terminal state.  The WHERE clause prevents a race where
      // another process (orchestrator or concurrent CLI) sets the task
      // terminal between our BFS fetch and this write.
      const result = this.db.prepare<unknown[], { changes: number }>(
        "UPDATE tasks SET status = 'CANCELLED', completed_at = ?, updated_at = ? " +
        "WHERE id = ? AND status NOT IN ('DONE','FAILED','CANCELLED','ESCALATED')",
      ).run(now, now, current.id) as unknown as { changes: number };

      if (result.changes === 0) {
        // Already in a terminal state — count but skip event emission.
        alreadyTerminal++;
      } else {
        tasksCancelled.push(current.id);
        cancelledCount++;

        // Emit cancellation event
        this.eventBus.emitTask({
          event_type: "TASK_CANCELLED",
          task_id:        current.id,
          parent_task_id: current.parent_id,
          agent_from:     "orchestrator",
          agent_to:       current.assigned_agent,
          division:       current.division,
          data:           { reason, cancelled_by: "orchestrator" },
        }).catch((err: unknown) => {
          logger.warn("orchestrator", "Failed to emit TASK_CANCELLED event", { metadata: { error: err } });
        });

        logger.info("orchestrator", "Task cancelled in cascade", { metadata: {
          task_id: current.id,
          reason,
        } });
      }

      // Add children to process
      const children = this.store.getByParent(current.id);
      toProcess.push(...children);
    }

    return { cancelled_count: cancelledCount, already_terminal: alreadyTerminal, tasks_cancelled: tasksCancelled };
  }
}
