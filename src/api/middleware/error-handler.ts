// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11a: Error Handler Middleware
 *
 * Catches all thrown errors, maps SidjuaError codes to HTTP status codes,
 * and returns a consistent JSON error response.
 *
 * Production mode: omit `detail` and stack trace from responses.
 */

import { appendFileSync } from "node:fs";
import type { ErrorHandler } from "hono";
import { SidjuaError } from "../../core/error-codes.js";
import { createLogger } from "../../core/logger.js";
import { REQUEST_ID_KEY } from "./request-logger.js";

const logger = createLogger("api-server");


/** SQLite error codes that indicate the database is temporarily busy. */
const SQLITE_BUSY_CODES = new Set([
  "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED_SHAREDCACHE",
]);

/**
 * Return true when the thrown error originates from better-sqlite3 and indicates
 * a transient contention condition (busy / locked). These errors should never
 * surface internal paths or DB codes to the caller.
 */
function isSqliteBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // better-sqlite3 sets `code` on the Error object
  const code = (err as Error & { code?: string }).code;
  if (code !== undefined && SQLITE_BUSY_CODES.has(code)) return true;
  // Fallback: match message text for drivers that don't set `.code`
  return /SQLITE_(BUSY|LOCKED)/i.test(err.message);
}


function writeToErrorLog(entry: Record<string, unknown>): void {
  const errorLogPath = process.env["SIDJUA_ERROR_LOG"];
  if (!errorLogPath) return;
  try {
    appendFileSync(errorLogPath, JSON.stringify(entry) + "\n");
  } catch (_e) {
    // ignore — error log write failure must not affect the response
  }
}


/**
 * Replace absolute file system paths in a string with "[path]".
 * Prevents internal directory layout from leaking in production error messages.
 */
function sanitizePath(msg: string): string {
  // Strip absolute paths (/home/user/...) and relative paths (./foo, ../bar)
  // Also handles Windows-style paths (C:\Users\..., .\foo, ..\bar)
  return msg
    .replace(/\/[^\s:,'"}\]]{2,}/g, "[path]")
    .replace(/\.\.?\/[^\s:,'"}\]]+/g, "[path]")
    .replace(/\.\.?\\[^\s:,'"}\]]+/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s:,'"}\]]+/g, "[path]");
}


function httpStatusForSidjuaError(err: SidjuaError): number {
  const code = err.code;

  // Governance errors → 403
  if (code.startsWith("GOV-")) {
    if (code === "GOV-008") return 503; // rollback in progress
    return 403;
  }

  // Task errors
  if (code === "TASK-001" || code === "TASK-002") return 400;
  if (code === "TASK-003") return 409;
  if (code === "TASK-004") return 408;
  if (code === "TASK-005") return 409;

  // Agent errors
  if (code === "AGT-001") return 404;
  if (code === "AGT-002" || code === "AGT-003" || code === "AGT-005") return 503;
  if (code === "AGT-004") return 503;

  // Provider errors → 502
  if (code.startsWith("PROV-")) return 502;

  // Tool errors
  if (code === "TOOL-001") return 404;
  if (code === "TOOL-005" || code === "TOOL-006") return 403;
  if (code.startsWith("TOOL-")) return 500;

  // System errors → 500
  if (code.startsWith("SYS-")) return 500;

  // Input errors → 400
  if (code.startsWith("INPUT-")) return 400;

  // Provider config errors
  if (code === "PCFG-001") return 404;
  if (code === "PCFG-002") return 400;
  if (code === "PCFG-003") return 404;
  if (code === "PCFG-004") return 400;

  // Chat errors
  if (code === "CHAT-001" || code === "CHAT-003") return 400;
  if (code === "CHAT-002") return 404;
  if (code === "CHAT-004") return 502;

  // Execution errors (Phase 13c)
  if (code === "EXEC-003") return 400; // invalid input
  if (code === "EXEC-004") return 404; // task not found
  if (code === "EXEC-005") return 402; // budget exhausted
  if (code === "EXEC-006") return 409; // task cancelled
  if (code === "EXEC-007") return 500; // synthesis failed

  // Module sandbox errors
  if (code === "MOD-002" || code === "MOD-003" || code === "MOD-006") return 403;
  if (code === "MOD-005") return 504;
  if (code.startsWith("MOD-")) return 500;

  return 500;
}


/**
 * Create the global error handler for the Hono app.
 *
 * @param isDevelopment  If true, include `detail` and stack in responses
 */
export function createErrorHandler(isDevelopment = false): ErrorHandler {
  return (err, c) => {
    const requestId = (c.get(REQUEST_ID_KEY) as string | undefined) ?? "unknown";

    if (err instanceof SidjuaError) {
      const status = httpStatusForSidjuaError(err);

      logger.error("api_error", `API error ${err.code}: ${err.message}`, {
        correlationId: requestId,
        error: {
          code:    err.code,
          message: err.message,
        },
        metadata: { status, path: c.req.path },
      });

      const safeMessage = isDevelopment ? err.message : sanitizePath(err.message);
      const body: Record<string, unknown> = {
        code:        err.code,
        message:     safeMessage,
        recoverable: err.recoverable,
        request_id:  requestId,
      };
      if (err.suggestion !== undefined) body["suggestion"] = err.suggestion;
      if (isDevelopment && err.detail !== undefined) body["detail"] = err.detail;

      return c.json({ error: body }, status as Parameters<typeof c.json>[1]);
    }

    // SQLite contention — return 503 with a safe generic message (no paths/codes)
    if (isSqliteBusyError(err)) {
      logger.warn("api_db_busy", "Database temporarily busy", {
        correlationId: requestId,
        metadata: { path: c.req.path },
      });
      return c.json({
        error: {
          code:        "SYS-002",
          message:     "Database temporarily busy, please retry",
          recoverable: true,
          suggestion:  "Retry after a short delay",
          request_id:  requestId,
        },
      }, 503);
    }

    // Generic / unexpected error → SYS-001
    logger.error("api_unexpected_error", `Unexpected error: ${err.message}`, {
      correlationId: requestId,
      error: {
        code:    "SYS-001",
        message: err.message,
        ...(isDevelopment ? { stack: err.stack } : {}),
      },
      metadata: { path: c.req.path },
    });

    // Write to error log file (SIDJUA_ERROR_LOG) for all 500s
    writeToErrorLog({
      timestamp:  new Date().toISOString(),
      level:      "error",
      kind:       "api",
      route:      `${c.req.method} ${c.req.path}`,
      status:     500,
      message:    err.message,
      request_id: requestId,
    });

    const body: Record<string, unknown> = {
      code:        "SYS-001",
      message:     "Internal server error",
      recoverable: true,
      suggestion:  "Retry",
      request_id:  requestId,
    };
    if (isDevelopment) {
      body["detail"] = err.message;
    }

    return c.json({ error: body }, 500);
  };
}
