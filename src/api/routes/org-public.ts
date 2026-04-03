// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P348/P349 — Glasscheibe Public Org Chart Routes (unauthenticated)
 *
 *   GET  /api/v1/org/public        — privacy-filtered org chart tree (JSON)
 *   GET  /api/v1/org/public/live   — SSE stream of public agent-status events
 *   GET  /widget/glasscheibe.js    — embeddable vanilla JS widget (P349)
 *
 * All routes:
 *  - Require no Bearer token (added to PUBLIC_PATHS / PUBLIC_PREFIXES in auth.ts)
 *  - Apply IP-keyed rate limiter on API routes (60 req/min per IP, burst 10)
 *  - Return CORS headers for browser cross-origin consumption
 *
 * Widget pattern follows pwa.ts: content is inlined as a constant — no
 * runtime file reads, no build-step copies needed.
 */

import type { Hono }        from "hono";
import type Database        from "better-sqlite3";
import { streamSSE }        from "hono/streaming";
import { readFileSync }     from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath }    from "node:url";
import { createLogger }     from "../../core/logger.js";
import { rateLimiter }      from "../middleware/rate-limiter.js";
import type { RateLimitConfig } from "../middleware/rate-limiter.js";
import { OrgChartStore }    from "../../org-chart/org-chart-store.js";
import { toPublicTree, filterPublicEvent } from "../org-public/privacy-filter.js";
import type { EventStreamManager, SSEWritable } from "../sse/event-stream.js";
import type { SSEEvent }    from "../sse/event-filter.js";

const logger = createLogger("org-public");

export interface OrgPublicRouteServices {
  db:                   InstanceType<typeof Database>;
  manager:              EventStreamManager;
  /** Milliseconds between keep-alive pings (default 30 000). */
  keepaliveIntervalMs?: number;
  /** Allowed CORS origin (default "*"). */
  corsOrigin?:          string;
}

/** 60 req / min per IP — conservative for a public, unauthenticated endpoint */
const PUBLIC_RATE_LIMIT: RateLimitConfig = {
  enabled:      true,
  window_ms:    60_000,
  max_requests: 60,
  burst_max:    10,
};

// ---------------------------------------------------------------------------
// FilteringSSEWritable
// ---------------------------------------------------------------------------

/**
 * Wraps an inner SSEWritable and intercepts writeSSE() calls, applying the
 * Glasscheibe privacy filter before forwarding to the real Hono stream.
 *
 * Non-public event types are silently dropped (returns without writing).
 * Internal data fields (tier, model, cost, …) are stripped; only
 * agentId, divisionId, and status pass through.
 */
class FilteringSSEWritable implements SSEWritable {
  constructor(private readonly inner: SSEWritable) {}

  async writeSSE(msg: { id?: string; event?: string; data: string }): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data);
    } catch (_e) {
      return; // malformed data — drop silently
    }

    const candidate: SSEEvent = {
      id:        parseInt(msg.id ?? "0", 10) || 0,
      type:      (msg.event ?? "") as SSEEvent["type"],
      data:      (typeof parsed === "object" && parsed !== null
        ? parsed
        : {}) as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    };

    const filtered = filterPublicEvent(candidate);
    if (filtered === null) return; // event not allowed on public stream

    return this.inner.writeSSE({
      ...msg,
      data: JSON.stringify(filtered.data),
    });
  }

  write(data: string): Promise<unknown>   { return this.inner.write(data); }
  get closed(): boolean                   { return this.inner.closed; }
  close(): Promise<void>                  { return this.inner.close(); }
  sleep(ms: number): Promise<unknown>     { return this.inner.sleep(ms); }
  abort(): void                           { this.inner.abort(); }
}

// ---------------------------------------------------------------------------
// Glasscheibe widget JS — loaded once at startup from the static asset file.
// Source: src/api/static/glasscheibe-widget.js (the canonical production JS)
// Readable/commented version: src/api/static/glasscheibe.js (for development)
// ---------------------------------------------------------------------------

const _widgetDir = dirname(fileURLToPath(import.meta.url));
const GLASSCHEIBE_WIDGET_JS = readFileSync(
  resolve(_widgetDir, "../static/glasscheibe-widget.js"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

/** Read a workspace_config value — returns null on any error or missing row. */
function getWorkspaceConfig(db: InstanceType<typeof Database>, key: string): string | null {
  try {
    const row = db.prepare<[string], { value: string }>(
      "SELECT value FROM workspace_config WHERE key = ?",
    ).get(key);
    return row?.value ?? null;
  } catch (_e) {
    return null;
  }
}

export function registerOrgPublicRoutes(
  app: Hono,
  {
    db,
    manager,
    keepaliveIntervalMs = 30_000,
    corsOrigin          = "*",
  }: OrgPublicRouteServices,
): void {
  const store = new OrgChartStore(db);
  const rl    = rateLimiter(PUBLIC_RATE_LIMIT);

  function corsHeaders(): Record<string, string> {
    return {
      "Access-Control-Allow-Origin":  corsOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
  }

  // CORS pre-flight
  app.options("/api/v1/org/public", (c) => {
    return new Response(null, { status: 204, headers: corsHeaders() });
  });
  app.options("/api/v1/org/public/live", (c) => {
    return new Response(null, { status: 204, headers: corsHeaders() });
  });

  // ── GET /api/v1/org/public ──────────────────────────────────────────────
  app.get("/api/v1/org/public", rl, (c) => {
    if (getWorkspaceConfig(db, "public_org_chart_enabled") !== "true") {
      return c.json({ error: "public_org_chart_disabled", message: "The public org chart is disabled on this server." }, 404);
    }
    for (const [k, v] of Object.entries(corsHeaders())) c.header(k, v);
    const internal = store.getTree();
    const pub      = toPublicTree(internal);
    return c.json(pub);
  });

  // ── GET /api/v1/org/public/live ─────────────────────────────────────────
  app.get("/api/v1/org/public/live", rl, (c) => {
    if (getWorkspaceConfig(db, "public_org_chart_enabled") !== "true") {
      return c.json({ error: "public_org_chart_disabled", message: "The public org chart is disabled on this server." }, 404);
    }
    for (const [k, v] of Object.entries(corsHeaders())) c.header(k, v);

    const clientId = crypto.randomUUID();

    return streamSSE(c, async (stream) => {
      const filteringStream = new FilteringSSEWritable(stream);

      const added = manager.addClient({
        id:               clientId,
        stream:           filteringStream,
        filters:          {},  // no topic filters — privacy filter handles event selection
        connectedAt:      new Date().toISOString(),
        lastEventId:      0,
        pendingBytes:     0,
        lastBytesAddedAt: 0,
      });

      if (!added) {
        await stream.writeSSE({
          event: "error",
          data:  JSON.stringify({ code: "SSE-503", message: "Too many connections — try again later" }),
        });
        await stream.close();
        return;
      }

      logger.info("public_sse_opened", `Public SSE client ${clientId} connected`);

      try {
        while (!stream.closed) {
          await stream.sleep(keepaliveIntervalMs);
          if (!stream.closed) {
            await stream.write(`:ping ${Math.floor(Date.now() / 1000)}\n\n`);
          }
        }
      } finally {
        manager.removeClient(clientId);
        logger.info("public_sse_closed", `Public SSE client ${clientId} disconnected`);
      }
    });
  });

  // ── GET /widget/glasscheibe.js ───────────────────────────────────────────
  // Embeddable vanilla JS widget — served as a static asset, no auth required.
  // Content is inlined (zero runtime file reads); see src/api/static/glasscheibe.js.
  app.get("/widget/glasscheibe.js", (c) => {
    if (getWorkspaceConfig(db, "public_org_chart_enabled") !== "true") {
      return c.text("/* Public org chart is disabled on this server. */\n", 404);
    }
    return c.body(GLASSCHEIBE_WIDGET_JS, 200, {
      "Content-Type":                 "application/javascript; charset=utf-8",
      "Cache-Control":                "public, max-age=3600",
      "Access-Control-Allow-Origin":  corsOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
  });
}
