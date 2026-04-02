// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Drain Middleware
 *
 * When drain mode is active, rejects ALL incoming requests with 503.
 * Used during the final phase of a blue/green update: the old slot
 * stops accepting new work so in-flight requests can complete before
 * the container is stopped.
 *
 * Register EARLY in the middleware chain — before route handlers.
 */

import type { MiddlewareHandler } from "hono";

let drainMode = false;

/** Enable drain mode — all NEW requests will receive 503. */
export function enableDrainMode(): void {
  drainMode = true;
}

/** Returns whether drain mode is currently active. */
export function isDrainMode(): boolean {
  return drainMode;
}

/** Disable drain mode (for testing / cancel). */
export function disableDrainMode(): void {
  drainMode = false;
}

/** Reset drain state — call in tests to prevent cross-test pollution. */
export function resetDrainState(): void {
  drainMode = false;
}

/**
 * Drain middleware — must be registered before route handlers.
 * Rejects all requests when drainMode is active.
 *
 * i18n key: update.drain_error
 */
export function drainMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (drainMode) {
      c.status(503);
      c.header("Retry-After", "30");
      return c.json({ error: "Service draining for update", retryAfter: 30 });
    }
    await next();
  };
}
