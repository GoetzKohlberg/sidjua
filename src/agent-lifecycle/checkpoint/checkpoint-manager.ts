// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5c: CheckpointManager
 *
 * Manages agent_checkpoints and coordinates with WALManager.
 * Supports full_recovery (checkpoint + WAL replay), partial_recovery
 * (WAL only), and clean_start (no checkpoint exists).
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../../utils/db.js";
import { WALManager, type WALEntry, type AppendWALInput } from "./wal-manager.js";
import { createLogger, type Logger } from "../../core/logger.js";


export type CheckpointType = "periodic" | "shutdown" | "manual" | "pre_task" | "post_task";

export interface CheckpointRecord {
  id: string;
  agent_id: string;
  timestamp: string;
  type: CheckpointType;
  /** Parsed state object (from state_json column). */
  state: Record<string, unknown>;
  wal_sequence: number;
  created_at: string;
}

export interface CreateCheckpointInput {
  agent_id: string;
  type: CheckpointType;
  state?: Record<string, unknown>;
}

export type RecoveryMode = "full_recovery" | "partial_recovery" | "clean_start";

export interface RecoveryResult {
  mode: RecoveryMode;
  agent_id: string;
  checkpoint?: CheckpointRecord;
  wal_entries: WALEntry[];
}


export class CheckpointManager {
  private readonly walManager: WALManager;

  constructor(
    private readonly db: Database,
    walManager?: WALManager,
    private readonly logger: Logger = createLogger("checkpoint-manager"),
  ) {
    this.walManager = walManager ?? new WALManager(db);
  }

  // ---------------------------------------------------------------------------
  // Checkpoint operations
  // ---------------------------------------------------------------------------

  /**
   * Write a new checkpoint for an agent.
   * Truncates WAL entries before the new checkpoint's wal_sequence.
   * @returns The created CheckpointRecord.
   */
  createCheckpoint(input: CreateCheckpointInput): CheckpointRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const stateData = input.state ?? {};
    const stateJson = JSON.stringify(stateData);

    // Determine the latest WAL sequence to anchor this checkpoint.
    // Use 0 if no WAL entries exist yet.
    const latestSeqRow = this.db.prepare<[string], { seq: number | null }>(`
      SELECT MAX(sequence) AS seq FROM agent_wal WHERE agent_id = ?
    `).get(input.agent_id) as { seq: number | null };
    const walSequence = latestSeqRow.seq ?? 0;

    this.db.prepare<[string, string, string, string, string, number, string], void>(`
      INSERT INTO agent_checkpoints (id, agent_id, timestamp, type, state_json, wal_sequence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.agent_id, now, input.type, stateJson, walSequence, now);

    // Truncate WAL entries that are now captured by this checkpoint.
    // Pass walSequence + 1 so DELETE WHERE sequence < (walSequence+1) = sequence <= walSequence.
    this.walManager.truncateWAL(input.agent_id, walSequence + 1);

    this.logger.debug("checkpoint_created", "Checkpoint created", {
      metadata: {
        checkpoint_id: id,
        agent_id: input.agent_id,
        type: input.type,
        wal_sequence: walSequence,
      },
    });

    return {
      id,
      agent_id: input.agent_id,
      timestamp: now,
      type: input.type,
      state: stateData,
      wal_sequence: walSequence,
      created_at: now,
    };
  }

  /**
   * Retrieve the most recent checkpoint for an agent.
   * Returns undefined if none exists.
   */
  getLastCheckpoint(agentId: string): CheckpointRecord | undefined {
    const row = this.db.prepare<[string], {
      id: string;
      agent_id: string;
      timestamp: string;
      type: string;
      state_json: string;
      wal_sequence: number;
      created_at: string;
    }>(`
      SELECT id, agent_id, timestamp, type, state_json, wal_sequence, created_at
      FROM agent_checkpoints
      WHERE agent_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(agentId);

    if (row === undefined) return undefined;

    return {
      id: row.id,
      agent_id: row.agent_id,
      timestamp: row.timestamp,
      type: row.type as CheckpointType,
      state: JSON.parse(row.state_json) as Record<string, unknown>,
      wal_sequence: row.wal_sequence,
      created_at: row.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // WAL passthrough
  // ---------------------------------------------------------------------------

  /** Convenience: append a WAL entry via the underlying WALManager. */
  appendWAL(input: AppendWALInput): number {
    return this.walManager.appendWAL(input);
  }

  /** Retrieve WAL entries since a given sequence (delegates to WALManager). */
  getWALSince(agentId: string, sequence: number): WALEntry[] {
    return this.walManager.getWALSince(agentId, sequence);
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  /**
   * Determine the recovery path for an agent and return all data needed to
   * restore its state.
   *
   *  - full_recovery:  checkpoint exists + WAL entries after it
   *  - partial_recovery: WAL entries exist but no checkpoint (should be rare)
   *  - clean_start:    nothing exists; agent starts fresh
   */
  recover(agentId: string): RecoveryResult {
    const checkpoint = this.getLastCheckpoint(agentId);

    if (checkpoint !== undefined) {
      const walEntries = this.walManager.getWALSince(agentId, checkpoint.wal_sequence);
      this.logger.info("full_recovery_path", "Full recovery path", {
        metadata: { agent_id: agentId, checkpoint_id: checkpoint.id, wal_entries: walEntries.length },
      });
      return { mode: "full_recovery", agent_id: agentId, checkpoint, wal_entries: walEntries };
    }

    // No checkpoint — check for any WAL entries.
    const walEntries = this.walManager.getWALSince(agentId, 0);
    if (walEntries.length > 0) {
      this.logger.info("partial_recovery_path", "Partial recovery path (WAL only)", {
        metadata: { agent_id: agentId, wal_entries: walEntries.length },
      });
      return { mode: "partial_recovery", agent_id: agentId, wal_entries: walEntries };
    }

    this.logger.info("clean_start", "Clean start (no checkpoint or WAL)", {
      metadata: { agent_id: agentId },
    });
    return { mode: "clean_start", agent_id: agentId, wal_entries: [] };
  }
}
