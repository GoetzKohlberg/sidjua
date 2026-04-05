// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Orchestrator Event Handlers
 *
 * Free functions for the 8 task-event handler methods extracted from
 * OrchestratorProcess to keep orchestrator.ts focused on lifecycle and
 * coordination wiring.
 *
 * Each handler receives an EventHandlerContext containing the sub-components
 * it needs so the functions remain pure dependencies — no class coupling.
 */

import { createLogger }       from "../core/logger.js";
import { TaskPriority, AckState } from "../pipeline/types.js";
import type { TaskStore }     from "../tasks/store.js";
import type { TaskEvent }     from "../tasks/types.js";
import type { WorkDistributor }   from "./distributor.js";
import type { SynthesisCollector } from "./synthesis.js";
import type { EscalationManager } from "./escalation.js";
import type { PeerRouter }    from "./peer-router.js";
import type { TaskPipeline }  from "../pipeline/task-pipeline.js";
import type { AgentInstance, EscalationReason } from "./types.js";

const logger = createLogger("orchestrator");

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface EventHandlerContext {
  store:               TaskStore;
  agents:              Map<string, AgentInstance>;
  distributor:         WorkDistributor;
  synthesisCollector:  SynthesisCollector;
  escalationManager:   EscalationManager;
  peerRouter:          PeerRouter;
  pipeline:            TaskPipeline | null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleNewTask(ctx: EventHandlerContext, event: TaskEvent): Promise<void> {
  const task = ctx.store.get(event.task_id);
  if (task === null) return;

  // Skip already-assigned/running tasks
  if (task.status !== "CREATED" && task.status !== "PENDING") return;

  // Phase 9.5: Use TaskPipeline if configured
  if (ctx.pipeline !== null) {
    const producerId = event.agent_from ?? "orchestrator";
    // Derive priority from task type / tier
    const priority   = task.tier === 1 ? TaskPriority.URGENT : TaskPriority.REGULAR;
    ctx.pipeline.submit(task, priority, producerId);
    // Pipeline handles assignment, IPC, and ACK tracking
    return;
  }

  // Phase 9 direct assignment (no pipeline)
  const agents     = [...ctx.agents.values()];
  const assignment = ctx.distributor.assignTask(task, agents);

  if (assignment === null) {
    // No agent available — stay PENDING, retry on next loop
    ctx.store.update(task.id, { status: "PENDING" });
    logger.debug("task_queued_no_agent", "Task queued: no agent available", {
      metadata: { task_id: task.id, tier: task.tier },
    });
    return;
  }

  // Assign task in DB
  ctx.store.update(task.id, {
    status:         "ASSIGNED",
    assigned_agent: assignment.agent_id,
  });

  // Update in-memory agent tracking
  const inst = ctx.agents.get(assignment.agent_id);
  if (inst !== undefined) {
    inst.active_task_count++;
    inst.status = inst.active_task_count >= inst.definition.max_concurrent_tasks
      ? "overloaded"
      : "busy";

    // IPC: send task to agent subprocess
    inst.process.send({ type: "TASK_ASSIGNED", task_id: task.id });
  }

  logger.info("task_assigned", "Task assigned", {
    metadata: { task_id: task.id, agent_id: assignment.agent_id, reason: assignment.reason },
  });
}

export async function handleResultReady(ctx: EventHandlerContext, event: TaskEvent): Promise<void> {
  const task = ctx.store.get(event.task_id);
  if (task === null) return;

  const now = new Date().toISOString();

  // Update task to DONE if not already
  if (task.status !== "DONE") {
    ctx.store.update(task.id, {
      status:       "DONE",
      completed_at: task.completed_at ?? now,
    });
  }

  // Update agent tracking
  const agentId = task.assigned_agent;
  if (agentId !== null) {
    const inst = ctx.agents.get(agentId);
    if (inst !== undefined) {
      inst.active_task_count   = Math.max(0, inst.active_task_count - 1);
      inst.total_tasks_completed++;
      inst.status              = inst.active_task_count === 0 ? "idle" : "busy";
    }

    // Phase 9.5: notify pipeline of COMPLETED state
    if (ctx.pipeline !== null) {
      ctx.pipeline.handleAck(task.id, AckState.COMPLETED, agentId);
    }
  }

  if (task.parent_id === null) {
    // Root task complete — user will be notified by Phase 10/11
    logger.info("root_task_complete", "Root task complete", { metadata: { task_id: task.id } });
    return;
  }

  // Child task: check if parent is ready for synthesis
  const completedTask = ctx.store.get(task.id) ?? task;
  const synthStatus   = ctx.synthesisCollector.registerResult({
    ...completedTask,
    status: "DONE",
  });

  if (synthStatus.ready) {
    await ctx.synthesisCollector.triggerParentSynthesis(
      synthStatus.parent_task_id,
      synthStatus.child_summaries,
    );
  }
}

export async function handleTaskFailed(ctx: EventHandlerContext, event: TaskEvent): Promise<void> {
  const task = ctx.store.get(event.task_id);
  if (task === null) return;

  // Update agent tracking
  const agentId = task.assigned_agent;
  if (agentId !== null) {
    const inst = ctx.agents.get(agentId);
    if (inst !== undefined) {
      inst.active_task_count = Math.max(0, inst.active_task_count - 1);
      inst.status            = inst.active_task_count === 0 ? "idle" : "busy";
    }

    // Phase 9.5: notify pipeline of FAILED state
    if (ctx.pipeline !== null) {
      ctx.pipeline.handleAck(task.id, AckState.FAILED, agentId);
    }
  }

  if (task.retry_count < task.max_retries) {
    // Retry: reset to PENDING, increment counter
    ctx.store.update(task.id, {
      status:         "PENDING",
      retry_count:    task.retry_count + 1,
      assigned_agent: null,
    });
    logger.info("task_queued_for_retry", "Task queued for retry", {
      metadata: { task_id: task.id, retry: task.retry_count + 1, max: task.max_retries },
    });
  } else {
    // Retries exhausted → escalate
    ctx.store.update(task.id, { status: "FAILED" });
    const refreshed = ctx.store.get(task.id) ?? task;
    ctx.escalationManager.escalate(refreshed, "max_retries_exceeded");
  }
}

export async function handleEscalation(ctx: EventHandlerContext, event: TaskEvent): Promise<void> {
  const task = ctx.store.get(event.task_id);
  if (task === null) return;

  const reason = (event.data["reason"] as string ?? "agent_requested") as EscalationReason;
  ctx.escalationManager.escalate(task, reason);
}

export async function handleConsultation(ctx: EventHandlerContext, event: TaskEvent): Promise<void> {
  const task = ctx.store.get(event.task_id);
  if (task === null) return;

  ctx.peerRouter.route(task);
}

export async function handleAgentCrash(ctx: EventHandlerContext, event: TaskEvent): Promise<void> {
  const agentId = event.agent_from;
  if (agentId === null) return;

  const inst = ctx.agents.get(agentId);
  if (inst !== undefined) {
    inst.status = "crashed";
  }

  // Tasks assigned to crashed agent — without checkpoint: reset to PENDING
  const activeTasks = ctx.store.getByAgent(agentId);
  for (const task of activeTasks) {
    if (task.status === "RUNNING" || task.status === "ASSIGNED") {
      if (task.checkpoint === null) {
        ctx.store.update(task.id, {
          status:         "PENDING",
          assigned_agent: null,
          retry_count:    task.retry_count + 1,
        });
      }
      // Tasks with checkpoint: agent will resume after ITBootstrapAgent restarts it
    }
  }

  logger.warn("agent_crashed", "Agent crashed", {
    metadata: { agent_id: agentId, tasks_affected: activeTasks.length },
  });
}

export async function handleAgentRecovery(ctx: EventHandlerContext, event: TaskEvent): Promise<void> {
  const agentId = event.agent_from;
  if (agentId === null) return;

  const inst = ctx.agents.get(agentId);
  if (inst !== undefined) {
    inst.status = inst.active_task_count > 0 ? "busy" : "idle";
  }

  logger.info("agent_recovered", "Agent recovered", { metadata: { agent_id: agentId } });
}

export async function handleBudgetExceeded(ctx: EventHandlerContext, event: TaskEvent): Promise<void> {
  const task = ctx.store.get(event.task_id);
  if (task === null) return;

  ctx.escalationManager.escalate(task, "budget_exceeded");
}

export async function handleHeartbeatTimeout(ctx: EventHandlerContext, event: TaskEvent): Promise<void> {
  // ITBootstrapAgent (Phase 8) handles the actual process health check and restart.
  // Orchestrator just logs and marks the agent as potentially unhealthy.
  const agentId = (event.data["agent_id"] as string | undefined) ?? event.agent_to;

  logger.warn("heartbeat_timeout", "Heartbeat timeout — delegating to ITBootstrapAgent", {
    metadata: { agent_id: agentId, task_id: event.task_id },
  });

  if (agentId !== null) {
    const inst = ctx.agents.get(agentId);
    if (inst !== undefined && inst.status !== "crashed") {
      inst.last_heartbeat = new Date().toISOString();
      // ITBootstrapAgent will emit AGENT_CRASHED if process is confirmed dead
    }
  }
}
