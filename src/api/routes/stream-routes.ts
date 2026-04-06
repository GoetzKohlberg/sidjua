// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — P377: LLM SSE Streaming Endpoint
 *
 * GET /api/v1/stream/:agentId?message=<text>
 *
 * Streams an LLM completion token-by-token as Server-Sent Events.
 * The agent's configured provider is used; MCP tools are included if
 * an McpRegistry is provided.
 *
 * Security:
 *   - requireScope("operator") — LLM execution requires at least operator scope
 *   - Max 5 concurrent streams per token (429 when exceeded)
 *   - 5-minute idle timeout (no events for 5 min → close)
 *   - tool_use_input_delta events NOT forwarded to client (may contain secrets)
 *
 * SSE event types forwarded to client:
 *   - text_delta      { text }
 *   - message_done    { usage? }
 *   - error           { error }
 *
 * Events that are NEVER forwarded:
 *   - tool_use_start  (internal)
 *   - tool_use_input_delta (security: may contain secrets)
 *   - tool_use_end    (internal)
 */

import { Hono, type Context } from "hono";
import { streamSSE }          from "hono/streaming";
import { randomUUID }         from "node:crypto";
import { createLogger }       from "../../core/logger.js";
import { requireScope, CALLER_CONTEXT_KEY } from "../middleware/require-scope.js";
import type { CallerContext }  from "../caller-context.js";
import { getProviderForAgent } from "../../core/provider-config.js";
import { AnthropicAdapter }            from "../../providers/adapters/anthropic-adapter.js";
import { OpenAICompatibleAdapter }     from "../../providers/adapters/openai-compatible-adapter.js";
import { executeWithToolLoopStreaming } from "../../core/mcp/tool-executor-streaming.js";
import type { McpRegistry }   from "../../core/mcp/mcp-registry.js";
import type { McpMessage }    from "../../core/mcp/tool-executor.js";
import type { ProviderAdapter } from "../../providers/types.js";
import type Database          from "better-sqlite3";

const logger = createLogger("stream-routes");

/** Maximum concurrent SSE streams per caller token. */
const MAX_STREAMS_PER_TOKEN = 5;

/** Idle timeout: if no event is produced in this window, close the stream. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

/** Track active stream count per tokenId. */
const _activeStreams = new Map<string, number>();

/** Reset stream counters — for testing only. */
export function clearStreamState(): void {
  _activeStreams.clear();
}

function incrementStreams(key: string): boolean {
  const current = _activeStreams.get(key) ?? 0;
  if (current >= MAX_STREAMS_PER_TOKEN) return false;
  _activeStreams.set(key, current + 1);
  return true;
}

function decrementStreams(key: string): void {
  const current = _activeStreams.get(key) ?? 0;
  if (current <= 1) {
    _activeStreams.delete(key);
  } else {
    _activeStreams.set(key, current - 1);
  }
}

/**
 * Build a ProviderAdapter from the ConfiguredProvider data.
 * Returns null if provider_id is unknown.
 */
function buildAdapter(provider: {
  provider_id: string;
  api_key:     string;
  api_base?:   string;
  model?:      string;
}): ProviderAdapter | null {
  const { provider_id, api_key, api_base, model } = provider;

  if (provider_id === "anthropic") {
    return new AnthropicAdapter({
      apiKey:       api_key,
      defaultModel: model ?? "claude-sonnet-4-6",
      ...(api_base ? { baseUrl: api_base } : {}),
    });
  }

  // OpenAI-compatible providers
  const oaiProviders: Record<string, { baseUrl: string; defaultModel: string }> = {
    openai:   { baseUrl: "https://api.openai.com/v1",     defaultModel: "gpt-4o-mini" },
    deepseek: { baseUrl: "https://api.deepseek.com/v1",   defaultModel: "deepseek-chat" },
    grok:     { baseUrl: "https://api.x.ai/v1",           defaultModel: "grok-3-latest" },
    kimi:     { baseUrl: "https://api.moonshot.ai/v1",    defaultModel: "moonshot-v1-128k" },
  };

  const oai = oaiProviders[provider_id];
  if (oai !== undefined) {
    return new OpenAICompatibleAdapter({
      apiKey:       api_key,
      baseUrl:      api_base ?? oai.baseUrl,
      defaultModel: model ?? oai.defaultModel,
      providerName: provider_id,
    });
  }

  // Custom OpenAI-compatible endpoint (api_base is mandatory)
  if (api_base !== undefined && api_base.length > 0) {
    return new OpenAICompatibleAdapter({
      apiKey:       api_key,
      baseUrl:      api_base,
      defaultModel: model ?? "llama-3.3-70b-versatile",
      providerName: provider_id,
    });
  }

  return null;
}


export interface StreamRouteServices {
  /** Optional MCP registry — tools included when present. */
  mcpRegistry?: McpRegistry | null;
  /** Working directory — passed to tool loop for memory verification. */
  workDir?: string;
  /** Optional DB — for future agent lookup context. */
  db?: InstanceType<typeof Database> | null;  // eslint-disable-line @typescript-eslint/no-explicit-any
}


export function registerStreamRoutes(app: Hono, services: StreamRouteServices = {}): void {
  const { mcpRegistry = null, workDir = process.cwd() } = services;

  /**
   * GET /api/v1/stream/:agentId
   *
   * Query params:
   *   message  — required — the user's message text
   *   model    — optional — override the agent's default model
   */
  app.get("/api/v1/stream/:agentId", requireScope("operator"), (c: Context) => {
    const agentId = c.req.param("agentId")!;
    const message = c.req.query("message");

    if (!message || message.trim().length === 0) {
      return c.json(
        { error: { code: "REQ-001", message: "message query parameter is required", recoverable: true } },
        400,
      );
    }

    const ctx      = c.get(CALLER_CONTEXT_KEY) as CallerContext | undefined;
    const streamKey = ctx?.tokenId ?? ctx?.agentId ?? "anonymous";

    // Concurrent stream limit per token
    if (!incrementStreams(streamKey)) {
      logger.warn("stream_limit_exceeded", "Concurrent stream limit exceeded", {
        metadata: { agentId, streamKey, limit: MAX_STREAMS_PER_TOKEN },
      });
      return c.json(
        {
          error: {
            code:        "RATE-001",
            message:     `Maximum ${MAX_STREAMS_PER_TOKEN} concurrent streams per token`,
            recoverable: true,
          },
        },
        429,
      );
    }

    return streamSSE(c, async (stream) => {
      const conversationId = randomUUID();
      let   idleTimer: ReturnType<typeof setTimeout> | null = null;

      function resetIdle(): void {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          void stream.close();
        }, IDLE_TIMEOUT_MS);
      }

      try {
        // Resolve provider config
        const providerConfig = getProviderForAgent(agentId);
        if (providerConfig === null) {
          await stream.writeSSE({
            event: "error",
            data:  JSON.stringify({ error: "No LLM provider configured for this agent" }),
          });
          return;
        }

        const adapter = buildAdapter(providerConfig);
        if (adapter === null) {
          await stream.writeSSE({
            event: "error",
            data:  JSON.stringify({ error: `Unknown provider: ${providerConfig.provider_id}` }),
          });
          return;
        }

        const overrideModel = c.req.query("model");
        const model         = overrideModel ?? providerConfig.model ?? adapter.defaultModel;
        const trimmedMsg    = message.trim();

        const messages: McpMessage[] = [
          { role: "user", content: trimmedMsg },
        ];

        const toolCtx = {
          agentId,
          division:        ctx?.division ?? "",
          tier:            "T2",
          budgetRemaining: Number.MAX_SAFE_INTEGER,
          conversationId,
          model,
          workDir,
        };

        resetIdle();

        // Build the event generator
        const gen = mcpRegistry !== null
          ? executeWithToolLoopStreaming(adapter, mcpRegistry, messages, toolCtx)
          : (async function* directStream() {
              if (typeof adapter.chatStream === "function") {
                yield* adapter.chatStream!({ model, messages: [{ role: "user", content: trimmedMsg }] });
              } else {
                const res = await adapter.chat({ model, messages: [{ role: "user", content: trimmedMsg }] });
                yield { type: "text_delta" as const, text: res.content };
                yield {
                  type:  "message_done" as const,
                  usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens },
                };
              }
            })();

        for await (const event of gen) {
          if (stream.closed) break;
          resetIdle();

          switch (event.type) {
            case "text_delta":
              await stream.writeSSE({
                event: "text_delta",
                data:  JSON.stringify({ text: event.text ?? "" }),
              });
              break;

            case "message_done":
              await stream.writeSSE({
                event: "message_done",
                data:  JSON.stringify({ ...(event.usage !== undefined ? { usage: event.usage } : {}) }),
              });
              break;

            case "error":
              await stream.writeSSE({
                event: "error",
                data:  JSON.stringify({ error: event.error ?? "Unknown error" }),
              });
              break;

            // tool_use_start, tool_use_input_delta, tool_use_end — NOT forwarded
            default:
              break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("stream_error", "Stream handler error", {
          metadata: { agentId, error: msg },
        });
        if (!stream.closed) {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ error: msg }) });
        }
      } finally {
        if (idleTimer !== null) clearTimeout(idleTimer);
        decrementStreams(streamKey);
      }
    });
  });
}
