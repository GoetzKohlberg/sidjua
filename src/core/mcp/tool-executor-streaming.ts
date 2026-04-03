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

import { createHash }          from "node:crypto";
import { createLogger }        from "../logger.js";
import { activityEmitter }     from "../activity/activity-emitter.js";
import { governToolCall }      from "./mcp-governance-hook.js";
import { selectRelevantTools } from "./tool-selector.js";
import { estimateTokens, compressContext } from "./context-budget.js";
import { verifyMemoryReferences } from "./memory-verifier.js";
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
// Internal helpers (re-implemented locally to avoid export coupling)
// ---------------------------------------------------------------------------

function flattenContent(content: string | Array<{ type: string; text?: string; content?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text")        return b.text ?? "";
      if (b.type === "tool_result") return b.content ?? "";
      return JSON.stringify(b);
    })
    .join("\n");
}

function mcpSchemaToParams(schema: Record<string, unknown>): import("../../providers/types.js").ToolParameterSchema {
  const properties = schema["properties"];
  const required   = schema["required"];
  return {
    type:       "object",
    properties: (typeof properties === "object" && properties !== null)
      ? properties as Record<string, { type: string; description?: string; enum?: string[] }>
      : {},
    ...(Array.isArray(required) ? { required: required as string[] } : {}),
  };
}

function extractTaskText(messages: McpMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") return flattenContent(m.content as string | Array<{ type: string; text?: string; content?: string }>);
  }
  return "";
}

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
      const toolResultParts: string[] = [];
      const govCtx: GovernanceContext = {
        agentId:         ctx.agentId,
        division:        ctx.division,
        tier:            ctx.tier,
        budgetRemaining: ctx.budgetRemaining,
        conversationId:  ctx.conversationId,
        ...(ctx.taskClassification !== undefined ? { taskClassification: ctx.taskClassification } : {}),
      };

      for (const tc of pendingCalls.values()) {
        const toolName = tc.name;

        // Parse accumulated JSON — fail-safe to empty args
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.inputJson.length > 0 ? tc.inputJson : "{}") as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch (err) {
          logger.warn("mcp_stream_tool_arg_parse", "Tool arg JSON parse failed — using empty args", {
            metadata: { tool: toolName, error: err instanceof Error ? err.message : String(err) },
          });
        }

        const argsHash = createHash("sha256")
          .update(JSON.stringify(args))
          .digest("hex")
          .slice(0, 16);

        // Memory reference verification
        if (ctx.workDir !== undefined) {
          let verified: { valid: boolean; invalidRefs: string[] };
          try {
            verified = await verifyMemoryReferences(args, ctx.workDir);
          } catch (err) {
            verified = { valid: false, invalidRefs: ["verification-error"] };
            logger.warn("mcp_stream_verify_error", "Memory reference verification threw", {
              metadata: { tool: toolName, error: err instanceof Error ? err.message : String(err) },
            });
          }
          if (!verified.valid) {
            activityEmitter.emit({
              event_type: "mcp.tool.error",
              category:   "agent",
              agent_id:   ctx.agentId,
              title:      `MCP tool ${toolName} — invalid file reference`,
              severity:   "warning",
              details:    { tool: toolName, refs: verified.invalidRefs },
            });
            toolResultParts.push(`[Tool: ${toolName}] Error: invalid file reference — ${verified.invalidRefs.join(", ")}`);
            continue;
          }
        }

        // Governance check
        const serverInfo = registry.getServerForTool(toolName);
        if (serverInfo === undefined) {
          toolResultParts.push(`[Tool: ${toolName}] Error: tool not registered`);
          continue;
        }

        const decision = await governToolCall(toolName, args, serverInfo.name, serverInfo.governance, govCtx);
        if (!decision.allowed) {
          activityEmitter.emit({
            event_type: "mcp.tool.blocked",
            category:   "agent",
            agent_id:   ctx.agentId,
            title:      `MCP tool ${toolName} blocked (stage ${decision.stage ?? "?"})`,
            severity:   "warning",
            details:    { tool: toolName, stage: decision.stage, reason: decision.reason, args_hash: argsHash },
          });
          toolResultParts.push(`[Tool: ${toolName}] Blocked: ${decision.reason ?? "governance policy"}`);
          continue;
        }

        // Call tool
        activityEmitter.emit({
          event_type: "mcp.tool.called",
          category:   "agent",
          agent_id:   ctx.agentId,
          title:      `MCP tool ${toolName} called`,
          severity:   "info",
          details:    { tool: toolName, server: serverInfo.name, args_hash: argsHash },
        });

        try {
          const result     = await registry.callTool(toolName, args);
          const resultText = result.content.map((b) => b.type === "text" ? b.text : "").join("\n");

          activityEmitter.emit({
            event_type: "mcp.tool.success",
            category:   "agent",
            agent_id:   ctx.agentId,
            title:      `MCP tool ${toolName} succeeded`,
            severity:   "info",
            details:    { tool: toolName, server: serverInfo.name },
          });

          toolResultParts.push(`[Tool: ${toolName}]\n${resultText}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          activityEmitter.emit({
            event_type: "mcp.tool.error",
            category:   "agent",
            agent_id:   ctx.agentId,
            title:      `MCP tool ${toolName} error`,
            severity:   "error",
            details:    { tool: toolName, server: serverInfo.name, error: errMsg },
          });
          toolResultParts.push(`[Tool: ${toolName}] Error: ${errMsg}`);
        }
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

    // Process tool calls
    const toolResultParts: string[] = [];
    const govCtx: GovernanceContext = {
      agentId:         ctx.agentId,
      division:        ctx.division,
      tier:            ctx.tier,
      budgetRemaining: ctx.budgetRemaining,
      conversationId:  ctx.conversationId,
      ...(ctx.taskClassification !== undefined ? { taskClassification: ctx.taskClassification } : {}),
    };

    for (const tc of res.toolCalls) {
      const toolName = tc.name;
      const args     = tc.input;

      const argsHash = createHash("sha256")
        .update(JSON.stringify(args))
        .digest("hex")
        .slice(0, 16);

      if (ctx.workDir !== undefined) {
        let verified: { valid: boolean; invalidRefs: string[] };
        try {
          verified = await verifyMemoryReferences(args, ctx.workDir);
        } catch (err) {
          verified = { valid: false, invalidRefs: ["verification-error"] };
          logger.warn("mcp_stream_verify_error_fallback", "Memory reference verification threw", {
            metadata: { tool: toolName, error: err instanceof Error ? err.message : String(err) },
          });
        }
        if (!verified.valid) {
          toolResultParts.push(`[Tool: ${toolName}] Error: invalid file reference — ${verified.invalidRefs.join(", ")}`);
          continue;
        }
      }

      const serverInfo = registry.getServerForTool(toolName);
      if (serverInfo === undefined) {
        toolResultParts.push(`[Tool: ${toolName}] Error: tool not registered`);
        continue;
      }

      const decision = await governToolCall(toolName, args, serverInfo.name, serverInfo.governance, govCtx);
      if (!decision.allowed) {
        activityEmitter.emit({
          event_type: "mcp.tool.blocked",
          category:   "agent",
          agent_id:   ctx.agentId,
          title:      `MCP tool ${toolName} blocked`,
          severity:   "warning",
          details:    { tool: toolName, reason: decision.reason, args_hash: argsHash },
        });
        toolResultParts.push(`[Tool: ${toolName}] Blocked: ${decision.reason ?? "governance policy"}`);
        continue;
      }

      activityEmitter.emit({
        event_type: "mcp.tool.called",
        category:   "agent",
        agent_id:   ctx.agentId,
        title:      `MCP tool ${toolName} called`,
        severity:   "info",
        details:    { tool: toolName, server: serverInfo.name, args_hash: argsHash },
      });

      try {
        const result     = await registry.callTool(toolName, args);
        const resultText = result.content.map((b) => b.type === "text" ? b.text : "").join("\n");
        activityEmitter.emit({
          event_type: "mcp.tool.success",
          category:   "agent",
          agent_id:   ctx.agentId,
          title:      `MCP tool ${toolName} succeeded`,
          severity:   "info",
          details:    { tool: toolName, server: serverInfo.name },
        });
        toolResultParts.push(`[Tool: ${toolName}]\n${resultText}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        activityEmitter.emit({
          event_type: "mcp.tool.error",
          category:   "agent",
          agent_id:   ctx.agentId,
          title:      `MCP tool ${toolName} error`,
          severity:   "error",
          details:    { tool: toolName, server: serverInfo.name, error: errMsg },
        });
        toolResultParts.push(`[Tool: ${toolName}] Error: ${errMsg}`);
      }
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
