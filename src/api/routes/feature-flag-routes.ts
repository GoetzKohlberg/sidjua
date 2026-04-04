// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Feature Flag REST Endpoints
 *
 * GET  /api/v1/system/feature-flags        — list all flags (operator scope)
 * POST /api/v1/system/feature-flags/:name  — override a flag value (operator scope)
 */

import { Hono } from "hono";
import { requireScope } from "../middleware/require-scope.js";
import { createLogger } from "../../core/logger.js";
import { getFeatureFlags } from "../../core/config/feature-flags.js";
import type Database from "better-sqlite3";

const logger = createLogger("feature-flag-routes");

export interface FeatureFlagRouteServices {
  db?: InstanceType<typeof Database> | null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerFeatureFlagRoutes(
  app: Hono,
  services: FeatureFlagRouteServices = {},
): void {
  const { db = null } = services;

  // ── GET /api/v1/system/feature-flags ───────────────────────────────────────
  app.get("/api/v1/system/feature-flags", requireScope("operator"), (c) => {
    const manager = getFeatureFlags();
    const state   = manager.getState();

    return c.json({
      flags:    state.flags,
      sources:  state.source,
      loadedAt: state.loadedAt,
    });
  });

  // ── POST /api/v1/system/feature-flags/:name ───────────────────────────────
  app.post("/api/v1/system/feature-flags/:name", requireScope("operator"), async (c) => {
    const flagName = c.req.param("name");

    let value: boolean;
    try {
      const body = await c.req.json() as Record<string, unknown>;
      if (typeof body["enabled"] !== "boolean") {
        return c.json(
          { error: { code: "FF-400", message: "Request body must include { enabled: boolean }" } },
          400,
        );
      }
      value = body["enabled"];
    } catch (_e) {
      return c.json(
        { error: { code: "FF-400", message: "Invalid JSON body" } },
        400,
      );
    }

    const manager = getFeatureFlags();
    const allFlags = manager.getAll();

    if (!(flagName in allFlags)) {
      return c.json(
        { error: { code: "FF-404", message: `Unknown feature flag: ${flagName}` } },
        404,
      );
    }

    if (db !== null) {
      manager.setDbOverride(flagName, value, db);
    } else {
      // In-memory only — won't persist across restarts
      logger.warn("feature_flag_no_db", "No DB available — flag override is in-memory only", {
        metadata: { flagName, value },
      });
    }

    return c.json({
      flag:    flagName,
      enabled: manager.get(flagName),
      persisted: db !== null,
    });
  });
}
