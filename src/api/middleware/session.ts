// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P434b: File-backed Session Middleware
 *
 * Cookie: sidjua_sid=<base64url_id>.<base64url_hmac_sha256>
 *   - HMAC key: sessionSecret from ConfigManager (base64-decoded)
 *   - HttpOnly, SameSite=Strict, Secure (when the request was served over HTTPS —
 *     plain-HTTP deployments omit Secure so the browser will send the cookie back)
 *   - Max-Age: SESSION_TTL_MS (8 hours default)
 *
 * FileSessionStore: .system/sessions/<id>.json
 *   - One JSON file per session; purged on expiry
 *   - No locking needed (single-process, event-loop serialized)
 *
 * Double-submit CSRF: sessionMiddleware sets csrfToken in session;
 *   csrf.ts Phase 4 reads X-CSRF-Token header and compares.
 */

import { join }                          from "node:path";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { mkdirSync }                     from "node:fs";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import type { MiddlewareHandler }        from "hono";
import { createLogger }                  from "../../core/logger.js";

const logger = createLogger("session");

// ── Constants ────────────────────────────────────────────────────────────────

/** Default session TTL: 8 hours. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Hono context key for the active session. */
export const SESSION_KEY = "sidjua_session";

/** Cookie name. */
export const SESSION_COOKIE = "sidjua_sid";

/** Length of the random CSRF token (bytes → base64url). */
const CSRF_TOKEN_BYTES = 24;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionData {
  /** Unique session ID (random 32-byte base64url). */
  id:          string;
  /** ISO-8601 creation time. */
  createdAt:   string;
  /** ISO-8601 expiry time. */
  expiresAt:   string;
  /** Random CSRF token for double-submit pattern. */
  csrfToken:   string;
}

// ── Cookie signing ────────────────────────────────────────────────────────────

/**
 * Sign a session ID with HMAC-SHA256 using the session secret.
 * Returns `<id>.<signature>` where signature is base64url-encoded.
 */
export function signSessionId(id: string, secret: string): string {
  const sig = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(id)
    .digest("base64url");
  return `${id}.${sig}`;
}

/**
 * Verify a signed session cookie value.
 * Returns the session ID if valid, or null if tampered/malformed.
 */
export function verifySessionCookie(cookieValue: string, secret: string): string | null {
  const lastDot = cookieValue.lastIndexOf(".");
  if (lastDot < 1) return null;

  const id  = cookieValue.slice(0, lastDot);
  const sig = cookieValue.slice(lastDot + 1);

  const expected = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(id)
    .digest("base64url");

  // Timing-safe comparison
  const sigBuf      = Buffer.from(sig,      "utf-8");
  const expectedBuf = Buffer.from(expected, "utf-8");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  return id;
}

// ── FileSessionStore ──────────────────────────────────────────────────────────

export class FileSessionStore {
  private readonly sessionsDir: string;

  constructor(workDir: string) {
    this.sessionsDir = join(workDir, ".system", "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** Create a new session with a fresh CSRF token. */
  async create(ttlMs: number = SESSION_TTL_MS): Promise<SessionData> {
    const id        = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
    const now       = new Date();
    const session: SessionData = {
      id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      csrfToken,
    };
    await this._write(session);
    return session;
  }

  /**
   * Look up a session by ID.
   * Returns null if the session does not exist or has expired.
   * Expired sessions are deleted lazily.
   */
  async get(id: string): Promise<SessionData | null> {
    // Guard against path traversal — IDs must be URL-safe base64
    if (!this._isValidId(id)) return null;

    const path = this._path(id);
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch (_e) {
      return null; // not found
    }

    let session: SessionData;
    try {
      session = JSON.parse(raw) as SessionData;
    } catch (_e) {
      await this._delete(id); // corrupt file
      return null;
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await this._delete(id);
      return null;
    }

    return session;
  }

  /** Delete a session (logout). */
  async delete(id: string): Promise<void> {
    if (!this._isValidId(id)) return;
    await this._delete(id);
  }

  /**
   * Sweep sessions directory and remove all expired session files.
   * Called periodically (e.g., on startup and every SESSION_TTL_MS / 2).
   */
  async purgeExpired(): Promise<number> {
    let removed = 0;
    try {
      const entries = await readdir(this.sessionsDir);
      const now     = Date.now();
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const id = entry.slice(0, -5); // strip .json
        try {
          const raw     = await readFile(join(this.sessionsDir, entry), "utf-8");
          const session = JSON.parse(raw) as SessionData;
          if (new Date(session.expiresAt).getTime() <= now) {
            await this._delete(id);
            removed++;
          }
        } catch (_e) {
          // Corrupt or already deleted — remove
          try { await unlink(join(this.sessionsDir, entry)); } catch (_) { /* best effort */ }
          removed++;
        }
      }
    } catch (_e) { /* best effort */ }
    return removed;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _path(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }

  private async _write(session: SessionData): Promise<void> {
    await writeFile(this._path(session.id), JSON.stringify(session), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  private async _delete(id: string): Promise<void> {
    try { await unlink(this._path(id)); } catch (_e) { /* best effort */ }
  }

  /** Only allow base64url characters (A-Z a-z 0-9 - _) to prevent path traversal. */
  private _isValidId(id: string): boolean {
    return /^[A-Za-z0-9_-]{1,100}$/.test(id);
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Parse and validate the sidjua_sid cookie, load the session from FileSessionStore,
 * and expose it on the Hono context as SESSION_KEY.
 *
 * Routes that require an authenticated session can do:
 *   const session = c.get(SESSION_KEY) as SessionData | undefined;
 *   if (!session) return c.json({ error: "session required" }, 401);
 */
export function sessionMiddleware(
  store: FileSessionStore,
  getSecret: () => string | null,
): MiddlewareHandler {
  return async (c, next) => {
    const secret = getSecret();
    if (secret === null) {
      // Server not yet configured — no session auth possible
      return next();
    }

    const cookieHeader = c.req.header("cookie");
    if (cookieHeader !== undefined) {
      const sessionId = extractAndVerifyCookie(cookieHeader, secret);
      if (sessionId !== null) {
        const session = await store.get(sessionId);
        if (session !== null) {
          c.set(SESSION_KEY, session);
        }
      }
    }

    return next();
  };
}

/**
 * Build a Set-Cookie header value for the session cookie.
 *
 * The Secure flag is set iff the originating request was served over HTTPS.
 * Plain-HTTP deployments (LAN Docker, dev loopback) must NOT set Secure because
 * browsers would refuse to send the cookie back on subsequent HTTP requests,
 * producing a silent authentication failure that looks like "session expired".
 *
 * Scheme is determined at the call site from the current request's URL, not
 * from the Host header (hostname tells you nothing about transport security).
 * Reverse-proxy TLS termination via X-Forwarded-Proto is NOT trusted here —
 * that is a separate future feature gated behind an explicit SIDJUA_TRUSTED_PROXIES
 * allowlist.
 *
 * @param signedValue  The signed session ID cookie value.
 * @param isHttps      Whether the current request arrived over HTTPS.
 * @param ttlMs        Cookie lifetime in milliseconds (default: SESSION_TTL_MS).
 */
export function buildSessionCookieHeader(
  signedValue: string,
  isHttps:     boolean,
  ttlMs:       number = SESSION_TTL_MS,
): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const secure = isHttps ? "; Secure" : "";
  return `${SESSION_COOKIE}=${signedValue}; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=${maxAge}`;
}

/**
 * Build a Set-Cookie header to clear the session cookie.
 * Must mirror the Secure flag of the original Set-Cookie so the browser matches
 * and clears the cookie (a clear-cookie without Secure is ignored for Secure cookies).
 *
 * @param isHttps  Whether the current request arrived over HTTPS.
 */
export function clearSessionCookieHeader(isHttps: boolean): string {
  const secure = isHttps ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=0`;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Parse the Cookie header for sidjua_sid and verify its HMAC.
 * Returns the raw session ID (before the dot) on success, null otherwise.
 */
function extractAndVerifyCookie(cookieHeader: string, secret: string): string | null {
  // Parse cookie string manually to avoid a dependency
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eqIdx   = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const name  = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (name === SESSION_COOKIE) {
      return verifySessionCookie(value, secret);
    }
  }
  return null;
}
