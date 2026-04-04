// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — System Lifecycle Routes
 *
 * Endpoints for cooperative agent freeze/resume, used by the blue/green sidecar
 * before and after a zero-downtime update.
 *
 * POST /api/v1/system/freeze  — begin cooperative freeze of all agents
 * POST /api/v1/system/resume  — resume all agents after freeze
 * GET  /api/v1/system/state   — return current system state + active agent count
 *
 * All routes require operator scope.
 */

import { Hono }             from "hono";
import { requireScope }     from "../middleware/require-scope.js";
import {
  handleFreeze,
  handleResume,
  getSystemState,
  getActiveAgentCount,
  markFrozen,
}                           from "../../core/agents/lifecycle.js";
import {
  logFreezeAudit,
  cleanupFreezeAudit,
}                           from "../../core/agents/freeze-audit.js";
import { createLogger }     from "../../core/logger.js";
import type { BackpressureManager } from "../../core/runtime/backpressure.js";

const logger = createLogger("system-lifecycle");

export interface SystemLifecycleServices {
  backpressure?: BackpressureManager | null;
}

export function registerSystemLifecycleRoutes(
  app: Hono,
  services: SystemLifecycleServices = {},
): void {
  /**
   * POST /api/v1/system/freeze
   *
   * Requests cooperative freeze.  Agents are notified via the FREEZING state;
   * they checkpoint themselves and stop processing new tasks.
   * Returns immediately — callers should poll GET /state until state = "FROZEN"
   * or until all active agents have dropped to 0.
   */
  app.post("/api/v1/system/freeze", requireScope("operator"), async (c) => {
    const triggeredBy = (c.req.header("x-triggered-by") ?? "api").slice(0, 64);
    const result = await handleFreeze();

    logFreezeAudit({
      event:        "freeze_requested",
      triggeredBy,
      activeAgents: result.activeAgents,
      timestamp:    new Date().toISOString(),
    });

    // If no active agents remain, mark as fully frozen immediately
    if (result.activeAgents === 0 && result.state === "FREEZING") {
      markFrozen();
      logFreezeAudit({
        event:        "frozen",
        triggeredBy:  "system",
        activeAgents: 0,
        timestamp:    new Date().toISOString(),
      });
    }

    logger.info("system-lifecycle", "Freeze requested", {
      metadata: { state: result.state, activeAgents: result.activeAgents, triggeredBy },
    });

    return c.json({
      state:        result.state,
      activeAgents: result.activeAgents,
    });
  });

  /**
   * POST /api/v1/system/resume
   *
   * Resumes all frozen agents.  Sets system state back to RUNNING and
   * signals agents to resume from their last checkpoints.
   */
  app.post("/api/v1/system/resume", requireScope("operator"), async (c) => {
    const triggeredBy = (c.req.header("x-triggered-by") ?? "api").slice(0, 64);
    const result = await handleResume();

    logFreezeAudit({
      event:        "resume_requested",
      triggeredBy,
      activeAgents: 0,
      timestamp:    new Date().toISOString(),
    });

    logFreezeAudit({
      event:        "resumed",
      triggeredBy:  "system",
      activeAgents: result.resumedAgents,
      timestamp:    new Date().toISOString(),
    });

    // Prune old audit entries after a successful resume
    cleanupFreezeAudit();

    logger.info("system-lifecycle", "Resume complete", {
      metadata: { state: result.state, resumedAgents: result.resumedAgents, triggeredBy },
    });

    return c.json({
      state:         result.state,
      resumedAgents: result.resumedAgents,
    });
  });

  /**
   * GET /api/v1/system/state
   *
   * Returns current system state and active agent count.
   * Lightweight — safe to poll frequently.
   */
  app.get("/api/v1/system/state", requireScope("operator"), (c) => {
    return c.json({
      state:        getSystemState(),
      activeAgents: getActiveAgentCount(),
    });
  });

  /**
   * GET /api/v1/system/backpressure
   *
   * Returns current backpressure queue status: active workers per tier,
   * queue depth, and per-tier concurrency limits.
   * Returns 503 if the BackpressureManager is not wired up.
   */
  app.get("/api/v1/system/backpressure", requireScope("operator"), (c) => {
    const { backpressure } = services;
    if (backpressure == null) {
      return c.json({ error: "Backpressure manager not available" }, 503);
    }
    return c.json(backpressure.getStatus());
  });
}
