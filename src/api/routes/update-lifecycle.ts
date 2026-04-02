// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Update Lifecycle Routes
 *
 * Endpoints called BY the sidecar on the app to control lifecycle state.
 * These are on the internal Docker network, authenticated via UPDATER_TOKEN.
 *
 * POST /api/v1/update/prepare — enable write-lock. requireScope("operator")
 * POST /api/v1/update/cancel  — disable write-lock. requireScope("operator")
 * POST /api/v1/drain          — enable full drain mode. requireScope("operator")
 */

import { Hono }         from "hono";
import { requireScope } from "../middleware/require-scope.js";
import { enableReadOnlyMode, disableReadOnlyMode } from "../middleware/readonly.js";
import { enableDrainMode } from "../middleware/drain.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("update-lifecycle");

export function registerUpdateLifecycleRoutes(app: Hono): void {
  /**
   * POST /api/v1/update/prepare
   * Sets write-lock (read-only) mode. Called by the sidecar before starting the new slot.
   * Idempotent — safe to call multiple times.
   */
  app.post("/api/v1/update/prepare", requireScope("operator"), (c) => {
    enableReadOnlyMode();
    const ts = new Date().toISOString();
    logger.info("update-lifecycle", "Write-lock enabled (prepare)", { metadata: { timestamp: ts } });
    return c.json({ readOnly: true, timestamp: ts });
  });

  /**
   * POST /api/v1/update/cancel
   * Reverts write-lock mode. Called by the sidecar if update is aborted.
   * Idempotent — safe to call multiple times.
   */
  app.post("/api/v1/update/cancel", requireScope("operator"), (c) => {
    disableReadOnlyMode();
    const ts = new Date().toISOString();
    logger.info("update-lifecycle", "Write-lock disabled (cancel)", { metadata: { timestamp: ts } });
    return c.json({ readOnly: false, timestamp: ts });
  });

  /**
   * POST /api/v1/drain
   * Enables full drain mode — rejects all new requests.
   * Called by the sidecar just before stopping this slot.
   * NOT reversible in process (container will be stopped shortly).
   */
  app.post("/api/v1/drain", requireScope("operator"), (c) => {
    enableDrainMode();
    const ts = new Date().toISOString();
    logger.info("update-lifecycle", "Drain mode enabled", { metadata: { timestamp: ts } });
    return c.json({ draining: true, timestamp: ts });
  });
}
