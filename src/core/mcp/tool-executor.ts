// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP Tool Executor
 *
 * Standalone LLM ↔ MCP tool-calling loop.  Unlike the AgentReasoningLoop
 * (which uses meta-tool AGENT_DECISION_TOOLS), this module drives native
 * provider tool-use:
 *
 *   messages → select tools → LLM call (with MCP tools in native format)
 *     → if stop_reason=tool_use: governance → call MCP → inject result → loop
 *     → if stop_reason=end_turn: return text
 *
 * Security rails:
 *   - max iterations: 10 (default), hard ceiling: 25
 *   - sequential governance per tool call (fail-closed)
 *   - arg-hash logging only — raw args never logged
 *   - memory reference verification before every call
 *
 * Usage: `executeWithToolLoop()` is a standalone helper callable from any
 * context.  The AgentReasoningLoop wires McpRegistry into its `use_tool`
 * dispatch path separately (direct `callTool` without a nested LLM loop).
 */

import { createHash }           from "node:crypto";
import { createLogger }         from "../logger.js";
import { activityEmitter }      from "../activity/activity-emitter.js";
import { governToolCall }       from "./mcp-governance-hook.js";
import { selectRelevantTools }  from "./tool-selector.js";
import { estimateTokens, compressContext } from "./context-budget.js";
import { verifyMemoryReferences } from "./memory-verifier.js";
import type { McpRegistry }     from "./mcp-registry.js";
import type { McpTool }         from "./types.js";
import type {
  GovernanceContext,
} from "./types.js";
import type {
  ProviderAdapter,
  LLMMessage,
  LLMRequest,
  ToolDefinition,
  ToolParameterSchema,
  ToolLLMResponse,
} from "../../providers/types.js";

const logger = createLogger("mcp-tool-executor");

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const MAX_TOOL_ITERATIONS              = 10;
export const MAX_TOOL_ITERATIONS_HARD_CEILING = 25;
export const CONTEXT_COMPRESS_THRESHOLD       = 100_000; // tokens
export const CONTEXT_COMPRESS_TARGET          = 80_000;  // tokens
export const MAX_TOOLS_PER_CALL               = 10;

// ---------------------------------------------------------------------------
// McpMessage — multi-turn conversation type (array or string content)
// ---------------------------------------------------------------------------

export interface McpContentBlock {
  type:        "text" | "tool_use" | "tool_result";
  /** For text blocks. */
  text?:       string;
  /** For tool_use blocks — provider-assigned id. */
  id?:         string;
  /** For tool_use blocks — tool name. */
  name?:       string;
  /** For tool_use blocks — parsed arguments. */
  input?:      Record<string, unknown>;
  /** For tool_result blocks — links back to a tool_use id. */
  tool_use_id?: string;
  /** For tool_result blocks — serialised result text. */
  content?:    string;
}

export interface McpMessage {
  role:    "user" | "assistant";
  content: string | McpContentBlock[];
}

export interface McpLlmResponse {
  stopReason:   "end_turn" | "tool_use" | "max_tokens" | string;
  content:      McpContentBlock[];
  textContent:  string;
  toolCalls:    Array<{ id?: string; name: string; input: Record<string, unknown> }>;
  inputTokens:  number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// McpLlmProvider — thin wrapper around ProviderAdapter for native tool calls
// ---------------------------------------------------------------------------

export interface McpLlmProvider {
  readonly providerName: string;
  chat(messages: McpMessage[], tools: McpTool[], model: string): Promise<McpLlmResponse>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Flatten McpMessage array content to a plain string for ProviderAdapter. */
function flattenContent(content: string | McpContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text")        return b.text ?? "";
      if (b.type === "tool_result") return b.content ?? "";
      return JSON.stringify(b);
    })
    .join("\n");
}

/** Convert McpTool.inputSchema to ToolParameterSchema for ProviderAdapter.chatWithTools. */
function mcpSchemaToParams(schema: Record<string, unknown>): ToolParameterSchema {
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

/** Convert ProviderAdapter.chatWithTools response to McpLlmResponse. */
function toLlmResponse(res: ToolLLMResponse): McpLlmResponse {
  const content: McpContentBlock[] = [];
  if (res.textContent.length > 0) {
    content.push({ type: "text", text: res.textContent });
  }
  for (const tc of res.toolCalls) {
    content.push({
      type:  "tool_use",
      name:  tc.name,
      input: tc.input,
      ...(tc.id !== undefined ? { id: tc.id } : {}),
    });
  }
  return {
    stopReason:  res.finishReason ?? (res.toolCalls.length > 0 ? "tool_use" : "end_turn"),
    content,
    textContent: res.textContent,
    toolCalls:   res.toolCalls.map((tc) => ({
      name:  tc.name,
      input: tc.input,
      ...(tc.id !== undefined ? { id: tc.id } : {}),
    })),
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an McpLlmProvider that wraps an existing ProviderAdapter.
 *
 * Multi-turn handling: tool results are serialised as plain text in user
 * messages so the existing ProviderAdapter.chatWithTools() can be reused
 * without provider-specific array-content formatting.
 */
export function createMcpLlmProvider(adapter: ProviderAdapter): McpLlmProvider {
  return {
    providerName: adapter.providerName,

    async chat(messages: McpMessage[], tools: McpTool[], model: string): Promise<McpLlmResponse> {
      // Convert McpMessage[] → LLMMessage[]
      const llmMessages: LLMMessage[] = messages.map((m) => ({
        role:    m.role,
        content: flattenContent(m.content),
      }));

      // Convert McpTool[] → ToolDefinition[]
      const toolDefs: ToolDefinition[] = tools.map((t) => ({
        name:        t.name,
        description: t.description,
        parameters:  mcpSchemaToParams(t.inputSchema),
      }));

      const req: LLMRequest = { model, messages: llmMessages };
      const res = await adapter.chatWithTools(req, toolDefs);
      return toLlmResponse(res);
    },
  };
}

// ---------------------------------------------------------------------------
// executeWithToolLoop
// ---------------------------------------------------------------------------

export interface ToolLoopContext {
  /** Agent identifier — used for governance + audit. */
  agentId:             string;
  /** Agent's division — RBAC enforcement. */
  division:            string;
  /** Agent's trust tier ("T1" | "T2" | "T3"). */
  tier:                string;
  /** Remaining budget in USD — budget-gate enforcement. */
  budgetRemaining:     number;
  /** Conversation / task id — for audit correlation. */
  conversationId:      string;
  /** Task data classification ("PUBLIC" | "INTERNAL" | ...). */
  taskClassification?: string;
  /** Model string used to call the LLM (e.g. "claude-sonnet-4-6"). */
  model:               string;
  /** Working directory — passed to verifyMemoryReferences. */
  workDir?:            string;
}

export interface ToolLoopResult {
  /** Final text content from the last LLM turn. */
  text:          string;
  /** Number of MCP tool calls made during the loop. */
  toolCallsMade: number;
  inputTokens:   number;
  outputTokens:  number;
  stoppedReason: "end_turn" | "max_iterations" | "max_tokens" | "error" | string;
}

/**
 * Drive a multi-turn LLM ↔ MCP tool-calling loop.
 *
 * @param provider  Wrapped ProviderAdapter (use createMcpLlmProvider()).
 * @param registry  McpRegistry — tool lookup, governance config, callTool.
 * @param messages  Initial conversation (at minimum a user message with the task).
 * @param ctx       Governance + audit context.
 * @param opts.maxIterations  Override max iterations (default: MAX_TOOL_ITERATIONS).
 *
 * @returns ToolLoopResult with the final text and usage stats.
 */
export async function executeWithToolLoop(
  provider: McpLlmProvider,
  registry: McpRegistry,
  messages: McpMessage[],
  ctx:      ToolLoopContext,
  opts?:    { maxIterations?: number },
): Promise<ToolLoopResult> {
  const maxIter = Math.min(
    opts?.maxIterations ?? MAX_TOOL_ITERATIONS,
    MAX_TOOL_ITERATIONS_HARD_CEILING,
  );

  // Select tools for this agent
  const availableTools = await registry.getToolsForAgent(ctx.agentId, ctx.division, ctx.tier);
  const taskText = extractTaskText(messages);
  const selectedTools = selectRelevantTools(availableTools, taskText, MAX_TOOLS_PER_CALL);

  const conversation: McpMessage[] = [...messages];
  let totalInputTokens  = 0;
  let totalOutputTokens = 0;
  let toolCallsMade     = 0;
  let finalText         = "";

  for (let iteration = 0; iteration < maxIter; iteration++) {
    // Compress context if over budget
    const est = estimateTokens(conversation);
    const activeMessages = est > CONTEXT_COMPRESS_THRESHOLD
      ? compressContext(conversation, CONTEXT_COMPRESS_TARGET).messages
      : conversation;

    // LLM call
    let response: McpLlmResponse;
    try {
      response = await provider.chat(activeMessages, selectedTools, ctx.model);
    } catch (err) {
      logger.warn("mcp_tool_loop_llm_error", "LLM call failed in MCP tool loop", {
        metadata: {
          agent_id: ctx.agentId,
          iteration,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return {
        text:          finalText || "Tool loop aborted: LLM error.",
        toolCallsMade,
        inputTokens:   totalInputTokens,
        outputTokens:  totalOutputTokens,
        stoppedReason: "error",
      };
    }

    totalInputTokens  += response.inputTokens;
    totalOutputTokens += response.outputTokens;
    finalText          = response.textContent;

    // Terminal: no tool calls or model says done
    if (response.toolCalls.length === 0 || response.stopReason === "end_turn") {
      return {
        text:          finalText,
        toolCallsMade,
        inputTokens:   totalInputTokens,
        outputTokens:  totalOutputTokens,
        stoppedReason: response.stopReason.length > 0 ? response.stopReason : "end_turn",
      };
    }

    if (response.stopReason === "max_tokens") {
      return {
        text:          finalText,
        toolCallsMade,
        inputTokens:   totalInputTokens,
        outputTokens:  totalOutputTokens,
        stoppedReason: "max_tokens",
      };
    }

    // Process tool calls — sequential, fail-closed governance
    const toolResultParts: string[] = [];
    const govCtx: GovernanceContext = {
      agentId:         ctx.agentId,
      division:        ctx.division,
      tier:            ctx.tier,
      budgetRemaining: ctx.budgetRemaining,
      conversationId:  ctx.conversationId,
      ...(ctx.taskClassification !== undefined ? { taskClassification: ctx.taskClassification } : {}),
    };

    for (const tc of response.toolCalls) {
      const toolName = tc.name;
      const args     = tc.input;

      // Arg-hash for audit — raw args are never logged
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
          logger.warn("mcp_verify_error", "Memory reference verification threw", {
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
        toolCallsMade++;

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

    // Append assistant turn + tool results to conversation
    const assistantText = response.textContent.length > 0
      ? response.textContent
      : "Calling tools…";
    conversation.push({ role: "assistant", content: assistantText });
    conversation.push({ role: "user",      content: toolResultParts.join("\n\n") });
  }

  // Max iterations reached
  activityEmitter.emit({
    event_type: "mcp.loop.max_iterations",
    category:   "agent",
    agent_id:   ctx.agentId,
    title:      "MCP tool loop reached max iterations",
    severity:   "warning",
    details:    { max: maxIter, tool_calls: toolCallsMade },
  });

  return {
    text:          finalText || "Max tool iterations reached without a final answer.",
    toolCallsMade,
    inputTokens:   totalInputTokens,
    outputTokens:  totalOutputTokens,
    stoppedReason: "max_iterations",
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract task description from the last user message in the conversation. */
function extractTaskText(messages: McpMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") return flattenContent(m.content);
  }
  return "";
}
