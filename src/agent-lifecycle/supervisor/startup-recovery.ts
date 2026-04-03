// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5c: StartupRecoveryManager
 *
 * On startup, checks whether the previous shutdown was clean.
 * If not, queries all active/processing agents and runs recovery for each.
 * Resets shutdown_clean=false after recovery (so next startup knows to check).
 */

import type { Database } from "../../utils/db.js";
import type { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import type { AgentRegistry } from "../agent-registry.js";
import { createLogger, type Logger } from "../../core/logger.js";
import type { RecoveryResult } from "../checkpoint/checkpoint-manager.js";


export interface RecoveryReport {
  shutdown_was_clean: boolean;
  agents_recovered: number;
  results: RecoveryResult[];
  timestamp: string;
}


export class StartupRecoveryManager {
  constructor(
    private readonly db: Database,
    private readonly checkpointManager: CheckpointManager,
    private readonly registry: AgentRegistry,
    private readonly logger: Logger = createLogger("startup-recovery"),
  ) {}

  /**
   * Run startup recovery.
   *
   * 1. Read system_state.shutdown_clean.
   * 2. If "true" → clean shutdown, no recovery needed.
   * 3. If "false" or missing → unclean; query agents in active/processing state.
   * 4. Run checkpointManager.recover() for each.
   * 5. Set shutdown_clean=false (reset for current session).
   * 6. Return RecoveryReport.
   */
  recover(): RecoveryReport {
    const timestamp = new Date().toISOString();

    // Update last_startup timestamp
    this._setSystemState("last_startup", timestamp);

    const shutdownClean = this._readSystemState("shutdown_clean");
    const wasClean = shutdownClean === "true";

    if (wasClean) {
      this.logger.info("clean_startup", "Clean startup — no recovery needed");
      // Reset for current session (session is now running, mark unclean until shutdown)
      this._setSystemState("shutdown_clean", "false");
      return {
        shutdown_was_clean: true,
        agents_recovered: 0,
        results: [],
        timestamp,
      };
    }

    this.logger.warn("unclean_shutdown_detected", "Unclean shutdown detected — running recovery");

    // Query agents that were not in a terminal state (stopped/error/deleted).
    // This catches 'active', 'processing', 'starting', 'idle', and 'stopping'
    // — any non-terminal status that could leave data in an inconsistent state.
    const rows = this.db.prepare<[], { id: string }>(`
      SELECT id FROM agent_definitions
      WHERE status NOT IN ('stopped', 'error', 'deleted')
    `).all() as { id: string }[];

    const results: RecoveryResult[] = [];
    for (const row of rows) {
      this.logger.info("recovering_agent", "Recovering agent", { metadata: { agent_id: row.id } });
      const result = this.checkpointManager.recover(row.id);
      results.push(result);
    }

    this.logger.info("recovery_complete", "Recovery complete", { metadata: { agents_recovered: results.length } });

    // Mark current session as unclean until we get a clean shutdown
    this._setSystemState("shutdown_clean", "false");

    return {
      shutdown_was_clean: false,
      agents_recovered: results.length,
      results,
      timestamp,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _readSystemState(key: string): string | null {
    const row = this.db.prepare<[string], { value: string }>(
      "SELECT value FROM system_state WHERE key = ?",
    ).get(key);
    return row?.value ?? null;
  }

  private _setSystemState(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db.prepare<[string, string, string], void>(`
      INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now);
  }
}
