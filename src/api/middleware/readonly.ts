// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Read-Only Middleware
 *
 * During a blue/green update, the active slot is placed in write-lock
 * mode between "prepare" and "cancel/drain". This middleware rejects
 * all write requests (POST/PUT/PATCH/DELETE) except lifecycle endpoints
 * that the sidecar must call while the app is frozen.
 *
 * Register AFTER the drain middleware, before route handlers.
 */

import type { MiddlewareHandler } from "hono";

let updateReadOnlyMode = false;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths that the sidecar calls DURING read-only mode.
 * These MUST be whitelisted or the sidecar can't drive the lifecycle.
 */
const LIFECYCLE_PATHS = [
  "/api/v1/drain",
  "/api/v1/update/cancel",
  "/api/v1/update/prepare",
  "/api/v1/system/freeze",
  "/api/v1/system/resume",
  "/api/v1/system/state",
];

/** Enable write-lock mode. */
export function enableReadOnlyMode(): void {
  updateReadOnlyMode = true;
}

/** Disable write-lock mode. */
export function disableReadOnlyMode(): void {
  updateReadOnlyMode = false;
}

/** Returns whether write-lock mode is currently active. */
export function isReadOnlyMode(): boolean {
  return updateReadOnlyMode;
}

/** Reset read-only state — call in tests to prevent cross-test pollution. */
export function resetReadOnlyState(): void {
  updateReadOnlyMode = false;
}

/**
 * Read-only middleware — blocks write operations during update prepare.
 *
 * i18n key: update.readonly_error
 */
export function readonlyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (updateReadOnlyMode && WRITE_METHODS.has(c.req.method)) {
      const path = new URL(c.req.url, "http://localhost").pathname;
      if (!LIFECYCLE_PATHS.some((p) => path.startsWith(p))) {
        c.status(503);
        c.header("Retry-After", "120");
        return c.json({ error: "System updating — changes paused briefly", retryAfter: 120 });
      }
    }
    await next();
  };
}
