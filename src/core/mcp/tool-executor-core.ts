// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — MCP Tool Executor Shared Core
 *
 * Logic shared between tool-executor.ts (non-streaming) and
 * tool-executor-streaming.ts (streaming).  Extracted to eliminate the
 * governance + execution block that was duplicated three times.
 *
 * Exports:
 *   flattenContent()        — flatten McpContentBlock[] to plain string
 *   mcpSchemaToParams()     — convert MCP inputSchema to ToolParameterSchema
 *   extractTaskText()       — extract last user message from conversation
 *   executeSingleToolCall() — governance check + registry call → result string
 */

import { createHash }          from "node:crypto";
import { createLogger }        from "../logger.js";
import { activityEmitter }     from "../activity/activity-emitter.js";
import { governToolCall }      from "./mcp-governance-hook.js";
import { verifyMemoryReferences } from "./memory-verifier.js";
import type { McpRegistry }    from "./mcp-registry.js";
import type { GovernanceContext } from "./types.js";
import type { ToolParameterSchema } from "../../providers/types.js";

const logger = createLogger("mcp-tool-executor-core");

// ---------------------------------------------------------------------------
// Re-export types so importers can get them from a single place
// ---------------------------------------------------------------------------

export type ContentBlock = { type: string; text?: string; content?: string };

// ---------------------------------------------------------------------------
// Shared helper: flatten content array to plain string
// ---------------------------------------------------------------------------

/**
 * Flatten a string-or-content-block message to a plain string.
 * Used when converting McpMessage content to LLMMessage content.
 */
export function flattenContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text")        return b.text ?? "";
      if (b.type === "tool_result") return b.content ?? "";
      return JSON.stringify(b);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Shared helper: convert MCP inputSchema to ToolParameterSchema
// ---------------------------------------------------------------------------

/**
 * Convert an MCP tool inputSchema object to the ToolParameterSchema format
 * expected by ProviderAdapter.chatWithTools().
 */
export function mcpSchemaToParams(schema: Record<string, unknown>): ToolParameterSchema {
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

// ---------------------------------------------------------------------------
// Shared helper: extract last user message text from a conversation
// ---------------------------------------------------------------------------

/**
 * Return the text content of the last user message in the conversation.
 * Used by selectRelevantTools() to rank tools by relevance to the task.
 */
export function extractTaskText(messages: Array<{ role: string; content: string | ContentBlock[] }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") return flattenContent(m.content as string | ContentBlock[]);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Shared: single tool call execution (governance check + registry call)
// ---------------------------------------------------------------------------

export interface SingleToolCallOpts {
  /** Agent working directory — enables memory reference verification. */
  workDir?:          string;
  /** Agent ID for activity events and metrics. */
  agentId:           string;
  /** Optional hook for recording governance block metrics. */
  onGovernanceBlock?: (stage: unknown) => void;
  /** Optional hook for recording successful tool call metrics. */
  onToolCallSuccess?: (toolName: string) => void;
  /** If true, PII-redact error messages before logging. */
  redactErrors?:     boolean;
}

/**
 * Execute a single MCP tool call:
 *   1. Verify memory references (if workDir is set).
 *   2. Look up the tool server and run governance.
 *   3. Call the tool via the registry.
 *
 * Returns a string fragment suitable for appending to the tool results
 * message that will be injected into the conversation as the next user turn.
 *
 * Never throws — all errors are returned as `[Tool: name] Error: ...` strings
 * so the LLM can reason about them.
 */
export async function executeSingleToolCall(
  toolName: string,
  args:     Record<string, unknown>,
  registry: McpRegistry,
  govCtx:   GovernanceContext,
  opts:     SingleToolCallOpts,
): Promise<string> {
  const { agentId, workDir } = opts;

  // Arg-hash for audit — raw args are never logged
  const argsHash = createHash("sha256")
    .update(JSON.stringify(args))
    .digest("hex")
    .slice(0, 16);

  // ── Memory reference verification ──────────────────────────────────────
  if (workDir !== undefined) {
    let verified: { valid: boolean; invalidRefs: string[] };
    try {
      verified = await verifyMemoryReferences(args, workDir);
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
        agent_id:   agentId,
        title:      `MCP tool ${toolName} — invalid file reference`,
        severity:   "warning",
        details:    { tool: toolName, refs: verified.invalidRefs },
      });
      return `[Tool: ${toolName}] Error: invalid file reference — ${verified.invalidRefs.join(", ")}`;
    }
  }

  // ── Governance check ────────────────────────────────────────────────────
  const serverInfo = registry.getServerForTool(toolName);
  if (serverInfo === undefined) {
    return `[Tool: ${toolName}] Error: tool not registered`;
  }

  const decision = await governToolCall(toolName, args, serverInfo.name, serverInfo.governance, govCtx);
  if (!decision.allowed) {
    opts.onGovernanceBlock?.(decision.stage);
    activityEmitter.emit({
      event_type: "mcp.tool.blocked",
      category:   "agent",
      agent_id:   agentId,
      title:      `MCP tool ${toolName} blocked (stage ${decision.stage ?? "?"})`,
      severity:   "warning",
      details:    { tool: toolName, stage: decision.stage, reason: decision.reason, args_hash: argsHash },
    });
    return `[Tool: ${toolName}] Blocked: ${decision.reason ?? "governance policy"}`;
  }

  // ── Call tool ───────────────────────────────────────────────────────────
  activityEmitter.emit({
    event_type: "mcp.tool.called",
    category:   "agent",
    agent_id:   agentId,
    title:      `MCP tool ${toolName} called`,
    severity:   "info",
    details:    { tool: toolName, server: serverInfo.name, args_hash: argsHash },
  });

  try {
    const result     = await registry.callTool(toolName, args);
    const resultText = result.content.map((b) => b.type === "text" ? b.text : "").join("\n");

    opts.onToolCallSuccess?.(toolName);
    activityEmitter.emit({
      event_type: "mcp.tool.success",
      category:   "agent",
      agent_id:   agentId,
      title:      `MCP tool ${toolName} succeeded`,
      severity:   "info",
      details:    { tool: toolName, server: serverInfo.name },
    });

    return `[Tool: ${toolName}]\n${resultText}`;
  } catch (err) {
    let errMsg = err instanceof Error ? err.message : String(err);
    if (opts.redactErrors) {
      const { redactPii } = await import("../telemetry/pii-redactor.js");
      errMsg = redactPii(errMsg);
    }
    activityEmitter.emit({
      event_type: "mcp.tool.error",
      category:   "agent",
      agent_id:   agentId,
      title:      `MCP tool ${toolName} error`,
      severity:   "error",
      details:    { tool: toolName, server: serverInfo.name, error: errMsg },
    });
    return `[Tool: ${toolName}] Error: ${errMsg}`;
  }
}
