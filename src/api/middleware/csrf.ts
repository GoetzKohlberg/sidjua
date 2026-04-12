// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — CSRF origin-validation + double-submit middleware
 *
 * Validates the Origin (or Referer) header for state-changing requests
 * (POST/PUT/DELETE/PATCH). Blocks cross-origin requests.
 *
 * ORIGIN VALIDATION (highest priority):
 *   When an Origin header IS present it is ALWAYS validated against the allowlist.
 *   No bypass (Content-Type, Authorization, X-Requested-With) can override this.
 *   A browser extension that injects an Authorization header cross-origin cannot
 *   forge a request from an evil origin past this check.
 *
 * DOUBLE-SUBMIT CSRF (session-based requests):
 *   When an active session is present in context (loaded by sessionMiddleware),
 *   the X-CSRF-Token header must match session.csrfToken (timing-safe compare).
 *   This is defense-in-depth: even a valid origin does not bypass this check.
 *   Bearer-token / API-key requests never have a session, so they are unaffected.
 *
 * NO-ORIGIN BYPASS RULE (applies only when Origin is absent AND no session):
 *   Programmatic clients (CLI tools, curl, server-to-server calls) typically
 *   don't send an Origin header. They can bypass CSRF validation if they present:
 *     - Authorization: <token>          — API-key auth (not a browser form)
 *     - Content-Type: application/json  — browsers can't set this on form posts
 *     - X-Requested-With: <any>         — non-CORS-safelisted header; needs pre-flight
 *
 * MISSING ORIGIN RULE:
 *   No-Origin requests with none of the above bypass markers are blocked.
 *   Form-POST CSRF attacks may omit Origin in some browser/proxy configurations.
 *
 * Allowed origins (when Origin IS present):
 *   - Same-origin: the Origin header must match the request's own Host header
 *     (scheme, host, and port all equal). This is the W3C same-origin definition
 *     and works for any deployment — localhost, LAN IP, public hostname, IPv6.
 *   - Loopback safety net: http(s)://localhost[:<port>], http(s)://127.0.0.1[:<port>],
 *     and http(s)://[::1][:<port>] are always allowed regardless of Host, to
 *     keep the Desktop-App use case working if the Host header is ever rewritten
 *     by a local tool.
 *
 * Reverse proxies (X-Forwarded-Host, X-Forwarded-Proto) are NOT trusted by this
 * middleware. P438 assumes direct container exposure. A proxy-aware mode is a
 * future feature and requires an explicit SIDJUA_TRUSTED_PROXIES allowlist.
 *
 * Fallback: if Origin is absent but Referer is present, the origin component
 *   of the Referer URL is validated against the same same-origin + loopback rules.
 */

import { timingSafeEqual }                from "node:crypto";
import type { MiddlewareHandler, Context } from "hono";
import { createLogger }                    from "../../core/logger.js";
import { SESSION_KEY }                     from "./session.js";
import type { SessionData }                from "./session.js";

const logger = createLogger("api-server");


/** HTTP methods that mutate server state and therefore need CSRF protection. */
const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Safety-net allowlist for loopback origins. Used when Host header is absent
 * or when the request genuinely came from the local machine (Desktop-App use case).
 * Everything else is validated by same-origin comparison against the Host header.
 * Covers IPv6 loopback [::1] in addition to the IPv4 aliases.
 */
const LOOPBACK_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Parsed representation of an HTTP/HTTPS origin. */
interface ParsedOrigin {
  scheme: string;
  host:   string;
  port:   string | null;
}

/**
 * Parse an origin-like string into canonical {scheme, host, port} parts.
 * Returns null on parse failure or for non-HTTP(S) schemes.
 */
function parseOrigin(value: string): ParsedOrigin | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return {
      scheme: u.protocol.replace(":", ""),
      host:   u.hostname.toLowerCase(),
      port:   u.port || null,
    };
  } catch {
    return null;
  }
}

/**
 * Build the canonical origin of the current request from its Host header.
 * Assumes the server is directly exposed (no reverse proxy).
 * Returns null if the Host header is missing or malformed.
 */
function getRequestOrigin(c: Context): ParsedOrigin | null {
  const hostHeader = c.req.header("host");
  if (!hostHeader) return null;
  // Derive scheme from the request URL (http: in direct-exposure mode).
  const requestUrl = new URL(c.req.url, "http://localhost");
  return parseOrigin(`${requestUrl.protocol}//${hostHeader}`);
}

/** True iff two parsed origins share protocol, host, and port. */
function isSameOrigin(a: ParsedOrigin, b: ParsedOrigin): boolean {
  return a.scheme === b.scheme && a.host === b.host && a.port === b.port;
}

/**
 * Validate an origin string (already parsed) against the current request.
 * Returns true if the origin is allowed (same-origin OR loopback safety net).
 */
function isOriginAllowed(parsedOrigin: ParsedOrigin, rawOrigin: string, c: Context): boolean {
  if (LOOPBACK_ORIGIN_RE.test(rawOrigin)) return true;
  const requestOrigin = getRequestOrigin(c);
  return requestOrigin !== null && isSameOrigin(parsedOrigin, requestOrigin);
}


/**
 * Reject state-changing requests from unexpected origins.
 * For session-based requests, also enforces double-submit CSRF token check.
 */
export const csrfMiddleware: MiddlewareHandler = async (c, next) => {
  // Safe methods don't mutate state — skip check
  if (!MUTATING_METHODS.has(c.req.method)) {
    return next();
  }

  const origin = c.req.header("origin");

  // ── Step 1: Origin present — ALWAYS validate first ────────────────────────
  // Browser extensions can inject Authorization headers cross-origin, so
  // checking Authorization/Content-Type before Origin would be exploitable.
  if (origin !== undefined) {
    const parsedOrigin = parseOrigin(origin);
    if (parsedOrigin === null) {
      logger.warn("csrf_origin_malformed", "CSRF: malformed origin header", {
        metadata: { origin, method: c.req.method, path: c.req.path },
      });
      return c.json({ error: "CSRF: invalid origin" }, 403);
    }
    if (!isOriginAllowed(parsedOrigin, origin, c)) {
      logger.warn("csrf_origin_rejected", "CSRF: cross-origin request blocked", {
        metadata: {
          origin,
          request_origin: (() => { const ro = getRequestOrigin(c); return ro ? `${ro.scheme}://${ro.host}${ro.port ? ":" + ro.port : ""}` : null; })(),
          method: c.req.method,
          path:   c.req.path,
        },
      });
      return c.json({ error: "CSRF: invalid origin" }, 403);
    }
    // Origin valid — fall through to double-submit check for session requests
  }

  // ── Step 2: Double-submit CSRF for session-based requests ─────────────────
  // sessionMiddleware (runs before csrf in the chain) sets SESSION_KEY when a
  // valid signed session cookie is present. Bearer-token clients never have a
  // session, so this branch only applies to browser / cookie-auth callers.
  const session = c.get(SESSION_KEY) as SessionData | undefined;
  if (session !== undefined) {
    const csrfHeader = c.req.header("x-csrf-token") ?? "";
    const expected   = Buffer.from(session.csrfToken, "utf-8");
    const provided   = Buffer.from(csrfHeader,        "utf-8");
    const valid =
      expected.length > 0 &&
      expected.length === provided.length &&
      timingSafeEqual(expected, provided);
    if (!valid) {
      logger.warn("csrf_double_submit_fail", "CSRF: X-CSRF-Token missing or invalid for session request", {
        metadata: { method: c.req.method, path: c.req.path, hasToken: csrfHeader.length > 0 },
      });
      return c.json({ error: "CSRF: invalid or missing X-CSRF-Token" }, 403);
    }
    return next();
  }

  // ── Step 3: No session — Bearer-token / programmatic client ───────────────
  // If origin was already validated in step 1 and passed, allow through.
  if (origin !== undefined) {
    return next();
  }

  // No origin and no session — check bypass markers.
  // These markers can only be set by non-browser clients (CLI, curl, SDKs)
  // that would not use cookie auth anyway.
  const hasAuth         = c.req.header("authorization") !== undefined;
  const contentType     = c.req.header("content-type") ?? "";
  const isJson          = contentType.includes("application/json");
  const hasXRW          = c.req.header("x-requested-with") !== undefined;
  const hasSidjuaHeader = c.req.header("x-sidjua-request") !== undefined;

  if (hasAuth || isJson || hasXRW || hasSidjuaHeader) {
    return next();
  }

  // ── No origin + no session + no bypass markers — Referer fallback ─────────
  const referer = c.req.header("referer");

  if (referer !== undefined) {
    let refererOrigin: string;
    try {
      refererOrigin = new URL(referer).origin;
    } catch (_err) {
      logger.warn("csrf_malformed_referer", "CSRF: malformed Referer header blocked", {
        metadata: { referer, method: c.req.method, path: c.req.path },
      });
      return c.json({ error: "CSRF validation failed: malformed Referer header" }, 403);
    }

    const parsedRefererOrigin = parseOrigin(refererOrigin);
    if (parsedRefererOrigin === null || !isOriginAllowed(parsedRefererOrigin, refererOrigin, c)) {
      logger.warn("csrf_referer_rejected", "CSRF: request from disallowed Referer origin blocked", {
        metadata: { refererOrigin, method: c.req.method, path: c.req.path },
      });
      return c.json({ error: "CSRF validation failed: disallowed Referer origin" }, 403);
    }
    return next();
  }

  // Neither Origin, nor session, nor bypass markers, nor valid Referer — block.
  logger.warn("csrf_missing_origin", "CSRF: state-changing request missing both Origin and Referer", {
    metadata: { method: c.req.method, path: c.req.path },
  });
  return c.json({ error: "CSRF validation failed: missing Origin header" }, 403);
};
