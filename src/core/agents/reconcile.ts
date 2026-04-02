// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Agent Startup Reconciliation
 *
 * On startup, scans all persisted checkpoints and reconciles orphaned frozen
 * agents (e.g. from an interrupted update). Version-mismatched checkpoints
 * are migrated. Incompatible checkpoints are reset to idle.
 *
 * Must run AFTER the database is ready but BEFORE accepting HTTP requests.
 */

import { loadAllCheckpoints, persistCheckpoint } from "./checkpoint.js";
import { migrateAgentState }                     from "./state-migration.js";
import { getSystemState }                        from "./lifecycle.js";
import { createLogger }                          from "../logger.js";

const logger = createLogger("reconcile");

/**
 * Reconcile orphaned frozen agents on startup.
 *
 * @param currentVersion  The currently running app version
 */
export async function reconcileOnStartup(currentVersion: string): Promise<void> {
  let checkpoints: Awaited<ReturnType<typeof loadAllCheckpoints>>;
  try {
    checkpoints = await loadAllCheckpoints();
  } catch (err: unknown) {
    logger.warn("reconcile", "Failed to load checkpoints — skipping reconciliation", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  const frozenAgents = checkpoints.filter((c) => c.status === "frozen");

  if (frozenAgents.length > 0 && getSystemState() === "RUNNING") {
    logger.warn("reconcile", "Orphaned frozen agents found on startup", {
      metadata: { count: frozenAgents.length },
    });

    for (const checkpoint of frozenAgents) {
      if (checkpoint.version !== currentVersion) {
        const migrated = await migrateAgentState(checkpoint, currentVersion);
        if (migrated === null) {
          logger.warn("reconcile", "Agent checkpoint incompatible — resetting to idle", {
            metadata: { agentId: checkpoint.id, version: checkpoint.version },
          });
          try {
            await persistCheckpoint({ ...checkpoint, status: "idle" });
          } catch (err: unknown) {
            logger.warn("reconcile", "Failed to reset incompatible checkpoint", {
              metadata: { agentId: checkpoint.id, error: err instanceof Error ? err.message : String(err) },
            });
          }
          continue;
        }
        try {
          await persistCheckpoint({ ...migrated, status: "idle" });
        } catch (err: unknown) {
          logger.warn("reconcile", "Failed to persist migrated checkpoint", {
            metadata: { agentId: checkpoint.id, error: err instanceof Error ? err.message : String(err) },
          });
        }
      } else {
        // Same version — just unfreeze
        try {
          await persistCheckpoint({ ...checkpoint, status: "idle" });
        } catch (err: unknown) {
          logger.warn("reconcile", "Failed to unfreeze checkpoint", {
            metadata: { agentId: checkpoint.id, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }

    logger.info("reconcile", "Orphaned agent reconciliation complete", {
      metadata: { count: frozenAgents.length },
    });
  }

  // Migrate any remaining version-mismatched checkpoints (not just frozen ones)
  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== "frozen" && checkpoint.version !== currentVersion) {
      const migrated = await migrateAgentState(checkpoint, currentVersion);
      if (migrated !== null) {
        try {
          await persistCheckpoint(migrated);
        } catch (err: unknown) {
          logger.warn("reconcile", "Failed to migrate stale checkpoint", {
            metadata: { agentId: checkpoint.id, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }
  }
}
