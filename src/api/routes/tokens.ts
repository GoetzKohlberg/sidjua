// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Token Management REST Endpoints
 *
 *   GET    /api/v1/tokens              — list tokens (readonly, no hashes)
 *   GET    /api/v1/tokens/:id          — get token by ID
 *   POST   /api/v1/tokens              — create token → returns raw token ONCE
 *   DELETE /api/v1/tokens/:id          — revoke token (soft-delete)
 *
 * All endpoints require admin scope.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { TokenStore, TokenScope } from "../token-store.js";
import { requireScope, scopeAtLeast, CALLER_CONTEXT_KEY } from "../middleware/require-scope.js";
import type { CallerContext } from "../caller-context.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("api-tokens");

const VALID_SCOPES = new Set<TokenScope>(["admin", "operator", "agent", "readonly"]);

/**
 * Middleware for POST /api/v1/tokens: allows either admin scope OR the
 * restricted "bootstrap" role (legacy key, first-run only).
 * All other token management routes (list, get, delete) still require admin.
 */
const requireAdminOrBootstrap: MiddlewareHandler = async (c, next) => {
  const ctx = c.get(CALLER_CONTEXT_KEY) as CallerContext | undefined;
  if (ctx === undefined) {
    return c.json({ error: { code: "AUTH-001", message: "Authentication required", recoverable: false } }, 401);
  }
  if (ctx.role === "bootstrap" || scopeAtLeast(ctx.role, "admin")) {
    return next();
  }
  return c.json({ error: { code: "AUTH-003", message: "Insufficient scope", recoverable: false } }, 403);
};

export interface TokenRouteServices {
  tokenStore: TokenStore;
}

export function registerTokenRoutes(app: Hono, services: TokenRouteServices): void {
  const { tokenStore } = services;

  // ── GET /api/v1/tokens ───────────────────────────────────────────────────
  app.get("/api/v1/tokens", requireScope("admin"), (c) => {
    try {
      const tokens = tokenStore.listTokens();
      return c.json({ tokens });
    } catch (e: unknown) {
      logger.error("token_list_error", "Failed to list tokens", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
      return c.json({ error: { code: "SYS-500", message: "Internal error" } }, 500);
    }
  });

  // ── GET /api/v1/tokens/:id ───────────────────────────────────────────────
  app.get("/api/v1/tokens/:id", requireScope("admin"), (c) => {
    const id = c.req.param("id");
    try {
      const token = tokenStore.getToken(id);
      if (token === null) {
        return c.json({ error: { code: "TOKEN-404", message: "Token not found" } }, 404);
      }
      return c.json({ token });
    } catch (e: unknown) {
      logger.error("token_get_error", "Failed to get token", {
        metadata: { id, error: e instanceof Error ? e.message : String(e) },
      });
      return c.json({ error: { code: "SYS-500", message: "Internal error" } }, 500);
    }
  });

  // ── POST /api/v1/tokens ──────────────────────────────────────────────────
  // bootstrap role is allowed here for the initial-setup flow (first token creation).
  // All other token routes (list/get/delete) still require admin scope.
  app.post("/api/v1/tokens", requireAdminOrBootstrap, async (c) => {
    let body: {
      scope?:     unknown;
      division?:  unknown;
      agentId?:   unknown;
      label?:     unknown;
      expiresAt?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch (e: unknown) {
      logger.debug("api-tokens", "Token create body parse failed", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      return c.json({ error: { code: "TOKEN-400", message: "Invalid JSON body" } }, 400);
    }

    const { scope, division, agentId, label, expiresAt } = body;

    if (typeof scope !== "string" || !VALID_SCOPES.has(scope as TokenScope)) {
      return c.json({
        error: { code: "TOKEN-400", message: `scope must be one of: ${[...VALID_SCOPES].join(", ")}` },
      }, 400);
    }
    if (typeof label !== "string" || label.trim() === "") {
      return c.json({ error: { code: "TOKEN-400", message: "label is required" } }, 400);
    }
    if (division !== undefined && typeof division !== "string") {
      return c.json({ error: { code: "TOKEN-400", message: "division must be a string" } }, 400);
    }
    if (agentId !== undefined && typeof agentId !== "string") {
      return c.json({ error: { code: "TOKEN-400", message: "agentId must be a string" } }, 400);
    }

    let parsedExpiry: Date | undefined;
    if (expiresAt !== undefined) {
      if (typeof expiresAt !== "string") {
        return c.json({ error: { code: "TOKEN-400", message: "expiresAt must be an ISO-8601 string" } }, 400);
      }
      parsedExpiry = new Date(expiresAt);
      if (isNaN(parsedExpiry.getTime())) {
        return c.json({ error: { code: "TOKEN-400", message: "expiresAt is not a valid date" } }, 400);
      }
    }

    try {
      const { id, rawToken } = tokenStore.createToken({
        scope:      scope as TokenScope,
        ...(typeof division === "string" ? { division } : {}),
        ...(typeof agentId  === "string" ? { agentId  } : {}),
        label:      label.trim(),
        ...(parsedExpiry !== undefined ? { expiresAt: parsedExpiry } : {}),
      });

      logger.info("token_create_success", "Token created via REST API", {
        metadata: { id, scope, label: label.trim() },
      });

      if (scope === "admin") {
        logger.info("token_bootstrap_reminder", "Admin token created. Bootstrap key should be disabled.", {
          metadata: { id },
        });
      }

      return c.json({
        id,
        rawToken,                       // shown ONCE — caller must store immediately
        warning: "This token will not be shown again. Store it securely.",
      }, 201);
    } catch (e: unknown) {
      logger.error("token_create_error", "Failed to create token", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
      return c.json({ error: { code: "SYS-500", message: "Internal error" } }, 500);
    }
  });

  // ── DELETE /api/v1/tokens/:id ────────────────────────────────────────────
  app.delete("/api/v1/tokens/:id", requireScope("admin"), (c) => {
    const id = c.req.param("id");
    try {
      const revoked = tokenStore.revokeToken(id);
      if (!revoked) {
        return c.json({ error: { code: "TOKEN-404", message: "Token not found or already revoked" } }, 404);
      }
      return c.json({ ok: true, id, revoked: true });
    } catch (e: unknown) {
      logger.error("token_revoke_error", "Failed to revoke token", {
        metadata: { id, error: e instanceof Error ? e.message : String(e) },
      });
      return c.json({ error: { code: "SYS-500", message: "Internal error" } }, 500);
    }
  });
}
