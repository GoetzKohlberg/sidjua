// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5c: WAL Manager
 *
 * Manages the agent_wal table: append, query, truncate, and verify
 * write-ahead log entries. Each entry is tamper-evident via SHA-256 checksum.
 */

import { createHmac } from "node:crypto";
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


/**
 * The HMAC key for WAL entry integrity.
 * Read from SIDJUA_WAL_HMAC_KEY environment variable. When present, new entries
 * use HMAC-SHA256 (more tamper-evident than plain SHA-256). When absent, falls
 * back to legacy SHA-256 for backward compatibility with existing entries.
 *
 * The prefix "$hmac$" in the checksum column distinguishes HMAC entries from
 * legacy SHA-256 entries, enabling seamless migration.
 */
const WAL_HMAC_PREFIX = "$hmac$";

/** Minimum required length for the HMAC key (32 bytes = 256-bit). */
const WAL_HMAC_MIN_KEY_BYTES = 32;

function getWalHmacKey(): string | undefined {
  return process.env["SIDJUA_WAL_HMAC_KEY"];
}

/** Suppress duplicate "HMAC key not set" log entries within a single process run. */
let _hmacFallbackWarned = false;

/**
 * Validate WAL HMAC key configuration at startup.
 *
 * - Production (NODE_ENV=production): throws if key is absent or too short.
 *   Silent SHA-256 fallback is not permitted in production — it is not
 *   tamper-proof and would allow WAL entries to be silently forged.
 * - Development / test: logs a one-time warning and continues.
 *
 * Call once during application startup (e.g. in cli-server.ts).
 */
export function assertWalHmacKeyConfigured(): void {
  const key = getWalHmacKey();
  const isProduction = process.env["NODE_ENV"] === "production";

  if (key === undefined || key === "") {
    if (isProduction) {
      throw new Error(
        "WAL integrity error: SIDJUA_WAL_HMAC_KEY must be set in production. " +
        "Without it WAL entries are signed with plain SHA-256, which is not tamper-proof. " +
        "Generate a key with: openssl rand -hex 32",
      );
    }
    if (!_hmacFallbackWarned) {
      _hmacFallbackWarned = true;
      _walLogger.warn(
        "wal_hmac_fallback",
        "SIDJUA_WAL_HMAC_KEY not configured — using SHA-256 fallback (not tamper-proof). " +
        "Set SIDJUA_WAL_HMAC_KEY in production.",
      );
    }
    return;
  }

  const keyBytes = Buffer.byteLength(key, "utf-8");
  if (keyBytes < WAL_HMAC_MIN_KEY_BYTES) {
    throw new Error(
      `SIDJUA_WAL_HMAC_KEY is too short (${keyBytes} bytes; minimum ${WAL_HMAC_MIN_KEY_BYTES}). ` +
      "Generate a secure key with: openssl rand -hex 32",
    );
  }
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
    return this._verifyChecksum(
      entry.sequence,
      entry.agent_id,
      entry.timestamp,
      entry.operation,
      entry.data_json,
      entry.checksum,
    );
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
    const payload = `${seq}:${agentId}:${timestamp}:${operation}:${dataJson}`;
    const hmacKey = getWalHmacKey();
    if (hmacKey !== undefined && hmacKey !== "") {
      const mac = createHmac("sha256", hmacKey).update(payload).digest("hex");
      return `${WAL_HMAC_PREFIX}${mac}`;
    }
    if (!_hmacFallbackWarned) {
      _hmacFallbackWarned = true;
      _walLogger.warn(
        "wal_hmac_fallback",
        "SIDJUA_WAL_HMAC_KEY not configured — using SHA-256 fallback (not tamper-proof).",
      );
    }
    return sha256hex(payload);
  }

  /** Verify a single WAL entry checksum. Handles both HMAC and legacy SHA-256. */
  private _verifyChecksum(
    seq: number,
    agentId: string,
    timestamp: string,
    operation: string,
    dataJson: string,
    stored: string,
  ): boolean {
    const payload = `${seq}:${agentId}:${timestamp}:${operation}:${dataJson}`;
    if (stored.startsWith(WAL_HMAC_PREFIX)) {
      const hmacKey = getWalHmacKey();
      if (hmacKey === undefined || hmacKey === "") {
        // HMAC entry but no key configured — cannot verify; treat as mismatch.
        return false;
      }
      const expected = `${WAL_HMAC_PREFIX}${createHmac("sha256", hmacKey).update(payload).digest("hex")}`;
      return expected === stored;
    }
    // Legacy SHA-256 entry
    return sha256hex(payload) === stored;
  }
}
