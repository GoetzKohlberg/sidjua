// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9: EscalationManager
 *
 * Handles all failure modes and tier escalation.
 *
 * Decision tree per reason:
 *   capability_mismatch / agent_requested → same-tier reassignment first, then parent
 *   max_retries_exceeded / repeated_crashes → escalate to parent tier immediately
 *   budget_exceeded → notify parent, parent decides
 *   timeout → force checkpoint + reset to PENDING (retry); if exhausted → parent
 *   quality_concern → reset to PENDING with parent feedback in description
 *   Any reason at T1 with no peer → HUMAN_REQUIRED
 */

import type { Database } from "../utils/db.js";
import type { Task } from "../tasks/types.js";
import { TaskStore } from "../tasks/store.js";
import { TaskEventBus } from "../tasks/event-bus.js";
import type {
  AgentInstance,
  EscalationReason,
  EscalationRecord,
  EscalationResult,
  HumanDecision,
} from "./types.js";
import { WorkDistributor } from "./distributor.js";
import type { TaskTreeManager } from "./tree-manager.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("escalation");


interface EscalationLogRow {
  task_id: string;
  from_agent: string;
  from_tier: number;
  to_tier: number;
  reason: string;
  resolution: string | null;
  created_at: string;
}


export class EscalationManager {
  private readonly store: TaskStore;

  constructor(
    private readonly db: Database,
    private readonly eventBus: TaskEventBus,
    private readonly distributor: WorkDistributor,
    private readonly agents: Map<string, AgentInstance>,
    private readonly treeManager: TaskTreeManager,
  ) {
    this.store = new TaskStore(db);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS escalation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        from_tier INTEGER NOT NULL,
        to_tier INTEGER NOT NULL,
        reason TEXT NOT NULL,
        resolution TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS human_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        options TEXT NOT NULL,
        decision TEXT,
        guidance TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_escalation_task ON escalation_log(task_id);
      CREATE INDEX IF NOT EXISTS idx_human_decisions_pending
        ON human_decisions(decided_at) WHERE decided_at IS NULL;
    `);
  }

  // ---------------------------------------------------------------------------
  // Core: escalate
  // ---------------------------------------------------------------------------

  /**
   * Main escalation entry point.
   *
   * Called when a task cannot be completed by its assigned agent.
   * Follows the decision tree defined in the class doc comment.
   */
  escalate(task: Task, reason: EscalationReason): EscalationResult {
    const fromAgent = task.assigned_agent ?? "unknown";
    const fromTier  = task.tier;

    logger.info("escalation", "Escalating task", { metadata: {
      task_id:    task.id,
      from_agent: fromAgent,
      from_tier:  fromTier,
      reason,
    } });

    const record: EscalationRecord = {
      task_id:    task.id,
      from_agent: fromAgent,
      from_tier:  fromTier,
      to_tier:    fromTier,
      reason,
      timestamp:  new Date().toISOString(),
      resolution: null,
    };

    // --- Step 1: try same-tier reassignment for capability issues ---
    if (reason === "capability_mismatch" || reason === "agent_requested") {
      const available = [...this.agents.values()].filter(
        (a) => a.definition.id !== fromAgent,
      );
      const assignment = this.distributor.assignTask(task, available);
      if (assignment !== null) {
        this.store.update(task.id, {
          assigned_agent: assignment.agent_id,
          status:         "PENDING",
        });
        record.resolution = "reassigned";
        this.writeLog(record);

        logger.info("escalation", "Task reassigned to same-tier agent", { metadata: {
          task_id:   task.id,
          new_agent: assignment.agent_id,
        } });

        return {
          action:       "reassigned",
          target_agent: assignment.agent_id,
          target_tier:  fromTier,
          record,
        };
      }
      // No peer available — fall through to parent escalation
    }

    // --- Step 2: T1 with no parent (or T1 after all else) → HUMAN_REQUIRED ---
    if (fromTier === 1 || task.parent_id === null) {
      return this.requireHuman(task, reason, record);
    }

    // --- Step 3: Route based on reason ---
    switch (reason) {
      case "max_retries_exceeded":
      case "repeated_crashes":
      case "capability_mismatch": // fell through from failed same-tier attempt
      case "agent_requested":
        return this.escalateToParent(task, reason, record);

      case "budget_exceeded":
        return this.notifyParentBudget(task, record);

      case "timeout":
        return this.handleTimeout(task, record);

      case "quality_concern":
        return this.handleQualityConcern(task, record);
    }
  }

  // ---------------------------------------------------------------------------
  // Core: handleHumanDecision
  // ---------------------------------------------------------------------------

  /**
   * Human operator responds to a task awaiting human intervention.
   *
   * Actions:
   *   retry    — reset task with optional guidance, clear retry count
   *   cancel   — cancel task + all descendants
   *   reassign — assign to a specific agent
   *   resolve  — human provides the result directly
   */
  handleHumanDecision(taskId: string, decision: HumanDecision): void {
    const task = this.store.get(taskId);
    if (task === null) {
      logger.warn("escalation", "Human decision for unknown task", { metadata: { taskId } });
      return;
    }

    const now = new Date().toISOString();

    // Persist decision to human_decisions table
    this.db.prepare<unknown[], void>(`
      UPDATE human_decisions
      SET decision = ?, guidance = ?, decided_at = ?
      WHERE task_id = ? AND decided_at IS NULL
    `).run(decision.action, decision.guidance ?? null, now, taskId);

    switch (decision.action) {
      case "retry": {
        const description = decision.guidance !== undefined
          ? `${task.description}\n\n[HUMAN_GUIDANCE] ${decision.guidance}`
          : task.description;

        this.store.update(taskId, {
          status:        "PENDING",
          description,
          assigned_agent: null,
          retry_count:   0, // human-authorized restart — reset retry count
        });
        break;
      }

      case "cancel": {
        this.treeManager.cancelSubTree(taskId, "human_decision: cancel");
        break;
      }

      case "reassign": {
        if (decision.target_agent !== undefined) {
          this.store.update(taskId, {
            status:        "ASSIGNED",
            assigned_agent: decision.target_agent,
          });
        }
        break;
      }

      case "resolve": {
        const resultSummary = decision.result ?? "(human-provided resolution)";
        this.store.update(taskId, {
          status:         "DONE",
          result_summary: resultSummary,
          completed_at:   now,
        });
        break;
      }
    }

    logger.info("escalation", "Human decision applied", { metadata: {
      task_id: taskId,
      action:  decision.action,
    } });
  }

  // ---------------------------------------------------------------------------
  // Core: getEscalationHistory
  // ---------------------------------------------------------------------------

  /** Returns all escalation records for a task, chronological order. */
  getEscalationHistory(taskId: string): EscalationRecord[] {
    const rows = this.db
      .prepare<[string], EscalationLogRow>(
        "SELECT * FROM escalation_log WHERE task_id = ? ORDER BY created_at ASC",
      )
      .all(taskId);

    return rows.map((r) => ({
      task_id:    r.task_id,
      from_agent: r.from_agent,
      from_tier:  r.from_tier,
      to_tier:    r.to_tier,
      reason:     r.reason as EscalationReason,
      timestamp:  r.created_at,
      resolution: r.resolution as EscalationRecord["resolution"],
    }));
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private escalateToParent(
    task: Task,
    reason: EscalationReason,
    record: EscalationRecord,
  ): EscalationResult {
    const parentId = task.parent_id;
    const parent   = parentId !== null ? this.store.get(parentId) : null;
    const toTier   = Math.max(1, task.tier - 1);

    record.to_tier    = toTier;
    record.resolution = "reassigned";

    this.store.update(task.id, { status: "ESCALATED" });

    if (parent !== null) {
      this.eventBus.emitTask({
        event_type:     "TASK_ESCALATED",
        task_id:        task.id,
        parent_task_id: parentId,
        agent_from:     task.assigned_agent,
        agent_to:       parent.assigned_agent,
        division:       task.division,
        data: {
          reason,
          task_id:     task.id,
          retry_count: task.retry_count,
        },
      }).catch(() => undefined);
    }

    this.writeLog(record);

    logger.info("escalation", "Task escalated to parent tier", { metadata: {
      task_id:   task.id,
      from_tier: task.tier,
      to_tier:   toTier,
      reason,
    } });

    return {
      action:       "escalated_to_parent",
      target_agent: parent?.assigned_agent ?? null,
      target_tier:  toTier,
      record,
    };
  }

  private notifyParentBudget(
    task: Task,
    record: EscalationRecord,
  ): EscalationResult {
    const parentId = task.parent_id;
    const parent   = parentId !== null ? this.store.get(parentId) : null;
    const toTier   = Math.max(1, task.tier - 1);

    record.to_tier = toTier;

    if (parent !== null) {
      this.eventBus.emitTask({
        event_type:     "BUDGET_WARNING",
        task_id:        task.id,
        parent_task_id: parentId,
        agent_from:     task.assigned_agent,
        agent_to:       parent.assigned_agent,
        division:       task.division,
        data: {
          reason:       "budget_exceeded",
          token_used:   task.token_used,
          token_budget: task.token_budget,
          cost_used:    task.cost_used,
          cost_budget:  task.cost_budget,
        },
      }).catch(() => undefined);
    }

    this.writeLog(record);

    return {
      action:       "escalated_to_parent",
      target_agent: parent?.assigned_agent ?? null,
      target_tier:  toTier,
      record,
    };
  }

  private handleTimeout(task: Task, record: EscalationRecord): EscalationResult {
    const newRetry = task.retry_count + 1;

    if (newRetry >= task.max_retries) {
      // Retries exhausted → escalate to parent tier
      const updatedTask = { ...task, retry_count: newRetry };
      return this.escalateToParent(updatedTask, "timeout", record);
    }

    // Reset to PENDING for retry
    this.store.update(task.id, {
      status:        "PENDING",
      retry_count:   newRetry,
      assigned_agent: null,
    });

    record.resolution = null;
    this.writeLog(record);

    logger.info("escalation", "Timeout: task reset to PENDING", { metadata: {
      task_id:     task.id,
      retry_count: newRetry,
    } });

    return {
      action:       "retrying",
      target_agent: null,
      target_tier:  task.tier,
      record,
    };
  }

  private handleQualityConcern(
    task: Task,
    record: EscalationRecord,
  ): EscalationResult {
    const feedback = `\n\n[QUALITY_REVIEW] Previous result was deemed insufficient. Please revise.`;

    this.store.update(task.id, {
      status:        "PENDING",
      description:   task.description + feedback,
      assigned_agent: null,
    });

    record.resolution = null;
    this.writeLog(record);

    return {
      action:       "retrying",
      target_agent: null,
      target_tier:  task.tier,
      record,
    };
  }

  private requireHuman(
    task: Task,
    reason: EscalationReason,
    record: EscalationRecord,
  ): EscalationResult {
    this.store.update(task.id, { status: "ESCALATED" });
    record.resolution = "human_required";
    this.writeLog(record);
    this.writeHumanDecision(task.id, reason);

    logger.warn("escalation", "Task requires human intervention", { metadata: {
      task_id: task.id,
      reason,
    } });

    return {
      action:       "human_required",
      target_agent: null,
      target_tier:  null,
      record,
    };
  }

  private writeLog(record: EscalationRecord): void {
    const resolvedAt = record.resolution !== null ? new Date().toISOString() : null;
    this.db.prepare<unknown[], void>(`
      INSERT INTO escalation_log
        (task_id, from_agent, from_tier, to_tier, reason, resolution, resolved_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.task_id,
      record.from_agent,
      record.from_tier,
      record.to_tier,
      record.reason,
      record.resolution,
      resolvedAt,
      record.timestamp,
    );
  }

  private writeHumanDecision(taskId: string, reason: EscalationReason): void {
    const now     = new Date().toISOString();
    const options = JSON.stringify(["retry", "cancel", "reassign", "resolve"]);
    this.db.prepare<unknown[], void>(`
      INSERT INTO human_decisions (task_id, reason, options, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, reason, options, now);
  }
}
