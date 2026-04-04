// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Memory Consolidation REST Endpoints
 *
 * GET  /api/v1/memory/status          — index stats + lock status (operator)
 * POST /api/v1/memory/consolidate     — trigger consolidation run (operator)
 * POST /api/v1/memory/approve/:id     — T1 approve/reject pending result (admin)
 * GET  /api/v1/memory/pending         — list pending approvals (operator)
 */

import { Hono } from "hono";
import { requireScope } from "../middleware/require-scope.js";
import { createLogger } from "../../core/logger.js";
import type Database from "better-sqlite3";
import { MemoryIndexManager }   from "../../core/memory/memory-index.js";
import { MemoryConsolidator }   from "../../core/memory/memory-consolidator.js";
import { MemoryGovernance }     from "../../core/memory/memory-governance.js";
import {
  acquireConsolidationLock,
  releaseConsolidationLock,
  getConsolidationLock,
  recordLastConsolidationRun,
} from "../../core/memory/memory-trigger.js";

const logger = createLogger("memory-routes");

export interface MemoryRouteServices {
  db:      InstanceType<typeof Database>;
  workDir: string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerMemoryRoutes(app: Hono, services: MemoryRouteServices): void {
  const { db, workDir } = services;
  const indexManager    = new MemoryIndexManager(workDir);
  const consolidator    = new MemoryConsolidator(indexManager);
  const governance      = new MemoryGovernance(db);

  // ── GET /api/v1/memory/status ──────────────────────────────────────────────
  app.get("/api/v1/memory/status", requireScope("operator"), (c) => {
    const stats = indexManager.getStats();
    const lock  = getConsolidationLock(db);
    const pending = governance.getPendingApprovals().length;

    return c.json({
      index: {
        total_entries: stats.total,
        unique_agents: stats.agents,
        oldest_entry:  stats.oldest,
        newest_entry:  stats.newest,
      },
      lock: lock !== null
        ? { held: true, holder: lock.holder, acquired_at: lock.acquired_at, expires_at: lock.expires_at }
        : { held: false },
      pending_approvals: pending,
    });
  });

  // ── POST /api/v1/memory/consolidate ───────────────────────────────────────
  app.post("/api/v1/memory/consolidate", requireScope("operator"), async (c) => {
    // Parse optional body
    let since: string | undefined;
    try {
      const body = await c.req.json() as Record<string, unknown>;
      if (typeof body["since"] === "string") since = body["since"];
    } catch (_e) {
      // No body — ok
    }

    // Try to acquire advisory lock
    if (!acquireConsolidationLock(db)) {
      return c.json(
        { error: { code: "MEM-409", message: "Consolidation already in progress" } },
        409,
      );
    }

    try {
      const result = consolidator.run(db, since);
      const approvalId = governance.submitForApproval(result);
      recordLastConsolidationRun(db);

      logger.info("memory_consolidate_api", "Consolidation run triggered via REST", {
        metadata: { runId: result.run_id, approvalId },
      });

      return c.json({
        run_id:       result.run_id,
        approval_id:  approvalId,
        started_at:   result.started_at,
        completed_at: result.completed_at,
        summary: {
          gathered:         result.gather.count,
          after_consolidate: result.consolidate.total_out,
          after_prune:       result.prune.kept.length,
          proposed_additions: result.proposed_additions.length,
          proposed_removals:  result.proposed_removals.length,
        },
        message: "Consolidation complete. Pending T1 approval before changes are applied.",
      }, 202);
    } catch (err: unknown) {
      logger.warn("memory_consolidate_error", "Consolidation run failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json(
        { error: { code: "MEM-500", message: "Consolidation failed", detail: err instanceof Error ? err.message : String(err) } },
        500,
      );
    } finally {
      releaseConsolidationLock(db);
    }
  });

  // ── POST /api/v1/memory/approve/:id ───────────────────────────────────────
  app.post("/api/v1/memory/approve/:id", requireScope("admin"), async (c) => {
    const approvalId = c.req.param("id");

    let approved   = true;
    let approvedBy: string | undefined;
    let reason:     string | undefined;

    try {
      const body = await c.req.json() as Record<string, unknown>;
      if (typeof body["approved"]    === "boolean") approved    = body["approved"];
      if (typeof body["approved_by"] === "string")  approvedBy  = body["approved_by"];
      if (typeof body["reason"]      === "string")  reason      = body["reason"];
    } catch (_e) {
      // No body — default to approve
    }

    let updatedApproval;
    try {
      updatedApproval = governance.processApproval(approvalId, approved, approvedBy, reason);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return c.json({ error: { code: "MEM-404", message: `Approval ${approvalId} not found` } }, 404);
      }
      if (msg.includes("already")) {
        return c.json({ error: { code: "MEM-409", message: msg } }, 409);
      }
      return c.json({ error: { code: "MEM-500", message: msg } }, 500);
    }

    // If approved, apply the changes immediately
    if (approved) {
      try {
        consolidator.applyApproved(updatedApproval.result);
      } catch (err: unknown) {
        logger.warn("memory_apply_error", "Failed to apply approved consolidation", {
          metadata: { approvalId, error: err instanceof Error ? err.message : String(err) },
        });
        return c.json(
          { error: { code: "MEM-500", message: "Approval recorded but failed to apply changes" } },
          500,
        );
      }
    }

    return c.json({
      approval_id: approvalId,
      status:      updatedApproval.status,
      decided_at:  updatedApproval.decided_at,
      applied:     approved,
    });
  });

  // ── GET /api/v1/memory/pending ─────────────────────────────────────────────
  app.get("/api/v1/memory/pending", requireScope("operator"), (c) => {
    const pending = governance.getPendingApprovals();
    return c.json({
      pending: pending.map((a) => ({
        approval_id:  a.approval_id,
        run_id:       a.run_id,
        submitted_at: a.submitted_at,
        additions:    a.result.proposed_additions.length,
        removals:     a.result.proposed_removals.length,
      })),
      total: pending.length,
    });
  });
}
