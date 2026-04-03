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
} from "./mcp-tool-adapter.js";
export type {
  AnthropicTool,
  OpenAiTool,
  OllamaTool,
  LlmToolFormat,
} from "./mcp-tool-adapter.js";
