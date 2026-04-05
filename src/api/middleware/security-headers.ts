// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — HTTP Security Headers Middleware (audit-7, Fix 5)
 *
 * Adds defence-in-depth HTTP security headers to every response:
 *   - X-Content-Type-Options: nosniff          (prevent MIME sniffing)
 *   - X-Frame-Options: DENY                    (prevent clickjacking)
 *   - Referrer-Policy: no-referrer             (no referrer leakage)
 *   - Content-Security-Policy: default-src 'none' (REST API — no scripts/resources)
 *   - Strict-Transport-Security               (HSTS — only set when HTTPS is detected)
 *
 * Applied after the middleware stack so headers are present on all responses
 * including 4xx/5xx error responses.
 */

import { randomBytes }       from "node:crypto";
import type { MiddlewareHandler } from "hono";

// HSTS max-age: 1 year (recommended minimum for HTTPS deployments)
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Middleware that sets HTTP security response headers.
 *
 * HSTS is only emitted when the request was received over HTTPS (detected via
 * the X-Forwarded-Proto header, set by a TLS-terminating reverse proxy). Do NOT
 * enable HSTS on plain HTTP — browsers will refuse to connect afterwards.
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  // Generate a per-request nonce for inline style whitelisting (replaces the inline-style exception).
  const nonce = randomBytes(16).toString("base64url");
  c.set("nonce" as never, nonce);

  await next();

  const res = c.res;

  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
  // CSP: strict for API, permissive (but safe) for GUI
  const isApi = c.req.path.startsWith('/api/');
  if (isApi) {
    res.headers.set("Content-Security-Policy", "default-src 'none'");
  } else {
    res.headers.set("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'`);
  }
  res.headers.set("X-Permitted-Cross-Domain-Policies", "none");

  // HSTS — only add when the connection is over HTTPS to avoid breaking HTTP
  const proto = c.req.header("X-Forwarded-Proto");
  if (proto === "https") {
    res.headers.set(
      "Strict-Transport-Security",
      `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    );
  }
};
