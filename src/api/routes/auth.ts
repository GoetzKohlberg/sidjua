// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P434b: GUI Auth Routes
 *
 * POST /api/v1/auth/setup            — first-time admin password setup
 * POST /api/v1/auth/login            — password login, returns session cookie
 * POST /api/v1/auth/logout           — clear session cookie
 * GET  /api/v1/auth/verify           — returns auth state (200 or 401)
 * GET  /api/v1/auth/csrf             — returns CSRF token for active session
 * POST /api/v1/auth/settings/password — change admin password (requires session)
 */

import { Hono, type Context } from "hono";
import { randomBytes } from "node:crypto";
import argon2          from "argon2";
import { createLogger }     from "../../core/logger.js";
import { CALLER_CONTEXT_KEY } from "../middleware/require-scope.js";
import { authRateLimiter }   from "../middleware/rate-limiter.js";
import type { ConfigManager } from "../config.js";
import {
  FileSessionStore,
  SESSION_KEY,
  SESSION_TTL_MS,
  signSessionId,
  buildSessionCookieHeader,
  clearSessionCookieHeader,
} from "../middleware/session.js";
import type { SessionData }   from "../middleware/session.js";
import { reqId }              from "../utils/request-id.js";

const logger = createLogger("auth-routes");

/** Minimum password length enforced at setup and change. */
const MIN_PASSWORD_LEN = 12;

const ARGON2_OPTIONS = {
  type:        argon2.argon2id,
  memoryCost:  65536, // 64 MiB
  timeCost:    3,
  parallelism: 4,
} as const;

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface AuthRouteServices {
  configManager: ConfigManager;
  sessionStore:  FileSessionStore;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function registerAuthRoutes(app: Hono, services: AuthRouteServices): void {
  const { configManager, sessionStore } = services;

  // ── POST /api/v1/auth/setup ──────────────────────────────────────────────
  // Public — only works on first run (before admin password is set).
  app.post("/api/v1/auth/setup", authRateLimiter(), async (c: Context) => {
    const requestId = reqId(c);

    if (!configManager.isFirstRun()) {
      logger.warn("auth_setup_already_done", "Setup requested but server is already configured", {
        correlationId: requestId,
      });
      return c.json(
        {
          error: {
            code:        "AUTH-409",
            message:     "Server is already configured. Use /api/v1/auth/settings/password to change.",
            recoverable: false,
            request_id:  requestId,
          },
        },
        409,
      );
    }

    let body: { password?: unknown };
    try {
      body = await c.req.json() as { password?: unknown };
    } catch (_e) {
      return c.json(
        { error: { code: "SETUP-400", message: "Request body must be JSON", recoverable: false, request_id: requestId } },
        400,
      );
    }

    const password = typeof body.password === "string" ? body.password : null;
    if (password === null || password.length < MIN_PASSWORD_LEN) {
      return c.json(
        {
          error: {
            code:        "SETUP-400",
            message:     `Password must be at least ${MIN_PASSWORD_LEN} characters`,
            recoverable: true,
            request_id:  requestId,
          },
        },
        400,
      );
    }

    // Generate session secret (32 random bytes → base64)
    const sessionSecret = randomBytes(32).toString("base64");
    // Hash password with argon2id
    const passwordHash  = await argon2.hash(password, ARGON2_OPTIONS);

    await configManager.save({ passwordHash, sessionSecret });

    // Create first session
    const session   = await sessionStore.create(SESSION_TTL_MS);
    const signed    = signSessionId(session.id, sessionSecret);
    const host      = c.req.header("host") ?? "localhost";
    const cookieHdr = buildSessionCookieHeader(signed, host);
    c.header("Set-Cookie", cookieHdr);

    logger.info("auth_setup_complete", "Admin password set — server configured", { correlationId: requestId });

    return c.json({ ok: true, csrfToken: session.csrfToken });
  });


  // ── POST /api/v1/auth/login ──────────────────────────────────────────────
  // Public — password login; rate-limited by auth-specific bucket.
  app.post("/api/v1/auth/login", authRateLimiter(), async (c: Context) => {
    const requestId = reqId(c);

    if (configManager.isFirstRun()) {
      return c.json(
        {
          error: {
            code:        "AUTH-403",
            message:     "Server not configured. Complete first-time setup first.",
            recoverable: true,
            request_id:  requestId,
          },
        },
        403,
      );
    }

    let body: { password?: unknown };
    try {
      body = await c.req.json() as { password?: unknown };
    } catch (_e) {
      return c.json(
        { error: { code: "AUTH-400", message: "Request body must be JSON", recoverable: false, request_id: requestId } },
        400,
      );
    }

    const password = typeof body.password === "string" ? body.password : null;
    if (password === null) {
      return c.json(
        { error: { code: "AUTH-400", message: "password field required", recoverable: true, request_id: requestId } },
        400,
      );
    }

    const cfg = configManager.getConfig();
    if (cfg.passwordHash === null) {
      // Should not happen (isFirstRun check above) but guard defensively
      return c.json(
        { error: { code: "AUTH-503", message: "Auth service unavailable", recoverable: true, request_id: requestId } },
        503,
      );
    }

    const valid = await argon2.verify(cfg.passwordHash, password);
    if (!valid) {
      logger.warn("auth_login_invalid", "Login attempt with invalid password", { correlationId: requestId });
      // Constant-time path: delay is already built into argon2.verify
      return c.json(
        {
          error: {
            code:        "AUTH-001",
            message:     "Invalid credentials",
            recoverable: true,
            request_id:  requestId,
          },
        },
        401,
      );
    }

    const sessionSecret = cfg.sessionSecret;
    if (sessionSecret === null) {
      return c.json(
        { error: { code: "AUTH-503", message: "Auth service unavailable", recoverable: true, request_id: requestId } },
        503,
      );
    }

    const session   = await sessionStore.create(SESSION_TTL_MS);
    const signed    = signSessionId(session.id, sessionSecret);
    const host      = c.req.header("host") ?? "localhost";
    const cookieHdr = buildSessionCookieHeader(signed, host);
    c.header("Set-Cookie", cookieHdr);

    logger.info("auth_login_success", "Successful login", { correlationId: requestId });

    return c.json({ ok: true, csrfToken: session.csrfToken });
  });


  // ── POST /api/v1/auth/logout ─────────────────────────────────────────────
  // Public (cookie-clear is safe without auth check).
  app.post("/api/v1/auth/logout", async (c: Context) => {
    const session = c.get(SESSION_KEY) as SessionData | undefined;
    if (session !== undefined) {
      await sessionStore.delete(session.id);
    }
    c.header("Set-Cookie", clearSessionCookieHeader());
    return c.json({ ok: true });
  });


  // ── GET /api/v1/auth/verify ──────────────────────────────────────────────
  // Public — returns auth state without gating access.
  // Used by the SPA on load to determine which screen to show.
  app.get("/api/v1/auth/verify", (c: Context) => {
    const requestId = reqId(c);
    const session   = c.get(SESSION_KEY) as SessionData | undefined;
    if (session !== undefined) {
      return c.json({ authenticated: true, via: "session" });
    }
    // Could also be authenticated via Bearer token — check callerContext
    const callerCtx = c.get(CALLER_CONTEXT_KEY) as { role?: string } | undefined;
    if (callerCtx?.role !== undefined) {
      return c.json({ authenticated: true, via: "bearer" });
    }
    return c.json(
      {
        authenticated: false,
        error: {
          code:        "AUTH-001",
          message:     "Not authenticated",
          recoverable: true,
          request_id:  requestId,
        },
      },
      401,
    );
  });


  // ── GET /api/v1/auth/csrf ────────────────────────────────────────────────
  // Requires active session — returns the CSRF token for use in X-CSRF-Token header.
  // Called by the SPA after page reload to re-fetch the CSRF token from the session.
  app.get("/api/v1/auth/csrf", (c: Context) => {
    const requestId = reqId(c);
    const session   = c.get(SESSION_KEY) as SessionData | undefined;
    if (session === undefined) {
      return c.json(
        { error: { code: "AUTH-001", message: "Session required", recoverable: true, request_id: requestId } },
        401,
      );
    }
    return c.json({ csrfToken: session.csrfToken });
  });


  // ── POST /api/v1/auth/settings/password ──────────────────────────────────
  // Requires active session — changes the admin password.
  app.post("/api/v1/auth/settings/password", authRateLimiter(), async (c: Context) => {
    const requestId = reqId(c);
    const session   = c.get(SESSION_KEY) as SessionData | undefined;
    if (session === undefined) {
      return c.json(
        { error: { code: "AUTH-001", message: "Session required", recoverable: true, request_id: requestId } },
        401,
      );
    }

    let body: { currentPassword?: unknown; newPassword?: unknown };
    try {
      body = await c.req.json() as typeof body;
    } catch (_e) {
      return c.json(
        { error: { code: "AUTH-400", message: "Request body must be JSON", recoverable: false, request_id: requestId } },
        400,
      );
    }

    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : null;
    const newPassword     = typeof body.newPassword     === "string" ? body.newPassword     : null;

    if (currentPassword === null || newPassword === null) {
      return c.json(
        { error: { code: "AUTH-400", message: "currentPassword and newPassword required", recoverable: true, request_id: requestId } },
        400,
      );
    }
    if (newPassword.length < MIN_PASSWORD_LEN) {
      return c.json(
        { error: { code: "AUTH-400", message: `New password must be at least ${MIN_PASSWORD_LEN} characters`, recoverable: true, request_id: requestId } },
        400,
      );
    }

    const cfg = configManager.getConfig();
    if (cfg.passwordHash === null) {
      return c.json(
        { error: { code: "AUTH-503", message: "Auth service unavailable", recoverable: true, request_id: requestId } },
        503,
      );
    }

    const valid = await argon2.verify(cfg.passwordHash, currentPassword);
    if (!valid) {
      logger.warn("auth_password_change_invalid", "Password change: current password incorrect", {
        correlationId: requestId,
      });
      return c.json(
        { error: { code: "AUTH-001", message: "Current password incorrect", recoverable: true, request_id: requestId } },
        401,
      );
    }

    const newHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
    await configManager.save({ passwordHash: newHash });

    logger.info("auth_password_changed", "Admin password changed", { correlationId: requestId });
    return c.json({ ok: true });
  });
}
