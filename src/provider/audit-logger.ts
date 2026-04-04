// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Provider Layer: Audit Logger
 *
 * Writes a complete record of every provider call to the main sidjua.db.
 * Two new tables are created on first use (CREATE TABLE IF NOT EXISTS):
 *
 *   provider_calls
 *     Summary row — one per call. Always written (even on error).
 *     Contains metadata: provider, model, tokens, cost, latency, finish_reason,
 *     error info, and the owning agent/division.
 *
 *   provider_call_content
 *     Full request and response bodies — one-to-one with provider_calls.
 *     Stored as JSON. Required for audit replay and debugging.
 *
 * Design notes:
 *   - All operations are synchronous (better-sqlite3) for minimal hot-path overhead.
 *   - Error calls: provider_calls row is written with error_code + error_message.
 *     provider_call_content still records the request; response_json is NULL.
 *   - This module does NOT emit events — that is done by ProviderRegistry.
 *   - Foreign key between provider_call_content.call_id → provider_calls.call_id
 *     is enforced only when foreign_keys pragma is ON.
 */

import type { Database } from "../utils/db.js";
import type { ProviderCallRequest, ProviderCallResponse, ProviderError } from "../types/provider.js";


const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS provider_calls (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id        TEXT    NOT NULL UNIQUE,
    timestamp      TEXT    NOT NULL DEFAULT (datetime('now')),
    agent_id       TEXT    NOT NULL,
    division_code  TEXT    NOT NULL,
    provider       TEXT    NOT NULL,
    model          TEXT    NOT NULL,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    cost_usd       REAL    NOT NULL DEFAULT 0,
    latency_ms     INTEGER NOT NULL DEFAULT 0,
    finish_reason  TEXT,
    error_code     TEXT,
    error_message  TEXT,
    task_id        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_provider_calls_timestamp ON provider_calls(timestamp);
  CREATE INDEX IF NOT EXISTS idx_provider_calls_agent     ON provider_calls(agent_id);
  CREATE INDEX IF NOT EXISTS idx_provider_calls_division  ON provider_calls(division_code);

  CREATE TABLE IF NOT EXISTS provider_call_content (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id        TEXT    NOT NULL UNIQUE,
    request_json   TEXT    NOT NULL,
    response_json  TEXT
  );
`;


interface ProviderCallRow {
  call_id:       string;
  agent_id:      string;
  division_code: string;
  provider:      string;
  model:         string;
  input_tokens:  number;
  output_tokens: number;
  cost_usd:      number;
  latency_ms:    number;
  finish_reason: string | null;
  error_code:    string | null;
  error_message: string | null;
  task_id:       string | null;
}

interface ProviderCallContentRow {
  call_id:       string;
  request_json:  string;
  response_json: string | null;
}


/**
 * Logs every provider call to the main sidjua.db.
 * Call ensureTables() once during registry initialisation.
 */
export class ProviderAuditLogger {
  constructor(private readonly db: Database) {
    this.ensureTables();
  }

  // ---------------------------------------------------------------------------
  // Prepared statement helpers (inline to avoid field-type declaration complexity)
  // ---------------------------------------------------------------------------

  private insertCallStmt() {
    return this.db.prepare<ProviderCallRow, void>(`
      INSERT INTO provider_calls
        (call_id, agent_id, division_code, provider, model,
         input_tokens, output_tokens, cost_usd, latency_ms,
         finish_reason, error_code, error_message, task_id)
      VALUES
        (:call_id, :agent_id, :division_code, :provider, :model,
         :input_tokens, :output_tokens, :cost_usd, :latency_ms,
         :finish_reason, :error_code, :error_message, :task_id)
    `);
  }

  private insertContentStmt() {
    return this.db.prepare<ProviderCallContentRow, void>(`
      INSERT INTO provider_call_content (call_id, request_json, response_json)
      VALUES (:call_id, :request_json, :response_json)
    `);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create provider_calls and provider_call_content tables if they do not exist.
   * Safe to call multiple times (CREATE TABLE IF NOT EXISTS).
   */
  ensureTables(): void {
    this.db.exec(SCHEMA_SQL);
  }

  /**
   * Log a successful call.
   * Both the summary (provider_calls) and full content (provider_call_content)
   * are written in a single transaction.
   */
  logCall(request: ProviderCallRequest, response: ProviderCallResponse): void {
    const callRow: ProviderCallRow = {
      call_id:       request.callId,
      agent_id:      request.agentId,
      division_code: request.divisionCode,
      provider:      response.provider,
      model:         response.model,
      input_tokens:  response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      cost_usd:      response.costUsd,
      latency_ms:    response.latencyMs,
      finish_reason: response.finishReason ?? null,
      error_code:    null,
      error_message: null,
      task_id:       request.taskId ?? null,
    };

    const contentRow: ProviderCallContentRow = {
      call_id:       request.callId,
      request_json:  serializeRequest(request),
      response_json: JSON.stringify(response),
    };

    this.db.transaction(() => {
      this.insertCallStmt().run(callRow);
      this.insertContentStmt().run(contentRow);
    })();
  }

  /**
   * Log a failed call.
   * The summary row records the error; response_json is NULL in provider_call_content.
   *
   * @param request - The request that was attempted.
   * @param error - The error that was thrown.
   * @param latencyMs - Time elapsed before the error, in milliseconds.
   */
  logError(request: ProviderCallRequest, error: ProviderError | Error, latencyMs: number): void {
    const isProviderErr = "code" in error && "provider" in error;
    const errorCode     = isProviderErr ? (error as ProviderError).code : "UNKNOWN";

    const callRow: ProviderCallRow = {
      call_id:       request.callId,
      agent_id:      request.agentId,
      division_code: request.divisionCode,
      provider:      request.provider,
      model:         request.model,
      input_tokens:  0,
      output_tokens: 0,
      cost_usd:      0,
      latency_ms:    latencyMs,
      finish_reason: null,
      error_code:    errorCode,
      error_message: error.message,
      task_id:       request.taskId ?? null,
    };

    const contentRow: ProviderCallContentRow = {
      call_id:       request.callId,
      request_json:  serializeRequest(request),
      response_json: null,
    };

    this.db.transaction(() => {
      this.insertCallStmt().run(callRow);
      this.insertContentStmt().run(contentRow);
    })();
  }
}


/**
 * Serialize a ProviderCallRequest to JSON for storage.
 * API keys are never present in request objects.
 *
 * Content redaction: set SIDJUA_AUDIT_CONTENT=redact to replace message
 * bodies and system prompts with "[REDACTED]" for privacy-sensitive deployments.
 * Default (unset or any other value): full content is stored.
 */
function serializeRequest(request: ProviderCallRequest): string {
  if (process.env["SIDJUA_AUDIT_CONTENT"] === "redact") {
    const redacted = {
      ...request,
      messages:     request.messages.map((m) => ({ ...m, content: "[REDACTED]" })),
      ...(request.systemPrompt !== undefined ? { systemPrompt: "[REDACTED]" } : {}),
    };
    return JSON.stringify(redacted);
  }
  return JSON.stringify(request);
}
