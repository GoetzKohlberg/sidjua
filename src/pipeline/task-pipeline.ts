// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9.5: TaskPipeline
 *
 * Main broker. Wires PriorityQueue + AckTracker + BackpressureMonitor.
 *
 * Called by OrchestratorProcess instead of direct WorkDistributor.assignTask().
 * Adds queuing, priority, delivery, ACK tracking, and producer notifications.
 *
 * No LLM calls — pure coordination.
 */

import type { Database } from "../utils/db.js";
import type { TaskEventBus } from "../tasks/event-bus.js";
import type { Task } from "../tasks/types.js";
import type { AgentInstance } from "../orchestrator/types.js";
import { WorkDistributor } from "../orchestrator/distributor.js";
import { PriorityQueue } from "./priority-queue.js";
import { AckTracker } from "./ack-tracker.js";
import { BackpressureMonitor } from "./backpressure.js";
import {
  AckState,
  TaskPriority,
  DEFAULT_PIPELINE_CONFIG,
} from "./types.js";
import type {
  PipelineConfig,
  QueueEntry,
  SubmitResult,
  QueueStatus,
  TaskPosition,
  ExpiredTask,
} from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("task-pipeline");


export class TaskPipeline {
  readonly queue:       PriorityQueue;
  readonly ackTracker:  AckTracker;
  readonly backpressure: BackpressureMonitor;
  readonly distributor:  WorkDistributor;
  readonly config:       PipelineConfig;

  constructor(
    private readonly db:       Database,
    private readonly eventBus: TaskEventBus,
    /** Live agent registry from OrchestratorProcess. */
    private readonly agents:   Map<string, AgentInstance>,
    config?: Partial<PipelineConfig>,
  ) {
    this.config       = { ...DEFAULT_PIPELINE_CONFIG, ...config };
    this.queue        = new PriorityQueue(db);
    this.ackTracker   = new AckTracker(db, eventBus);
    this.backpressure = new BackpressureMonitor(this.config);
    this.distributor  = new WorkDistributor();

    // Register all current agents with backpressure monitor
    for (const [, inst] of agents) {
      this.backpressure.registerAgent(
        inst.definition.id,
        inst.definition.max_concurrent_tasks,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // submit
  // ---------------------------------------------------------------------------

  /**
   * Submit a task to the pipeline.
   *
   * 1. Check global queue limit
   * 2. Create QueueEntry with TTL from priority
   * 3. Persist to DB
   * 4. Find best consumer via WorkDistributor
   * 5. Check backpressure → deliver or queue
   * 6. Notify producer: QUEUED
   * 7. Return SubmitResult
   */
  submit(
    task:              Task,
    priority:          TaskPriority,
    producer_agent_id: string,
  ): SubmitResult {
    // 1. Global queue limit check
    const currentTotal = this.queue.totalQueued();
    if (currentTotal >= this.config.max_queue_size_global) {
      logger.warn("pipeline", "Pipeline full — task rejected", { metadata: {
        task_id: task.id,
        total:   currentTotal,
        limit:   this.config.max_queue_size_global,
      } });
      return {
        accepted:          false,
        task_id:           task.id,
        queue_position:    null,
        estimated_wait_ms: null,
        reason:            "pipeline_full",
      };
    }

    // 2. TTL from priority
    const ttlMs      = this.config.ttl_by_priority[priority] ?? this.config.ttl_default_ms;
    const now        = new Date().toISOString();
    const expiresAt  = new Date(Date.now() + ttlMs).toISOString();

    // 3. Find consumer via WorkDistributor
    const agentList  = [...this.agents.values()];
    const assignment = this.distributor.assignTask(task, agentList);

    let consumerId: string | null = null;
    let recommendation: "accept" | "queue" | "redirect" = "queue";

    if (assignment !== null) {
      const rec = this.backpressure.shouldAccept(assignment.agent_id);
      if (rec !== "redirect") {
        consumerId     = assignment.agent_id;
        recommendation = rec;
      }
    }

    // 4. Create and persist QueueEntry
    const entry: QueueEntry = {
      task_id:           task.id,
      producer_agent_id,
      consumer_agent_id: consumerId,
      priority,
      original_priority: priority,
      ack_state:         AckState.QUEUED,
      queued_at:         now,
      accepted_at:       null,
      started_at:        null,
      completed_at:      null,
      ttl_expires_at:    expiresAt,
      delivery_attempts: 0,
      last_delivery_at:  null,
      excluded_agents:   [],
      metadata:          {},
    };

    this.queue.enqueue(entry);

    // 5. Deliver immediately if agent is accepting
    if (consumerId !== null && recommendation === "accept") {
      this.deliverToAgent(task.id, consumerId);
    } else if (consumerId !== null) {
      // Queue for agent — backpressure says "queue" (not "redirect")
      this.backpressure.onTaskQueued(consumerId);
    }

    // 6. Compute position
    const position = this.queue.getPositionInLane(task.id);

    logger.info("pipeline", "Task submitted", { metadata: {
      task_id:  task.id,
      priority,
      consumer: consumerId ?? "unassigned",
      recommendation,
    } });

    return {
      accepted:          true,
      task_id:           task.id,
      queue_position:    position,
      estimated_wait_ms: this.estimateWait(priority),
    };
  }

  // ---------------------------------------------------------------------------
  // dispatchPending
  // ---------------------------------------------------------------------------

  /**
   * Called every poll cycle by the OrchestratorProcess event loop.
   *
   * 1. Re-dispatch unassigned tasks to available agents
   * 2. Boost starved tasks (starvation protection)
   * 3. Expire stale tasks (TTL enforcement)
   *
   * Returns count of dispatched tasks.
   */
  dispatchPending(): number {
    let dispatched = 0;

    // Get all idle agents and try to assign pending tasks
    const agents = [...this.agents.values()];
    for (const inst of agents) {
      const agentId = inst.definition.id;
      const rec     = this.backpressure.shouldAccept(agentId);
      if (rec === "redirect") continue;

      // Try to dequeue next task for this agent (includes unassigned tasks)
      const entry = this.queue.dequeueNext(agentId);
      if (entry === null) continue;

      // Deliver via IPC
      inst.process.send({ type: "TASK_ASSIGNED", task_id: entry.task_id });
      this.queue.updateState(entry.task_id, AckState.ACCEPTED, {
        accepted_at:      new Date().toISOString(),
        last_delivery_at: new Date().toISOString(),
        consumer_agent_id: agentId,
      });
      this.backpressure.onTaskAccepted(agentId);
      dispatched++;
    }

    // Starvation boost (every starvation_check_interval_ms — caller responsibility)
    this.queue.boostStarved(this.config.priority_boost_after_ms);

    // TTL expiry
    const expired = this.queue.expireStale();
    for (const exp of expired) {
      this.notifyExpired(exp);
    }

    if (dispatched > 0) {
      logger.debug("pipeline", "Dispatched pending tasks", { metadata: { count: dispatched } });
    }

    return dispatched;
  }

  // ---------------------------------------------------------------------------
  // handleAck
  // ---------------------------------------------------------------------------

  /**
   * Called when an agent sends an ACK via IPC.
   *
   * Routes to the appropriate state transition:
   *   ACCEPTED  → agent picked up task
   *   RUNNING   → agent started work
   *   COMPLETED → task done, free slot
   *   FAILED    → task failed, update state
   *   REJECTED  → requeue with agent exclusion
   */
  handleAck(task_id: string, ack: AckState, agent_id: string): void {
    const entry = this.queue.getEntry(task_id);
    if (entry === null) {
      logger.warn("pipeline", "handleAck: task not found", { metadata: { task_id, ack } });
      return;
    }

    switch (ack) {
      case AckState.ACCEPTED: {
        this.ackTracker.transition(task_id, entry.ack_state, AckState.ACCEPTED, agent_id, "Agent accepted");
        this.backpressure.onTaskAccepted(agent_id);
        break;
      }

      case AckState.RUNNING: {
        this.ackTracker.transition(task_id, entry.ack_state, AckState.RUNNING, agent_id, "Agent running");
        break;
      }

      case AckState.COMPLETED: {
        this.ackTracker.transition(task_id, entry.ack_state, AckState.COMPLETED, agent_id, "Task completed");
        this.backpressure.onTaskCompleted(agent_id);
        // Trigger dispatch: a slot just freed
        this.dispatchPending();
        break;
      }

      case AckState.FAILED: {
        this.ackTracker.transition(task_id, entry.ack_state, AckState.FAILED, agent_id, "Task failed");
        this.backpressure.onTaskFailed(agent_id);
        // OrchestratorProcess handles retry/escalation — pipeline just tracks state
        break;
      }

      case AckState.REJECTED: {
        // Agent cannot handle at runtime — requeue with agent exclusion
        this.ackTracker.transition(task_id, entry.ack_state, AckState.REJECTED, agent_id, "Agent rejected");
        // After REJECTED → QUEUED (valid transition)
        this.queue.requeue(task_id, undefined, agent_id);
        this.ackTracker.transition(task_id, AckState.REJECTED, AckState.QUEUED, agent_id, "Requeued after rejection");
        logger.info("pipeline", "Task requeued after rejection", { metadata: { task_id, excluded: agent_id } });
        break;
      }

      case AckState.CANCELLED: {
        this.ackTracker.transition(task_id, entry.ack_state, AckState.CANCELLED, agent_id, "Task cancelled");
        if (entry.consumer_agent_id !== null) {
          this.backpressure.onTaskCompleted(entry.consumer_agent_id); // free slot
        }
        break;
      }

      default:
        logger.warn("pipeline", "Unexpected ACK state", { metadata: { task_id, ack } });
    }
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /**
   * Returns queue depth, priority breakdown, and throughput.
   * Scoped to agent if agent_id provided.
   */
  getQueueStatus(agent_id?: string): QueueStatus {
    const byPriority = this.queue.countByPriority();
    const total      = agent_id !== undefined
      ? this.queue.size(agent_id)
      : Object.values(byPriority).reduce((s, n) => s + n, 0);

    return {
      total_queued:          total,
      by_priority:           byPriority,
      oldest_queued_ms:      this.queue.oldestQueuedAge(),
      throughput_per_minute: this.queue.completedInWindow(60_000),
      agents_accepting:      this.backpressure.acceptingCount(),
      agents_at_capacity:    this.backpressure.atCapacityCount(),
    };
  }

  /**
   * Returns position of a specific task in the queue.
   */
  getTaskPosition(task_id: string): TaskPosition | null {
    const entry = this.queue.getEntry(task_id);
    if (entry === null) return null;

    return {
      task_id,
      priority:          entry.priority,
      position_in_lane:  this.queue.getPositionInLane(task_id),
      total_ahead:       this.queue.getQueuedAhead(task_id),
      consumer_agent_id: entry.consumer_agent_id,
      ack_state:         entry.ack_state,
      queued_since_ms:   Date.now() - new Date(entry.queued_at).getTime(),
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * On startup: reload non-terminal entries and re-register agents
   * with backpressure monitor based on current DB state.
   * Returns count of recovered entries.
   */
  recover(): number {
    const entries = this.queue.getNonTerminal();

    // Re-register all known agents (in case they were added after construction)
    for (const [, inst] of this.agents) {
      this.backpressure.registerAgent(
        inst.definition.id,
        inst.definition.max_concurrent_tasks,
      );
    }

    // Reconstruct backpressure counts from DB state
    for (const [agentId] of this.agents) {
      const active = entries.filter(
        (e) => e.consumer_agent_id === agentId && e.ack_state === AckState.RUNNING,
      ).length;
      const queued = entries.filter(
        (e) => e.consumer_agent_id === agentId && e.ack_state === AckState.QUEUED,
      ).length;
      this.backpressure.initFromCounts(agentId, active, queued);
    }

    // Tasks in ACCEPTED state that didn't COMPLETE → requeue
    for (const entry of entries) {
      if (entry.ack_state === AckState.ACCEPTED) {
        this.queue.requeue(entry.task_id);
      }
    }

    logger.info("pipeline", "Recovery complete", { metadata: { recovered: entries.length } });
    return entries.length;
  }

  /**
   * Graceful shutdown: stop accepting, wait for in-flight tasks.
   * Returns when queue is empty or timeout reached.
   */
  async drain(): Promise<void> {
    const DRAIN_TIMEOUT_MS = 30_000;
    const POLL_INTERVAL_MS = 500;
    const start            = Date.now();

    while (Date.now() - start < DRAIN_TIMEOUT_MS) {
      const active = this.queue.getNonTerminal().filter(
        (e) => e.ack_state === AckState.RUNNING || e.ack_state === AckState.ACCEPTED,
      );
      if (active.length === 0) break;

      await sleep(POLL_INTERVAL_MS);
    }

    logger.info("pipeline", "Drain complete");
  }

  /**
   * Register a new agent with the pipeline's backpressure monitor.
   * Called when a new agent joins the pool.
   */
  registerAgent(agent_id: string, capacity: number): void {
    this.backpressure.registerAgent(agent_id, capacity);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Deliver a task to an agent via IPC. */
  private deliverToAgent(task_id: string, agent_id: string): void {
    const inst = this.agents.get(agent_id);
    if (inst === undefined) return;

    const now = new Date().toISOString();
    inst.process.send({ type: "TASK_ASSIGNED", task_id });

    this.queue.updateState(task_id, AckState.ACCEPTED, {
      accepted_at:      now,
      last_delivery_at: now,
      delivery_attempts: 1,
    });

    this.backpressure.onTaskAccepted(agent_id);

    logger.info("pipeline", "Task delivered to agent", { metadata: { task_id, agent_id } });
  }

  /** Notify producer of TTL expiry. */
  private notifyExpired(exp: ExpiredTask): void {
    this.eventBus.emitTask({
      event_type:     "PIPELINE_ACK_UPDATE",
      task_id:        exp.task_id,
      parent_task_id: null,
      agent_from:     null,
      agent_to:       exp.producer_agent_id,
      division:       "orchestrator",
      data: {
        previous_state: AckState.QUEUED,
        new_state:      AckState.EXPIRED,
        details:        `Task expired after TTL (queued at ${exp.queued_at})`,
      },
    }).catch(() => undefined);
  }

  /** Rough wait estimate based on priority count and throughput. */
  private estimateWait(priority: TaskPriority): number {
    const throughput = this.queue.completedInWindow(60_000); // per minute
    if (throughput === 0) return 0;

    // Count tasks ahead with higher or equal priority
    const byPriority = this.queue.countByPriority();
    let ahead = 0;
    for (let p = TaskPriority.CRITICAL; p <= priority; p++) {
      ahead += byPriority[p as TaskPriority] ?? 0;
    }

    const perMs = throughput / 60_000;
    return perMs > 0 ? Math.round(ahead / perMs) : 0;
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
