// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13a: Anthropic Raw-HTTP Adapter
 *
 * Calls the Anthropic Messages API directly with Node.js built-in fetch().
 * No SDK dependency — keeps the adapter thin and avoids version coupling.
 *
 * Endpoints used:
 *   POST https://api.anthropic.com/v1/messages
 *
 * Tool use: sends `tools` array; response contains `tool_use` content blocks.
 * Non-streaming only (V1 design decision — full response buffered for audit).
 */

import { createLogger } from "../../core/logger.js";
import { SidjuaError }  from "../../core/error-codes.js";
import { ANTHROPIC_TOOLS } from "../tool-response-parser.js";
import type {
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ModelDefinition,
  ProviderAdapter,
  ToolCall,
  ToolDefinition,
  ToolLLMResponse,
  TokenUsage,
} from "../types.js";

const logger = createLogger("providers");


export interface AnthropicAdapterConfig {
  apiKey:       string;
  baseUrl?:     string;          // default: https://api.anthropic.com
  defaultModel: string;          // e.g. "claude-sonnet-4-5-20250929"
  maxRetries?:  number;
  timeout_ms?:  number;          // default: 120 000
}


interface AnthropicRequestBody {
  model:       string;
  messages:    { role: "user" | "assistant"; content: string }[];
  system?:     string;
  max_tokens:  number;
  temperature?: number;
  tools?:      unknown[];
  tool_choice?: { type: "auto" };
}

interface AnthropicTextBlock  { type: "text";     text:  string }
interface AnthropicToolUseBlock {
  type:  "tool_use";
  id:    string;
  name:  string;
  input: Record<string, unknown>;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicResponse {
  id:          string;
  model:       string;
  stop_reason: string | null;
  content:     AnthropicContentBlock[];
  usage: {
    input_tokens:  number;
    output_tokens: number;
  };
}

interface AnthropicErrorBody {
  error?: { type?: string; message?: string };
}


export class AnthropicAdapter implements ProviderAdapter {
  readonly providerName = "anthropic";
  readonly defaultModel: string;

  private readonly apiKey:   string;
  private readonly baseUrl:  string;
  private readonly timeout:  number;

  constructor(config: AnthropicAdapterConfig) {
    this.apiKey      = config.apiKey;
    this.baseUrl     = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.defaultModel = config.defaultModel;
    this.timeout     = config.timeout_ms ?? 120_000;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const model  = request.model ?? this.defaultModel;
    const body   = this.buildBody(request, model);
    const start  = Date.now();
    const raw    = await this.post("/v1/messages", body);
    return this.parseResponse(raw, model, start);
  }

  async chatWithTools(request: LLMRequest, tools: ToolDefinition[]): Promise<ToolLLMResponse> {
    const model  = request.model ?? this.defaultModel;
    const body   = this.buildBody(request, model, tools);
    const start  = Date.now();
    const raw    = await this.post("/v1/messages", body);
    return this.parseToolResponse(raw, model, start);
  }

  estimateTokens(messages: LLMMessage[]): number {
    // ~4 chars per token + 4 overhead per message
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 4, 0);
  }

  getModels(): ModelDefinition[] {
    return [
      { id: "claude-opus-4-6",              displayName: "Claude Opus 4.6",   contextWindow: 200_000, pricing: { inputPerMillion: 15.00, outputPerMillion: 75.00 } },
      { id: "claude-sonnet-4-6",            displayName: "Claude Sonnet 4.6", contextWindow: 200_000, pricing: { inputPerMillion:  3.00, outputPerMillion: 15.00 } },
      { id: "claude-haiku-4-5-20251001",    displayName: "Claude Haiku 4.5",  contextWindow: 200_000, pricing: { inputPerMillion:  0.80, outputPerMillion:  4.00 } },
    ];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildBody(
    request: LLMRequest,
    model:   string,
    tools?:  ToolDefinition[],
  ): AnthropicRequestBody {
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const systemContent =
      request.systemPrompt ??
      request.messages.find((m) => m.role === "system")?.content;

    const body: AnthropicRequestBody = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4_096,
      ...(systemContent !== undefined ? { system: systemContent } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    if (tools !== undefined && tools.length > 0) {
      const anthropicTools = tools.map((t) => ({
        name:         t.name,
        description:  t.description,
        input_schema: t.parameters,
      }));
      body.tools       = anthropicTools;
      body.tool_choice = { type: "auto" };
    }

    return body;
  }

  private parseResponse(raw: AnthropicResponse, model: string, start: number): LLMResponse {
    const usage: TokenUsage = {
      inputTokens:  raw.usage.input_tokens,
      outputTokens: raw.usage.output_tokens,
      totalTokens:  raw.usage.input_tokens + raw.usage.output_tokens,
    };

    const content = raw.content
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      content,
      usage,
      latencyMs: Date.now() - start,
      model,
      provider:  "anthropic",
      ...(raw.stop_reason != null ? { finishReason: raw.stop_reason } : {}),
    };
  }

  private parseToolResponse(raw: AnthropicResponse, model: string, start: number): ToolLLMResponse {
    const base  = this.parseResponse(raw, model, start);

    const toolCalls: ToolCall[] = raw.content
      .filter((b): b is AnthropicToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    const textContent = raw.content
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return { ...base, toolCalls, textContent };
  }

  /** POST to the Anthropic API with abort-controller timeout + error mapping. */
  private async post(path: string, body: unknown): Promise<AnthropicResponse> {
    const url        = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeout);

    let res: Response;
    try {
      res = await fetch(url, {
        method:  "POST",
        headers: {
          "x-api-key":         this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const detail  = isAbort ? "Request timed out" : String(err);
      logger.error("anthropic_fetch_error", detail, { error: { code: "PROV-001", message: detail } });
      throw SidjuaError.from("PROV-001", detail);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      await this.mapHttpError(res);
    }

    return res.json() as Promise<AnthropicResponse>;
  }

  private async mapHttpError(res: Response): Promise<never> {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json() as AnthropicErrorBody;
      if (body.error?.message) detail = body.error.message;
    } catch (e: unknown) { logger.debug("anthropic-adapter", "Anthropic error body JSON parse failed — using string fallback", { metadata: { error: e instanceof Error ? e.message : String(e) } }); }

    const { status } = res;
    logger.error("anthropic_api_error", `Anthropic API error ${status}: ${detail}`, {
      error: { code: "PROV-001", message: detail },
      metadata: { status },
    });

    if (status === 401) throw SidjuaError.from("PROV-005", detail);
    if (status === 400) throw SidjuaError.from("PROV-006", detail);
    if (status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      throw SidjuaError.from("PROV-002", `Rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`);
    }
    if (status === 529) throw SidjuaError.from("PROV-001", "Anthropic API overloaded");
    throw SidjuaError.from("PROV-001", detail);
  }
}
