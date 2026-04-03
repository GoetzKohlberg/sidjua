// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 8: AgentLoop
 *
 * Core execution cycle running inside each agent subprocess.
 * The agent "thinks" here — dequeuing tasks, calling LLM, parsing decisions,
 * creating sub-tasks, writing results, and routing to parents.
 *
 * Execution cycle (one iteration):
 *   1. Check events (RESULT_READY, CONSULTATION_RESPONSE, system events)
 *   2. Check waiting tasks (all sub-tasks received? → synthesis)
 *   3. Pick next task (if capacity available)
 *   4. Execute task (EXECUTE or DECOMPOSE via LLM)
 *   5. Checkpoint if interval elapsed
 *   6. Cost check (approaching hourly limit?)
 *   6.5 Memory health check (if interval elapsed)
 *   7. Sleep sleepMs, repeat
 */

import { randomUUID } from "node:crypto";
import type { AgentDefinition, AgentState, AgentDecision, SubTaskPlan, TaskCheckpoint, MemoryHygieneConfig, HygieneCycleResult } from "./types.js";
import type { ActionExecutor } from "./action-executor.js";
import type { AgentContext } from "./context.js";
import type { CheckpointManager } from "./checkpoint.js";
import type { MemoryManager } from "./memory.js";
import type { ProviderRegistry } from "../provider/registry.js";
import type { TaskStore } from "../tasks/store.js";
import type { TaskQueue } from "../tasks/queue.js";
import type { TaskEventBus } from "../tasks/event-bus.js";
import type { TaskStateMachine } from "../tasks/state-machine.js";
import type { ResultStore } from "../tasks/result-store.js";
import type { TaskRouter } from "../tasks/router.js";
import type { Task, ManagementSummary, TaskEvent } from "../tasks/types.js";
import { DecompositionValidator } from "../tasks/decomposition.js";
import { parseAgentResponse } from "./response-parser.js";
import { createLogger, type Logger } from "../core/logger.js";

const _logger = createLogger("agent-loop");


export interface AgentLoopProviders {
  registry: ProviderRegistry;
  taskStore: TaskStore;
  taskQueue: TaskQueue;
  eventBus: TaskEventBus;
  stateMachine: TaskStateMachine;
  resultStore: ResultStore;
  taskRouter: TaskRouter;
  actionExecutor: ActionExecutor;
  checkpointManager: CheckpointManager;
  memoryManager: MemoryManager;
  context: AgentContext;
}


export class AgentLoop {
  private _running = false;
  private _paused = false;
  private readonly _activeTaskIds = new Set<string>();
  private readonly _waitingTaskIds = new Set<string>();
  private _lastCheckpointTime    = Date.now();
  private _checkpointFailCount   = 0;
  private _checkpointBackoffUntil = 0;
  private _lastMemoryCheckTime   = Date.now();
  private readonly _decompositionValidator = new DecompositionValidator();
  private readonly _sleepMs: number;
  private readonly _memoryCheckIntervalMs: number;

  private _state: AgentState;

  constructor(
    private readonly definition: AgentDefinition,
    private readonly providers: AgentLoopProviders,
    private readonly logger: Logger = createLogger("agent-loop"),
    options: { sleepMs?: number; memoryCheckIntervalMs?: number } = {},
  ) {
    this._sleepMs = options.sleepMs ?? 100;
    this._memoryCheckIntervalMs = options.memoryCheckIntervalMs ?? 300_000;
    this._state = buildInitialState(definition);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start the execution loop. Resolves when stop() is called. */
  async start(): Promise<void> {
    this._running = true;
    this._state.started_at = new Date().toISOString();
    this._state.status = "IDLE";

    this.logger.info("agent_loop_started", "AgentLoop started", { metadata: { agent_id: this.definition.id } });

    while (this._running) {
      if (this._paused) {
        await sleep(this._sleepMs);
        continue;
      }

      try {
        await this._checkEvents();
        await this._checkWaitingTasks();
        await this._pickAndExecuteTask();
        await this._maybeSaveCheckpoint();
        this._checkCostLimit();
        await this._maybeCheckMemoryHealth();
      } catch (err) {
        this.logger.error("loop_iteration_error", "Loop iteration error", {
          metadata: { agent_id: this.definition.id, error: err instanceof Error ? err.message : String(err) },
        });
        // Continue loop — don't crash on a single iteration error
      }

      await sleep(this._sleepMs);
    }

    this.logger.info("agent_loop_stopped", "AgentLoop stopped", { metadata: { agent_id: this.definition.id } });
  }

  /** Stop the loop. If graceful, waits for active tasks to finish. */
  async stop(graceful: boolean): Promise<void> {
    if (graceful && this._activeTaskIds.size > 0) {
      this.logger.info("graceful_stop_waiting", "Graceful stop: waiting for active tasks", {
        metadata: { agent_id: this.definition.id, active_count: this._activeTaskIds.size },
      });
      // Wait up to 30s for active tasks
      const deadline = Date.now() + 30_000;
      while (this._activeTaskIds.size > 0 && Date.now() < deadline) {
        await sleep(100);
      }
    }
    this._running = false;
  }

  pause(): void {
    this._paused = true;
    this._state.status = "PAUSED";
    this.logger.info("agent_loop_paused", "AgentLoop paused", { metadata: { agent_id: this.definition.id } });
  }

  resume(): void {
    this._paused = false;
    this._state.status = this._activeTaskIds.size > 0 ? "WORKING" : "IDLE";
    this.logger.info("agent_loop_resumed", "AgentLoop resumed", { metadata: { agent_id: this.definition.id } });
  }

  isPaused(): boolean {
    return this._paused;
  }

  isRunning(): boolean {
    return this._running;
  }

  getState(): AgentState {
    return {
      ...this._state,
      active_tasks: [...this._activeTaskIds],
      waiting_tasks: [...this._waitingTaskIds],
    };
  }

  // ---------------------------------------------------------------------------
  // Step 1: Check events
  // ---------------------------------------------------------------------------

  private async _checkEvents(): Promise<void> {
    const events = await this.providers.eventBus.consume(this.definition.id);
    for (const event of events) {
      await this._handleEvent(event);
    }
  }

  private async _handleEvent(event: TaskEvent): Promise<void> {
    switch (event.event_type) {
      case "RESULT_READY":
      case "TASK_PROGRESS": {
        // A sub-task completed → check if waiting parent is now complete
        const parentId = event.parent_task_id;
        if (parentId !== null && this._waitingTaskIds.has(parentId)) {
          const completion = await this.providers.taskRouter.checkParentCompletion(parentId);
          if (completion.complete) {
            this.logger.debug("waiting_task_ready", "Waiting task ready for synthesis", {
              metadata: { agent_id: this.definition.id, task_id: parentId },
            });
            // Mark as ready for synthesis — it will be picked up in _checkWaitingTasks
          }
        }
        break;
      }

      case "CONSULTATION_RESPONSE": {
        // Store consultation response in short-term memory
        const response = event.data["response"] as string | undefined;
        const consultId = event.data["consultation_task_id"] as string | undefined;
        if (response !== undefined && consultId !== undefined) {
          await this.providers.memoryManager.appendShortTerm(
            `Consultation response (task ${consultId}):\n${response}`,
          );
        }
        break;
      }

      default:
        // Ignore other event types
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: Check waiting tasks
  // ---------------------------------------------------------------------------

  private async _checkWaitingTasks(): Promise<void> {
    for (const taskId of [...this._waitingTaskIds]) {
      const task = this.providers.taskStore.get(taskId);
      if (task === null) {
        this._waitingTaskIds.delete(taskId);
        continue;
      }

      const completion = await this.providers.taskRouter.checkParentCompletion(taskId);
      if (completion.complete) {
        this._waitingTaskIds.delete(taskId);
        // Begin synthesis asynchronously
        this._runSynthesis(task).catch((err) => {
          this.logger.error("synthesis_error", "Synthesis error", {
            metadata: { agent_id: this.definition.id, task_id: taskId, error: String(err) },
          });
          this._activeTaskIds.delete(taskId);
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: Pick next task
  // ---------------------------------------------------------------------------

  private async _pickAndExecuteTask(): Promise<void> {
    if (this._activeTaskIds.size >= this.definition.max_concurrent_tasks) return;

    const task = this.providers.taskQueue.dequeue(this.definition.id);
    if (task === null) {
      if (this._activeTaskIds.size === 0 && this._waitingTaskIds.size === 0) {
        this._state.status = "IDLE";
      }
      return;
    }

    this._state.status = "WORKING";
    // Fire-and-forget: tasks run concurrently
    this._executeTask(task).catch((err) => {
      this.logger.error("task_execution_error", "Task execution error", {
        metadata: { agent_id: this.definition.id, task_id: task.id, error: String(err) },
      });
      this._activeTaskIds.delete(task.id);
      this._updateStatus();
    });
  }

  // ---------------------------------------------------------------------------
  // Step 4: Execute task
  // ---------------------------------------------------------------------------

  private async _executeTask(assignedTask: Task): Promise<void> {
    // Transition to RUNNING
    let task: Task;
    try {
      task = await this.providers.stateMachine.transition(assignedTask, "RUNNING");
    } catch (e: unknown) {
      _logger.warn("agent-loop", "Task status transition failed — task may already be in terminal state", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      // May already be in a non-transitionable state
      task = this.providers.taskStore.get(assignedTask.id) ?? assignedTask;
      if (task.status !== "RUNNING") return;
    }

    this._activeTaskIds.add(task.id);
    this._updateStatus();

    this.logger.debug("executing_task", "Executing task", {
      metadata: { agent_id: this.definition.id, task_id: task.id, task_type: task.type, task_title: task.title },
    });

    try {
      if (task.type === "consultation") {
        await this._executeConsultation(task);
      } else {
        await this._executeMainTask(task);
      }
    } finally {
      this._activeTaskIds.delete(task.id);
      this._updateStatus();
    }
  }

  private async _executeMainTask(task: Task): Promise<void> {
    const messages = await this.providers.context.buildMessages(task);
    const llmRequest = this.providers.context.buildLLMRequest(messages, task);

    const result = await this.providers.actionExecutor.executeLLMCall(llmRequest, task);

    if (!result.success || result.response === undefined) {
      const reason = result.block_reason ?? "LLM call failed";
      this.logger.warn("llm_call_failed", "LLM call failed/blocked", {
        metadata: { agent_id: this.definition.id, task_id: task.id, reason },
      });
      await this._failTask(task, reason);
      return;
    }

    const parsed = parseAgentResponse(result.response.content);

    if (parsed === null) {
      // Retry once with clarification
      const retryParsed = await this._retryWithClarification(task, result.response.content);
      if (retryParsed === null) {
        await this._failTask(task, "Could not parse LLM response after retry");
        return;
      }
      await this._actOnDecision(task, retryParsed, result.response);
    } else {
      await this._actOnDecision(task, parsed, result.response);
    }
  }

  private async _executeConsultation(task: Task): Promise<void> {
    const messages = await this.providers.context.buildConsultationMessages(task);
    const llmRequest = this.providers.context.buildLLMRequest(messages, task);

    const result = await this.providers.actionExecutor.executeLLMCall(llmRequest, task);

    if (!result.success || result.response === undefined) {
      await this._failTask(task, result.block_reason ?? "Consultation LLM call failed");
      return;
    }

    // For consultation, extract the response text (less strict format)
    const responseText = extractConsultationResponse(result.response.content);

    // Complete the consultation task
    await this.providers.stateMachine.transition(task, "DONE", {
      result_summary: responseText.slice(0, 500),
      confidence: 0.85,
    });

    // Route consultation response back to requester
    const completedTask = this.providers.taskStore.get(task.id)!;
    await this.providers.taskRouter.routeConsultation(completedTask, responseText);
  }

  private async _actOnDecision(
    task: Task,
    parsed: AgentDecision,
    response: { costUsd: number; usage: { totalTokens: number } },
  ): Promise<void> {
    if (parsed.decision === "EXECUTE") {
      await this._handleExecuteDecision(task, parsed, response);
    } else {
      await this._handleDecomposeDecision(task, parsed);
    }
  }

  private async _handleExecuteDecision(
    task: Task,
    parsed: Extract<AgentDecision, { decision: "EXECUTE" }>,
    response: { costUsd: number; usage: { totalTokens: number } },
  ): Promise<void> {
    // Complete the task
    const doneTask = await this.providers.stateMachine.transition(task, "DONE", {
      result_summary: parsed.summary,
      confidence: parsed.confidence,
    });

    // Build management summary
    const summary: ManagementSummary = {
      task_id: task.id,
      parent_task_id: task.parent_id ?? task.root_id,
      agent_id: this.definition.id,
      confidence: parsed.confidence,
      key_findings: parsed.summary,
      result_file: "",
      tokens_used: response.usage.totalTokens,
      cost_usd: response.costUsd,
      completed_at: new Date().toISOString(),
    };

    // Route result to parent (writes file, increments counter, emits events)
    await this.providers.taskRouter.routeResult(doneTask, summary);

    // Update memory with what we learned
    const experience = this.providers.memoryManager.buildExperienceEntry(
      task,
      `Executed directly. Confidence: ${parsed.confidence}. ${parsed.summary}`,
    );
    await this.providers.memoryManager.addLongTerm(experience);
    await this.providers.memoryManager.appendShortTerm(
      `Completed task "${task.title}" (EXECUTE). ${parsed.summary}`,
    );

    // Update agent cost tracking
    this._state.total_cost_usd += response.costUsd;
    this._state.total_tokens_used += response.usage.totalTokens;
    this._state.current_hour_cost += response.costUsd;

    this.logger.info("task_executed_completed", "Task executed and completed", {
      metadata: { agent_id: this.definition.id, task_id: task.id, confidence: parsed.confidence },
    });
  }

  private async _handleDecomposeDecision(
    task: Task,
    parsed: Extract<AgentDecision, { decision: "DECOMPOSE" }>,
  ): Promise<void> {
    if (parsed.plan.length === 0) {
      await this._failTask(task, "Decompose response had empty plan");
      return;
    }

    // Build CreateTaskInput array for validation
    const childInputs = parsed.plan.map((p) => buildChildInput(p, task, this.definition));

    // Validate via DecompositionValidator
    const validation = this._decompositionValidator.validate(task, childInputs);
    if (!validation.valid) {
      await this._failTask(
        task,
        `Decomposition validation failed: ${validation.errors.join("; ")}`,
      );
      return;
    }

    // Create child tasks
    const children = childInputs.map((input) =>
      this.providers.taskStore.create(input),
    );

    // Update parent with expected count
    const updatedTask = this.providers.taskStore.update(task.id, {
      sub_tasks_expected: children.length,
    });

    // Transition parent to WAITING
    const waitingTask = await this.providers.stateMachine.transition(updatedTask, "WAITING");
    this._waitingTaskIds.add(waitingTask.id);

    // Enqueue children
    for (const child of children) {
      this.providers.taskQueue.enqueue(child);
    }

    // Update memory
    await this.providers.memoryManager.appendShortTerm(
      `Decomposed task "${task.title}" into ${children.length} sub-tasks.`,
    );

    this.logger.info("task_decomposed", "Task decomposed into sub-tasks", {
      metadata: { agent_id: this.definition.id, task_id: task.id, child_count: children.length },
    });
  }

  // ---------------------------------------------------------------------------
  // Synthesis
  // ---------------------------------------------------------------------------

  private async _runSynthesis(waitingTask: Task): Promise<void> {
    this._activeTaskIds.add(waitingTask.id);
    this._updateStatus();

    try {
      // Reload fresh task state
      let task = this.providers.taskStore.get(waitingTask.id);
      if (task === null) return;

      // Transition back to RUNNING for synthesis
      task = await this.providers.stateMachine.transition(task, "RUNNING");

      // Gather child summaries
      const children = this.providers.taskStore.getByParent(task.id)
        .filter((c) => c.status === "DONE" && c.type !== "consultation");

      const summaries = children.map((c) =>
        `**${c.title}** (confidence: ${c.confidence ?? "N/A"})\n${c.result_summary ?? "(no summary)"}`,
      );

      // Also try reading full result files for low-confidence children
      const skill = this.providers.context["skill"]; // access private field
      const fullReviews: string[] = [];
      let fullReviewCount = 0;
      const maxFullReviews = skill?.review_behavior?.max_full_reviews_per_synthesis ?? 3;
      const threshold = skill?.review_behavior?.confidence_threshold ?? 0.8;

      for (const child of children) {
        if (fullReviewCount >= maxFullReviews) break;
        if ((child.confidence ?? 1.0) < threshold && child.result_file) {
          try {
            const fullResult = await this.providers.resultStore.readResult(
              child.id,
              child.division,
            );
            if (fullResult) {
              fullReviews.push(
                `**Full review: ${child.title}**\n${fullResult.content}`,
              );
              fullReviewCount++;
            }
          } catch (e: unknown) {
            _logger.debug("agent-loop", "Context file not readable — using summary only", { metadata: { error: e instanceof Error ? e.message : String(e) } });
          }
        }
      }

      const allSummaries = [...summaries, ...fullReviews];

      // Build synthesis messages
      const messages = await this.providers.context.buildSynthesisMessages(task, allSummaries);
      const llmRequest = this.providers.context.buildLLMRequest(messages, task);

      const result = await this.providers.actionExecutor.executeLLMCall(llmRequest, task);

      if (!result.success || result.response === undefined) {
        await this._failTask(task, result.block_reason ?? "Synthesis LLM call failed");
        return;
      }

      const parsed = parseAgentResponse(result.response.content);
      if (parsed === null || parsed.decision !== "EXECUTE") {
        await this._failTask(task, "Synthesis produced invalid response");
        return;
      }

      // Complete synthesis task
      const doneTask = await this.providers.stateMachine.transition(task, "DONE", {
        result_summary: parsed.summary,
        confidence: parsed.confidence,
      });

      const summary: ManagementSummary = {
        task_id: task.id,
        parent_task_id: task.parent_id ?? task.root_id,
        agent_id: this.definition.id,
        confidence: parsed.confidence,
        key_findings: parsed.summary,
        result_file: "",
        tokens_used: result.response.usage.totalTokens,
        cost_usd: result.response.costUsd,
        completed_at: new Date().toISOString(),
      };

      await this.providers.taskRouter.routeResult(doneTask, summary);

      await this.providers.memoryManager.appendShortTerm(
        `Synthesized "${task.title}" from ${children.length} sub-tasks. ${parsed.summary}`,
      );

      this._state.total_cost_usd += result.response.costUsd;
      this._state.total_tokens_used += result.response.usage.totalTokens;
      this._state.current_hour_cost += result.response.costUsd;

      this.logger.info("synthesis_complete", "Synthesis complete", {
        metadata: { agent_id: this.definition.id, task_id: task.id, child_count: children.length },
      });
    } finally {
      this._activeTaskIds.delete(waitingTask.id);
      this._updateStatus();
    }
  }

  // ---------------------------------------------------------------------------
  // Retry
  // ---------------------------------------------------------------------------

  private async _retryWithClarification(
    task: Task,
    originalResponse: string,
  ): Promise<AgentDecision | null> {
    this.logger.warn("malformed_response_retry", "Malformed response — retrying with clarification", {
      metadata: { agent_id: this.definition.id, task_id: task.id },
    });

    const clarification = `Your previous response was not in the required format. Please try again.

Previous response (excerpt):
${originalResponse.slice(0, 300)}

You MUST respond with exactly:
DECISION: EXECUTE or DECOMPOSE
Then the appropriate RESULT/SUMMARY/CONFIDENCE or PLAN section.`;

    const messages = await this.providers.context.buildMessages(task, clarification);
    const llmRequest = this.providers.context.buildLLMRequest(messages, task);

    const result = await this.providers.actionExecutor.executeLLMCall(llmRequest, task);
    if (!result.success || result.response === undefined) return null;

    return parseAgentResponse(result.response.content);
  }

  // ---------------------------------------------------------------------------
  // Failure handling
  // ---------------------------------------------------------------------------

  private async _failTask(task: Task, reason: string): Promise<void> {
    this.logger.warn("task_failed", "Task failed", {
      metadata: { agent_id: this.definition.id, task_id: task.id, reason },
    });

    try {
      const currentTask = this.providers.taskStore.get(task.id) ?? task;
      if (currentTask.status === "RUNNING" || currentTask.status === "WAITING") {
        await this.providers.stateMachine.transition(currentTask, "FAILED", {
          error_message: reason,
        });
      }
    } catch (err) {
      this.logger.error("task_transition_failed", "Failed to transition task to FAILED", {
        metadata: { task_id: task.id, error: String(err) },
      });
    }

    // Record error in agent state
    this._addError("unknown", reason, task.id);
  }

  // ---------------------------------------------------------------------------
  // Step 5: Checkpoint
  // ---------------------------------------------------------------------------

  private async _maybeSaveCheckpoint(): Promise<void> {
    const now = Date.now();

    // Exponential backoff on repeated failures
    if (now < this._checkpointBackoffUntil) return;

    if (now - this._lastCheckpointTime < this.definition.checkpoint_interval_ms) return;

    try {
      await this._saveCheckpoint();
      this._lastCheckpointTime    = now;
      this._checkpointFailCount   = 0;
      this._checkpointBackoffUntil = 0;
    } catch (err: unknown) {
      this._checkpointFailCount++;
      // Backoff: 2s, 4s, 8s, 16s, 32s, cap at 60s
      const backoffMs = Math.min(2000 * Math.pow(2, this._checkpointFailCount - 1), 60_000);
      this._checkpointBackoffUntil = now + backoffMs;
      this.logger.warn("checkpoint_save_failed", `Checkpoint save failed (attempt ${this._checkpointFailCount}, next retry in ${backoffMs}ms)`, {
        metadata: { agent_id: this.definition.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private async _saveCheckpoint(): Promise<void> {
    const taskStates: TaskCheckpoint[] = [];
    for (const taskId of [...this._activeTaskIds, ...this._waitingTaskIds]) {
      const t = this.providers.taskStore.get(taskId);
      if (t !== null) {
        taskStates.push({
          task_id: taskId,
          status: t.status,
          progress_notes: "",
          messages_so_far: 0,
          partial_result: t.result_summary,
        });
      }
    }

    // Let errors propagate to _maybeSaveCheckpoint for backoff handling
    const version = await this.providers.checkpointManager.save({
      agent_id: this.definition.id,
      timestamp: new Date().toISOString(),
      version: 0, // will be overwritten by manager
      state: this.getState(),
      task_states: taskStates,
      memory_snapshot: this.providers.memoryManager.serialize(),
    });

    this._state.last_checkpoint = new Date().toISOString();

    this.logger.debug("checkpoint_saved", "Checkpoint saved", {
      metadata: { agent_id: this.definition.id, version },
    });

    // Keep only last 5
    await this.providers.checkpointManager.cleanup(this.definition.id, 5);
  }

  // ---------------------------------------------------------------------------
  // Step 6: Cost check
  // ---------------------------------------------------------------------------

  private _checkCostLimit(): void {
    // Reset hourly window if needed
    const now = Date.now();
    const hourStart = new Date(this._state.hour_start).getTime();
    if (now - hourStart > 3_600_000) {
      this._state.current_hour_cost = 0;
      this._state.hour_start = new Date().toISOString();
    }

    if (this._state.current_hour_cost >= this.definition.cost_limit_per_hour) {
      this.logger.warn("hourly_cost_limit_reached", "Hourly cost limit reached — pausing", {
        metadata: {
          agent_id: this.definition.id,
          current_hour_cost: this._state.current_hour_cost,
          limit: this.definition.cost_limit_per_hour,
        },
      });
      this.pause();
    }
  }

  // ---------------------------------------------------------------------------
  // Step 6.5: Memory health check
  // ---------------------------------------------------------------------------

  private async _maybeCheckMemoryHealth(): Promise<void> {
    const now = Date.now();
    if (now - this._lastMemoryCheckTime < this._memoryCheckIntervalMs) return;
    this._lastMemoryCheckTime = now;

    try {
      const health = await this.providers.memoryManager.getMemoryHealth();

      const status = health.short_term.status;
      if (status === "warning" || status === "critical") {
        this.logger.warn("memory_health_degraded", "Short-term memory health degraded", {
          metadata: { agent_id: this.definition.id, status, size_kb: health.short_term.size_kb },
        });

        // Auto-compact on warning/critical
        try {
          await this.providers.memoryManager.compactShortTerm("smart");
          this.logger.info("memory_auto_compacted", "Auto-compacted short-term memory", {
            metadata: { agent_id: this.definition.id },
          });
        } catch (compactErr) {
          this.logger.warn("memory_compaction_failed", "Auto-compaction failed", {
            metadata: {
              agent_id: this.definition.id,
              error: compactErr instanceof Error ? compactErr.message : String(compactErr),
            },
          });
        }
      }
    } catch (err) {
      this.logger.error("memory_health_check_error", "Memory health check error", {
        metadata: { agent_id: this.definition.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /**
   * Handle a HYGIENE_REQUEST from Bootstrap (via IPC).
   * Runs a full hygiene cycle and returns the result.
   */
  async handleHygieneRequest(config: MemoryHygieneConfig): Promise<HygieneCycleResult> {
    this.logger.info("hygiene_cycle_requested", "Running hygiene cycle (requested by Bootstrap)", {
      metadata: { agent_id: this.definition.id },
    });
    return this.providers.memoryManager.runHygieneCycle(config);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _updateStatus(): void {
    if (this._paused) {
      this._state.status = "PAUSED";
    } else if (this._activeTaskIds.size > 0) {
      this._state.status = "WORKING";
    } else if (this._waitingTaskIds.size > 0) {
      this._state.status = "WAITING";
    } else {
      this._state.status = "IDLE";
    }
  }

  private _addError(
    type: "crash" | "timeout" | "budget" | "provider" | "governance" | "unknown",
    message: string,
    taskId?: string,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      ...(taskId !== undefined ? { task_id: taskId } : {}),
    };
    this._state.error_log.push(entry);
    // Keep ring buffer at max 20
    if (this._state.error_log.length > 20) {
      this._state.error_log.shift();
    }
  }
}


function buildInitialState(definition: AgentDefinition): AgentState {
  return {
    agent_id: definition.id,
    status: "IDLE",
    pid: null,
    started_at: null,
    last_heartbeat: null,
    last_checkpoint: null,
    active_tasks: [],
    waiting_tasks: [],
    queued_tasks: 0,
    total_tokens_used: 0,
    total_cost_usd: 0,
    restart_count: 0,
    current_hour_cost: 0,
    hour_start: new Date().toISOString(),
    error_log: [],
  };
}

function buildChildInput(
  plan: SubTaskPlan,
  parentTask: Task,
  definition: AgentDefinition,
) {
  return {
    title: plan.title,
    description: plan.description,
    division: parentTask.division,
    type: "delegation" as const,
    tier: plan.tier,
    parent_id: parentTask.id,
    root_id: parentTask.root_id,
    token_budget: Math.floor(definition.token_budget_per_task / 2),
    cost_budget: parentTask.cost_budget / 4,
    metadata: { created_by_decomposition: true },
  };
}

function extractConsultationResponse(text: string): string {
  // For consultation, extract RESULT section if present, otherwise return full text
  const resultMatch = text.match(/RESULT\s*:\s*\n([\s\S]*?)(?=SUMMARY\s*:|CONFIDENCE\s*:|$)/i);
  if (resultMatch) return resultMatch[1]!.trim();

  // Try to remove the format headers and return content
  return text
    .replace(/^DECISION\s*:.*$/im, "")
    .replace(/^RESULT\s*:\s*$/im, "")
    .replace(/^SUMMARY\s*:.*$/im, "")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
