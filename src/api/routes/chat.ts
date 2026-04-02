// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Agent Chat REST Endpoints
 *
 * POST   /api/v1/chat/:agentId         — Send a message (SSE stream response)
 * GET    /api/v1/chat/:agentId/history — Get conversation history
 * DELETE /api/v1/chat/:agentId/history — Clear conversation history
 *
 * Conversation history is stored in-process (in-memory Map). Max 100 messages
 * per conversation are kept in the LLM context window.
 */

import { Hono }                    from "hono";
import { streamSSE }               from "hono/streaming";
import { requireScope }            from "../middleware/require-scope.js";
import { randomUUID }              from "node:crypto";
import { SidjuaError }             from "../../core/error-codes.js";
import { createLogger }            from "../../core/logger.js";
import { getStarterAgents }        from "../../defaults/loader.js";
import { buildSystemPrompt }       from "../../defaults/loader.js";
import { getProviderForAgent }     from "../../core/provider-config.js";
import type { AgentRole }          from "../../defaults/loader.js";
import { loadDefaultRoles }        from "../../defaults/loader.js";
import { getToolDefinitions,
         executeToolCall }         from "./agent-tools.js";
import type { AgentVisibilityContext } from "./agent-tools.js";
import type { Database }           from "better-sqlite3";
import { runAuditMigrations }      from "../../core/audit/audit-migrations.js";
import { bridgeAuditEvent }        from "../../core/activity/bridges/audit-event-bridge.js";
import type { UploadStore }        from "../../uploads/upload-store.js";
import { ConversationUploadTracker } from "../../uploads/conversation-uploads.js";

const logger = createLogger("chat-routes");


interface ChatMessage {
  id:           string;
  role:         "user" | "assistant" | "tool_call" | "tool_result";
  content:      string;
  timestamp:    string;
  tool_name?:   string;
  tool_call_id?: string;
  tool_success?: boolean;
}

interface Conversation {
  conversation_id: string;
  agent_id:        string;
  messages:        ChatMessage[];
}

/** Maximum concurrent conversations held in memory. LRU eviction when exceeded. */
const MAX_CONVERSATIONS = 500;

const _conversations = new Map<string, Conversation>();

/** Map from agentId to the most recent conversationId (for default lookups). */
const _agentConversation = new Map<string, string>();

/** Reset all state — for testing only. */
export function clearChatState(): void {
  _conversations.clear();
  _agentConversation.clear();
}


let _auditTableEnsured = false;

/**
 * Write a single row to audit_events.
 * Lazily ensures the audit table exists. Non-fatal — logs failures at debug level.
 */
function writeAuditEvent(
  db:        Database | null,
  agentId:   string,
  eventType: string,
  action:    "allowed" | "blocked" | "escalated",
  details:   Record<string, unknown>,
): void {
  if (db === null) return;
  try {
    if (!_auditTableEnsured) {
      runAuditMigrations(db);
      _auditTableEnsured = true;
    }
    db.prepare(
      `INSERT INTO audit_events
         (id, agent_id, division, event_type, rule_id, action, severity, details)
       VALUES (?, ?, '', ?, '', ?, 'low', ?)`,
    ).run(randomUUID(), agentId, eventType, action, JSON.stringify(details));
    bridgeAuditEvent({
      agent_id:   agentId,
      division:   "",
      event_type: eventType,
      action,
      severity:   "low",
      details:    JSON.stringify(details),
    });
  } catch (_e) {
    logger.warn("chat-routes", "audit write failed", {
      metadata: { eventType, agentId, error: _e instanceof Error ? _e.message : String(_e) },
    });
  }
}


/** Max bytes per conversation accepted for restore (matches the live request limit). */
const MAX_CONVERSATION_BYTES = 10 * 1024 * 1024; // 10 MiB

/** DDL for the chat_conversations table. Called lazily before first use. */
function ensureChatTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      messages   TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

/**
 * Persist all in-memory conversations to SQLite.
 * Called by the checkpoint timer and during graceful shutdown.
 * Never throws — errors are logged and swallowed.
 */
export function persistChatState(db: Database): void {
  try {
    ensureChatTable(db);
    const now = new Date().toISOString();
    const upsert = db.prepare<[string, string, string, string, string, string], void>(
      `INSERT OR REPLACE INTO chat_conversations (id, agent_id, messages, created_at, updated_at)
       VALUES (?, ?, ?, COALESCE((SELECT created_at FROM chat_conversations WHERE id = ?), ?), ?)`,
    );
    const deleteStale = db.prepare<[string], void>(
      "DELETE FROM chat_conversations WHERE id = ?",
    );

    // Collect IDs currently in DB so we can delete evicted conversations
    const dbIds = new Set<string>(
      (db.prepare<[], { id: string }>("SELECT id FROM chat_conversations").all())
        .map((r) => r.id),
    );

    const persist = db.transaction(() => {
      for (const [id, conv] of _conversations) {
        upsert.run(id, conv.agent_id, JSON.stringify(conv.messages), id, now, now);
        dbIds.delete(id); // still in memory — don't delete
      }
      // Remove conversations evicted from memory
      for (const staleId of dbIds) {
        deleteStale.run(staleId);
      }
    });
    persist();
  } catch (e: unknown) {
    logger.warn("chat-routes", "Chat state persist failed — non-fatal", {
      metadata: { error: e instanceof Error ? e.message : String(e) },
    });
  }
}

/**
 * Restore conversations from SQLite into the in-memory Map.
 * Called on startup before the HTTP server starts.
 * Loads at most MAX_CONVERSATIONS entries ordered by most-recently-updated.
 * Skips conversations whose serialized messages exceed MAX_CONVERSATION_BYTES.
 */
export function restoreChatState(db: Database): number {
  try {
    ensureChatTable(db);
    const rows = db.prepare<[number], { id: string; agent_id: string; messages: string }>(
      `SELECT id, agent_id, messages FROM chat_conversations
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(MAX_CONVERSATIONS);

    let restored = 0;
    for (const row of rows) {
      if (Buffer.byteLength(row.messages, "utf8") > MAX_CONVERSATION_BYTES) continue;
      try {
        const messages = JSON.parse(row.messages) as ChatMessage[];
        const conv: Conversation = { conversation_id: row.id, agent_id: row.agent_id, messages };
        _conversations.set(row.id, conv);
        _agentConversation.set(row.agent_id, row.id);
        restored++;
      } catch (_e) {
        // Skip malformed rows
      }
    }
    return restored;
  } catch (e: unknown) {
    logger.warn("chat-routes", "Chat state restore failed — starting with empty history", {
      metadata: { error: e instanceof Error ? e.message : String(e) },
    });
    return 0;
  }
}

/**
 * Evict the oldest conversation when the store is at capacity.
 * Map insertion order is FIFO — the first entry is the oldest.
 */
function evictOldestIfNeeded(): void {
  if (_conversations.size < MAX_CONVERSATIONS) return;
  const oldest = _conversations.keys().next().value;
  if (oldest !== undefined) {
    _conversations.delete(oldest);
    for (const [agentId, convId] of _agentConversation.entries()) {
      if (convId === oldest) { _agentConversation.delete(agentId); break; }
    }
  }
}

function getOrCreateConversation(agentId: string, conversationId?: string): Conversation {
  const id = conversationId ?? _agentConversation.get(agentId) ?? randomUUID();
  let conv = _conversations.get(id);
  if (!conv) {
    evictOldestIfNeeded();
    conv = { conversation_id: id, agent_id: agentId, messages: [] };
    _conversations.set(id, conv);
  }
  _agentConversation.set(agentId, id);
  return conv;
}


let _rolesCache: Map<string, AgentRole> | null = null;

function getRoleMap(): Map<string, AgentRole> {
  if (_rolesCache !== null) return _rolesCache;
  try {
    const roles = loadDefaultRoles();
    _rolesCache = new Map(roles.map((r) => [r.id, r]));
  } catch (_loadErr: unknown) {
    _rolesCache = new Map();
  }
  return _rolesCache;
}

/** Reset role cache — for testing only. */
export function clearRoleCache(): void {
  _rolesCache = null;
}


/**
 * Build an OpenAI-compatible messages array from conversation history + new user message.
 * Truncates to the last 100 messages (preserving system prompt as first entry).
 * Upload context is appended to the system prompt so all providers receive it correctly.
 */
function buildMessages(
  systemPrompt:   string,
  history:        ChatMessage[],
  userMessage:    string,
  uploadContexts?: Array<{ content: string }>,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const MAX_HISTORY = 98; // system + up to 98 history + user = 100 total
  // Only "user" and "assistant" roles map to LLM API roles; tool_call/tool_result are internal
  const llmHistory = history.filter(
    (m): m is ChatMessage & { role: "user" | "assistant" } =>
      m.role === "user" || m.role === "assistant",
  );
  const trimmed = llmHistory.slice(-MAX_HISTORY);

  // Append upload context to system prompt so all providers handle it correctly
  let effectiveSystemPrompt = systemPrompt;
  if (uploadContexts !== undefined && uploadContexts.length > 0) {
    const uploadSection = uploadContexts.map((u) => u.content).join("\n\n");
    effectiveSystemPrompt += `\n\n## Uploaded Files\n\n${uploadSection}`;
  }

  return [
    { role: "system",    content: effectiveSystemPrompt },
    ...trimmed.map((m) => ({ role: m.role, content: m.content })),
    { role: "user",      content: userMessage },
  ];
}


export interface ChatRouteServices {
  workDir?:     string;
  db?:          Database | null;
  uploadStore?: UploadStore | null;
}

/** Maximum tool iterations per chat turn — prevents runaway tool loops. */
const MAX_TOOL_ITERATIONS = 5;

/** XML fallback pattern: <tool_call>{"tool":"name","parameters":{...}}</tool_call> */
const XML_TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

/** Llama-style: <function=tool_name>{"param":"value"}</function> */
const LLAMA_TOOL_CALL_RE = /<function=([a-z_]+)>([\s\S]*?)<\/function>/g;

interface ParsedToolCall {
  tool:       string;
  parameters: Record<string, unknown>;
}

function parseXmlToolCalls(content: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  for (const match of content.matchAll(XML_TOOL_CALL_RE)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed["tool"] === "string") {
        results.push({
          tool:       parsed["tool"],
          parameters: (typeof parsed["parameters"] === "object" && parsed["parameters"] !== null)
            ? parsed["parameters"] as Record<string, unknown>
            : {},
        });
      }
    } catch (_jsonErr: unknown) { /* skip malformed */ }
  }
  return results;
}

function parseLlamaToolCalls(content: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  for (const match of content.matchAll(LLAMA_TOOL_CALL_RE)) {
    const toolName = match[1]?.trim();
    const raw      = match[2]?.trim();
    if (!toolName) continue;
    let params: Record<string, unknown> = {};
    if (raw) {
      try { params = JSON.parse(raw) as Record<string, unknown>; }
      catch (_e: unknown) { /* skip malformed */ }
    }
    results.push({ tool: toolName, parameters: params });
  }
  return results;
}

export function registerChatRoutes(app: Hono, services: ChatRouteServices = {}): void {
  const chatWorkDir   = services.workDir ?? process.cwd();
  const chatDb        = services.db ?? null;
  const uploadTracker = (services.uploadStore != null)
    ? new ConversationUploadTracker(services.uploadStore)
    : null;

  // ── POST /api/v1/chat/:agentId ─────────────────────────────────────────
  app.post("/api/v1/chat/:agentId", requireScope("operator"), async (c) => {
    const agentId = c.req.param("agentId");

    // Validate agent exists
    const roleMap = getRoleMap();
    const role    = roleMap.get(agentId);
    if (role === undefined) {
      // Check starter agents list as well (defensive)
      const starters = getStarterAgents();
      if (!starters.some((s) => s.id === agentId)) {
        throw SidjuaError.from("CHAT-002", `Agent "${agentId}" not found`);
      }
    }

    // Get provider
    const provider = getProviderForAgent(agentId);
    if (provider === null) {
      return c.json(
        { error: "no_provider", message: "No LLM provider configured. Go to Settings to set one up." },
        400,
      );
    }

    // Enforce per-message size limit before parsing to reject large payloads early
    const MAX_MESSAGE_BYTES      = 100 * 1024;        // 100 KiB per message
    const MAX_CONVERSATION_BYTES = 10 * 1024 * 1024;  // 10 MiB total conversation

    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_MESSAGE_BYTES) {
      return c.json(
        { error: "payload_too_large", message: "Request body exceeds 100 KiB limit" },
        413,
      );
    }

    // Parse request body
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (_parseErr: unknown) {
      throw SidjuaError.from("CHAT-001", "Request body must be valid JSON");
    }

    const messageRaw = body["message"];
    if (typeof messageRaw !== "string" || messageRaw.trim() === "") {
      throw SidjuaError.from("CHAT-001", "message is required and must not be empty");
    }
    const userMessage = messageRaw.trim();

    const conversationIdRaw = body["conversation_id"];
    const conversationId    = typeof conversationIdRaw === "string" ? conversationIdRaw : undefined;

    // Get or create conversation
    const conversation  = getOrCreateConversation(agentId, conversationId);
    const convId        = conversation.conversation_id;

    // Enforce per-conversation size limit
    const existingConvBytes = conversation.messages.reduce(
      (sum, m) => sum + Buffer.byteLength(m.content, "utf8"),
      0,
    );
    if (existingConvBytes + Buffer.byteLength(userMessage, "utf8") > MAX_CONVERSATION_BYTES) {
      return c.json(
        { error: "conversation_too_large", message: "Conversation exceeds 10 MiB limit — clear history and start a new conversation" },
        413,
      );
    }

    // Add user message to history
    const userMsg: ChatMessage = {
      id:        randomUUID(),
      role:      "user",
      content:   userMessage,
      timestamp: new Date().toISOString(),
    };
    conversation.messages.push(userMsg);

    // Build system prompt and messages
    const effectiveRole = role ?? (() => {
      const r = getStarterAgents().find((s) => s.id === agentId);
      return r ? { ...r, recommended_model: { min_quality: "B+", suggested: "groq-llama70b-free" } } as AgentRole : null;
    })();

    const systemPrompt = effectiveRole !== null
      ? buildSystemPrompt(effectiveRole)
      : `You are ${agentId}, an AI assistant. Respond helpfully.`;

    // Load upload context messages for this conversation (always from DB = always current)
    const uploadContexts = uploadTracker !== null
      ? uploadTracker.getUploadContextMessages(convId)
      : [];

    const messages = buildMessages(systemPrompt, conversation.messages.slice(0, -1), userMessage, uploadContexts);

    // Clean provider url
    const apiBase    = (provider.api_base ?? "").replace(/\/$/, "");
    const apiKey     = provider.api_key;
    const model      = provider.model ?? "llama-3.3-70b-versatile";

    const agentVisCtx: AgentVisibilityContext | undefined =
      effectiveRole !== null
        ? { tier: effectiveRole.tier, division: effectiveRole.division }
        : undefined;
    const toolDefs = getToolDefinitions(agentId, agentVisCtx);

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();

      stream.onAbort(() => { controller.abort(); });

      // Send start event
      await stream.writeSSE({
        event: "message",
        data:  JSON.stringify({ type: "start", conversation_id: convId }),
      });

      let assistantContent = "";
      let inputTokens      = 0;
      let outputTokens     = 0;

      // ── Tool-aware path (Phase 1: non-streaming to detect tool calls) ──
      // When the agent has tool definitions, make a non-streaming first call.
      // If tool calls come back, execute them and stream a follow-up response.
      // Otherwise, emit the text as token events.
      if (toolDefs.length > 0) {
        try {
          const firstSignal = AbortSignal.any !== undefined
            ? AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
            : controller.signal;

          const firstRes = await fetch(`${apiBase}/chat/completions`, {
            method:  "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type":  "application/json",
            },
            body: JSON.stringify({
              model,
              messages,
              stream:      false,
              max_tokens:  1024,
              tools:       toolDefs,
              tool_choice: "auto",
            }),
            signal: firstSignal,
          });

          if (!firstRes.ok) {
            let errMsg = "LLM request failed";
            if (firstRes.status === 401 || firstRes.status === 403) errMsg = "Invalid API key — check your provider settings.";
            else if (firstRes.status === 429) errMsg = "Rate limit reached. Free providers have strict limits — please wait a moment or consider switching to a paid provider.";
            else if (firstRes.status >= 500)  errMsg = "The AI provider is temporarily unavailable. Free providers can be less reliable — if this persists, consider a paid provider or a local model.";
            else errMsg = `The AI provider returned an error (${firstRes.status}). If you are using a free provider, connection issues may occur. Consider a paid provider or a local model for better reliability.`;

            logger.warn("chat_llm_error", "LLM returned error status", {
              metadata: { agent_id: agentId, http_status: firstRes.status },
            });
            await stream.writeSSE({
              event: "message",
              data:  JSON.stringify({ type: "error", error: errMsg, details: `HTTP ${firstRes.status} from provider` }),
            });
            return;
          }

          // Some providers return SSE even when stream: false — detect and fall through
          const firstContentType = firstRes.headers.get("content-type") ?? "";
          if (firstContentType.includes("text/event-stream")) {
            // Provider ignored stream: false — process the SSE body as regular streaming
            const sseReader = firstRes.body?.getReader();
            if (sseReader) {
              const sseDecoder = new TextDecoder();
              let   sseBuf     = "";
              while (true) {
                const { done, value } = await sseReader.read();
                if (done) break;
                sseBuf += sseDecoder.decode(value, { stream: true });
                const lines = sseBuf.split("\n");
                sseBuf      = lines.pop() ?? "";
                for (const line of lines) {
                  const t = line.trim();
                  if (!t.startsWith("data:")) continue;
                  const d = t.slice(5).trim();
                  if (d === "[DONE]") break;
                  try {
                    const chunk   = JSON.parse(d) as Record<string, unknown>;
                    const usage   = chunk["usage"] as Record<string, unknown> | undefined;
                    if (usage) {
                      inputTokens  = (usage["prompt_tokens"]     as number | undefined) ?? inputTokens;
                      outputTokens = (usage["completion_tokens"] as number | undefined) ?? outputTokens;
                    }
                    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
                    if (!choices || choices.length === 0) continue;
                    const delta   = choices[0]?.["delta"] as Record<string, unknown> | undefined;
                    const content = delta?.["content"] as string | undefined;
                    if (typeof content === "string" && content.length > 0) {
                      assistantContent += content;
                      await stream.writeSSE({ event: "message", data: JSON.stringify({ type: "token", content }) });
                    }
                  } catch (_jsonErr: unknown) { /* skip */ }
                }
              }
            }
            // Skip to the done/history section below (no tool calls in SSE fallback)
            // Jump out of the tool-path by setting an empty choices result
            // (handled by the finally block and "done" event at end of streamSSE callback)
          } else {

          const firstJson      = await firstRes.json() as Record<string, unknown>;
          const firstUsage     = firstJson["usage"] as Record<string, unknown> | undefined;
          inputTokens          = (firstUsage?.["prompt_tokens"]     as number | undefined) ?? 0;
          outputTokens         = (firstUsage?.["completion_tokens"] as number | undefined) ?? 0;

          const firstChoices   = firstJson["choices"] as Array<Record<string, unknown>> | undefined;
          const firstChoice    = firstChoices?.[0];
          const finishReason   = firstChoice?.["finish_reason"] as string | undefined;
          const assistantMsg   = firstChoice?.["message"] as Record<string, unknown> | undefined;
          const nativeCalls    = assistantMsg?.["tool_calls"] as Array<Record<string, unknown>> | undefined;

          // Check for tool calls: native function calling, XML fallback, or Llama format
          const textContent    = (assistantMsg?.["content"] as string | undefined) ?? "";
          const xmlCalls       = parseXmlToolCalls(textContent);
          const llamaCalls     = parseLlamaToolCalls(textContent);

          const hasNativeCalls = finishReason === "tool_calls" && Array.isArray(nativeCalls) && nativeCalls.length > 0;
          const hasXmlCalls    = xmlCalls.length > 0;
          const hasLlamaCalls  = llamaCalls.length > 0;

          // Strip tool call tags so they don't leak into context or assistant content
          const cleanedTextContent = textContent
            .replace(LLAMA_TOOL_CALL_RE, "")
            .replace(XML_TOOL_CALL_RE, "")
            .trim();

          if (hasNativeCalls || hasXmlCalls || hasLlamaCalls) {
            const rawCalls = hasNativeCalls
              ? nativeCalls.map((tc) => {
                  const fn   = tc["function"] as Record<string, unknown> | undefined;
                  const name = fn?.["name"] as string | undefined ?? "";
                  let params: Record<string, unknown> = {};
                  try { params = JSON.parse(fn?.["arguments"] as string ?? "{}") as Record<string, unknown>; }
                  catch (_e: unknown) { /* ignore */ }
                  return { id: tc["id"] as string | undefined, name, params };
                })
              : hasXmlCalls
                ? xmlCalls.map((xc) => ({ id: undefined, name: xc.tool, params: xc.parameters }))
                : llamaCalls.map((lc) => ({ id: undefined, name: lc.tool, params: lc.parameters }));

            // Validate tool names and enforce iteration cap
            const toolCallsToExecute = rawCalls
              .filter((tc) => tc.name.trim().length > 0)
              .slice(0, MAX_TOOL_ITERATIONS);

            // Track messages for follow-up call (with tool results)
            const followUpMessages: Array<Record<string, unknown>> = [
              ...messages,
              // Append the assistant message (with or without tool_calls field)
              hasNativeCalls
                ? { role: "assistant", content: textContent || null, tool_calls: nativeCalls }
                : { role: "assistant", content: cleanedTextContent || null },
            ];

            for (const tc of toolCallsToExecute) {
              const callId = tc.id ?? randomUUID();

              // Emit tool_call SSE event
              await stream.writeSSE({
                event: "message",
                data:  JSON.stringify({ type: "tool_call", tool: tc.name, parameters: tc.params }),
              });

              // Persist tool_call in conversation history
              conversation.messages.push({
                id:           randomUUID(),
                role:         "tool_call",
                content:      JSON.stringify(tc.params),
                timestamp:    new Date().toISOString(),
                tool_name:    tc.name,
                tool_call_id: callId,
              });

              const ctx = { workDir: chatWorkDir, db: chatDb, depth: 0 };
              const result = await executeToolCall(agentId, tc.name, tc.params, ctx);

              // Emit tool_result SSE event
              await stream.writeSSE({
                event: "message",
                data:  JSON.stringify({
                  type:    "tool_result",
                  tool:    tc.name,
                  success: result.success,
                  data:    result.data ?? null,
                  error:   result.error ?? null,
                }),
              });

              // Persist tool_result in conversation history
              conversation.messages.push({
                id:           randomUUID(),
                role:         "tool_result",
                content:      result.success ? JSON.stringify(result.data) : (result.error ?? "Tool failed"),
                timestamp:    new Date().toISOString(),
                tool_name:    tc.name,
                tool_call_id: callId,
                tool_success: result.success,
              });

              // Write audit event for tool execution
              writeAuditEvent(chatDb, agentId, "tool_call", "allowed", {
                tool:    tc.name,
                success: result.success,
                error:   result.error ?? null,
              });

              const resultContent = result.success
                ? JSON.stringify(result.data)
                : `Error: ${result.error ?? "Tool execution failed"}`;

              if (hasNativeCalls && tc.id !== undefined) {
                followUpMessages.push({ role: "tool", content: resultContent, tool_call_id: tc.id });
              } else {
                // XML fallback: inject result as a user-turn tool note
                followUpMessages.push({
                  role:    "user",
                  content: `[Tool result for ${tc.name}]: ${resultContent}`,
                });
              }
            }

            // Emit any pre-tool non-tag text as assistant prefix
            if (cleanedTextContent.length > 0) {
              assistantContent = cleanedTextContent;
            }

            // Phase 2: stream the follow-up response with tool results
            const contSignal = AbortSignal.any !== undefined
              ? AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
              : controller.signal;

            const contRes = await fetch(`${apiBase}/chat/completions`, {
              method:  "POST",
              headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type":  "application/json",
              },
              body: JSON.stringify({ model, messages: followUpMessages, stream: true, max_tokens: 1024 }),
              signal: contSignal,
            });

            if (!contRes.ok) {
              let errMsg = "LLM follow-up request failed";
              if (contRes.status === 401 || contRes.status === 403) errMsg = "Invalid API key";
              else if (contRes.status === 429) errMsg = "Rate limit reached. Please wait a moment and try again.";
              await stream.writeSSE({
                event: "message",
                data:  JSON.stringify({ type: "error", error: errMsg, details: `HTTP ${contRes.status} from provider` }),
              });
              return;
            }

            const contReader = contRes.body?.getReader();
            if (!contReader) {
              await stream.writeSSE({
                event: "message",
                data:  JSON.stringify({ type: "error", error: "Provider returned no response body" }),
              });
              return;
            }

            const contDecoder = new TextDecoder();
            let   contBuffer  = "";
            while (true) {
              const { done, value } = await contReader.read();
              if (done) break;
              contBuffer += contDecoder.decode(value, { stream: true });
              const lines = contBuffer.split("\n");
              contBuffer  = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const dataStr = trimmed.slice(5).trim();
                if (dataStr === "[DONE]") break;
                try {
                  const chunk   = JSON.parse(dataStr) as Record<string, unknown>;
                  const usage   = chunk["usage"] as Record<string, unknown> | undefined;
                  if (usage) {
                    outputTokens += (usage["completion_tokens"] as number | undefined) ?? 0;
                  }
                  const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
                  if (!choices || choices.length === 0) continue;
                  const delta   = choices[0]?.["delta"] as Record<string, unknown> | undefined;
                  const content = delta?.["content"] as string | undefined;
                  if (typeof content === "string" && content.length > 0) {
                    assistantContent += content;
                    await stream.writeSSE({ event: "message", data: JSON.stringify({ type: "token", content }) });
                  }
                } catch (_jsonErr: unknown) { /* skip malformed */ }
              }
            }
          } else {
            // No tool calls — emit the text content as token events
            if (textContent.length > 0) {
              assistantContent = textContent;
              // Emit in small chunks to simulate streaming
              const CHUNK_SIZE = 20;
              for (let i = 0; i < textContent.length; i += CHUNK_SIZE) {
                const chunk = textContent.slice(i, i + CHUNK_SIZE);
                await stream.writeSSE({ event: "message", data: JSON.stringify({ type: "token", content: chunk }) });
              }
            }
          }

          } // close: else (non-SSE JSON path)

        } catch (fetchErr: unknown) {
          const isAbort = fetchErr instanceof DOMException && fetchErr.name === "AbortError"
            || fetchErr instanceof Error && fetchErr.name === "AbortError";
          if (!isAbort) {
            const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            logger.warn("chat_network_error", "LLM network error", {
              metadata: { agent_id: agentId, error: msg.slice(0, 200) },
            });
            await stream.writeSSE({
              event: "message",
              data:  JSON.stringify({ type: "error", error: "Network error connecting to LLM provider", details: msg.slice(0, 200) }),
            });
          }
          return;
        }
      } else {
        // ── Original streaming path (no tool definitions) ──────────────────
        try {
          const res = await fetch(`${apiBase}/chat/completions`, {
            method:  "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type":  "application/json",
            },
            body: JSON.stringify({
              model,
              messages,
              stream:    true,
              max_tokens: 1024,
            }),
            signal: AbortSignal.any !== undefined
              ? AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
              : controller.signal,
          });

          if (!res.ok) {
            let errMsg = "LLM request failed";
            if (res.status === 401 || res.status === 403) errMsg = "Invalid API key — check your provider settings.";
            else if (res.status === 429) errMsg = "Rate limit reached. Free providers have strict limits — please wait a moment or consider switching to a paid provider.";
            else if (res.status >= 500)  errMsg = "The AI provider is temporarily unavailable. Free providers can be less reliable — if this persists, consider a paid provider or a local model.";
            else errMsg = `The AI provider returned an error (${res.status}). If you are using a free provider, connection issues may occur. Consider a paid provider or a local model for better reliability.`;

            logger.warn("chat_llm_error", "LLM returned error status", {
              metadata: { agent_id: agentId, http_status: res.status },
            });

            await stream.writeSSE({
              event: "message",
              data:  JSON.stringify({ type: "error", error: errMsg, details: `HTTP ${res.status} from provider` }),
            });
            return;
          }

          // Parse SSE stream from LLM
          const reader = res.body?.getReader();
          if (!reader) {
            await stream.writeSSE({
              event: "message",
              data:  JSON.stringify({ type: "error", error: "Provider returned no response body" }),
            });
            return;
          }

          const decoder = new TextDecoder();
          let   buffer  = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer      = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;

              const dataStr = trimmed.slice(5).trim();
              if (dataStr === "[DONE]") break;

              try {
                const chunk  = JSON.parse(dataStr) as Record<string, unknown>;
                const usage  = chunk["usage"] as Record<string, unknown> | undefined;
                if (usage) {
                  inputTokens  = (usage["prompt_tokens"]     as number | undefined) ?? inputTokens;
                  outputTokens = (usage["completion_tokens"] as number | undefined) ?? outputTokens;
                }

                const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
                if (!choices || choices.length === 0) continue;

                const delta   = choices[0]?.["delta"] as Record<string, unknown> | undefined;
                const content = delta?.["content"] as string | undefined;
                if (typeof content === "string" && content.length > 0) {
                  assistantContent += content;
                  await stream.writeSSE({
                    event: "message",
                    data:  JSON.stringify({ type: "token", content }),
                  });
                }
              } catch (_jsonErr: unknown) {
                // Skip malformed chunks
              }
            }
          }
        } catch (fetchErr: unknown) {
          const isAbort = fetchErr instanceof DOMException && fetchErr.name === "AbortError"
            || fetchErr instanceof Error && fetchErr.name === "AbortError";

          if (!isAbort) {
            const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            logger.warn("chat_network_error", "LLM network error", {
              metadata: { agent_id: agentId, error: msg.slice(0, 200) },
            });
            await stream.writeSSE({
              event: "message",
              data:  JSON.stringify({ type: "error", error: "Network error connecting to LLM provider", details: msg.slice(0, 200) }),
            });
          }
          return;
        }
      }

      // Store assistant response in history
      if (assistantContent.length > 0) {
        const assistantMsg: ChatMessage = {
          id:        randomUUID(),
          role:      "assistant",
          content:   assistantContent,
          timestamp: new Date().toISOString(),
        };
        conversation.messages.push(assistantMsg);

        // Trim to 100 messages
        if (conversation.messages.length > 100) {
          conversation.messages = conversation.messages.slice(conversation.messages.length - 100);
        }

        // Write audit event for completed chat turn
        writeAuditEvent(chatDb, agentId, "chat_turn", "allowed", {
          conversation_id: convId,
          input_tokens:    inputTokens,
          output_tokens:   outputTokens,
        });
      }

      // Send done event
      await stream.writeSSE({
        event: "message",
        data:  JSON.stringify({
          type:  "done",
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }),
      });

      logger.info("chat_complete", "Chat turn complete", {
        metadata: { agent_id: agentId, conversation_id: convId, output_tokens: outputTokens },
      });
    });
  });

  // ── GET /api/v1/chat/:agentId/history ─────────────────────────────────
  app.get("/api/v1/chat/:agentId/history", requireScope("readonly"), (c) => {
    const agentId        = c.req.param("agentId");
    const conversationId = c.req.query("conversation_id");
    const limitRaw       = c.req.query("limit");
    const limit          = Math.min(parseInt(limitRaw ?? "50", 10) || 50, 200);

    const roleMap = getRoleMap();
    if (!roleMap.has(agentId) && !getStarterAgents().some((s) => s.id === agentId)) {
      throw SidjuaError.from("CHAT-002", `Agent "${agentId}" not found`);
    }

    const id   = conversationId ?? _agentConversation.get(agentId);
    const conv = id ? _conversations.get(id) : undefined;

    const messages = (conv?.messages ?? [])
      .slice(-limit)
      .map((m) => ({
        role:      m.role,
        content:   m.content,
        timestamp: m.timestamp,
      }));

    return c.json({
      conversation_id: conv?.conversation_id ?? null,
      agent_id:        agentId,
      messages,
    });
  });

  // ── DELETE /api/v1/chat/:agentId/history ──────────────────────────────
  app.delete("/api/v1/chat/:agentId/history", requireScope("operator"), (c) => {
    const agentId = c.req.param("agentId");

    const roleMap = getRoleMap();
    if (!roleMap.has(agentId) && !getStarterAgents().some((s) => s.id === agentId)) {
      throw SidjuaError.from("CHAT-002", `Agent "${agentId}" not found`);
    }

    const existingId = _agentConversation.get(agentId);
    if (existingId) {
      _conversations.delete(existingId);
      _agentConversation.delete(agentId);
    }

    logger.info("chat_history_cleared", "Chat history cleared", {
      metadata: { agent_id: agentId },
    });

    return c.json({ cleared: true, agent_id: agentId });
  });
}
