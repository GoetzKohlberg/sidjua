// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP subsystem barrel export
 */

export * from "./types.js";
export { McpClient } from "./mcp-client.js";
export { McpRegistry, matchToolPattern } from "./mcp-registry.js";
export { governToolCall, clearRateLimitState } from "./mcp-governance-hook.js";
export {
  mcpToolsToLlmFormat,
  llmToolResultToMcp,
  detectProviderFromModel,
} from "./mcp-tool-adapter.js";
export type {
  AnthropicTool,
  OpenAiTool,
  OllamaTool,
  LlmToolFormat,
} from "./mcp-tool-adapter.js";
export { selectRelevantTools } from "./tool-selector.js";
export { estimateTokens, compressContext } from "./context-budget.js";
export type { CompressResult } from "./context-budget.js";
export { verifyMemoryReferences } from "./memory-verifier.js";
export type { VerifyResult } from "./memory-verifier.js";
export {
  createMcpLlmProvider,
  executeWithToolLoop,
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_ITERATIONS_HARD_CEILING,
  CONTEXT_COMPRESS_THRESHOLD,
  CONTEXT_COMPRESS_TARGET,
  MAX_TOOLS_PER_CALL,
} from "./tool-executor.js";
export type {
  McpContentBlock,
  McpMessage,
  McpLlmResponse,
  McpLlmProvider,
  ToolLoopContext,
  ToolLoopResult,
} from "./tool-executor.js";
export { executeWithToolLoopStreaming } from "./tool-executor-streaming.js";
