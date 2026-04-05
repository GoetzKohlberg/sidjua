// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP Tool Executor (Streaming Variant)
 *
 * Streaming counterpart to executeWithToolLoop.  Drives the same LLM ↔ MCP
 * tool-calling loop but yields LlmStreamEvent items token-by-token so the
 * caller can pipe them to an SSE or WebSocket stream.
 *
 * Security rails (same as non-streaming variant):
 *   - tool_use_input_delta events are NOT forwarded to the client
 *     (tool arguments may contain secrets resolved by the MCP server)
 *   - max iterations: 10 (default), hard ceiling: 25
 *   - sequential governance per tool call (fail-closed)
 *   - arg-hash logging only — raw args never logged
 *   - memory reference verification before every call
 *
 * Fallback: if the adapter does not implement chatStream(), the full
 * chatWithTools() response is yielded as a single text_delta event.
 */

import { createLogger }        from "../logger.js";
import { activityEmitter }     from "../activity/activity-emitter.js";
import { selectRelevantTools } from "./tool-selector.js";
import { estimateTokens, compressContext } from "./context-budget.js";
import {
  flattenContent,
  mcpSchemaToParams,
  extractTaskText,
  executeSingleToolCall,
} from "./tool-executor-core.js";
import type { McpRegistry }    from "./mcp-registry.js";
import type { GovernanceContext } from "./types.js";
import {
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_ITERATIONS_HARD_CEILING,
  CONTEXT_COMPRESS_THRESHOLD,
  CONTEXT_COMPRESS_TARGET,
  MAX_TOOLS_PER_CALL,
} from "./tool-executor.js";
import type {
  McpMessage,
  ToolLoopContext,
} from "./tool-executor.js";
import type {
  ProviderAdapter,
  LLMMessage,
  LLMRequest,
  ToolDefinition,
  LlmStreamEvent,
} from "../../providers/types.js";

export type { McpMessage, ToolLoopContext };

const logger = createLogger("mcp-tool-executor-streaming");

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

interface PendingToolCall {
  id:        string;
  name:      string;
  inputJson: string;   // accumulated JSON string from tool_use_input_delta
}

// ---------------------------------------------------------------------------
// executeWithToolLoopStreaming
// ---------------------------------------------------------------------------

/**
 * Drive a multi-turn LLM ↔ MCP tool-calling loop, yielding stream events.
 *
 * @param adapter   ProviderAdapter — must implement chatStream() or falls back
 *                  to chatWithTools() yielding a single text_delta.
 * @param registry  McpRegistry — tool lookup, governance config, callTool.
 * @param messages  Initial conversation (at minimum a user message).
 * @param ctx       Governance + audit context.
 * @param opts.maxIterations  Override max iterations (default: MAX_TOOL_ITERATIONS).
 *
 * Yields LlmStreamEvent items.  Callers MUST NOT forward tool_use_input_delta
 * events to end-users (they may contain raw tool arguments with secrets).
 */
export async function* executeWithToolLoopStreaming(
  adapter:  ProviderAdapter,
  registry: McpRegistry,
  messages: McpMessage[],
  ctx:      ToolLoopContext,
  opts?:    { maxIterations?: number },
): AsyncGenerator<LlmStreamEvent> {
  const maxIter = Math.min(
    opts?.maxIterations ?? MAX_TOOL_ITERATIONS,
    MAX_TOOL_ITERATIONS_HARD_CEILING,
  );

  // Select tools for this agent
  const availableTools = await registry.getToolsForAgent(ctx.agentId, ctx.division, ctx.tier);
  const taskText       = extractTaskText(messages);
  const selectedTools  = selectRelevantTools(availableTools, taskText, MAX_TOOLS_PER_CALL);

  // Convert McpTool[] → ToolDefinition[]
  const toolDefs: ToolDefinition[] = selectedTools.map((t) => ({
    name:        t.name,
    description: t.description,
    parameters:  mcpSchemaToParams(t.inputSchema),
  }));

  const conversation: McpMessage[] = [...messages];

  for (let iteration = 0; iteration < maxIter; iteration++) {
    // Compress context if over budget
    const est = estimateTokens(conversation);
    const activeMessages: McpMessage[] = est > CONTEXT_COMPRESS_THRESHOLD
      ? compressContext(conversation, CONTEXT_COMPRESS_TARGET).messages as McpMessage[]
      : conversation;

    // Convert McpMessage[] → LLMMessage[]
    const llmMessages: LLMMessage[] = activeMessages.map((m) => ({
      role:    m.role,
      content: flattenContent(m.content as string | Array<{ type: string; text?: string; content?: string }>),
    }));

    const req: LLMRequest = { model: ctx.model, messages: llmMessages };

    // ── Streaming path ─────────────────────────────────────────────────────
    if (typeof adapter.chatStream === "function") {
      const pendingCalls   = new Map<string, PendingToolCall>();
      let   currentCallId  = "";
      let   iterText       = "";
      let   sawMessageDone = false;

      try {
        for await (const event of adapter.chatStream(req, toolDefs)) {
          switch (event.type) {
            case "text_delta":
              iterText += event.text ?? "";
              yield event;   // forward text tokens to caller
              break;

            case "tool_use_start": {
              const tc = event.toolUse;
              if (tc !== undefined && tc.id.length > 0) {
                currentCallId = tc.id;
                pendingCalls.set(tc.id, { id: tc.id, name: tc.name, inputJson: "" });
              }
              // Do NOT yield tool_use_start to caller — tool data may contain secrets
              break;
            }

            case "tool_use_input_delta": {
              // Accumulate JSON fragment — NEVER forwarded to client
              const partial = event.toolUse?.inputPartial ?? "";
              const id      = event.toolUse?.id ?? currentCallId;
              const pending = pendingCalls.get(id);
              if (pending !== undefined) {
                pending.inputJson += partial;
              } else if (currentCallId.length > 0) {
                const fallback = pendingCalls.get(currentCallId);
                if (fallback !== undefined) fallback.inputJson += partial;
              }
              // NOT yielded — security: may contain secrets
              break;
            }

            case "tool_use_end":
              // Not forwarded — callers learn about completed tools via tool_result events
              break;

            case "message_done":
              sawMessageDone = true;
              yield event;   // always forward — signals end of this LLM turn
              break;

            case "error":
              yield event;
              return;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("mcp_stream_error", "Streaming LLM call failed", {
          metadata: { agent_id: ctx.agentId, iteration, error: msg },
        });
        yield { type: "error", error: `LLM stream error: ${msg}` };
        return;
      }

      // If the stream ended without message_done (unusual), synthesise it
      if (!sawMessageDone) {
        yield { type: "message_done" };
      }

      // No tool calls → we are done
      if (pendingCalls.size === 0) {
        return;
      }

      // Process tool calls (governance + execution)
      const govCtx: GovernanceContext = {
        agentId:         ctx.agentId,
        division:        ctx.division,
        tier:            ctx.tier,
        budgetRemaining: ctx.budgetRemaining,
        conversationId:  ctx.conversationId,
        ...(ctx.taskClassification !== undefined ? { taskClassification: ctx.taskClassification } : {}),
      };

      const toolResultParts: string[] = [];
      for (const tc of pendingCalls.values()) {
        // Parse accumulated JSON — fail-safe to empty args
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.inputJson.length > 0 ? tc.inputJson : "{}") as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch (err) {
          logger.warn("mcp_stream_tool_arg_parse", "Tool arg JSON parse failed — using empty args", {
            metadata: { tool: tc.name, error: err instanceof Error ? err.message : String(err) },
          });
        }

        const part = await executeSingleToolCall(tc.name, args, registry, govCtx, {
          agentId: ctx.agentId,
          ...(ctx.workDir !== undefined ? { workDir: ctx.workDir } : {}),
        });
        toolResultParts.push(part);
      }

      // Append assistant turn + tool results to conversation, then loop
      const assistantText = iterText.length > 0 ? iterText : "Calling tools…";
      conversation.push({ role: "assistant", content: assistantText });
      conversation.push({ role: "user",      content: toolResultParts.join("\n\n") });

      // Continue the loop — next iteration will call the LLM with the tool results
      continue;
    }

    // ── Non-streaming fallback ─────────────────────────────────────────────
    // adapter.chatStream is not available; call chatWithTools() and yield the
    // full response as a single text_delta, handling tool calls normally.
    let res: import("../../providers/types.js").ToolLLMResponse;
    try {
      res = await adapter.chatWithTools(req, toolDefs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("mcp_stream_fallback_error", "Fallback chatWithTools call failed", {
        metadata: { agent_id: ctx.agentId, iteration, error: msg },
      });
      yield { type: "error", error: `LLM call error: ${msg}` };
      return;
    }

    if (res.textContent.length > 0) {
      yield { type: "text_delta", text: res.textContent };
    }
    yield { type: "message_done", usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens } };

    // No tool calls → done
    if (res.toolCalls.length === 0) {
      return;
    }

    // Process tool calls (fallback path — no streaming accumulation needed)
    const govCtx: GovernanceContext = {
      agentId:         ctx.agentId,
      division:        ctx.division,
      tier:            ctx.tier,
      budgetRemaining: ctx.budgetRemaining,
      conversationId:  ctx.conversationId,
      ...(ctx.taskClassification !== undefined ? { taskClassification: ctx.taskClassification } : {}),
    };

    const toolResultParts: string[] = [];
    for (const tc of res.toolCalls) {
      const part = await executeSingleToolCall(tc.name, tc.input as Record<string, unknown>, registry, govCtx, {
        agentId: ctx.agentId,
        ...(ctx.workDir !== undefined ? { workDir: ctx.workDir } : {}),
      });
      toolResultParts.push(part);
    }

    const assistantText = res.textContent.length > 0 ? res.textContent : "Calling tools…";
    conversation.push({ role: "assistant", content: assistantText });
    conversation.push({ role: "user",      content: toolResultParts.join("\n\n") });
  }

  // Max iterations reached
  activityEmitter.emit({
    event_type: "mcp.loop.max_iterations",
    category:   "agent",
    agent_id:   ctx.agentId,
    title:      "MCP streaming tool loop reached max iterations",
    severity:   "warning",
    details:    { max: maxIter },
  });

  yield { type: "error", error: "Max tool iterations reached without a final answer." };
}
