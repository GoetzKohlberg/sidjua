// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Updater REST Routes
 *
 * Proxies to the sidecar updater service for blue/green update orchestration.
 *
 * GET  /api/v1/update/check    — check for available updates (no sidecar needed)
 * POST /api/v1/update/start    — start update (SSE proxy to sidecar)
 * GET  /api/v1/update/status   — get current update status
 * POST /api/v1/update/rollback — trigger rollback (SSE proxy to sidecar)
 *
 * All routes require admin scope.
 * If UPDATER_URL is not configured, returns 503.
 */

import { Hono }         from "hono";
import { requireScope } from "../middleware/require-scope.js";
import { checkForUpdate, getLastVersionInfo } from "../../core/updater/version-check.js";
import { SIDJUA_VERSION } from "../../version.js";
import { createLogger }   from "../../core/logger.js";

const logger = createLogger("updater-routes");

function getUpdaterUrl(): string | null {
  const url = process.env["UPDATER_URL"];
  return url && url.trim().length > 0 ? url.trim() : null;
}

export function registerUpdaterRoutes(app: Hono): void {
  /**
   * GET /api/v1/update/check
   * Check for an available update. Does not require the sidecar.
   */
  app.get("/api/v1/update/check", requireScope("admin"), async (c) => {
    try {
      const info = await checkForUpdate(SIDJUA_VERSION);
      return c.json(info);
    } catch (err: unknown) {
      logger.error("updater-routes", "Version check failed", {
        error: { code: "UPDATE-001", message: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Version check failed" }, 502);
    }
  });

  /**
   * GET /api/v1/update/status
   * Returns current update status from the sidecar.
   */
  app.get("/api/v1/update/status", requireScope("admin"), async (c) => {
    const updaterUrl = getUpdaterUrl();
    if (updaterUrl === null) {
      return c.json({ error: "Update service not available" }, 503);
    }

    try {
      const resp = await fetch(updaterUrl + "/status", { signal: AbortSignal.timeout(10_000) });
      const body: unknown = await resp.json();
      return c.json(body, resp.status as 200);
    } catch (err: unknown) {
      logger.warn("updater-routes", "Sidecar status fetch failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Update service unreachable" }, 503);
    }
  });

  /**
   * POST /api/v1/update/start
   * Starts a blue/green update. Proxies SSE stream from sidecar.
   */
  app.post("/api/v1/update/start", requireScope("admin"), async (c) => {
    const updaterUrl = getUpdaterUrl();
    if (updaterUrl === null) {
      return c.json({ error: "Update service not available" }, 503);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch (_err) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (typeof body["targetVersion"] !== "string" || !body["targetVersion"]) {
      return c.json({ error: "targetVersion required" }, 400);
    }

    try {
      const upstream = await fetch(updaterUrl + "/update", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ targetVersion: body["targetVersion"] }),
        signal:  AbortSignal.timeout(600_000), // 10 minutes max for full update
      });

      // Proxy the SSE stream from the sidecar to the browser
      return new Response(upstream.body, {
        status:  upstream.status,
        headers: {
          "Content-Type":  "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection":    "keep-alive",
        },
      });
    } catch (err: unknown) {
      logger.error("updater-routes", "Sidecar update request failed", {
        error: { code: "UPDATE-002", message: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Update service unreachable" }, 503);
    }
  });

  /**
   * POST /api/v1/update/rollback
   * Triggers rollback via sidecar. Proxies SSE stream.
   */
  app.post("/api/v1/update/rollback", requireScope("admin"), async (c) => {
    const updaterUrl = getUpdaterUrl();
    if (updaterUrl === null) {
      return c.json({ error: "Update service not available" }, 503);
    }

    try {
      const upstream = await fetch(updaterUrl + "/rollback", {
        method:  "POST",
        signal:  AbortSignal.timeout(300_000), // 5 minutes max for rollback
      });

      return new Response(upstream.body, {
        status:  upstream.status,
        headers: {
          "Content-Type":  "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection":    "keep-alive",
        },
      });
    } catch (err: unknown) {
      logger.error("updater-routes", "Sidecar rollback request failed", {
        error: { code: "UPDATE-003", message: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Update service unreachable" }, 503);
    }
  });

  // Expose last cached version info (fast, no network call)
  app.get("/api/v1/update/last-check", requireScope("readonly"), (c) => {
    const info = getLastVersionInfo();
    if (info === null) {
      return c.json({ checked: false }, 200);
    }
    return c.json({ checked: true, ...info }, 200);
  });
}
