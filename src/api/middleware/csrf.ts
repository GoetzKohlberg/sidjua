// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — CSRF origin-validation middleware
 *
 * Validates the Origin (or Referer) header for state-changing requests
 * (POST/PUT/DELETE/PATCH). Blocks cross-origin requests from non-localhost /
 * non-Tauri origins.
 *
 * Defense-in-depth: API key auth already prevents most CSRF, but a malicious
 * localhost page (e.g. compromised npm package with a dev server) could read
 * the key from localStorage. Origin validation adds an extra layer.
 *
 * ORIGIN VALIDATION (highest priority):
 *   When an Origin header IS present it is ALWAYS validated against the allowlist.
 *   No bypass (Content-Type, Authorization, X-Requested-With) can override this.
 *   A browser extension that injects an Authorization header cross-origin cannot
 *   forge a request from an evil origin past this check.
 *
 * NO-ORIGIN BYPASS RULE (applies only when Origin is absent):
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
 *   - tauri://localhost* — Tauri 2.x WebView
 *   - http(s)://localhost[:<port>] — local dev server
 *   - http(s)://127.0.0.1[:<port>] — loopback alias
 *
 * Fallback: if Origin is absent but Referer is present, the origin component
 *   of the Referer URL is validated against the same allowlist.
 */

import type { MiddlewareHandler } from "hono";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("api-server");


/** HTTP methods that mutate server state and therefore need CSRF protection. */
const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Regex matching allowed origins.
 * - tauri://localhost* — Tauri 2.0 WebView
 * - http(s)://localhost[:<port>] — local dev server
 * - http(s)://127.0.0.1[:<port>] — loopback alias
 */
const ALLOWED_ORIGIN_RE =
  /^tauri:\/\/localhost(\.localhost)?$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;


/**
 * Reject state-changing requests from unexpected origins.
 *
 * Previously requests with NO Origin header were allowed
 * unconditionally. Now they are blocked unless the Authorization header
 * is present (indicating custom-header auth, not cookie-based auth).
 */
export const csrfMiddleware: MiddlewareHandler = async (c, next) => {
  // Safe methods don't mutate state — skip check
  if (!MUTATING_METHODS.has(c.req.method)) {
    return next();
  }

  const origin  = c.req.header("origin");

  // ── Origin present: ALWAYS validate — no bypass can override this ──────────
  // Browser extensions can inject Authorization headers cross-origin, so checking
  // Authorization/Content-Type before Origin validation would be exploitable.
  if (origin !== undefined) {
    if (!ALLOWED_ORIGIN_RE.test(origin)) {
      logger.warn("csrf_origin_rejected", "CSRF: request from disallowed origin blocked", {
        metadata: { origin, method: c.req.method, path: c.req.path },
      });
      return c.json({ error: "CSRF: invalid origin" }, 403);
    }
    return next();
  }

  // ── No Origin header — programmatic client (CLI, curl, server-to-server) ───
  // Bypass CSRF if the request carries markers that browsers cannot forge
  // cross-origin without a CORS pre-flight:
  //   - Authorization: <token>         — API-key / Bearer auth
  //   - Content-Type: application/json — browsers use urlencoded/multipart for forms
  //   - X-Requested-With: <any>        — non-safelisted header; requires pre-flight
  const hasAuth       = c.req.header("authorization") !== undefined;
  const contentType   = c.req.header("content-type") ?? "";
  const isJson        = contentType.includes("application/json");
  const hasXRW        = c.req.header("x-requested-with") !== undefined;

  if (hasAuth || isJson || hasXRW) {
    return next();
  }

  // ── No Origin + no bypass markers — fall back to Referer validation ─────────
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

    if (!ALLOWED_ORIGIN_RE.test(refererOrigin)) {
      logger.warn("csrf_referer_rejected", "CSRF: request from disallowed Referer origin blocked", {
        metadata: { refererOrigin, method: c.req.method, path: c.req.path },
      });
      return c.json({ error: "CSRF validation failed: disallowed Referer origin" }, 403);
    }
    return next();
  }

  // Neither Origin, nor bypass markers, nor valid Referer — block.
  logger.warn("csrf_missing_origin", "CSRF: state-changing request missing both Origin and Referer", {
    metadata: { method: c.req.method, path: c.req.path },
  });
  return c.json({ error: "CSRF validation failed: missing Origin header" }, 403);
};
