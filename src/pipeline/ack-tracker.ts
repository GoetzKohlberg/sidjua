// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9.5: AckTracker
 *
 * State machine enforcement for pipeline ACK states, plus producer notifications.
 *
 * Every valid transition is persisted to pipeline_ack_history for audit.
 * Producer agents are notified via EventBus PIPELINE_ACK_UPDATE events.
 */

import type { Database } from "../utils/db.js";
import type { TaskEventBus } from "../tasks/event-bus.js";
import {
  AckState,
  VALID_TRANSITIONS,
} from "./types.js";
import type {
  QueueEntry,
  PipelineNotification,
  TransitionResult,
  AckTransition,
  TimedOutTask,
} from "./types.js";
import { PriorityQueue } from "./priority-queue.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("ack-tracker");


interface AckHistoryRow {
  id:         number;
  task_id:    string;
  from_state: string;
  to_state:   string;
  agent_id:   string;
  details:    string | null;
  created_at: string;
}


export class AckTracker {
  private readonly queue: PriorityQueue;

  constructor(
    private readonly db: Database,
    private readonly eventBus: TaskEventBus,
  ) {
    this.queue = new PriorityQueue(db);
  }

  // ---------------------------------------------------------------------------
  // State Machine
  // ---------------------------------------------------------------------------

  /**
   * Attempt a state transition. Validates allowed transitions, persists to history,
   * and emits a PIPELINE_ACK_UPDATE event to the producer.
   */
  transition(
    task_id:  string,
    from:     AckState,
    to:       AckState,
    agent_id: string,
    details   = "",
  ): TransitionResult {
    // Validate transition
    const allowed = VALID_TRANSITIONS.get(from);
    if (allowed === undefined || !allowed.has(to)) {
      const reason = `Transition ${from} → ${to} is not allowed`;
      logger.warn("ack_tracker", "Invalid transition", { metadata: { task_id, from, to } });
      return { valid: false, reason };
    }

    // Verify current state matches expected 'from'
    const entry = this.queue.getEntry(task_id);
    if (entry === null) {
      return { valid: false, reason: `Task not found in pipeline: ${task_id}` };
    }
    if (entry.ack_state !== from) {
      const reason = `Expected state ${from}, found ${entry.ack_state}`;
      return { valid: false, reason };
    }

    const now = new Date().toISOString();

    // Persist transition to history
    this.writeHistory(task_id, from, to, agent_id, details, now);

    // Update queue state
    const fields: Parameters<PriorityQueue["updateState"]>[2] = {};
    if (to === AckState.ACCEPTED)  fields.accepted_at  = now;
    if (to === AckState.RUNNING)   fields.started_at   = now;
    if (to === AckState.COMPLETED || to === AckState.FAILED ||
        to === AckState.CANCELLED || to === AckState.EXPIRED) {
      fields.completed_at = now;
    }

    this.queue.updateState(task_id, to, fields);

    // Build notification
    const notification: PipelineNotification = {
      task_id,
      producer_agent_id: entry.producer_agent_id,
      consumer_agent_id: entry.consumer_agent_id,
      previous_state:    from,
      new_state:         to,
      timestamp:         now,
      details,
    };

    // Notify producer
    this.notifyProducer(notification);

    logger.debug("ack_tracker", "State transition", { metadata: {
      task_id,
      from,
      to,
      agent_id,
    } });

    return { valid: true, notification };
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  /**
   * Emit PIPELINE_ACK_UPDATE event to the producer agent.
   * Non-blocking — fire and forget (event is SQLite-persisted).
   */
  notifyProducer(notification: PipelineNotification): void {
    this.eventBus.emitTask({
      event_type:     "PIPELINE_ACK_UPDATE",
      task_id:        notification.task_id,
      parent_task_id: null,
      agent_from:     notification.consumer_agent_id,
      agent_to:       notification.producer_agent_id,
      division:       "orchestrator",
      data: {
        previous_state:    notification.previous_state,
        new_state:         notification.new_state,
        consumer_agent_id: notification.consumer_agent_id,
        details:           notification.details,
      },
    }).catch((err: unknown) => {
      logger.warn("ack_tracker", "Failed to emit PIPELINE_ACK_UPDATE", { metadata: { error: err } });
    });
  }

  // ---------------------------------------------------------------------------
  // Timeout Detection
  // ---------------------------------------------------------------------------

  /**
   * Find tasks in QUEUED state where last_delivery_at + ack_timeout_ms < NOW.
   * These were delivered but the agent never sent ACCEPTED.
   */
  checkAckTimeouts(ack_timeout_ms: number): TimedOutTask[] {
    const cutoff = new Date(Date.now() - ack_timeout_ms).toISOString();
    const entries = this.queue.getAcceptedOlderThan(cutoff);

    return entries.map((e) => ({
      task_id:          e.task_id,
      ack_state:        e.ack_state,
      delivery_attempts: e.delivery_attempts,
      last_delivery_at: e.last_delivery_at ?? new Date(0).toISOString(),
      age_ms:           e.last_delivery_at
        ? Date.now() - new Date(e.last_delivery_at).getTime()
        : 0,
    }));
  }

  /**
   * Find tasks in ACCEPTED state where accepted_at + max_running_ms < NOW.
   * Agent may have crashed between ACK and task start.
   */
  checkRunningTimeouts(max_running_ms: number): TimedOutTask[] {
    const cutoff  = new Date(Date.now() - max_running_ms).toISOString();
    const entries = this.queue.getStuckAccepted(cutoff);

    return entries.map((e) => ({
      task_id:          e.task_id,
      ack_state:        e.ack_state,
      delivery_attempts: e.delivery_attempts,
      last_delivery_at: e.last_delivery_at ?? new Date(0).toISOString(),
      age_ms:           e.accepted_at
        ? Date.now() - new Date(e.accepted_at).getTime()
        : 0,
    }));
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  /**
   * Full state transition history for a task (audit trail).
   */
  getHistory(task_id: string): AckTransition[] {
    const rows = this.db.prepare<[string], AckHistoryRow>(
      "SELECT * FROM pipeline_ack_history WHERE task_id = ? ORDER BY created_at ASC",
    ).all(task_id);

    return rows.map((row) => ({
      task_id:    row.task_id,
      from_state: row.from_state as AckState,
      to_state:   row.to_state as AckState,
      agent_id:   row.agent_id,
      details:    row.details ?? "",
      timestamp:  row.created_at,
    }));
  }

  /**
   * All non-terminal tasks submitted by a specific producer.
   * Used by agent to check "what am I waiting for?"
   */
  getProducerPending(producer_agent_id: string): QueueEntry[] {
    const rows = this.db.prepare<[string]>(`
      SELECT pq.* FROM pipeline_queue pq
      WHERE pq.producer_agent_id = ?
        AND pq.ack_state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
      ORDER BY priority ASC, queued_at ASC
    `).all(producer_agent_id);

    // Use PriorityQueue's internal rowToEntry — access via getEntry for each
    return (rows as Array<{ task_id: string }>).map((row) =>
      this.queue.getEntry(row.task_id),
    ).filter((e): e is QueueEntry => e !== null);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private writeHistory(
    task_id:    string,
    from_state: AckState,
    to_state:   AckState,
    agent_id:   string,
    details:    string,
    now:        string,
  ): void {
    this.db.prepare<unknown[], void>(`
      INSERT INTO pipeline_ack_history (task_id, from_state, to_state, agent_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(task_id, from_state, to_state, agent_id, details || null, now);
  }
}
