// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Lightweight SSE client for CLI commands.
 *
 * Uses native fetch() streaming — no external dependency.
 * Parses standard SSE wire format (RFC 8895-compatible).
 * No automatic reconnection — the CLI exits on disconnect.
 */

import { createLogger } from "../../core/logger.js";

const logger = createLogger("cli-sse");


export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
  id?:  string;
}

export interface SseClientOptions {
  url:      string;
  apiKey:   string;
  onEvent:  (event: SseEvent) => void;
  onError?: (error: Error) => void;
  signal?:  AbortSignal;
}


/**
 * Connect to an SSE endpoint and stream events until the signal fires or the
 * server closes the connection.
 *
 * @param opts.url     Full URL including query params (ticket, filters, etc.)
 * @param opts.apiKey  API key sent as Authorization: Bearer header
 * @param opts.onEvent Called for every fully-parsed SSE event
 * @param opts.onError Called on network or parse error (optional)
 * @param opts.signal  AbortSignal — abort to cleanly disconnect
 */
export async function connectSse(opts: SseClientOptions): Promise<void> {
  const { url, apiKey, onEvent, onError, signal } = opts;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept":        "text/event-stream",
        "Cache-Control": "no-cache",
      },
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name === "AbortError") return; // clean cancel
    logger.debug("cli-sse", "SSE connect failed", { metadata: { url, error: e.message } });
    if (onError !== undefined) onError(e);
    return;
  }

  if (!res.ok) {
    const e = new Error(`SSE endpoint returned HTTP ${res.status}`);
    logger.debug("cli-sse", "SSE non-OK response", { metadata: { url, status: res.status } });
    if (onError !== undefined) onError(e);
    return;
  }

  const reader = res.body?.getReader();
  if (reader === undefined || reader === null) {
    if (onError !== undefined) onError(new Error("No response body from SSE endpoint"));
    return;
  }

  const decoder = new TextDecoder();
  let buffer    = "";

  // Per-event state (reset after each dispatch)
  let eventType = "message";
  let dataLines: string[] = [];
  let eventId:   string | undefined;

  try {
    while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (e.name === "AbortError") return;
        if (onError !== undefined) onError(e);
        return;
      }
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on newlines — SSE events are separated by blank lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.replace(/\r$/, ""); // strip CR from CRLF

        if (line === "") {
          // Blank line = dispatch event (if any data accumulated)
          if (dataLines.length > 0) {
            const joined = dataLines.join("\n");
            let parsed: Record<string, unknown> = {};
            try {
              const tmp = JSON.parse(joined) as unknown;
              if (typeof tmp === "object" && tmp !== null && !Array.isArray(tmp)) {
                parsed = tmp as Record<string, unknown>;
              }
            } catch (e: unknown) {
              logger.debug("cli-sse", "SSE data JSON parse failed — skipping event", {
                metadata: { error: e instanceof Error ? e.message : String(e) },
              });
            }
            onEvent({
              type: eventType,
              data: parsed,
              ...(eventId !== undefined ? { id: eventId } : {}),
            });
          }
          // Reset per-event state
          eventType = "message";
          dataLines = [];
          eventId   = undefined;
          continue;
        }

        if (line.startsWith(":")) {
          // Comment / keep-alive — ignore
          continue;
        }

        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) {
          // Field name with no value
          continue;
        }

        const field = line.slice(0, colonIdx);
        // Value: strip one optional leading space after ":"
        const value = line.slice(colonIdx + 1).replace(/^ /, "");

        switch (field) {
          case "event": eventType = value;                  break;
          case "data":  dataLines.push(value);              break;
          case "id":    eventId   = value;                  break;
          case "retry": /* reconnection delay — ignored */ break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
