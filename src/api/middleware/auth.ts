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
import { SESSION_KEY }            from "./session.js";
import type { SessionData }       from "./session.js";

const logger = createLogger("api-server");

/** Routes that bypass authentication (exact match) */
// /api/v1/events is deliberately public: EventSource cannot send custom headers.
// The handler enforces its own ticket-based auth (consumeTicket), so no Bearer
// token is needed at the middleware layer.  Unauthenticated requests without a
// valid ticket are rejected by the handler with AUTH-001.
// /api/v1/org/public is the Glasscheibe unauthenticated org-chart endpoint (P348).
// /widget/glasscheibe.js is the embeddable widget script (P349).
// /api/v1/auth/setup, /login, /logout, /verify — GUI auth endpoints (P434b)
const PUBLIC_PATHS = new Set([
  "/api/v1/health",
  "/api/v1/events",
  "/api/v1/org/public",
  "/widget/glasscheibe.js",
  "/api/v1/auth/setup",
  "/api/v1/auth/login",
  "/api/v1/auth/logout",
  "/api/v1/auth/verify",
  // P443: CSRF token fetch — called by auth.ts checkAuth() step 3 using raw fetch()
  // (no Authorization header). Auth middleware Bearer gate would block it before
  // session check runs; adding to PUBLIC_PATHS lets the session middleware resolve it.
  "/api/v1/auth/csrf",
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

  // ── Session-cookie auth — runs before Bearer-header check ─────────────────
  // Browser clients (GUI) never send Authorization: Bearer; they authenticate
  // via the sidjua_sid session cookie.  sessionMiddleware is wired before
  // authenticate in server.ts and populates SESSION_KEY when a valid cookie is
  // present.  Check here first so browser requests are granted before the
  // Bearer-only guard fires.  Bearer-token clients never have a session cookie
  // in practice, so this branch is a no-op for API / CLI callers.
  const session = c.get(SESSION_KEY as string) as SessionData | undefined;
  if (session !== undefined) {
    const ctx: CallerContext = { role: "admin" };
    c.set(CALLER_CONTEXT_KEY, ctx);
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

  // R3-M3: fail-closed when called with the AuthMiddlewareOptions form and
  // tokenStore is explicitly null (DB unavailable). Continuing with legacy-key
  // auth would silently degrade security. Return 503 instead.
  if (typeof getApiKeyOrOpts !== "function" && tokenStore === null) {
    logger.warn("auth_token_store_unavailable", "TokenStore unavailable — refusing legacy key fallback", {
      correlationId: requestId,
      metadata: { path },
    });
    return c.json(
      {
        error: {
          code:        "AUTH-503",
          message:     "Authentication service temporarily unavailable",
          recoverable: true,
          request_id:  requestId,
        },
      },
      503,
    );
  }

  // C3: if bootstrap key has been explicitly disabled, reject all legacy key auth.
  if (tokenStore !== null && tokenStore !== undefined && tokenStore.isBootstrapDisabled()) {
    logger.warn("auth_bootstrap_disabled", "Bootstrap key authentication is disabled — use a scoped token", {
      correlationId: requestId,
      metadata: { path },
    });
    return c.json(
      {
        error: {
          code:        "AUTH-011",
          message:     "Bootstrap key authentication is disabled. Use a scoped token.",
          recoverable: false,
          request_id:  requestId,
        },
      },
      401,
    );
  }

  const currentKey = getApiKey();
  const pendingKey = getPending?.() ?? null;

  // P436: When no legacy API key is configured (first-run, browser-session-only
  // deployment per SPEC-BOOTSTRAP-V2 v2.1 §5), the legacy bootstrap path is
  // effectively disabled. Reject explicitly rather than risk an empty-Bearer
  // match via timingSafeCompare("", "").
  if (currentKey === "" && (pendingKey === null || pendingKey === "")) {
    logger.warn("auth_no_legacy_key", "No legacy API key configured — bootstrap path disabled. Use session or scoped token.", {
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

  const valid =
    timingSafeCompare(providedKey, currentKey) ||
    (pendingKey !== null && pendingKey !== "" && timingSafeCompare(providedKey, pendingKey));

  if (valid) {
    // Legacy key → bootstrap scope (restricted: health + locale + first token creation only)
    logger.warn("auth_legacy_key", "Legacy API key used — restricted to bootstrap scope. Create a scoped token: sidjua token create --scope <scope>", {
      correlationId: requestId,
      metadata: { path },
    });
    // Warn prominently when admin tokens already exist — the bootstrap key should be disabled
    if (tokenStore !== null && tokenStore !== undefined && tokenStore.hasAdminToken()) {
      logger.warn("auth_bootstrap_stale", "SECURITY: Bootstrap key still active after admin tokens exist. Disable with: sidjua api-key disable-bootstrap", {
        correlationId: requestId,
        metadata: { path },
      });
    }
    const ctx: CallerContext = { role: "bootstrap" };
    c.set(CALLER_CONTEXT_KEY, ctx);

    // Once ANY scoped token exists, restrict bootstrap key to token-management
    // routes only. All other routes return 403 with migration instructions.
    // FAIL-OPEN: if we cannot query tokens, allow bootstrap (avoid lockout).
    if (tokenStore !== null && tokenStore !== undefined && tokenStore.hasAnyToken()) {
      if (!path.startsWith("/api/v1/tokens")) {
        logger.warn("bootstrap_migration_required", "Bootstrap key blocked — scoped tokens exist. Use a scoped token.", {
          correlationId: requestId,
          metadata: { path },
        });
        return c.json({
          error: {
            code:        "AUTH-010",
            message:     "Bootstrap key restricted. Create a scoped API token via POST /api/v1/tokens, then use that token.",
            recoverable: true,
          },
        }, 403);
      }
    }

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
