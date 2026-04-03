// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13a: OpenAI-Compatible Raw-HTTP Adapter
 *
 * A single adapter that handles any provider that speaks the OpenAI Chat
 * Completions API format:
 *   - OpenAI     (https://api.openai.com/v1)
 *   - DeepSeek   (https://api.deepseek.com/v1)
 *   - Grok / xAI (https://api.x.ai/v1)
 *   - Kimi / Moonshot (https://api.moonshot.ai/v1)
 *
 * Tool use: sends `tools` array with `type: "function"`, response contains
 * `tool_calls` in the assistant message.
 */

import { createLogger } from "../../core/logger.js";
import { SidjuaError }  from "../../core/error-codes.js";
import type {
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LlmStreamEvent,
  ModelDefinition,
  ProviderAdapter,
  ToolCall,
  ToolDefinition,
  ToolLLMResponse,
  TokenUsage,
} from "../types.js";

const logger = createLogger("providers");


export interface OpenAICompatibleAdapterConfig {
  apiKey:         string;
  baseUrl:        string;          // varies per provider
  defaultModel:   string;
  providerName:   string;          // "openai" | "deepseek" | "grok" | "kimi"
  timeout_ms?:    number;          // default: 120 000
  /** Additional headers merged into every request (e.g. X-Wait-For-Model). */
  customHeaders?: Record<string, string>;
}


interface OAIMessage {
  role:    string;
  content: string | null;
}

interface OAIToolFunction {
  name:      string;
  arguments: string;            // JSON string
}

interface OAIToolCall {
  id:       string;
  type:     "function";
  function: OAIToolFunction;
}

interface OAIResponseMessage extends OAIMessage {
  tool_calls?: OAIToolCall[];
}

interface OAIChoice {
  index:         number;
  finish_reason: string | null;
  message:       OAIResponseMessage;
}

interface OAIUsage {
  prompt_tokens:     number;
  completion_tokens: number;
  total_tokens:      number;
}

interface OAIResponse {
  id:      string;
  model:   string;
  choices: OAIChoice[];
  usage:   OAIUsage;
}

interface OAIErrorBody {
  error?: { message?: string; type?: string; code?: string };
}


export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly defaultModel: string;
  readonly providerName: string;

  private readonly apiKey:        string;
  private readonly baseUrl:       string;
  private readonly timeout:       number;
  private readonly customHeaders: Record<string, string>;

  constructor(config: OpenAICompatibleAdapterConfig) {
    this.apiKey        = config.apiKey;
    this.baseUrl       = config.baseUrl.replace(/\/$/, "");
    this.defaultModel  = config.defaultModel;
    this.providerName  = config.providerName;
    this.timeout       = config.timeout_ms ?? 120_000;
    this.customHeaders = config.customHeaders ?? {};
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.defaultModel;
    const body  = this.buildBody(request, model);
    const start = Date.now();
    const raw   = await this.post("/chat/completions", body);
    return this.parseResponse(raw, model, start);
  }

  async chatWithTools(request: LLMRequest, tools: ToolDefinition[]): Promise<ToolLLMResponse> {
    const model = request.model ?? this.defaultModel;
    const body  = this.buildBody(request, model, tools);
    const start = Date.now();
    const raw   = await this.post("/chat/completions", body);
    return this.parseToolResponse(raw, model, start);
  }

  async *chatStream(request: LLMRequest, tools?: ToolDefinition[]): AsyncGenerator<LlmStreamEvent> {
    const model = request.model ?? this.defaultModel;
    const body  = this.buildBody(request, model, tools);
    const url   = `${this.baseUrl}/chat/completions`;

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeout);

    let res: Response;
    try {
      res = await fetch(url, {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type":  "application/json",
          ...this.customHeaders,
        },
        body:   JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      yield { type: "error", error: err instanceof Error ? err.message : String(err) };
      return;
    }
    clearTimeout(timer);

    if (!res.ok) {
      yield { type: "error", error: `API error: ${res.status}` };
      return;
    }

    const reader = res.body?.getReader();
    if (reader === undefined || reader === null) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer    = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data) as Record<string, unknown>;
          } catch (_parseErr: unknown) {
            continue; // skip malformed SSE chunk
          }

          yield* this.parseOpenAiChunk(chunk);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private *parseOpenAiChunk(chunk: Record<string, unknown>): Generator<LlmStreamEvent> {
    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(choices) || choices.length === 0) return;

    const choice = choices[0] as Record<string, unknown>;
    const delta  = choice["delta"] as Record<string, unknown> | undefined;
    if (delta === undefined) return;

    // Text content
    const content = delta["content"];
    if (typeof content === "string" && content.length > 0) {
      yield { type: "text_delta", text: content };
    }

    // Tool calls
    const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = tc["function"] as Record<string, unknown> | undefined;
        // New tool call: has id
        if (typeof tc["id"] === "string" && tc["id"].length > 0) {
          yield {
            type:    "tool_use_start",
            toolUse: {
              id:   String(tc["id"]),
              name: String(fn?.["name"] ?? ""),
            },
          };
        }
        // Input delta: may contain secrets — NOT forwarded
        const args = fn?.["arguments"];
        if (typeof args === "string" && args.length > 0) {
          yield {
            type:    "tool_use_input_delta",
            toolUse: {
              id:           String(tc["id"] ?? ""),
              name:         "",
              inputPartial: args,
            },
          };
        }
      }
    }

    // Finish reason signals end of message
    const finishReason = choice["finish_reason"];
    if (finishReason !== null && finishReason !== undefined) {
      yield { type: "message_done" };
    }
  }

  estimateTokens(messages: LLMMessage[]): number {
    // ~4 chars per token + 4 overhead per message
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 4, 0);
  }

  getModels(): ModelDefinition[] {
    switch (this.providerName) {
      case "openai":
        return [
          { id: "gpt-4o",      displayName: "GPT-4o",      contextWindow: 128_000, pricing: { inputPerMillion:  2.50, outputPerMillion: 10.00 } },
          { id: "gpt-4o-mini", displayName: "GPT-4o Mini", contextWindow: 128_000, pricing: { inputPerMillion:  0.15, outputPerMillion:  0.60 } },
        ];
      case "deepseek":
        return [
          { id: "deepseek-chat",   displayName: "DeepSeek V3",   contextWindow: 64_000,  pricing: { inputPerMillion: 0.27, outputPerMillion: 1.10 } },
          { id: "deepseek-reason", displayName: "DeepSeek R1",   contextWindow: 64_000,  pricing: { inputPerMillion: 0.55, outputPerMillion: 2.19 } },
        ];
      case "grok":
        return [
          { id: "grok-3-latest", displayName: "Grok-3", contextWindow: 131_072, pricing: { inputPerMillion: 3.00, outputPerMillion: 15.00 } },
        ];
      case "kimi":
        return [
          { id: "moonshot-v1-128k", displayName: "Kimi 128k", contextWindow: 128_000, pricing: { inputPerMillion: 2.40, outputPerMillion:  9.60 } },
        ];
      default:
        return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildBody(
    request: LLMRequest,
    model:   string,
    tools?:  ToolDefinition[],
  ): Record<string, unknown> {
    const messages: OAIMessage[] = [];

    const systemContent =
      request.systemPrompt ??
      request.messages.find((m) => m.role === "system")?.content;

    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }

    for (const m of request.messages) {
      if (m.role === "system" && systemContent) continue; // already added above
      messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4_096,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    if (tools !== undefined && tools.length > 0) {
      body["tools"] = tools.map((t) => ({
        type:     "function",
        function: {
          name:        t.name,
          description: t.description,
          parameters:  t.parameters,
        },
      }));
      body["tool_choice"] = "auto";
    }

    return body;
  }

  private parseResponse(raw: OAIResponse, model: string, start: number): LLMResponse {
    const choice = raw.choices[0];
    const usage: TokenUsage = {
      inputTokens:  raw.usage.prompt_tokens,
      outputTokens: raw.usage.completion_tokens,
      totalTokens:  raw.usage.total_tokens,
    };

    return {
      content:  choice?.message.content ?? "",
      usage,
      latencyMs: Date.now() - start,
      model:     raw.model ?? model,
      provider:  this.providerName,
      ...(choice?.finish_reason != null ? { finishReason: choice.finish_reason } : {}),
    };
  }

  private parseToolResponse(raw: OAIResponse, model: string, start: number): ToolLLMResponse {
    const base    = this.parseResponse(raw, model, start);
    const choice  = raw.choices[0];
    const message = choice?.message;

    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch (e: unknown) {
        logger.warn("openai-compatible-adapter", "Tool argument JSON parse failed — using empty input", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      }
      return { id: tc.id, name: tc.function.name, input };
    });

    return {
      ...base,
      toolCalls,
      textContent: message?.content ?? "",
    };
  }

  /** POST to the provider endpoint with abort-controller timeout + error mapping. */
  private async post(path: string, body: unknown): Promise<OAIResponse> {
    const url        = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeout);

    let res: Response;
    try {
      res = await fetch(url, {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "content-type":  "application/json",
          ...this.customHeaders,
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const detail  = isAbort ? "Request timed out" : String(err);
      logger.error("openai_fetch_error", detail, {
        error: { code: "PROV-001", message: detail },
        metadata: { provider: this.providerName },
      });
      throw SidjuaError.from("PROV-001", `${this.providerName}: ${detail}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      await this.mapHttpError(res);
    }

    return res.json() as Promise<OAIResponse>;
  }

  private async mapHttpError(res: Response): Promise<never> {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json() as OAIErrorBody;
      if (body.error?.message) detail = body.error.message;
    } catch (e: unknown) { logger.debug("openai-compatible-adapter", "OpenAI error body JSON parse failed — using string fallback", { metadata: { error: e instanceof Error ? e.message : String(e) } }); }

    const { status } = res;
    logger.error("openai_api_error", `${this.providerName} API error ${status}: ${detail}`, {
      error: { code: "PROV-001", message: detail },
      metadata: { status, provider: this.providerName },
    });

    if (status === 401) throw SidjuaError.from("PROV-005", `${this.providerName}: ${detail}`);
    if (status === 400) throw SidjuaError.from("PROV-006", `${this.providerName}: ${detail}`);
    if (status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      throw SidjuaError.from("PROV-002", `${this.providerName}: rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`);
    }
    throw SidjuaError.from("PROV-001", `${this.providerName}: ${detail}`);
  }
}
