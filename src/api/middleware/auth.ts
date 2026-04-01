// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P269: Authentication Middleware (Scoped Tokens)
 *
 * SECURITY NOTE: The legacy single API key path (getApiKey) is provided for
 * backward compatibility only. It is now restricted to "bootstrap" scope —
 * only health checks, locale, and first-time token creation are allowed.
 * Operators must migrate to scoped tokens (`sidjua token create`) for full
 * access.  See docs/KNOWN-LIMITATIONS.md for migration guidance.
 *
 * Authentication flow:
 *   1. Extract token from Authorization: Bearer <token>
 *   2. Try scoped token lookup via TokenStore.validateToken()
 *      → derive CallerContext from token (scope, division, agentId, tokenId)
 *   3. If no scoped token found: try legacy single API key (backward compat)
 *      → set CallerContext = { role: "bootstrap" } + log deprecation warning
 *   4. If neither: 401 Unauthorized
 *
 * Sets c.set("callerContext", ctx) so route handlers and requireScope()
 * can access the derived authorization context.
 */

import type { MiddlewareHandler } from "hono";
import { createLogger }           from "../../core/logger.js";
import { timingSafeCompare }      from "../../core/crypto-utils.js";
import { REQUEST_ID_KEY }         from "./request-logger.js";
import { CALLER_CONTEXT_KEY }     from "./require-scope.js";
import type { CallerContext }     from "../caller-context.js";
import type { TokenStore }        from "../token-store.js";

const logger = createLogger("api-server");

/** Routes that bypass authentication (exact match) */
// /api/v1/events is deliberately public: EventSource cannot send custom headers.
// The handler enforces its own ticket-based auth (consumeTicket), so no Bearer
// token is needed at the middleware layer.  Unauthenticated requests without a
// valid ticket are rejected by the handler with AUTH-001.
// /api/v1/org/public is the Glasscheibe unauthenticated org-chart endpoint (P348).
// /widget/glasscheibe.js is the embeddable widget script (P349).
const PUBLIC_PATHS = new Set([
  "/api/v1/health",
  "/api/v1/events",
  "/api/v1/org/public",
  "/widget/glasscheibe.js",
]);

/** Path prefixes that bypass authentication (GUI static files, SPA routes) */
const PUBLIC_PREFIXES = [
  "/assets/", "/favicon", "/api/v1/locale",
  // Read-only static catalogs — no secrets, safe to serve without auth
  "/api/v1/starter-agents", "/api/v1/starter-divisions",
  // Glasscheibe sub-paths (e.g. /api/v1/org/public/live)
  "/api/v1/org/public/",
  // Embeddable widget files (future /widget/* assets are also public)
  "/widget/",
];

/**
 * Return true if the path should be served without authentication.
 * GUI static files and the health probe are public; all /api/* routes require auth.
 */
function isPublicPath(path: string): boolean {
  if (path === "/" || path === "/index.html") return true;
  if (PUBLIC_PATHS.has(path)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  // Any non-API path (SPA client-side routes) is public — the server returns index.html
  if (!path.startsWith("/api/")) return true;
  return false;
}

export interface AuthMiddlewareOptions {
  /** Function that returns the current (primary) legacy API key. */
  getApiKey: () => string;
  /**
   * Optional grace-period key during key rotation.
   * If provided, requests with the pending key are also accepted.
   */
  getPendingKey?: () => string | null;
  /**
   * Token store for scoped API tokens.
   * If provided, scoped tokens are validated first; legacy key is fallback.
   */
  tokenStore?: TokenStore | null;
}

/**
 * Create the authentication middleware.
 *
 * Validates Authorization: Bearer <token> against:
 *   1. Scoped tokens in TokenStore (if tokenStore is provided)
 *   2. Legacy single API key (backward compat → admin scope)
 *
 * Sets callerContext on the Hono context for downstream use.
 */
export const authenticate = (
  getApiKeyOrOpts: (() => string) | AuthMiddlewareOptions,
  getPendingKey?: () => string | null,
): MiddlewareHandler => async (c, next) => {
  const path = c.req.path;

  // Skip auth for public paths (health probe, GUI static files, SPA routes)
  if (isPublicPath(path)) {
    return next();
  }

  // Normalize overloaded signature
  let getApiKey: () => string;
  let getPending: (() => string | null) | undefined;
  let tokenStore: TokenStore | null | undefined;

  if (typeof getApiKeyOrOpts === "function") {
    getApiKey   = getApiKeyOrOpts;
    getPending  = getPendingKey;
    tokenStore  = null;
  } else {
    getApiKey   = getApiKeyOrOpts.getApiKey;
    getPending  = getApiKeyOrOpts.getPendingKey;
    tokenStore  = getApiKeyOrOpts.tokenStore;
  }

  const authHeader = c.req.header("Authorization");
  const requestId  = (c.get(REQUEST_ID_KEY) as string | undefined) ?? "unknown";

  if (authHeader === undefined || !authHeader.startsWith("Bearer ")) {
    logger.warn("auth_missing_header", "Request missing Authorization header", {
      correlationId: requestId,
      metadata: { path },
    });
    return c.json(
      {
        error: {
          code:        "AUTH-001",
          message:     "Authentication required",
          recoverable: false,
          request_id:  requestId,
        },
      },
      401,
    );
  }

  const providedKey = authHeader.slice(7); // strip "Bearer "

  // ── 1. Try scoped token lookup ─────────────────────────────────────────────
  if (tokenStore !== null && tokenStore !== undefined) {
    const token = tokenStore.validateToken(providedKey);
    if (token !== null) {
      const ctx: CallerContext = {
        role:     token.scope,
        ...(token.division !== undefined ? { division: token.division } : {}),
        ...(token.agentId  !== undefined ? { agentId:  token.agentId  } : {}),
        tokenId:  token.id,
      };
      c.set(CALLER_CONTEXT_KEY, ctx);
      return next();
    }
  }

  // ── 2. Fall back to legacy single API key ──────────────────────────────────
  const currentKey = getApiKey();
  const pendingKey = getPending?.() ?? null;

  const valid =
    timingSafeCompare(providedKey, currentKey) ||
    (pendingKey !== null && pendingKey !== "" && timingSafeCompare(providedKey, pendingKey));

  if (valid) {
    // Legacy key → bootstrap scope (restricted: health + locale + first token creation only)
    logger.warn("auth_legacy_key", "Legacy API key used — restricted to bootstrap scope. Create a scoped token: sidjua token create --scope <scope>", {
      correlationId: requestId,
      metadata: { path },
    });
    const ctx: CallerContext = { role: "bootstrap" };
    c.set(CALLER_CONTEXT_KEY, ctx);
    return next();
  }

  // ── 3. Neither matched ─────────────────────────────────────────────────────
  logger.warn("auth_invalid_key", "Invalid API key provided", {
    correlationId: requestId,
    metadata: { path },
  });
  return c.json(
    {
      error: {
        code:        "AUTH-001",
        message:     "Invalid API key",
        recoverable: false,
        request_id:  requestId,
      },
    },
    401,
  );
};
