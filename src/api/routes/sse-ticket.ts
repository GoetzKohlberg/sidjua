// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Short-Lived SSE Ticket System
 *
 * The SSE endpoint previously required the API key as a query parameter
 * (?token=<key>), which exposes the long-lived credential in server logs and
 * browser history.  This module provides a ticket exchange:
 *
 *   POST /api/v1/sse/ticket
 *     Authorization: Bearer <api-key>
 *   → { ticket: "<uuid>", expires_in: 30 }
 *
 *   GET /api/v1/events?ticket=<uuid>   (replaces ?token=<key>)
 *
 * Tickets are single-use, expire after TICKET_TTL_MS, and are stored in an
 * in-process Map (not persisted — lost on restart, which is acceptable for
 * short-lived event connections).
 */

import { randomUUID }       from "node:crypto";
import { Hono, type Context } from "hono";
import { createLogger }      from "../../core/logger.js";
import type { CallerContext } from "../caller-context.js";
import { CALLER_CONTEXT_KEY, requireScope } from "../middleware/require-scope.js";
import { getClientIp } from "../middleware/rate-limiter.js";


/** Maximum SSE ticket requests per IP per rate-limit window. */
export const TICKET_RATE_LIMIT_PER_IP = 10;

/** Rate-limit window duration in ms. */
export const TICKET_RATE_LIMIT_WINDOW_MS = 60_000;

interface IpRateState {
  count:   number;
  resetAt: number;
}

/** In-process per-IP request counts. Cleared by clearIpRateLimits() in tests. */
const _ipRequestCounts = new Map<string, IpRateState>();

/** Clear IP rate-limit state (for tests and graceful shutdown). */
export function clearIpRateLimits(): void {
  _ipRequestCounts.clear();
}

/**
 * Check and update per-IP rate limit.
 * Returns true if the request is within the limit; false if it should be rejected.
 */
function checkIpRateLimit(ip: string): boolean {
  const now = Date.now();
  const state = _ipRequestCounts.get(ip);
  if (state !== undefined && state.resetAt > now) {
    if (state.count >= TICKET_RATE_LIMIT_PER_IP) {
      return false;
    }
    state.count++;
    return true;
  }
  // New window (or new IP)
  _ipRequestCounts.set(ip, { count: 1, resetAt: now + TICKET_RATE_LIMIT_WINDOW_MS });
  return true;
}

const logger = createLogger("api-sse-ticket");


/** Milliseconds before an unused ticket expires. Short window limits exposure if tickets appear in logs. */
const TICKET_TTL_MS = 10_000;

/** Maximum in-flight tickets — prevents unbounded growth. */
const MAX_TICKETS = 1_000;

interface TicketEntry {
  /** ISO-8601 creation timestamp (for metrics / debugging). */
  createdAt: string;
  /** Wall-clock time after which this ticket is invalid. */
  expiresAt: number;
  /** Caller context bound to this ticket — used for SSE scope filtering. */
  callerContext?: CallerContext;
}

/** In-process store: ticket UUID → metadata. */
const _tickets = new Map<string, TicketEntry>();

// ---------------------------------------------------------------------------
// Periodic pruning — prevents unbounded accumulation when consumeTicket is
// not called (e.g. client never connects after obtaining a ticket).
// ---------------------------------------------------------------------------

/** Interval between proactive prune sweeps (2× TTL). */
const PRUNE_INTERVAL_MS = TICKET_TTL_MS * 2;

let _pruneTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic prune timer.
 * Safe to call multiple times — only one timer is active at a time.
 * Called automatically on module load; exposed for testing.
 */
export function startPruneTimer(): void {
  if (_pruneTimer !== null) return;
  _pruneTimer = setInterval(() => {
    pruneExpired();
  }, PRUNE_INTERVAL_MS);
  // Unref so the timer does not keep the process alive when there is no other work.
  if (typeof _pruneTimer === "object" && _pruneTimer !== null && "unref" in _pruneTimer) {
    (_pruneTimer as { unref(): void }).unref();
  }
}

/**
 * Stop the periodic prune timer.
 * Call during graceful shutdown or in test teardown.
 */
export function stopPruneTimer(): void {
  if (_pruneTimer !== null) {
    clearInterval(_pruneTimer);
    _pruneTimer = null;
  }
}

// Start automatically on module load
startPruneTimer();


function pruneExpired(): void {
  const now = Date.now();
  for (const [id, entry] of _tickets) {
    if (now > entry.expiresAt) {
      _tickets.delete(id);
    }
  }
}


/**
 * Validate and consume a ticket.
 *
 * Returns the CallerContext bound to the ticket when valid (empty object when no
 * restrictions were set), and removes the ticket atomically.
 * Returns `false` when the ticket is unknown or expired.
 *
 * Delete-first pattern — Map.delete() is the atomic check-and-remove.
 * We remove before validating expiry so a second concurrent caller that arrives
 * after the get() but before the original delete() cannot reuse the same ticket.
 * (JavaScript is single-threaded, so this is defence-in-depth, but the ordering
 * also makes the single-use guarantee explicit and immune to any future async refactoring.)
 */
export function consumeTicket(ticket: string): CallerContext | false {
  pruneExpired();
  const entry   = _tickets.get(ticket);
  const deleted = _tickets.delete(ticket); // Delete FIRST — then validate
  if (!deleted || entry === undefined) return false;          // unknown ticket
  if (Date.now() > entry.expiresAt)   return false;          // expired (already removed — correct)
  return entry.callerContext ?? {};   // return context (empty object = no restrictions)
}

/** Clear all tickets (for tests). */
export function clearTickets(): void {
  _tickets.clear();
}

/** Return current ticket count (for tests). */
export function ticketCount(): number {
  pruneExpired();
  return _tickets.size;
}


// ---------------------------------------------------------------------------
// Database-backed ticket persistence (A7: SSE ticket persistence)
// ---------------------------------------------------------------------------

/** DDL for persistent ticket storage. */
function ensureTicketTable(db: import("../../utils/db.js").Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sse_tickets (
      ticket_id  TEXT PRIMARY KEY,
      scope      TEXT NOT NULL DEFAULT 'readonly',
      division   TEXT,
      agent_id   TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sse_tickets_expires ON sse_tickets(expires_at)`);
}

/**
 * Persist a newly issued ticket to SQLite.
 * Call after adding the ticket to the in-memory map.
 * Non-fatal — in-memory path is authoritative.
 */
export function persistTicket(
  db: import("../../utils/db.js").Database,
  ticketId: string,
  callerContext?: import("../caller-context.js").CallerContext,
  expiresAt?: number,
): void {
  try {
    ensureTicketTable(db);
    const expiresIso = new Date(expiresAt ?? (Date.now() + TICKET_TTL_MS)).toISOString();
    db.prepare<[string, string, string | null, string | null, string], void>(
      "INSERT OR IGNORE INTO sse_tickets (ticket_id, scope, division, agent_id, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      ticketId,
      callerContext?.role ?? "readonly",
      callerContext?.division ?? null,
      callerContext?.agentId  ?? null,
      expiresIso,
    );
  } catch (_e) { /* non-fatal */ }
}

/**
 * Validate a ticket from SQLite (used when in-memory lookup fails — e.g. after restart).
 * Marks as used=1 atomically. Returns CallerContext when valid, null otherwise.
 */
export function validateTicketFromDb(
  db: import("../../utils/db.js").Database,
  ticketId: string,
): import("../caller-context.js").CallerContext | null {
  try {
    ensureTicketTable(db);
    const nowIso = new Date().toISOString();
    // Atomic: only mark used=1 if not yet consumed AND not expired.
    // UPDATE...RETURNING is atomic — no separate SELECT race condition.
    const row = db.prepare<[string, string], {
      scope: string; division: string | null; agent_id: string | null;
    }>(
      "UPDATE sse_tickets SET used = 1 WHERE ticket_id = ? AND used = 0 AND expires_at > ? RETURNING scope, division, agent_id",
    ).get(ticketId, nowIso);
    if (row === undefined) return null;
    return {
      role: row.scope as import("../token-store.js").TokenScope,
      ...(row.division ? { division: row.division } : {}),
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
    };
  } catch (_e) {
    return null;
  }
}

/**
 * Delete expired tickets from the DB. Call on startup and periodically.
 * Uses ISO 8601 comparison — expires_at is stored as toISOString() output.
 */
export function cleanupExpiredTicketsDb(db: import("../../utils/db.js").Database): void {
  try {
    ensureTicketTable(db);
    const nowIso = new Date().toISOString();
    db.prepare<[string], void>(
      "DELETE FROM sse_tickets WHERE expires_at < ?",
    ).run(nowIso);
  } catch (_e) { /* non-fatal */ }
}


// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TicketRouteServices {}

/**
 * Register the SSE ticket endpoint.
 *
 *   POST /api/v1/sse/ticket
 *     Authorization: Bearer <api-key>
 *   → 200 { ticket: string, expires_in: number }
 *   → 401 { error: { code, message } }
 *   → 429 { error: { code, message } }
 */
export function registerSseTicketRoutes(app: Hono, services: TicketRouteServices): void {
  app.post("/api/v1/sse/ticket", requireScope("readonly"), (c: Context) => {
    // Explicit bootstrap rejection — requireScope("readonly") already blocks this
    // (bootstrap level 0 < readonly level 1) but we add an explicit check for a
    // clear error message guiding the caller to create a scoped token first.
    const callerCtx = c.get(CALLER_CONTEXT_KEY) as CallerContext | undefined;
    if (callerCtx?.role === "bootstrap") {
      return c.json(
        { error: { code: "AUTH-003", message: "SSE requires a scoped token. Create one with: sidjua token create --scope readonly", recoverable: false } },
        403,
      );
    }

    // Per-IP rate limit — prevents a single client from exhausting the ticket store
    const clientIp = getClientIp(c.req.raw.headers);

    if (!checkIpRateLimit(clientIp)) {
      logger.warn("sse_ticket_ip_rate_limit", "SSE ticket per-IP rate limit exceeded", {
        metadata: { clientIp },
      });
      return c.json(
        {
          error: {
            code:        "RATE-002",
            message:     `Too many ticket requests from this IP — max ${TICKET_RATE_LIMIT_PER_IP} per minute`,
            recoverable: true,
          },
        },
        429,
      );
    }

    // Prune before checking capacity
    pruneExpired();
    if (_tickets.size >= MAX_TICKETS) {
      logger.warn("sse_ticket_limit", "SSE ticket store at capacity — rejecting request", {
        metadata: { size: _tickets.size },
      });
      return c.json(
        {
          error: {
            code:        "RATE-001",
            message:     "Too many pending SSE tickets — try again shortly",
            recoverable: true,
          },
        },
        429,
      );
    }

    // Issue ticket — store caller context for scope-based event filtering
    const callerContext = c.get(CALLER_CONTEXT_KEY) as CallerContext | undefined;
    const ticket = randomUUID();
    _tickets.set(ticket, {
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + TICKET_TTL_MS,
      ...(callerContext !== undefined ? { callerContext } : {}),
    });

    logger.info("sse_ticket_issued", "Issued short-lived SSE ticket", {
      metadata: { ticket_prefix: ticket.slice(0, 8) },
    });

    return c.json({ ticket, expires_in: Math.floor(TICKET_TTL_MS / 1000) }, 200);
  });
}
