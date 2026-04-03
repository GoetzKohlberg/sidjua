// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5c: WAL Manager
 *
 * Manages the agent_wal table: append, query, truncate, and verify
 * write-ahead log entries. Each entry is tamper-evident via SHA-256 checksum.
 */

import { sha256hex } from "../../core/crypto-utils.js";
import type { Database } from "../../utils/db.js";
import { createLogger } from "../../core/logger.js";

const _walLogger = createLogger("wal-manager");
import { SidjuaError } from "../../core/error-codes.js";


/** Maximum WAL entries returned in a single getWALSince() query.
 *  Prevents unbounded memory consumption if the WAL is flooded (attack or bug).
 *  Callers that need more should call again with the last returned sequence number. */
export const WAL_QUERY_LIMIT = 10_000;


export interface WALEntry {
  sequence: number;
  agent_id: string;
  timestamp: string;
  operation: string;
  data_json: string;
  checksum: string;
}

export interface AppendWALInput {
  agent_id: string;
  operation: string;
  /** Already-stringified JSON or raw object (will be JSON.stringify'd if object). */
  data: string | Record<string, unknown>;
}


export class WALManager {
  constructor(private readonly db: Database) {}

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Append a new entry to the WAL.
   * @returns The auto-assigned sequence number.
   */
  appendWAL(input: AppendWALInput): number {
    const timestamp = new Date().toISOString();
    const dataJson = typeof input.data === "string"
      ? input.data
      : JSON.stringify(input.data);

    // The two-step INSERT → UPDATE (to incorporate the auto-assigned sequence into the
    // checksum) must be atomic: wrap in a transaction so no reader can observe an entry
    // with an empty checksum between the insert and the update.
    let seq!: number;
    this.db.transaction(() => {
      this.db.prepare<[string, string, string, string], void>(`
        INSERT INTO agent_wal (agent_id, timestamp, operation, data_json, checksum)
        VALUES (?, ?, ?, ?, '')
      `).run(input.agent_id, timestamp, input.operation, dataJson);

      seq = (this.db.prepare<[], { seq: number }>(
        "SELECT last_insert_rowid() AS seq",
      ).get() as { seq: number }).seq;

      const checksum = this._computeChecksum(seq, input.agent_id, timestamp, input.operation, dataJson);

      this.db.prepare<[string, number], void>(
        "UPDATE agent_wal SET checksum = ? WHERE sequence = ?",
      ).run(checksum, seq);
    })();

    return seq;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Retrieve WAL entries for an agent after (exclusive) the given sequence.
   *
   * At most `limit` entries are returned (default: WAL_QUERY_LIMIT = 10,000) to
   * prevent unbounded memory consumption. If exactly `limit` entries are returned,
   * callers should call again with the last returned sequence number to page through
   * the remaining entries.
   *
   * Each entry's SHA-256 checksum is verified before it is returned.
   * A checksum mismatch indicates tampering or corruption — agent execution is
   * halted immediately by throwing SidjuaError WAL-001. Callers must not
   * catch this silently; recovery requires human intervention.
   */
  getWALSince(agentId: string, sequence: number, limit: number = WAL_QUERY_LIMIT): WALEntry[] {
    const rows = this.db.prepare<[string, number, number], WALEntry>(`
      SELECT sequence, agent_id, timestamp, operation, data_json, checksum
      FROM agent_wal
      WHERE agent_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(agentId, sequence, limit) as WALEntry[];

    for (const entry of rows) {
      if (!this.verifyEntry(entry)) {
        _walLogger.error("wal_checksum_mismatch", "WAL checksum mismatch — halting agent execution", {
          metadata: { agent_id: agentId, sequence: String(entry.sequence) },
        });
        throw SidjuaError.from(
          "WAL-001",
          `WAL integrity violation for agent ${agentId} at sequence ${entry.sequence} — agent execution halted`,
        );
      }
    }

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /**
   * Delete all WAL entries for an agent strictly before the given sequence.
   * Called after a checkpoint is written to keep the WAL lean.
   */
  truncateWAL(agentId: string, beforeSequence: number): void {
    this.db.prepare<[string, number], void>(`
      DELETE FROM agent_wal WHERE agent_id = ? AND sequence < ?
    `).run(agentId, beforeSequence);
  }

  // ---------------------------------------------------------------------------
  // Integrity
  // ---------------------------------------------------------------------------

  /**
   * Recompute the checksum for an entry and compare with stored value.
   * Returns true if the entry is unmodified.
   */
  verifyEntry(entry: WALEntry): boolean {
    const expected = this._computeChecksum(
      entry.sequence,
      entry.agent_id,
      entry.timestamp,
      entry.operation,
      entry.data_json,
    );
    return expected === entry.checksum;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _computeChecksum(
    seq: number,
    agentId: string,
    timestamp: string,
    operation: string,
    dataJson: string,
  ): string {
    return sha256hex(`${seq}:${agentId}:${timestamp}:${operation}:${dataJson}`);
  }
}
