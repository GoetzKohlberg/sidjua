// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11c: SSE Events Endpoint
 *
 * GET /api/v1/events?token=<api-key>&divisions=eng,sales&agents=sonnet-dev&tasks=0042
 *
 * Authentication is via query parameter because the browser's EventSource API
 * does not support custom headers.
 *
 * Uses Hono's streamSSE helper for RFC-compliant SSE responses.
 * Keep-alive ping comments are sent at a configurable interval.
 */

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { createLogger }       from "../../core/logger.js";
import { EventStreamManager } from "../sse/event-stream.js";
import { getReplaySince }     from "../sse/event-replay.js";
import { matchesFilters }     from "../sse/event-filter.js";
import type { SSEClientFilters } from "../sse/event-filter.js";
import { consumeTicket }      from "./sse-ticket.js";
import { getClientIp }        from "../middleware/rate-limiter.js";

const logger = createLogger("api-sse");


export interface EventRouteServices {
  /** Returns the current API key (supports rotation). */
  getApiKey: () => string;
  /** Shared EventStreamManager instance. */
  manager: EventStreamManager;
  /** Open database for event replay (optional — replay disabled if null). */
  db?: InstanceType<typeof Database> | null;
  /** Milliseconds between keep-alive pings (default 30 000). */
  keepaliveIntervalMs?: number;
}


/** Parse a comma-separated query param into an array (undefined if absent/empty). */
function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}


export function registerEventRoutes(app: Hono, services: EventRouteServices): void {
  const {
    manager,
    db               = null,
    keepaliveIntervalMs = 30_000,
  } = services;

  // ---- GET /api/v1/events ------------------------------------------------

  app.get("/api/v1/events", (c) => {
    // Reject deprecated token= query parameter — tokens in query strings appear
    // in server logs, browser history, and referrer headers.
    const legacyToken = c.req.query("token");
    if (legacyToken) {
      logger.warn("api-sse", "Rejected deprecated token= query parameter", {
        metadata: { ip: getClientIp(c.req.raw.headers) },
      });
      return c.json(
        {
          error: {
            code:        "AUTH-001",
            message:     "token= query parameter is not accepted. Use POST /api/v1/sse/ticket to obtain a short-lived ticket.",
            recoverable: true,
            request_id:  "unknown",
          },
        },
        401,
      );
    }

    // Auth: ticket-based only (short-lived, single-use)
    const ticket = c.req.query("ticket") ?? "";
    const clientIp = getClientIp(c.req.raw.headers);
    const ticketContext = ticket ? consumeTicket(ticket, clientIp) : false;

    if (ticketContext === false) {
      return c.json(
        {
          error: {
            code:        "AUTH-001",
            message:     "Invalid or missing ticket. Use POST /api/v1/sse/ticket to obtain a short-lived ticket.",
            recoverable: false,
            request_id:  "unknown",
          },
        },
        401,
      );
    }

    // Apply division scope from ticket — if ticket is division-scoped, restrict to that division
    const scopedDivision = (ticketContext as import("../caller-context.js").CallerContext).division;

    // Subscription filters (omit keys when undefined — exactOptionalPropertyTypes)
    // Division filter: honor ticket's division scope (if set), otherwise use query param
    const divisionsList = scopedDivision !== undefined
      ? [scopedDivision]                        // token is division-scoped — enforce restriction
      : parseList(c.req.query("divisions"));    // admin/operator — use query param as-is
    const agentsList    = parseList(c.req.query("agents"));
    const tasksList     = parseList(c.req.query("tasks"));
    const filters: SSEClientFilters = {
      ...(divisionsList !== undefined ? { divisions: divisionsList } : {}),
      ...(agentsList    !== undefined ? { agents:    agentsList }    : {}),
      ...(tasksList     !== undefined ? { tasks:     tasksList }     : {}),
    };

    // Last-Event-ID header (sent by browser on reconnect)
    const lastEventIdHeader = c.req.header("Last-Event-ID");
    const lastEventId       = lastEventIdHeader !== undefined
      ? (parseInt(lastEventIdHeader, 10) || 0)
      : 0;

    const clientId = crypto.randomUUID();

    return streamSSE(c, async (stream) => {
      // Enforce MAX_CLIENTS — addClient returns false when at capacity
      const added = manager.addClient({
        id:           clientId,
        stream,
        filters,
        connectedAt:  new Date().toISOString(),
        lastEventId,
        pendingBytes:     0,
        lastBytesAddedAt: 0,
      });
      if (!added) {
        await stream.writeSSE({
          event: "error",
          data:  JSON.stringify({ code: "SSE-503", message: "Too many SSE connections — try again later" }),
        });
        await stream.close();
        return;
      }

      logger.info("sse_connection_opened", `SSE client ${clientId} connected`, {
        metadata: { clientId, filters, lastEventId },
      });

      try {
        // Replay missed events on reconnection.
        // Try in-memory buffer first (fast, no DB); fall back to DB for older events.
        if (lastEventId > 0) {
          const buffered = manager.buffer.since(lastEventId);
          const missed   = buffered.length > 0
            ? buffered.filter((e) => matchesFilters(e, filters))
            : (db !== null ? getReplaySince(db, lastEventId, 1_000, 300_000).filter((e) => matchesFilters(e, filters)) : []);

          for (const event of missed) {
            await stream.writeSSE({
              id:    String(event.id),
              event: event.type,
              data:  JSON.stringify(event.data),
            });
          }
        }

        // Keep-alive ping loop — exits when stream is closed or aborted
        while (!stream.closed) {
          await stream.sleep(keepaliveIntervalMs);
          if (!stream.closed) {
            await stream.write(`:ping ${Math.floor(Date.now() / 1000)}\n\n`);
          }
        }
      } finally {
        manager.removeClient(clientId);
        logger.info("sse_connection_closed", `SSE client ${clientId} disconnected`, {
          metadata: { clientId },
        });
      }
    });
  });
}
