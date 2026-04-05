// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — API route helper utilities
 *
 * Shared helpers for Hono route handlers:
 *
 *   parsePagination()   — parse + validate limit/offset query params
 *   jsonSuccess()       — consistent 200 JSON response
 *   jsonError()         — consistent error JSON response
 *   apiHandler()        — wrap a handler with try/catch → 500 fallback
 */

import type { Context, Handler } from "hono";
import { createLogger }          from "../../core/logger.js";

const logger = createLogger("api-route-helpers");

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 100;

/**
 * Parse and validate `limit` and `offset` query params from a Hono Context.
 *
 * Returns `{ limit, offset }` on success, or `{ error }` if values are
 * out of range so callers can return a 400 response immediately.
 */
export function parsePagination(
  limitStr:  string | undefined,
  offsetStr: string | undefined,
  opts?: { defaultLimit?: number; maxLimit?: number },
): { limit: number; offset: number } | { error: string } {
  const defLimit = opts?.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = opts?.maxLimit     ?? MAX_LIMIT;
  const limit    = parseInt(limitStr  ?? String(defLimit), 10);
  const offset   = parseInt(offsetStr ?? "0", 10);
  if (isNaN(limit)  || limit  < 1 || limit  > maxLimit) return { error: `limit must be 1–${maxLimit}` };
  if (isNaN(offset) || offset < 0)                       return { error: "offset must be ≥ 0" };
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Consistent response helpers
// ---------------------------------------------------------------------------

/** Return a 200 JSON response with `{ data }` wrapper. */
export function jsonSuccess<T>(c: Context, data: T, status: 200 | 201 = 200): Response {
  return c.json(data, status);
}

/**
 * Return a JSON error response.
 *
 * @param c       Hono context
 * @param code    SIDJUA error code (e.g. "SYS-500")
 * @param message Human-readable message
 * @param status  HTTP status code (default: 500)
 */
export function jsonError(
  c: Context,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500 = 500,
): Response {
  return c.json({ error: { code, message } }, status);
}

// ---------------------------------------------------------------------------
// apiHandler — wraps a route handler with a generic try/catch
// ---------------------------------------------------------------------------

/**
 * Wrap a Hono route handler with a standard try/catch.
 *
 * On uncaught exception, logs the error and returns a generic 500 response.
 * Callers should still handle SidjuaError and domain-specific errors before
 * throwing, since apiHandler uses a catch-all fallback only.
 *
 * @example
 * app.get("/api/v1/tokens", requireScope("admin"), apiHandler(async (c) => {
 *   const tokens = tokenStore.listTokens();
 *   return c.json({ tokens });
 * }));
 */
export function apiHandler(
  event: string,
  handler: (c: Context) => Promise<Response> | Response,
): Handler {
  return async (c: Context): Promise<Response> => {
    try {
      return await handler(c);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error(event, "Unhandled route error", {
        metadata: { error: errMsg, path: c.req.path },
      });
      return c.json({ error: { code: "SYS-500", message: "Internal error" } }, 500);
    }
  };
}
