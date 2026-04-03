// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13a: Provider Adapter Types
 *
 * New raw-HTTP provider abstraction used by Phase 13 agent execution.
 * Separate from the Phase 6 LLMProvider / ProviderRegistry to avoid
 * coupling with the existing SDK-based adapters.
 *
 * Key additions over Phase 6 types:
 *   - chatWithTools() for agent decision tools
 *   - AgentDecision discriminated union for all 6 decision types
 *   - ToolDefinition in both Anthropic and OpenAI formats
 */


export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}


export interface LLMRequest {
  model?: string;               // falls back to adapter's defaultModel
  messages: LLMMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens:  number;
  outputTokens: number;
  totalTokens:  number;
}

export interface LLMResponse {
  content:      string;
  usage:        TokenUsage;
  finishReason?: string;
  latencyMs:    number;
  model:        string;
  provider:     string;
}

export interface ToolCall {
  /** Provider-assigned tool call id (Anthropic tool_use id / OpenAI tool call id).
   *  Required for multi-turn tool-result messages. Undefined for old-style dispatched tools. */
  id?:   string;
  name:  string;
  input: Record<string, unknown>;
}

/** Extends LLMResponse with tool call data (may have zero tool calls). */
export interface ToolLLMResponse extends LLMResponse {
  toolCalls:   ToolCall[];
  textContent: string;           // any text alongside the tool calls
}


export interface ToolParameterSchema {
  type:       "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?:  string[];
}

export interface ToolDefinition {
  name:        string;
  description: string;
  parameters:  ToolParameterSchema;
}

// Anthropic-native tool format (for request body)
export interface AnthropicTool {
  name:         string;
  description:  string;
  input_schema: ToolParameterSchema;
}

// OpenAI-native tool format (for request body)
export interface OpenAITool {
  type: "function";
  function: {
    name:        string;
    description: string;
    parameters:  ToolParameterSchema;
  };
}


export interface SubTaskDefinition {
  title:        string;
  description:  string;
  tier:         1 | 2 | 3;
  division?:    string;
}

export type AgentDecision =
  | { type: "execute_result";       result: string;  summary: string; confidence: number }
  | { type: "decompose_task";       reasoning: string; sub_tasks: SubTaskDefinition[] }
  | { type: "request_consultation"; question: string; target_capability: string; context?: string }
  | { type: "escalate_task";        reason: string;   attempted: string; suggestion?: string }
  | { type: "use_tool";             tool_name: string; tool_input: Record<string, unknown>; purpose: string }
  | { type: "think_more";           thoughts: string; next_step?: string }
  | { type: "no_tool_call" };        // LLM ignored tools — signal to caller to retry

export interface ValidationResult {
  valid:  boolean;
  errors: string[];
}


export interface ModelDefinition {
  id:            string;
  displayName:   string;
  contextWindow: number;
  pricing?: {
    inputPerMillion:  number;
    outputPerMillion: number;
  };
}


/**
 * A single event emitted by a streaming LLM call.
 * Used by chatStream() and executeWithToolLoopStreaming().
 */
export interface LlmStreamEvent {
  type: "text_delta" | "tool_use_start" | "tool_use_input_delta" | "tool_use_end" | "message_done" | "error";
  /** For text_delta: the token text. */
  text?: string;
  /** For tool_use_start / tool_use_end / tool_use_input_delta. */
  toolUse?: {
    id:            string;
    name:          string;
    /** JSON fragment being built — only populated for tool_use_input_delta. */
    inputPartial?: string;
  };
  /** For message_done: token usage. */
  usage?: { inputTokens: number; outputTokens: number };
  /** For error: human-readable description. */
  error?: string;
}

export interface ProviderAdapter {
  readonly providerName: string;
  readonly defaultModel: string;

  /** Standard chat completion (no tool use). */
  chat(request: LLMRequest): Promise<LLMResponse>;

  /** Chat with AGENT_DECISION_TOOLS injected. */
  chatWithTools(request: LLMRequest, tools: ToolDefinition[]): Promise<ToolLLMResponse>;

  /**
   * Streaming chat completion.
   * Optional — providers that don't implement this fall back to chatWithTools().
   * Yields LlmStreamEvent items token-by-token.
   * Tool input deltas (tool_use_input_delta) MUST NOT be forwarded to the client
   * because they may contain secrets.
   */
  chatStream?(request: LLMRequest, tools?: ToolDefinition[]): AsyncGenerator<LlmStreamEvent>;

  /** Heuristic token estimation for pre-call budget checks. */
  estimateTokens(messages: LLMMessage[]): number;

  /** Supported models for this adapter. */
  getModels(): ModelDefinition[];
}
