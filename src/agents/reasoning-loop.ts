// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13b: AgentReasoningLoop
 *
 * Multi-turn reasoning loop that uses real LLM tool-use calls (Phase 13a)
 * to drive an agent through a task to completion.
 *
 * This WRAPS (does not replace) the Phase 8 AgentLoop. AgentLoop still owns
 * the task dequeue/schedule/state-machine lifecycle. AgentReasoningLoop owns
 * the multi-turn LLM conversation for a single task execution.
 *
 * Turn lifecycle:
 *   1. Build messages (system prompt + task description + memory)
 *   2. Call provider.chatWithTools(messages, AGENT_DECISION_TOOLS)
 *   3. Parse → AgentDecision (Phase 13a ToolResponseParser)
 *   4. Switch on decision type → terminal or continue
 *
 * Safety rails:
 *   - max_turns_per_task    → force escalate on EXEC-001
 *   - max_tool_calls_per_task → force partial execute_result
 *   - turn_timeout_ms       → retry once, then escalate on EXEC-002
 *   - no_tool_call          → retry once with stronger prompt, then escalate
 *   - Context overflow      → summarize and continue (AGT-004 logged)
 *   - Checkpoint saved every checkpoint_every_n_turns turns
 */

import { createLogger }         from "../core/logger.js";
import { SidjuaError }          from "../core/error-codes.js";
import { AGENT_DECISION_TOOLS } from "../providers/tool-response-parser.js";
import type { ToolResponseParser } from "../providers/tool-response-parser.js";
import type {
  ProviderAdapter,
  LLMMessage,
  AgentDecision,
  TokenUsage,
} from "../providers/types.js";
import type { AgentDefinition }   from "./types.js";
import type { MemoryManager }     from "./memory.js";
import type { CheckpointManager } from "./checkpoint.js";
import type { PromptBuilder }   from "./prompt-builder.js";
import type { ActionExecutor }  from "./action-executor.js";
import { toolSchemaBuilder }    from "../tool-integration/tool-schema-builder.js";
import type { RbacContext }     from "../tool-integration/tool-rbac.js";
import type { Task }            from "../tasks/types.js";
import type { TaskStore }       from "../tasks/store.js";
import type { TaskEventBus }    from "../tasks/event-bus.js";

const logger = createLogger("reasoning-loop");


export interface ReasoningLoopConfig {
  /** Max reasoning turns before force-escalating (default: T1=20, T2=15, T3=10). */
  max_turns_per_task:       number;
  /** Max external tool calls before forcing a partial result (default: 50). */
  max_tool_calls_per_task:  number;
  /** Save a checkpoint every N turns (default: 5). */
  checkpoint_every_n_turns: number;
  /** Per-turn timeout in ms (default: 120 000). */
  turn_timeout_ms:          number;
  /**
   * Max estimated tokens before summarising the conversation (default: 150 000).
   * Set relative to the model's context window.
   */
  context_window_limit:     number;
}

/** Recommended defaults keyed by agent tier. */
export const DEFAULT_REASONING_CONFIG: Record<1 | 2 | 3, ReasoningLoopConfig> = {
  1: { max_turns_per_task: 20, max_tool_calls_per_task: 50, checkpoint_every_n_turns: 5, turn_timeout_ms: 120_000, context_window_limit: 150_000 },
  2: { max_turns_per_task: 15, max_tool_calls_per_task: 50, checkpoint_every_n_turns: 5, turn_timeout_ms: 120_000, context_window_limit: 150_000 },
  3: { max_turns_per_task: 10, max_tool_calls_per_task: 50, checkpoint_every_n_turns: 5, turn_timeout_ms: 120_000, context_window_limit: 150_000 },
};


export interface TaskResult {
  success:       boolean;
  decision:      AgentDecision;
  turns_taken:   number;
  total_tokens:  number;
  total_cost_usd: number;
  /** Full conversation messages at completion. */
  messages:      LLMMessage[];
}


/**
 * Function type for dispatching an external tool call.
 * The caller wires this to their ToolManager adapter execution.
 * Return value is passed back to the LLM as the tool result.
 */
export type ToolDispatcher = (
  toolName:  string,
  toolInput: Record<string, unknown>,
) => Promise<unknown>;

/** Cost recorder function (optional — wired to CostTracker in production). */
export type CostRecorder = (params: {
  divisionCode:  string;
  agentId:       string;
  provider:      string;
  model:         string;
  inputTokens:   number;
  outputTokens:  number;
  costUsd:       number;
  taskId:        string;
  /** Distinguishes LLM call costs from tool execution costs. */
  costType?:     "llm_call" | "tool_execution";
}) => void;


export interface ReasoningLoopDeps {
  /** Phase 13a raw-HTTP adapter for chatWithTools(). */
  provider:           ProviderAdapter;
  /** Phase 13a tool response parser. */
  toolParser:         ToolResponseParser;
  /** Phase 13b prompt builder. */
  promptBuilder:      PromptBuilder;
  /** Phase 8 action executor — governance enforcement for use_tool calls. */
  actionExecutor:     ActionExecutor;
  /** Phase 8 memory manager — load context and save task results. */
  memoryManager:      MemoryManager;
  /** Phase 8 checkpoint manager — periodic conversation state saves. */
  checkpointManager:  CheckpointManager;
  /** Phase 7 task store — create sub-tasks, update token/cost usage. */
  taskStore:          TaskStore;
  /** Phase 7 event bus — emit agent lifecycle events. */
  eventBus:           TaskEventBus;
  /** Pluggable tool executor. null = no external tools available. */
  dispatchTool:       ToolDispatcher | null;
  /** Optional cost recorder (wired to Phase 6 CostTracker). */
  recordCost?:        CostRecorder;
  /** Loop safety config. */
  config:             ReasoningLoopConfig;
}


export class AgentReasoningLoop {
  private readonly deps: ReasoningLoopDeps;

  constructor(deps: ReasoningLoopDeps) {
    this.deps = deps;
  }

  /**
   * Execute a single task through multi-turn LLM reasoning.
   *
   * The task MUST already be in RUNNING state (caller transitions via state machine).
   * This method drives the agent until a terminal decision is reached or safety
   * rails are triggered.
   *
   * @returns TaskResult (success/failure + full decision + usage stats)
   */
  async executeTask(task: Task, agent: AgentDefinition): Promise<TaskResult> {
    const { provider, toolParser, promptBuilder, memoryManager, config } = this.deps;

    // Eagerly load skill.md so buildSystemPrompt() can run sync
    await promptBuilder.preloadSkill(agent.skill_file);

    // Build the tools description list for the system prompt
    const toolDescriptions = AGENT_DECISION_TOOLS.map((t) => ({
      name:        t.name,
      description: t.description,
    }));

    // Build external tool schemas (internal + MCP) for this agent
    const rbacCtx: RbacContext = {
      agent_id: agent.id,
      tier:     agent.tier,
      division: agent.division,
      tools:    agent.tools ?? { internal: [], mcp: [] },
    };
    const { schemas: externalTools, tokenEstimate, toolCount } = toolSchemaBuilder.buildForAgent(rbacCtx);

    if (tokenEstimate > 2_000) {
      logger.warn("tool_schema_token_budget", "Tool schemas exceed 2000 tokens — consider reducing tool assignments", {
        metadata: { agent_id: agent.id, tools: toolCount, token_estimate: tokenEstimate },
      });
    }

    // Truncate if over 4000-token budget (keep internal tools, trim from end)
    const MAX_TOOL_TOKENS = 4_000;
    if (tokenEstimate > MAX_TOOL_TOKENS) {
      const maxSchemas = Math.floor(MAX_TOOL_TOKENS / 50);
      const original   = externalTools.length;
      externalTools.splice(maxSchemas);
      logger.warn("tool_schema_truncated", "Tool schemas truncated to fit token budget", {
        metadata: { agent_id: agent.id, kept: externalTools.length, original },
      });
    }

    // Build initial conversation
    const systemPrompt  = promptBuilder.buildSystemPrompt(agent, toolDescriptions, externalTools);
    const memoryContext = await memoryManager.getRelevantMemories(task, 800);
    const taskPrompt    = promptBuilder.buildTaskPrompt(task, memoryContext);

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user",   content: taskPrompt },
    ];

    let turn           = 0;
    let toolCallCount  = 0;
    let totalTokens    = 0;
    let totalCostUsd   = 0;
    let noToolRetries  = 0;

    // -------------------------------------------------------------------------
    // Main reasoning loop
    // -------------------------------------------------------------------------

    while (turn < config.max_turns_per_task) {
      turn++;

      this.deps.eventBus.emit("agent.turn.started", {
        agent_id: agent.id,
        task_id:  task.id,
        turn,
      });

      logger.info("reasoning_turn_started", `Turn ${turn}/${config.max_turns_per_task}`, {
        metadata: { agent_id: agent.id, task_id: task.id, turn },
      });

      // -- Checkpoint every N turns ------------------------------------------
      if (turn > 1 && (turn - 1) % config.checkpoint_every_n_turns === 0) {
        await this._saveCheckpoint(agent, task, messages, turn).catch((err) => {
          logger.warn("reasoning_checkpoint_failed", "Checkpoint save failed (continuing)", {
            metadata: { agent_id: agent.id, task_id: task.id, error: String(err) },
          });
        });
      }

      // -- Context window check -----------------------------------------------
      const estimatedTokens = provider.estimateTokens(messages);
      if (estimatedTokens > config.context_window_limit * 0.8) {
        logger.warn("reasoning_context_overflow", "Context nearing limit — summarising", {
          metadata: { agent_id: agent.id, task_id: task.id, estimated_tokens: estimatedTokens },
        });
        const summarised = this.deps.promptBuilder.summarizeConversation(messages, 10);
        messages.length = 0;
        messages.push(...summarised);
      }

      // -- LLM call with timeout ---------------------------------------------
      let toolResponse;
      try {
        toolResponse = await this._callWithTimeout(
          provider.chatWithTools(
            { messages, model: agent.model },
            AGENT_DECISION_TOOLS,
          ),
          config.turn_timeout_ms,
          "EXEC-002",
          agent,
          task,
        );
      } catch (err) {
        if (err instanceof SidjuaError && err.code === "EXEC-002") {
          // Turn timed out — retry once
          logger.warn("reasoning_turn_timeout", "Turn timeout — retrying once", {
            metadata: { agent_id: agent.id, task_id: task.id, turn },
          });
          try {
            toolResponse = await this._callWithTimeout(
              provider.chatWithTools({ messages, model: agent.model }, AGENT_DECISION_TOOLS),
              config.turn_timeout_ms,
              "EXEC-002",
              agent,
              task,
            );
          } catch (e: unknown) {
            logger.warn("reasoning-loop", "Retry timeout — escalating task", { metadata: { error: e instanceof Error ? e.message : String(e) } });
            // Timeout on retry → escalate
            return this._makeEscalationResult(
              task, agent, messages, turn, totalTokens, totalCostUsd,
              "Reasoning turn timed out after retry",
            );
          }
        } else {
          throw err;
        }
      }

      // Accumulate usage
      totalTokens  += toolResponse.usage.totalTokens;
      totalCostUsd += this._calculateCost(toolResponse.usage, agent);
      this._maybeRecordCost(toolResponse.usage, totalCostUsd, agent, task);

      // -- Parse decision ----------------------------------------------------
      let decision: AgentDecision;
      try {
        decision = toolParser.parse(toolResponse);
      } catch (e: unknown) {
        logger.warn("reasoning-loop", "Tool call parser failed — treating as no_tool_call", { metadata: { error: e instanceof Error ? e.message : String(e) } });
        decision = { type: "no_tool_call" };
      }

      this.deps.eventBus.emit("agent.turn.completed", {
        agent_id:      agent.id,
        task_id:       task.id,
        turn,
        decision_type: decision.type,
      });

      logger.info("reasoning_turn_decision", `Turn ${turn} → ${decision.type}`, {
        metadata: { agent_id: agent.id, task_id: task.id, turn, decision_type: decision.type },
      });

      // -- Switch on decision type -------------------------------------------

      if (decision.type === "no_tool_call") {
        noToolRetries++;
        if (noToolRetries >= 2) {
          return this._makeEscalationResult(
            task, agent, messages, turn, totalTokens, totalCostUsd,
            "Agent repeatedly failed to call a tool",
          );
        }
        // Retry with stronger instruction
        messages.push({
          role:    "user",
          content: "You MUST respond by calling one of the provided tools. " +
                   "Do not reply with plain text. Call the most appropriate tool now.",
        });
        continue;
      }

      if (decision.type === "think_more") {
        messages.push({ role: "assistant", content: decision.thoughts });
        messages.push({
          role:    "user",
          content: decision.next_step ?? "Continue with the next reasoning step.",
        });
        continue;
      }

      if (decision.type === "use_tool") {
        if (toolCallCount >= config.max_tool_calls_per_task) {
          // Force partial result
          logger.warn("reasoning_tool_limit", "Max tool calls reached — forcing partial result", {
            metadata: { agent_id: agent.id, task_id: task.id },
          });
          return {
            success:       false,
            decision:      {
              type:       "execute_result",
              result:     "Task partially completed — tool call limit reached.",
              summary:    "Partial result due to tool call limit.",
              confidence: 0.3,
            },
            turns_taken:    turn,
            total_tokens:   totalTokens,
            total_cost_usd: totalCostUsd,
            messages,
          };
        }

        toolCallCount++;

        // Governance enforcement before executing tool
        // Pass tool_input as parameters so policy/forbidden stages can inspect them
        const allowed = await this.deps.actionExecutor.executeAction(
          `custom.${decision.tool_name}`,
          decision.tool_name,
          decision.purpose,
          task,
          decision.tool_input as Record<string, unknown> | undefined,
        );

        if (!allowed.success) {
          this.deps.eventBus.emit("agent.tool.blocked", {
            agent_id:  agent.id,
            task_id:   task.id,
            tool_name: decision.tool_name,
            reason:    allowed.block_reason,
          });
          messages.push({
            role:    "assistant",
            content: `I tried to call tool \`${decision.tool_name}\` for: ${decision.purpose}`,
          });
          messages.push({
            role:    "user",
            content: `Tool call was blocked by governance: ${allowed.block_reason ?? "policy violation"}. ` +
                     `Choose a different approach that does not require this tool.`,
          });
          continue;
        }

        // Dispatch tool
        this.deps.eventBus.emit("agent.tool.called", {
          agent_id:  agent.id,
          task_id:   task.id,
          tool_name: decision.tool_name,
        });

        let toolResult: unknown = { status: "no_tool_dispatcher_configured" };
        if (this.deps.dispatchTool !== null) {
          try {
            toolResult = await this.deps.dispatchTool(decision.tool_name, decision.tool_input);
          } catch (err) {
            toolResult = { error: err instanceof Error ? err.message : String(err) };
            logger.warn("reasoning_tool_dispatch_error", `Tool dispatch failed: ${decision.tool_name}`, {
              metadata: { agent_id: agent.id, task_id: task.id, tool_name: decision.tool_name },
            });
          }

          // Record tool execution cost to ledger when the dispatcher
          // returns a cost_usd field (e.g. external API calls, paid tools).
          const resultObj = toolResult !== null && typeof toolResult === "object"
            ? toolResult as Record<string, unknown>
            : null;
          const toolCostUsd = typeof resultObj?.["cost_usd"] === "number"
            ? resultObj["cost_usd"]
            : 0;
          if (toolCostUsd > 0 && this.deps.recordCost !== undefined) {
            this.deps.recordCost({
              divisionCode: agent.division,
              agentId:      agent.id,
              provider:     "tool",
              model:        decision.tool_name,
              inputTokens:  0,
              outputTokens: 0,
              costUsd:      toolCostUsd,
              taskId:       task.id,
              costType:     "tool_execution",
            });
          }
        }

        messages.push({
          role:    "assistant",
          content: `Called tool \`${decision.tool_name}\`: ${decision.purpose}`,
        });
        messages.push(
          this.deps.promptBuilder.buildToolResultMessage(decision.tool_name, toolResult),
        );
        continue;
      }

      if (decision.type === "execute_result") {
        // Terminal: task complete
        this.deps.eventBus.emit("agent.task.completed", {
          agent_id:   agent.id,
          task_id:    task.id,
          confidence: decision.confidence,
        });

        // Update task usage in store
        this.deps.taskStore.update(task.id, {
          result_summary: decision.summary,
          confidence:     decision.confidence,
          token_used:     task.token_used + totalTokens,
          cost_used:      task.cost_used  + totalCostUsd,
        });

        // Save to memory
        await memoryManager.appendShortTerm(
          `Completed task "${task.title}" (execute_result). Confidence: ${decision.confidence}. ${decision.summary}`,
        );

        return {
          success:        true,
          decision,
          turns_taken:    turn,
          total_tokens:   totalTokens,
          total_cost_usd: totalCostUsd,
          messages,
        };
      }

      if (decision.type === "decompose_task") {
        // Create sub-tasks in TaskStore
        const children = decision.sub_tasks.map((st) =>
          this.deps.taskStore.create({
            title:        st.title,
            description:  st.description,
            division:     st.division ?? task.division,
            type:         "delegation",
            tier:         st.tier,
            parent_id:    task.id,
            root_id:      task.root_id,
            token_budget: Math.floor(task.token_budget / 2),
            cost_budget:  task.cost_budget / 4,
            metadata:     { created_by_decomposition: true, reasoning: decision.reasoning },
          }),
        );

        // Update parent expected count
        this.deps.taskStore.update(task.id, {
          sub_tasks_expected: children.length,
          token_used:         task.token_used + totalTokens,
          cost_used:          task.cost_used  + totalCostUsd,
        });

        this.deps.eventBus.emit("agent.task.decomposed", {
          agent_id:       agent.id,
          task_id:        task.id,
          sub_task_count: children.length,
          reasoning:      decision.reasoning,
        });

        await memoryManager.appendShortTerm(
          `Decomposed task "${task.title}" into ${children.length} sub-tasks. ${decision.reasoning}`,
        );

        return {
          success:        true,
          decision,
          turns_taken:    turn,
          total_tokens:   totalTokens,
          total_cost_usd: totalCostUsd,
          messages,
        };
      }

      if (decision.type === "request_consultation") {
        // Create consultation task
        this.deps.taskStore.create({
          title:       `Consultation: ${decision.question.slice(0, 80)}`,
          description: [
            decision.question,
            decision.context !== undefined ? `\nContext:\n${decision.context}` : "",
          ].join(""),
          division:     task.division,
          type:         "consultation",
          tier:         Math.max(1, agent.tier - 1) as 1 | 2 | 3,
          parent_id:    task.id,
          root_id:      task.root_id,
          token_budget: 2_000,
          cost_budget:  task.cost_budget / 8,
          metadata:     { target_capability: decision.target_capability },
        });

        this.deps.taskStore.update(task.id, {
          token_used: task.token_used + totalTokens,
          cost_used:  task.cost_used  + totalCostUsd,
        });

        return {
          success:        true,
          decision,
          turns_taken:    turn,
          total_tokens:   totalTokens,
          total_cost_usd: totalCostUsd,
          messages,
        };
      }

      if (decision.type === "escalate_task") {
        this.deps.eventBus.emit("agent.task.escalated", {
          agent_id: agent.id,
          task_id:  task.id,
          reason:   decision.reason,
        });

        this.deps.taskStore.update(task.id, {
          token_used: task.token_used + totalTokens,
          cost_used:  task.cost_used  + totalCostUsd,
        });

        return {
          success:        false,
          decision,
          turns_taken:    turn,
          total_tokens:   totalTokens,
          total_cost_usd: totalCostUsd,
          messages,
        };
      }
    }

    // -------------------------------------------------------------------------
    // Max turns exceeded — EXEC-001
    // -------------------------------------------------------------------------

    logger.warn("reasoning_max_turns", "Max turns exceeded — force escalating", {
      metadata: { agent_id: agent.id, task_id: task.id, turns: turn },
    });

    return this._makeEscalationResult(
      task, agent, messages, turn, totalTokens, totalCostUsd,
      `Exceeded max reasoning turns (${config.max_turns_per_task})`,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _callWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorCode: string,
    agent: AgentDefinition,
    task: Task,
  ): Promise<T> {
    let timerHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerHandle = setTimeout(() => {
        reject(SidjuaError.from(errorCode, `LLM call timed out after ${timeoutMs}ms`, {
          agent_id: agent.id,
          task_id:  task.id,
        }));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timerHandle);
      return result;
    } catch (err) {
      clearTimeout(timerHandle);
      throw err;
    }
  }

  private async _saveCheckpoint(
    agent: AgentDefinition,
    task:  Task,
    messages: LLMMessage[],
    turn: number,
  ): Promise<void> {
    await this.deps.checkpointManager.save({
      agent_id:        agent.id,
      timestamp:       new Date().toISOString(),
      version:         0, // auto-assigned by manager
      state: {
        agent_id:           agent.id,
        status:             "WORKING",
        pid:                null,
        started_at:         null,
        last_heartbeat:     null,
        last_checkpoint:    new Date().toISOString(),
        active_tasks:       [task.id],
        waiting_tasks:      [],
        queued_tasks:       0,
        total_tokens_used:  0,
        total_cost_usd:     0,
        restart_count:      0,
        current_hour_cost:  0,
        hour_start:         new Date().toISOString(),
        error_log:          [],
      },
      task_states: [{
        task_id:         task.id,
        status:          "RUNNING",
        progress_notes:  `Turn ${turn} of reasoning loop`,
        messages_so_far: messages.length,
        partial_result:  JSON.stringify(messages.slice(-4)), // keep last 4 messages
      }],
      memory_snapshot: this.deps.memoryManager.serialize(),
    });
  }

  private _makeEscalationResult(
    task:          Task,
    agent:         AgentDefinition,
    messages:      LLMMessage[],
    turn:          number,
    totalTokens:   number,
    totalCostUsd:  number,
    reason:        string,
  ): TaskResult {
    this.deps.eventBus.emit("agent.task.escalated", {
      agent_id: agent.id,
      task_id:  task.id,
      reason,
    });

    this.deps.taskStore.update(task.id, {
      token_used: task.token_used + totalTokens,
      cost_used:  task.cost_used  + totalCostUsd,
    });

    return {
      success:        false,
      decision:       {
        type:      "escalate_task",
        reason,
        attempted: `${turn} reasoning turns`,
      },
      turns_taken:    turn,
      total_tokens:   totalTokens,
      total_cost_usd: totalCostUsd,
      messages,
    };
  }

  /**
   * Rough USD cost estimate from token usage.
   * Uses the adapter's model pricing if available, otherwise a safe default.
   */
  private _calculateCost(usage: TokenUsage, agent: AgentDefinition): number {
    const models   = this.deps.provider.getModels();
    const modelDef = models.find((m) => m.id === agent.model);
    if (modelDef?.pricing === undefined) {
      // Fallback: ~$3/$15 per million (sonnet-class estimate)
      return (usage.inputTokens * 3 + usage.outputTokens * 15) / 1_000_000;
    }
    return (
      usage.inputTokens  * modelDef.pricing.inputPerMillion  +
      usage.outputTokens * modelDef.pricing.outputPerMillion
    ) / 1_000_000;
  }

  private _maybeRecordCost(
    usage:        TokenUsage,
    costUsd:      number,
    agent:        AgentDefinition,
    task:         Task,
  ): void {
    if (this.deps.recordCost === undefined) return;
    this.deps.recordCost({
      divisionCode:  agent.division,
      agentId:       agent.id,
      provider:      agent.provider,
      model:         agent.model,
      inputTokens:   usage.inputTokens,
      outputTokens:  usage.outputTokens,
      costUsd,
      taskId:        task.id,
    });
  }
}
