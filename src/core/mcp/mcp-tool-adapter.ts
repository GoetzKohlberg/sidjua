// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP Tool Adapter
 *
 * Converts MCP tool definitions to LLM provider formats (Anthropic, OpenAI, Ollama)
 * and converts LLM tool_use results back to MCP ToolResult format.
 */

import type { McpTool, McpToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Provider-specific tool formats
// ---------------------------------------------------------------------------

/** Anthropic claude tool format */
export interface AnthropicTool {
  name:         string;
  description:  string;
  input_schema: Record<string, unknown>;
}

/** OpenAI / GPT function-calling format */
export interface OpenAiTool {
  type:     "function";
  function: {
    name:        string;
    description: string;
    parameters:  Record<string, unknown>;
  };
}

/** Ollama tool format (matches OpenAI function format) */
export type OllamaTool = OpenAiTool;

export type LlmToolFormat = "anthropic" | "openai" | "ollama";

/**
 * Detect LLM provider format from model name string.
 * Used to pick the correct tool format for native MCP tool calling.
 */
export function detectProviderFromModel(model: string): LlmToolFormat {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  // openai, deepseek, grok/xai, kimi, mistral, qwen, llama, gemma, etc.
  return "openai";
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function toAnthropicTool(tool: McpTool): AnthropicTool {
  return {
    name:         tool.name,
    description:  tool.description,
    input_schema: tool.inputSchema,
  };
}

function toOpenAiTool(tool: McpTool): OpenAiTool {
  return {
    type: "function",
    function: {
      name:        tool.name,
      description: tool.description,
      parameters:  tool.inputSchema,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a list of MCP tools to the format expected by the given LLM provider.
 */
export function mcpToolsToLlmFormat(
  tools:    McpTool[],
  provider: LlmToolFormat,
): AnthropicTool[] | OpenAiTool[] {
  switch (provider) {
    case "anthropic":
      return tools.map(toAnthropicTool);
    case "openai":
    case "ollama":
      return tools.map(toOpenAiTool);
    default: {
      // Exhaustive check — TypeScript should catch unknown values at compile time
      const _exhaustive: never = provider;
      void _exhaustive;
      return tools.map(toAnthropicTool);
    }
  }
}

/**
 * Convert an LLM tool_use response back to MCP ToolResult format.
 *
 * For Anthropic: the result content is a list of content blocks.
 * For OpenAI / Ollama: the result is typically a JSON string.
 */
export function llmToolResultToMcp(
  result:   unknown,
  provider: LlmToolFormat,
): McpToolResult {
  switch (provider) {
    case "anthropic": {
      // Anthropic returns content blocks in tool_result
      if (Array.isArray(result)) {
        return {
          content: result.map((block) => {
            if (
              block !== null &&
              typeof block === "object" &&
              (block as Record<string, unknown>)["type"] === "text"
            ) {
              return { type: "text" as const, text: String((block as Record<string, unknown>)["text"] ?? "") };
            }
            return { type: "text" as const, text: JSON.stringify(block) };
          }),
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "openai":
    case "ollama": {
      // OpenAI / Ollama return a string (function call result)
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return { content: [{ type: "text", text }] };
    }

    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  }
}
