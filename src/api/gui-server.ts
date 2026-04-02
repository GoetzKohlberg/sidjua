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
import { assertWithinDirectory } from "../utils/path-utils.js";

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
    assertWithinDirectory(realPath, realpathSync(dir));
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  const ext  = extname(realPath);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const body = readFileSync(realPath);
  return c.newResponse(body, 200, { "Content-Type": mime });
}

/**
 * Serve index.html with the API key injected server-side (P281).
 *
 * The bootstrap payload is written into `window.__SIDJUA_BOOTSTRAP__` before
 * `</head>` so the GUI can read the key without a separate HTTP round-trip.
 *
 * Security constraints:
 *   - Key is injected ONLY for loopback requests (Host: localhost / 127.0.0.1 / ::1).
 *   - Non-local requests receive an empty payload `{}`.
 *   - Response is always `Cache-Control: no-store, no-cache` to prevent the key
 *     from being stored in browser or proxy caches.
 */
export function serveIndexHtmlWithBootstrap(
  c: Context,
  guiDist: string,
  getApiKey: () => string,
): Response {
  const filePath = join(guiDist, "index.html");
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch (_e) {
    return c.text("Not found", 404);
  }
  try {
    assertWithinDirectory(realPath, realpathSync(guiDist));
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  // Use the TCP peer address set server-side by toWebRequest() — not the Host header,
  // which is client-controlled and trivially spoofable.  Fail-closed: if the peer
  // address header is absent (e.g. test environment), do NOT inject the API key.
  const peerAddr = c.req.header("x-sidjua-peer-address") ?? "";
  const isLocal  = peerAddr === "127.0.0.1" || peerAddr === "::1" || peerAddr === "::ffff:127.0.0.1";

  let serverUrl = "";
  try { serverUrl = new URL(c.req.url).origin; } catch (_err) { /* non-fatal — GUI falls back to window.location.origin */ }

  const payload = (isLocal
    ? JSON.stringify({ api_key: getApiKey(), server_url: serverUrl })
    : JSON.stringify({})
  ).replace(/</g, "\\u003c");

  const script = `<script>window.__SIDJUA_BOOTSTRAP__ = ${payload};</script>`;
  const html   = readFileSync(realPath, "utf-8").replace("</head>", `  ${script}\n  </head>`);

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
