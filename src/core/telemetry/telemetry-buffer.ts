// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA Error Telemetry — Local SQLite Buffer
 *
 * Events are stored locally FIRST (source of truth), then sent to the remote
 * endpoint. If the network is unavailable, events stay pending and retry later.
 *
 * Memory exhaustion via fingerprint flooding.
 *   Previously store() wrote to SQLite on every call with no in-memory gate.
 *   An attacker (or a bug storm) generating many unhandledRejection events
 *   could execute thousands of SQL transactions per second even though the
 *   SQLite buffer is capped at BUFFER_CAP rows.
 *
 *   Fixed: an in-memory rate-limit layer sits in front of the SQLite write:
 *     - MAX_EVENTS_PER_FINGERPRINT: max events per unique fingerprint per window
 *     - MAX_UNIQUE_FINGERPRINTS: max distinct fingerprints tracked per window
 *   Both limits use a per-fingerprint sliding window of RATE_LIMIT_WINDOW_MS.
 *   store() now returns boolean: true = stored, false = rate-limited/dropped.
 */

import { join }         from "node:path";
import { openDatabase } from "../../utils/db.js";
import type { Database } from "../../utils/db.js";
import type { TelemetryEvent, StoredEvent } from "./telemetry-types.js";
import { BoundedMap } from "../../utils/bounded-map.js";


const MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS telemetry_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT    NOT NULL,
    event_json  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    sent_at     TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending'
  );

  CREATE INDEX IF NOT EXISTS idx_telemetry_status
    ON telemetry_events(status);

  CREATE INDEX IF NOT EXISTS idx_telemetry_fingerprint
    ON telemetry_events(fingerprint);
`;

const BUFFER_CAP = 100; // max pending events in SQLite


/**
 * In-memory rate-limit constants for the telemetry buffer.
 * These are process-local guards that prevent SQLite from being hammered.
 */
export const TELEMETRY_RATE_LIMITS = {
  /**
   * Sliding window length for rate-limit state (ms).
   * After this window, per-fingerprint counters reset.
   */
  RATE_LIMIT_WINDOW_MS: 60_000,

  /**
   * Maximum events stored per unique fingerprint per window.
   * Prevents a single recurring error from filling the buffer.
   */
  MAX_EVENTS_PER_FINGERPRINT: 5,

  /**
   * Maximum distinct fingerprints tracked in the in-memory rate-limit Map.
   * Aligned with BUFFER_CAP so the in-memory guard and the SQLite cap are
   * consistent. When this limit is reached, the oldest fingerprint entry is
   * evicted (FIFO) to make room for incoming unique errors — this prevents
   * the Map from growing without bound while still accepting new unique errors.
   */
  MAX_UNIQUE_FINGERPRINTS: 100,
} as const;


interface FingerprintRateState {
  count:       number;
  windowStart: number;
}

/**
 * Per-fingerprint event counters within the current rate-limit window.
 * Bounded to MAX_UNIQUE_FINGERPRINTS with LRU eviction: recently-seen
 * fingerprints are retained while stale ones are evicted first.
 */
const _fingerprintRateState = new BoundedMap<string, FingerprintRateState>(
  TELEMETRY_RATE_LIMITS.MAX_UNIQUE_FINGERPRINTS,
);

/** Interval for sweeping stale fingerprint entries (ms). */
const FINGERPRINT_CLEANUP_INTERVAL_MS = 60_000;

/** Maximum age for a fingerprint entry before it is evicted (ms). */
const FINGERPRINT_MAX_AGE_MS = 5 * 60_000; // 5 minutes

/**
 * Evict fingerprint rate-state entries that have not seen an event for
 * FINGERPRINT_MAX_AGE_MS.  Prevents unbounded Map growth under a slow,
 * sustained stream of unique error types.
 */
function sweepStaleFingerprintEntries(): void {
  const now = Date.now();
  for (const [fp, state] of _fingerprintRateState) {
    if (now - state.windowStart > FINGERPRINT_MAX_AGE_MS) {
      _fingerprintRateState.delete(fp);
    }
  }
}

// Start the cleanup sweep automatically.
const _fingerprintCleanupTimer = setInterval(
  sweepStaleFingerprintEntries,
  FINGERPRINT_CLEANUP_INTERVAL_MS,
);
// Don't hold the process open if this is the only remaining handle.
if (typeof _fingerprintCleanupTimer === "object" && _fingerprintCleanupTimer !== null && "unref" in _fingerprintCleanupTimer) {
  (_fingerprintCleanupTimer as { unref(): void }).unref();
}

/**
 * Reset all in-memory rate-limit state.
 * Call in test beforeEach to prevent cross-test pollution.
 */
export function resetTelemetryRateLimit(): void {
  _fingerprintRateState.clear();
}

/** Stop the telemetry fingerprint cleanup timer. Call during shutdown to clear the timer. */
export function stopTelemetryCleanup(): void {
  if (typeof _fingerprintCleanupTimer === "object" && _fingerprintCleanupTimer !== null) {
    clearInterval(_fingerprintCleanupTimer as ReturnType<typeof setInterval>);
  }
}

/**
 * Check and update the in-memory rate limit for a fingerprint.
 * Returns true if the event should be accepted; false if it should be dropped.
 *
 * Side-effect: updates (or creates) the fingerprint's rate state.
 */
function checkRateLimit(fingerprint: string): boolean {
  const now = Date.now();
  const { RATE_LIMIT_WINDOW_MS, MAX_EVENTS_PER_FINGERPRINT } = TELEMETRY_RATE_LIMITS;

  const existing = _fingerprintRateState.get(fingerprint);

  if (existing !== undefined) {
    // Check if window has expired — if so, reset counter
    if (now - existing.windowStart >= RATE_LIMIT_WINDOW_MS) {
      existing.count       = 1;
      existing.windowStart = now;
      return true;
    }
    // Within window: enforce per-fingerprint rate limit
    if (existing.count >= MAX_EVENTS_PER_FINGERPRINT) {
      return false;
    }
    existing.count++;
    return true;
  }

  // New fingerprint — BoundedMap evicts the least-recently-used entry when at capacity.
  _fingerprintRateState.set(fingerprint, { count: 1, windowStart: now });
  return true;
}


export class TelemetryBuffer {
  private db: Database;

  constructor(workDir: string) {
    const dbPath = join(workDir, ".system", "telemetry.db");
    this.db = openDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(MIGRATIONS);
  }

  // ---------------------------------------------------------------------------
  // store
  // ---------------------------------------------------------------------------

  /**
   * Save a telemetry event to the local buffer.
   *
   * Checks the in-memory rate limit FIRST — returns false immediately if
   * the fingerprint is flooding (skips the SQLite transaction entirely).
   *
   * If the SQLite buffer is at capacity (BUFFER_CAP pending), drops the oldest
   * pending event to make room for the new one.
   *
   * @returns true if stored, false if dropped by rate-limit or internal error
   */
  store(event: TelemetryEvent): boolean {
    // In-memory gate — no SQLite I/O on rate-limited events
    if (!checkRateLimit(event.fingerprint)) {
      return false;
    }

    const now = new Date().toISOString();

    this.db.transaction(() => {
      // Enforce cap: drop oldest pending if at limit
      const pendingCount = (this.db.prepare<[], { count: number }>(
        "SELECT COUNT(*) as count FROM telemetry_events WHERE status = 'pending'",
      ).get()?.count ?? 0);

      if (pendingCount >= BUFFER_CAP) {
        const oldest = this.db.prepare<[], { id: number }>(
          "SELECT id FROM telemetry_events WHERE status = 'pending' ORDER BY id ASC LIMIT 1",
        ).get();
        if (oldest !== undefined) {
          this.db.prepare<[number], void>(
            "DELETE FROM telemetry_events WHERE id = ?",
          ).run(oldest.id);
        }
      }

      this.db.prepare<[string, string, string], void>(
        "INSERT INTO telemetry_events (fingerprint, event_json, created_at) VALUES (?, ?, ?)",
      ).run(event.fingerprint, JSON.stringify(event), now);
    })();

    return true;
  }

  // ---------------------------------------------------------------------------
  // getPending
  // ---------------------------------------------------------------------------

  getPending(limit = 100): StoredEvent[] {
    const rows = this.db.prepare<[number], {
      id: number; fingerprint: string; event_json: string;
      created_at: string; sent_at: string | null; status: string;
    }>(
      "SELECT id, fingerprint, event_json, created_at, sent_at, status " +
      "FROM telemetry_events WHERE status = 'pending' ORDER BY id ASC LIMIT ?",
    ).all(limit);

    return rows.map((row) => ({
      id:          row.id,
      fingerprint: row.fingerprint,
      event:       JSON.parse(row.event_json) as TelemetryEvent,
      createdAt:   row.created_at,
      sentAt:      row.sent_at,
      status:      row.status as StoredEvent['status'],
    }));
  }

  // ---------------------------------------------------------------------------
  // markSent / markFailed
  // ---------------------------------------------------------------------------

  markSent(ids: number[]): void {
    if (ids.length === 0) return;
    const sentAt = new Date().toISOString();
    const stmt = this.db.prepare<[string, number], void>(
      "UPDATE telemetry_events SET status = 'sent', sent_at = ? WHERE id = ?",
    );
    this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(sentAt, id);
      }
    })();
  }

  markFailed(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare<[number], void>(
      "UPDATE telemetry_events SET status = 'pending' WHERE id = ?",
    );
    this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(id);
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // prune
  // ---------------------------------------------------------------------------

  /**
   * Delete sent events older than 7 days.
   * Keep at most 100 pending events (enforced on insert, but also cleanup here).
   */
  prune(): void {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare<[string], void>(
      "DELETE FROM telemetry_events WHERE status = 'sent' AND sent_at < ?",
    ).run(cutoff);
  }

  // ---------------------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------------------

  getStats(): { pending: number; sent: number; total: number } {
    const row = this.db.prepare<[], {
      pending: number; sent: number; total: number;
    }>(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'sent'    THEN 1 ELSE 0 END) AS sent,
         COUNT(*)                                             AS total
       FROM telemetry_events`,
    ).get();
    return {
      pending: row?.pending ?? 0,
      sent:    row?.sent    ?? 0,
      total:   row?.total   ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  clear(): void {
    this.db.prepare<[], void>("DELETE FROM telemetry_events").run();
  }

  // ---------------------------------------------------------------------------
  // close
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}


export function openTelemetryBuffer(workDir: string): TelemetryBuffer {
  return new TelemetryBuffer(workDir);
}
