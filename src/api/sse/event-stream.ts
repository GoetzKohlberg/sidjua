// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11c: SSE Event Stream Manager
 *
 * Manages the set of connected SSE clients and routes broadcast events to
 * matching clients. Also provides EventPoller which periodically reads new
 * task_events rows and feeds them into the manager.
 *
 * Memory exhaustion via unbounded SSE connections.
 *   Previously any authenticated caller could open unlimited SSE streams.
 *   Fixed: MAX_CLIENTS=100 hard cap; addClient() returns false when full
 *   (caller should return 503). Cleanup sweep every 30 s removes clients
 *   whose SSEWritable is closed without removeClient() being called.
 *
 * Design notes:
 *  - SSEWritable is a minimal interface over Hono's SSEStreamingApi so that
 *    tests can inject simple mock writables.
 *  - broadcast() ignores write errors (closed streams are cleaned up by the
 *    keep-alive ping loop in the route handler).
 */

import type Database from "better-sqlite3";
import { createLogger } from "../../core/logger.js";
import { matchesFilters, type SSEEvent, type SSEClientFilters } from "./event-filter.js";
import { getReplaySince } from "./event-replay.js";
import { SseEventBuffer, DEFAULT_BUFFER_SIZE } from "./event-buffer.js";

const logger = createLogger("api-sse");


export const SSE_LIMITS = {
  /** Maximum number of concurrent SSE connections. Excess connections get 503. */
  MAX_CLIENTS: 100,
  /**
   * How often to sweep for stale closed streams (ms).
   * Also proactively disconnects clients exceeding the high-water mark
   * or whose writes haven't drained within WRITE_TIMEOUT_MS.
   */
  CLEANUP_INTERVAL_MS: 10_000,
  /**
   * Maximum pending (unacknowledged) bytes per SSE client.
   * Clients that accumulate more than this are considered slow and are
   * disconnected to prevent server-side buffer bloat.
   */
  HIGH_WATER_MARK_BYTES: 64 * 1024, // 64 KiB
  /**
   * Maximum time (ms) a write may remain unacknowledged before the client
   * is disconnected. Prevents a single stalled client from holding onto
   * server-side buffers indefinitely between broadcasts.
   */
  WRITE_TIMEOUT_MS: 30_000,
  /** Max SSE connection attempts per IP in the rate window. */
  IP_RATE_LIMIT: 5,
  /** Rate window for per-IP connection attempts (ms). */
  IP_RATE_WINDOW_MS: 60_000,
} as const;

// ---------------------------------------------------------------------------
// IP-based SSE connection rate limiting
// Prevents a single IP from exhausting the MAX_CLIENTS pool even with valid
// tickets — limits to IP_RATE_LIMIT connection attempts per IP_RATE_WINDOW_MS.
// ---------------------------------------------------------------------------

/** Timestamps of recent SSE connection attempts per IP address. */
const _ipConnectAttempts = new Map<string, number[]>();

/** Exported for test cleanup only. */
export function clearSseIpRateLimitState(): void {
  _ipConnectAttempts.clear();
}

/**
 * Check and record an SSE connection attempt from the given IP.
 *
 * Returns true if the attempt is within limits, false if rate-limited.
 * The attempt is always recorded (even when returning false) so that
 * burst attempts do not reset the window.
 */
export function checkAndRecordSseIpAttempt(ip: string): boolean {
  const now    = Date.now();
  const cutoff = now - SSE_LIMITS.IP_RATE_WINDOW_MS;
  const prev   = (_ipConnectAttempts.get(ip) ?? []).filter((t) => t > cutoff);
  prev.push(now);
  _ipConnectAttempts.set(ip, prev);
  return prev.length <= SSE_LIMITS.IP_RATE_LIMIT;
}

// ---------------------------------------------------------------------------
// SSE writable abstraction (implemented by Hono's SSEStreamingApi in prod,
// and by simple mock objects in tests)
// ---------------------------------------------------------------------------

export interface SSEWritable {
  writeSSE(message: { id?: string; event?: string; data: string }): Promise<void>;
  write(data: string): Promise<unknown>;
  readonly closed: boolean;
  close(): Promise<void>;
  sleep(ms: number): Promise<unknown>;
  abort(): void;
}


export interface SSEClient {
  id: string;
  stream: SSEWritable;
  filters: SSEClientFilters;
  connectedAt: string;
  /** Rowid of the last event seen by the client (for reconnection replay). */
  lastEventId: number;
  /** Bytes of serialised SSE data currently buffered but not yet acknowledged. */
  pendingBytes: number;
  /**
   * Timestamp (ms since epoch) when pendingBytes was last incremented.
   * Zero means no bytes are outstanding. Used by the periodic sweep to detect
   * writes that stall for longer than WRITE_TIMEOUT_MS.
   */
  lastBytesAddedAt: number;
}


/**
 * Manages connected SSE clients and routes broadcast events.
 *
 * AddClient() now returns boolean — false means the server is at
 * MAX_CLIENTS capacity and the caller must return HTTP 503 to the client.
 * A cleanup sweep runs every CLEANUP_INTERVAL_MS to evict streams that were
 * closed without removeClient() being called.
 */
export class EventStreamManager {
  private readonly clients = new Map<string, SSEClient>();
  private _cleanupInterval: ReturnType<typeof setInterval> | null = null;
  /** In-memory buffer of the last N broadcast events for fast reconnection replay. */
  readonly buffer: SseEventBuffer;

  constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
    this.buffer = new SseEventBuffer(bufferSize);
    this._cleanupInterval = setInterval(
      () => { this._sweepClosed(); },
      SSE_LIMITS.CLEANUP_INTERVAL_MS,
    );
    // Don't prevent process exit when this is the only active handle
    if (
      typeof this._cleanupInterval === "object" &&
      this._cleanupInterval !== null &&
      "unref" in this._cleanupInterval
    ) {
      (this._cleanupInterval as { unref(): void }).unref();
    }
  }

  /**
   * Register a newly connected SSE client.
   *
   * Returns false and logs a warning when MAX_CLIENTS is reached.
   * The caller (events.ts route) must respond 503 when false is returned.
   */
  addClient(client: SSEClient): boolean {
    if (this.clients.size >= SSE_LIMITS.MAX_CLIENTS) {
      logger.warn("sse_max_clients", "SSE max clients reached, rejecting new connection", {
        metadata: { current: this.clients.size, max: SSE_LIMITS.MAX_CLIENTS },
      });
      return false;
    }
    this.clients.set(client.id, client);
    logger.info("sse_client_connected", `SSE client ${client.id} connected`, {
      metadata: { clientId: client.id, filters: client.filters },
    });
    return true;
  }

  /** Deregister a disconnected client. No-op if not found. */
  removeClient(clientId: string): void {
    if (!this.clients.has(clientId)) return;
    this.clients.delete(clientId);
    logger.info("sse_client_disconnected", `SSE client ${clientId} disconnected`, {
      metadata: { clientId },
    });
  }

  /**
   * Broadcast an event to all clients whose filters match.
   *
   * Now async — uses Promise.allSettled so all writes are properly
   * tracked, and failed writes immediately remove the client from the Map
   * rather than relying on the keep-alive ping loop for cleanup.
   *
   * Slow clients that accumulate more than HIGH_WATER_MARK_BYTES of
   * unacknowledged data are disconnected before writing to prevent
   * server-side buffer bloat.
   *
   * @param event  The SSE event to broadcast
   */
  async broadcast(event: SSEEvent): Promise<void> {
    // Store in in-memory buffer for fast reconnection replay
    this.buffer.add(event);

    const serialised = JSON.stringify(event.data);
    const eventBytes = Buffer.byteLength(serialised, "utf8");

    const targets = [...this.clients.values()].filter((c) => {
      if (c.stream.closed) return false;

      // Disconnect slow clients that have exceeded the high-water mark.
      if (c.pendingBytes + eventBytes > SSE_LIMITS.HIGH_WATER_MARK_BYTES) {
        logger.warn("sse_client_slow", `SSE client ${c.id} exceeded high-water mark, disconnecting`, {
          metadata: { clientId: c.id, pendingBytes: c.pendingBytes, eventBytes },
        });
        void c.stream.close().catch(() => undefined);
        this.clients.delete(c.id);
        return false;
      }

      return matchesFilters(event, c.filters);
    });

    const writes = targets.map((client) => {
      client.pendingBytes += eventBytes;
      client.lastBytesAddedAt = Date.now();
      return client.stream
        .writeSSE({
          id:    String(event.id),
          event: event.type,
          data:  serialised,
        })
        .then(() => {
          client.pendingBytes = Math.max(0, client.pendingBytes - eventBytes);
          if (client.pendingBytes === 0) client.lastBytesAddedAt = 0;
        })
        .catch((err: unknown) => {
          // Write failed — client likely disconnected; remove immediately
          logger.debug("sse_client_write_failed", `SSE client ${client.id} write failed, removing`, {
            metadata: { clientId: client.id, error: String(err) },
          });
          this.clients.delete(client.id);
        });
    });

    await Promise.allSettled(writes);
  }

  /** Number of currently connected clients. */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Sweep for clients that are stale or consuming too much memory:
   *  1. Streams that were closed without removeClient() being called.
   *  2. Clients whose pendingBytes exceed HIGH_WATER_MARK_BYTES (slow consumers).
   *  3. Clients whose writes have not drained within WRITE_TIMEOUT_MS.
   *
   * Called automatically every CLEANUP_INTERVAL_MS so backpressure is
   * enforced even when no new events are being broadcast.
   */
  private _sweepClosed(): void {
    const now = Date.now();
    let swept = 0;

    for (const [id, client] of this.clients) {
      if (client.stream.closed) {
        this.clients.delete(id);
        swept++;
        continue;
      }

      // Proactively disconnect clients that have exceeded the high-water mark
      // without receiving a new broadcast (the broadcast() check would have
      // caught it on the next event; this sweep catches idle slow clients).
      if (client.pendingBytes > SSE_LIMITS.HIGH_WATER_MARK_BYTES) {
        logger.warn("sse_client_backpressure", "SSE client disconnected: backpressure exceeded", {
          metadata: { clientId: id, pendingBytes: client.pendingBytes, limitBytes: SSE_LIMITS.HIGH_WATER_MARK_BYTES },
        });
        void client.stream.close().catch(() => undefined);
        this.clients.delete(id);
        swept++;
        continue;
      }

      // Disconnect clients whose writes have stalled beyond WRITE_TIMEOUT_MS
      if (
        client.pendingBytes > 0 &&
        client.lastBytesAddedAt > 0 &&
        now - client.lastBytesAddedAt > SSE_LIMITS.WRITE_TIMEOUT_MS
      ) {
        logger.warn("sse_client_write_timeout", "SSE client disconnected: write timeout exceeded", {
          metadata: {
            clientId:      id,
            pendingBytes:  client.pendingBytes,
            elapsedMs:     now - client.lastBytesAddedAt,
            timeoutMs:     SSE_LIMITS.WRITE_TIMEOUT_MS,
          },
        });
        void client.stream.close().catch(() => undefined);
        this.clients.delete(id);
        swept++;
      }
    }

    if (swept > 0) {
      logger.debug("sse_sweep_closed", `Swept ${swept} stale/slow SSE connections`, {
        metadata: { swept, remaining: this.clients.size },
      });
    }
  }

  /**
   * Graceful shutdown: send `event: close` to all clients then close streams.
   * Also clears the cleanup interval.
   */
  shutdown(): void {
    if (this._cleanupInterval !== null) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    for (const client of this.clients.values()) {
      void client.stream
        .writeSSE({
          event: "close",
          data:  JSON.stringify({ message: "Server shutting down" }),
        })
        .then(() => client.stream.close())
        .catch(() => undefined);
    }
    this.clients.clear();
  }
}


type Db = InstanceType<typeof Database>;

/**
 * Polls the task_events table at a configurable interval and broadcasts
 * new events to all connected SSE clients.
 *
 * Used when no IPC notification from the orchestrator is available.
 */
export class EventPoller {
  private _timer:    ReturnType<typeof setInterval> | null = null;
  private _lastId = 0;

  constructor(
    private readonly db:          Db,
    private readonly manager:     EventStreamManager,
    private readonly intervalMs:  number = 500,
  ) {}

  /** Start polling from the given rowid (0 = from now). */
  start(fromRowid = 0): void {
    if (this._timer !== null) return; // already running
    this._lastId = fromRowid;
    this._timer = setInterval(() => { this._poll(); }, this.intervalMs);
  }

  /** Stop polling. */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private _poll(): void {
    const events = getReplaySince(this.db, this._lastId, 100, null);
    for (const event of events) {
      if (event.id > this._lastId) {
        this._lastId = event.id;
      }
      // broadcast() is async; fire without await since setInterval can't await.
      // Promise rejections are handled inside broadcast() via Promise.allSettled.
      void this.manager.broadcast(event);
    }
  }
}
