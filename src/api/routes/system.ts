// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11a: System Routes
 *
 * GET /api/v1/health — public, no auth required (monitoring probes)
 * GET /api/v1/info   — authenticated, system metadata
 */

import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { reqId } from "../utils/request-id.js";
import { requireScope } from "../middleware/require-scope.js";

function resolveVersion(): string {
  // Only use SIDJUA_VERSION if it is explicitly set to a real version
  // (not the default placeholder "dev" written by the Dockerfile ARG).
  const envVersion = process.env["SIDJUA_VERSION"];
  if (envVersion && envVersion !== "dev") return envVersion;
  if (process.env["npm_package_version"]) return process.env["npm_package_version"];
  try {
    const vFile = join(fileURLToPath(new URL(".", import.meta.url)), ".version");
    if (existsSync(vFile)) return readFileSync(vFile, "utf-8").trim();
  } catch (_e) {
    // Fall through to default
  }
  return "dev";
}

const VERSION = resolveVersion();


interface BuildMeta {
  version:      string;
  build:        string;   // ISO build date
  ref:          string;   // git short ref
  vendor:       string;
  sig:          string;   // build signature
  build_number: number;   // monotonic CI build counter (0 = local/dev build)
}

function loadBuildMeta(): BuildMeta | null {
  const candidates = [
    "/app/.build-meta",                                                        // Docker absolute (primary)
    join(fileURLToPath(new URL(".", import.meta.url)), "../.build-meta"),      // dist/ → .build-meta (tsup bundle)
    join(process.cwd(), ".build-meta"),                                         // dev: relative to working dir
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")) as BuildMeta;
    } catch (_e) {
      // try next candidate
    }
  }
  return null;
}

const BUILD_META = loadBuildMeta();

/** Millisecond timestamp of process start (module-level, constant per process). */
const startedAt = new Date();
const startMs   = Date.now();

/**
 * Inject a deep health provider that adds db/disk/migration fields to GET /health.
 * Called by registerAllRoutes when a database is available.
 */
type DeepHealthFields = {
  healthy:            boolean;
  db_read:            boolean;
  db_write:           boolean;
  disk_ok:            boolean;
  migration_complete: boolean;
  qdrant_connected:   boolean;
};

let _deepHealthProvider: (() => Promise<DeepHealthFields>) | null = null;

export function setDeepHealthProvider(fn: (() => Promise<DeepHealthFields>) | null): void {
  _deepHealthProvider = fn;
}

export function createSystemRoutes(getApiKey?: () => string): Hono {
  const app = new Hono();

  /**
   * GET /health
   * Public endpoint — no authentication required.
   * Returns basic liveness plus deep health fields when DB is available.
   */
  // SCOPE: public (intentional, no auth required)
  app.get("/health", async (c) => {
    const deep = _deepHealthProvider ? await _deepHealthProvider() : null;
    return c.json({
      status:        "ok",
      version:       VERSION,
      uptime_ms:     Date.now() - startMs,
      build_number:  BUILD_META?.build_number ?? null,
      build_date:    BUILD_META?.build ?? null,
      build_ref:     BUILD_META?.ref   ?? null,
      components:    {},
      ...(deep ?? {}),
    });
  });

  /**
   * GET /info
   * Authenticated endpoint — returns system metadata.
   */
  app.get("/info", requireScope("readonly"), (c) => {
    const requestId = reqId(c);
    return c.json({
      name:        "SIDJUA",
      version:     VERSION,
      description: "AI agent governance platform",
      started_at:  startedAt.toISOString(),
      uptime_ms:   Date.now() - startMs,
      build_date:  BUILD_META?.build ?? null,
      build_ref:   BUILD_META?.ref   ?? null,
      build_sig:   BUILD_META?.sig   ?? null,
      request_id:  requestId,
    });
  });

  return app;
}
