// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11a: Rate Limiter Middleware
 *
 * Token bucket algorithm, in-memory only (no Redis dependency).
 * Keyed by API key from Authorization header (falls back to IP).
 *
 * Cleans up expired buckets every 60 seconds to prevent memory leaks.
 */

import type { MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { createLogger } from "../../core/logger.js";
import { REQUEST_ID_KEY } from "./request-logger.js";
import type { Database } from "better-sqlite3";

const logger = createLogger("api-server");


export interface RateLimitConfig {
  enabled:      boolean;
  window_ms:    number;  // sliding window length in ms
  max_requests: number;  // max requests per window
  burst_max:    number;  // extra burst allowance (tokens above max)
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled:      true,
  window_ms:    60_000,
  max_requests: 100,
  burst_max:    20,
};

/**
 * Tighter rate-limit config for auth endpoints (login, setup, password change).
 * 10 attempts per 15-minute window per IP, no burst allowance.
 * Keyed by IP only (no auth header — callers are pre-authentication).
 */
export const AUTH_RATE_LIMIT: RateLimitConfig = {
  enabled:      true,
  window_ms:    15 * 60_000, // 15 minutes
  max_requests: 10,
  burst_max:    0,
};

interface Bucket {
  tokens:        number;
  last_refill_ms: number;
  window_start:  number;
  window_count:  number;
  lastAccess:    number;
}


/** Hard cap on number of tracked clients — prevents unbounded growth under DDoS. */
const MAX_BUCKETS = 10_000;

/** Encapsulated rate-limit state — single binding prevents accidental rebinding. */
const rateLimitState = {
  /** Cleanup interval in ms (default 60s). Configurable for tests via setCleanupInterval(). */
  cleanupIntervalMs: 60_000,
  buckets:           new Map<string, Bucket>(),
  cleanupTimer:      null as ReturnType<typeof setInterval> | null,
};

/**
 * Insert or refresh a bucket, using TTL-based eviction then O(1) LRU when at capacity.
 * Map insertion order is the LRU order — re-inserting an existing key moves it to the end.
 * Bounds the Map size to MAX_BUCKETS even under high IP churn.
 */
function setBucket(key: string, bucket: Bucket): void {
  // Refresh existing key's LRU position by deleting and re-inserting (moves to end).
  if (rateLimitState.buckets.has(key)) {
    rateLimitState.buckets.delete(key);
    rateLimitState.buckets.set(key, bucket);
    return;
  }
  if (rateLimitState.buckets.size >= MAX_BUCKETS) {
    const TTL_MS = 60_000;
    const now = performance.now();
    // First: evict stale entries (TTL expired)
    for (const [k, b] of rateLimitState.buckets) {
      if (now - b.lastAccess > TTL_MS) {
        rateLimitState.buckets.delete(k);
        if (rateLimitState.buckets.size < MAX_BUCKETS) break;
      }
    }
    // Still at capacity: evict the oldest entry (front of insertion-ordered Map) — O(1)
    if (rateLimitState.buckets.size >= MAX_BUCKETS) {
      const lruKey = rateLimitState.buckets.keys().next().value as string | undefined;
      if (lruKey !== undefined) rateLimitState.buckets.delete(lruKey);
    }
  }
  rateLimitState.buckets.set(key, bucket);
}

function startCleanup(window_ms: number): void {
  if (rateLimitState.cleanupTimer !== null) return;
  rateLimitState.cleanupTimer = setInterval(() => {
    const cutoff = performance.now() - window_ms * 2;
    for (const [key, bucket] of rateLimitState.buckets) {
      if (bucket.last_refill_ms < cutoff) {
        rateLimitState.buckets.delete(key);
      }
    }
  }, rateLimitState.cleanupIntervalMs);
  // Don't prevent process exit
  if (rateLimitState.cleanupTimer.unref) rateLimitState.cleanupTimer.unref();
}

/** Reset for tests */
export function clearRateLimitState(): void {
  rateLimitState.buckets.clear();
}


/** DDL for the rate_limiter_state table. */
function ensureRateLimiterTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limiter_state (
      key         TEXT PRIMARY KEY,
      tokens      REAL NOT NULL,
      last_refill TEXT NOT NULL
    )
  `);
}

/**
 * Persist all in-memory rate-limiter buckets to SQLite.
 * Wrapped in a transaction for performance. Never throws.
 */
export function persistRateLimiterState(db: Database): void {
  try {
    ensureRateLimiterTable(db);
    const upsert = db.prepare<[string, number, string], void>(
      "INSERT OR REPLACE INTO rate_limiter_state (key, tokens, last_refill) VALUES (?, ?, ?)",
    );
    const persist = db.transaction(() => {
      for (const [key, bucket] of rateLimitState.buckets) {
        upsert.run(key, bucket.tokens, new Date(bucket.last_refill_ms).toISOString());
      }
    });
    persist();
  } catch (e: unknown) {
    logger.warn("api-server", "Rate limiter state persist failed — non-fatal", {
      metadata: { error: e instanceof Error ? e.message : String(e) },
    });
  }
}

/**
 * Restore rate-limiter buckets from SQLite.
 * Entries older than 2× the cleanup interval are considered stale and skipped.
 * Returns number of buckets restored.
 */
export function restoreRateLimiterState(db: Database): number {
  try {
    ensureRateLimiterTable(db);
    const staleThresholdMs = rateLimitState.cleanupIntervalMs * 2;
    const cutoffDate = new Date(new Date().getTime() - staleThresholdMs).toISOString();
    const rows = db.prepare<[string], { key: string; tokens: number; last_refill: string }>(
      "SELECT key, tokens, last_refill FROM rate_limiter_state WHERE last_refill > ?",
    ).all(cutoffDate);

    const now = performance.now();
    for (const row of rows) {
      const bucket: Bucket = {
        tokens:        row.tokens,
        last_refill_ms: now,
        window_start:  now,
        window_count:  0,
        lastAccess:    now,
      };
      rateLimitState.buckets.set(row.key, bucket);
    }
    return rows.length;
  } catch (e: unknown) {
    logger.warn("api-server", "Rate limiter state restore failed — starting fresh", {
      metadata: { error: e instanceof Error ? e.message : String(e) },
    });
    return 0;
  }
}

/**
 * Override the cleanup interval (used in tests to speed up expiry checks).
 * Must be called before the first rateLimiter() middleware creation.
 *
 * @param ms - Cleanup interval in milliseconds
 */
export function setCleanupInterval(ms: number): void {
  rateLimitState.cleanupIntervalMs = ms;
  // Reset timer so it picks up the new interval next time startCleanup() is called
  if (rateLimitState.cleanupTimer !== null) {
    clearInterval(rateLimitState.cleanupTimer);
    rateLimitState.cleanupTimer = null;
  }
}


/**
 * Compute a stable, collision-resistant bucket ID from the client IP and
 * Authorization header. Uses a 16-char hex prefix of SHA-256 of the full
 * header value to prevent prefix-collision attacks where different API keys
 * with the same first N characters would share a rate-limit bucket.
 */
function computeBucketId(ip: string, authHeader: string | undefined): string {
  if (!authHeader) return `ip:${ip}`;
  const authHash = createHash("sha256").update(authHeader).digest("hex").slice(0, 16);
  return `ip:${ip}:key:${authHash}`;
}

/**
 * Return the effective client IP address for rate-limiting purposes.
 *
 * When SIDJUA_TRUST_PROXY=true, the x-forwarded-for header is trusted (for
 * deployments behind a reverse proxy that sets it correctly).
 * Otherwise, x-sidjua-peer-address (set by server.ts from the TCP socket's
 * remoteAddress) is used — clients cannot spoof this header.
 */
export function getClientIp(headers: {
  get(name: string): string | null | undefined;
}): string {
  if (process.env["SIDJUA_TRUST_PROXY"] === "true") {
    const xff = headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]?.trim() ?? "unknown";
    const realIp = headers.get("x-real-ip");
    if (realIp) return realIp;
  }
  const peerAddr = headers.get("x-sidjua-peer-address");
  if (peerAddr) return peerAddr;
  return "unknown";
}


/**
 * Create the rate limiting middleware.
 */
export const rateLimiter = (config: RateLimitConfig = DEFAULT_RATE_LIMIT): MiddlewareHandler =>
  async (c, next) => {

    if (!config.enabled) return next();

    startCleanup(config.window_ms);

    // Key: SHA-256 hash of the full Authorization header (prevents prefix collisions)
    // or fall back to IP address.
    const auth = c.req.header("Authorization");
    const clientKey = computeBucketId(
      getClientIp(c.req.raw.headers),
      auth,
    );

    const now = performance.now();
    let bucket = rateLimitState.buckets.get(clientKey);

    if (bucket === undefined) {
      bucket = {
        tokens:         config.max_requests + config.burst_max,
        last_refill_ms: now,
        window_start:   now,
        window_count:   0,
        lastAccess:     now,
      };
      // Use setBucket to enforce MAX_BUCKETS cap with LRU eviction
      setBucket(clientKey, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.last_refill_ms;
    const refill  = (elapsed / config.window_ms) * config.max_requests;
    bucket.tokens = Math.min(bucket.tokens + refill, config.max_requests + config.burst_max);
    bucket.last_refill_ms = now;

    if (bucket.tokens < 1) {
      const retryAfterSec = Math.ceil(config.window_ms / config.max_requests / 1000);
      const requestId = (c.get(REQUEST_ID_KEY) as string | undefined) ?? "unknown";

      logger.warn("rate_limit_exceeded", "Rate limit exceeded", {
        correlationId: requestId,
        metadata: { client_key: clientKey },
      });

      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        {
          error: {
            code:        "RATE-429",
            message:     "Too many requests",
            recoverable: true,
            suggestion:  `Retry after ${retryAfterSec} seconds`,
            request_id:  requestId,
          },
        },
        429,
      );
    }

    bucket.tokens -= 1;
    bucket.window_count += 1;
    bucket.lastAccess = now;
    // Refresh LRU position so recently-active clients are not evicted first.
    setBucket(clientKey, bucket);

    return next();
  };

/**
 * Rate-limiter middleware for authentication endpoints (login, setup, password change).
 *
 * Uses a separate `auth:` bucket namespace (IP-only key, no auth-header hash)
 * and the tighter AUTH_RATE_LIMIT defaults.
 * Intended as route-level middleware on /api/v1/auth/login, /setup, /settings/password.
 */
export const authRateLimiter = (config: RateLimitConfig = AUTH_RATE_LIMIT): MiddlewareHandler =>
  async (c, next) => {
    if (!config.enabled) return next();

    startCleanup(config.window_ms);

    // Auth endpoints: key by IP only — Authorization header absent pre-auth
    const clientKey = `auth:${getClientIp(c.req.raw.headers)}`;

    const now = performance.now();
    let bucket = rateLimitState.buckets.get(clientKey);

    if (bucket === undefined) {
      bucket = {
        tokens:         config.max_requests + config.burst_max,
        last_refill_ms: now,
        window_start:   now,
        window_count:   0,
        lastAccess:     now,
      };
      setBucket(clientKey, bucket);
    }

    const elapsed = now - bucket.last_refill_ms;
    const refill  = (elapsed / config.window_ms) * config.max_requests;
    bucket.tokens = Math.min(bucket.tokens + refill, config.max_requests + config.burst_max);
    bucket.last_refill_ms = now;

    if (bucket.tokens < 1) {
      const retryAfterSec = Math.ceil(config.window_ms / config.max_requests / 1000);
      const requestId     = (c.get(REQUEST_ID_KEY) as string | undefined) ?? "unknown";

      logger.warn("auth_rate_limit_exceeded", "Auth rate limit exceeded", {
        correlationId: requestId,
        metadata: { client_key: clientKey },
      });

      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        {
          error: {
            code:        "RATE-429",
            message:     "Too many authentication attempts. Try again later.",
            recoverable: true,
            suggestion:  `Retry after ${retryAfterSec} seconds`,
            request_id:  requestId,
          },
        },
        429,
      );
    }

    bucket.tokens -= 1;
    bucket.window_count += 1;
    bucket.lastAccess = now;
    setBucket(clientKey, bucket);

    return next();
  };
