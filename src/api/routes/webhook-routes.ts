// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P378: Webhook Inbound Route
 *
 *   POST /api/v1/webhook/:agentId
 *
 * No requireScope() — uses its own token-based auth via X-Sidjua-Token header.
 * Accepts JSON payloads up to 1 MB, validates the per-agent token, normalizes
 * the payload, and submits a task for the target agent.
 *
 * Security design:
 * - Raw tokens are never stored or logged; only SHA-256 hashes are persisted.
 * - 401 is returned for ANY auth failure (no enumeration of what failed).
 * - Payload size is limited to 1 MB before parsing.
 * - Rate limit: 60 requests per minute per agent.
 */

import type { Database }               from "../../utils/db.js";
import { Hono, type Context }          from "hono";
import { createLogger }                from "../../core/logger.js";
import { WebhookTokenStore }           from "../../core/webhook/webhook-token-store.js";
import { validateToken }               from "../../core/webhook/webhook-auth.js";
import { normalizeWebhookPayload }     from "../../core/webhook/webhook-adapter.js";
import { webhookRateLimitCheck }       from "../../core/webhook/webhook-rate-limiter.js";
import { ExecutionBridge }             from "../../orchestrator/execution-bridge.js";
import { TaskEventBus }                from "../../tasks/event-bus.js";


const logger = createLogger("webhook-routes");

/** Maximum allowed request body size in bytes (1 MB). */
const MAX_PAYLOAD_BYTES = 1_048_576;

/** Generic 401 response — no detail about what failed. */
const UNAUTHORIZED = { error: { code: "AUTH-004", message: "Unauthorized", recoverable: false } } as const;


export interface WebhookRouteServices {
  db:                 Database;
  webhookTokenStore?: WebhookTokenStore | null;
}


export function registerWebhookRoutes(app: Hono, services: WebhookRouteServices): void {
  const tokenStore = services.webhookTokenStore
    ?? new WebhookTokenStore(services.db);

  // POST /api/v1/webhook/:agentId
  app.post("/api/v1/webhook/:agentId", async (c: Context) => {
    const agentId = c.req.param("agentId");

    // ── 1. Rate limit (before expensive auth) ────────────────────────────────
    if (!webhookRateLimitCheck(agentId)) {
      return c.json(
        { error: { code: "RATE-003", message: "Too many webhook requests — try again later", recoverable: true } },
        429,
      );
    }

    // ── 2. Payload size check ─────────────────────────────────────────────────
    const contentLength = c.req.header("content-length");
    if (contentLength !== undefined && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
      return c.json(
        { error: { code: "WEBHOOK-002", message: "Payload too large", recoverable: false } },
        413,
      );
    }

    // ── 3. Parse body ─────────────────────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      const raw = await c.req.text();
      if (raw.length > MAX_PAYLOAD_BYTES) {
        return c.json(
          { error: { code: "WEBHOOK-002", message: "Payload too large", recoverable: false } },
          413,
        );
      }
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return c.json(
          { error: { code: "WEBHOOK-003", message: "Payload must be a JSON object", recoverable: false } },
          400,
        );
      }
      body = parsed as Record<string, unknown>;
    } catch (_err) {
      return c.json(
        { error: { code: "WEBHOOK-003", message: "Invalid JSON payload", recoverable: false } },
        400,
      );
    }

    // ── 4. Token auth ─────────────────────────────────────────────────────────
    const rawToken = c.req.header("x-sidjua-token") ?? "";
    if (rawToken === "") {
      return c.json(UNAUTHORIZED, 401);
    }

    const tokens = tokenStore.findByAgent(agentId);
    if (tokens.length === 0) {
      // No tokens configured for agent — same response as bad token (no enumeration)
      logger.debug("webhook-routes", "No webhook tokens configured for agent", {
        metadata: { agent_id: agentId },
      });
      return c.json(UNAUTHORIZED, 401);
    }

    // Find a matching active token
    let matchedToken: (typeof tokens)[number] | undefined;
    for (const t of tokens) {
      if (validateToken(rawToken, t.token_hash)) {
        matchedToken = t;
        break;
      }
    }

    if (matchedToken === undefined) {
      logger.debug("webhook-routes", "Webhook token validation failed", {
        metadata: { agent_id: agentId },
      });
      return c.json(UNAUTHORIZED, 401);
    }

    // ── 5. Update last_used (best-effort) ────────────────────────────────────
    try {
      tokenStore.updateLastUsed(matchedToken.id, new Date().toISOString());
    } catch (_err) {
      // non-fatal
    }

    // ── 6. Normalize payload + detect source ─────────────────────────────────
    const source = matchedToken.source !== "*" ? matchedToken.source : undefined;
    const normalized = normalizeWebhookPayload(body, source);

    logger.info("webhook-routes", "Webhook received", {
      metadata: {
        agent_id: agentId,
        source:   normalized.source,
        title:    normalized.title.slice(0, 60),
      },
    });

    // ── 7. Submit task ────────────────────────────────────────────────────────
    try {
      const eventBus = new TaskEventBus(services.db);
      const bridge   = new ExecutionBridge(services.db, eventBus);
      const handle   = await bridge.submitTask({
        description: `${normalized.title}\n\n${normalized.description}`,
        priority:    3,
      });

      return c.json({
        task_id: handle.task_id,
        source:  normalized.source,
        title:   normalized.title,
      }, 202);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("webhook-routes", "Task submission failed for webhook", {
        metadata: { agent_id: agentId, error: msg },
      });
      return c.json(
        { error: { code: "WEBHOOK-004", message: "Task submission failed", recoverable: true } },
        500,
      );
    }
  });
}
