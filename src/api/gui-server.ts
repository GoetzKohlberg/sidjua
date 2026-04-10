// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — GUI Static File Server
 *
 * Serves the sidjua-gui/dist build as static files with symlink traversal
 * protection and a bootstrap API-key injection into index.html.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, extname } from "node:path";
import { assertWithinDirectoryReal } from "../utils/path-utils.js";

/** MIME types for GUI static file serving. */
export const MIME_TYPES: Record<string, string> = {
  ".html":  "text/html; charset=utf-8",
  ".js":    "application/javascript; charset=utf-8",
  ".css":   "text/css; charset=utf-8",
  ".svg":   "image/svg+xml",
  ".png":   "image/png",
  ".ico":   "image/x-icon",
  ".json":  "application/json",
  ".woff2": "font/woff2",
  ".woff":  "font/woff",
  ".ttf":   "font/ttf",
};

/** Serve a static file from the GUI dist directory. */
export function serveGuiFile(c: Context, dir: string, filename: string): Response {
  const filePath = join(dir, filename);

  // Security: resolve symlinks FIRST, then verify the real path stays within dir.
  // Resolving before checking prevents symlink traversal attacks where a symlink
  // inside the allowed directory points to a file outside it.
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch (_e) {
    return c.text("Not found", 404);
  }

  try {
    assertWithinDirectoryReal(realPath, dir);
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  const ext  = extname(realPath);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const body = readFileSync(realPath);
  return c.newResponse(body, 200, { "Content-Type": mime });
}

/**
 * Serve index.html with CSP nonce injection for Vite inline scripts.
 *
 * Bootstrap payload injection removed (P434a / #779 — SPEC-BOOTSTRAP-V2 §4.4).
 * The `_getApiKey` parameter is retained for call-site compatibility.
 *
 * Response is always `Cache-Control: no-store, no-cache`.
 */
export function serveIndexHtmlWithBootstrap(
  c: Context,
  guiDist: string,
  _getApiKey: () => string,
): Response {
  const filePath = join(guiDist, "index.html");
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch (_e) {
    return c.text("Not found", 404);
  }
  try {
    assertWithinDirectoryReal(realPath, guiDist);
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  // Retrieve the per-request nonce set by the securityHeaders middleware so
  // any Vite-injected inline scripts (e.g. modulepreload polyfill) are
  // whitelisted by the script-src CSP directive.
  const nonce = (c.get as (k: string) => string | undefined)("nonce" as never) ?? "";
  let html = readFileSync(realPath, "utf-8");

  // Add nonce to any inline <script> tags injected by vite (no src=, no nonce= yet).
  if (nonce) {
    html = html.replace(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
  }

  return c.newResponse(html, 200, {
    "Content-Type":  "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache",
    "Pragma":        "no-cache",
  });
}

/**
 * Register GUI static file routes on the given Hono app.
 * Returns true if the GUI dist directory was found, false if not built.
 */
export function registerGuiRoutes(
  app:     Hono,
  guiDist: string,
  getKey:  () => string,
): boolean {
  const hasGui = existsSync(join(guiDist, "index.html"));
  if (!hasGui) return false;

  app.get("/",           (c) => serveIndexHtmlWithBootstrap(c, guiDist, getKey));
  app.get("/index.html", (c) => serveIndexHtmlWithBootstrap(c, guiDist, getKey));
  app.get("/favicon.ico",(c) => serveGuiFile(c, guiDist, "favicon.ico"));
  app.get("/assets/*",   (c) => {
    const assetPath = c.req.path.replace(/^\/assets\//, "");
    return serveGuiFile(c, join(guiDist, "assets"), assetPath);
  });
  // SPA fallback — serve index.html for all unmatched non-API routes
  app.get("/*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.notFound();
    return serveIndexHtmlWithBootstrap(c, guiDist, getKey);
  });

  return true;
}
