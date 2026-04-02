// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Canonical URL / host validation (SSRF protection).
 *
 * Canonical file for all outbound URL and host validation.
 * - validateProviderUrl()   — validates provider API base URLs (returns UrlValidationResult)
 * - validateOutboundUrl()   — guards server-side fetches against SSRF (throws SidjuaError)
 * - validateSshHost()       — guards SSH connectivity tests against SSRF (throws SidjuaError)
 *
 * Enterprise seam: `validateProviderUrl` accepts an `allowCustom` flag so
 * operators can extend the allowed-domain set without patching this file.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { SidjuaError } from "../error-codes.js";

/** IPv4/IPv6 private and reserved address patterns. */
const PRIVATE_RANGES: RegExp[] = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,   // link-local
  /^::1$/,         // IPv6 loopback
  /^fc00:/i,       // IPv6 unique local
  /^fe80:/i,       // IPv6 link-local
  /^fd[0-9a-f]{2}/i, // IPv6 ULA
  /^0\.0\.0\.0$/,
  /^255\./,        // broadcast
  /^224\./,        // multicast
];

/**
 * Official provider domains approved for outbound test requests.
 * Subdomains of these hosts are also accepted.
 */
export const KNOWN_PROVIDER_DOMAINS: ReadonlyArray<string> = [
  "api.openai.com",
  "api.anthropic.com",
  "api.groq.com",
  "generativelanguage.googleapis.com",
  "api.x.ai",
  "api.deepseek.com",
  "api.mistral.ai",
  "api.together.xyz",
  "openrouter.ai",
  "api.cohere.com",
];

export interface UrlValidationResult {
  valid:    boolean;
  reason?:  string;
}

export interface ValidateProviderUrlOptions {
  /** Allow any HTTPS URL, not just known provider domains. Default: false. */
  allowCustom?: boolean;
}

/**
 * Validate a provider API base URL before making a server-side request.
 *
 * Rejects:
 *   - Non-HTTPS URLs (except http://localhost for local dev)
 *   - Private/reserved IP address ranges
 *   - Unknown provider domains (unless `allowCustom` is true)
 *
 * @param urlString - The URL to validate.
 * @param opts      - Validation options.
 * @returns `{ valid: true }` or `{ valid: false, reason: "..." }`.
 */
export function validateProviderUrl(
  urlString: string,
  opts?: ValidateProviderUrlOptions,
): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch (_e) {
    return { valid: false, reason: "Invalid URL format" };
  }

  const { hostname, protocol } = url;

  // Allow http only for localhost (local development)
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
  if (protocol !== "https:" && !(protocol === "http:" && isLocalhost)) {
    return { valid: false, reason: "Only HTTPS is allowed (http://localhost is permitted for local dev)" };
  }

  // Block private / reserved address ranges
  for (const range of PRIVATE_RANGES) {
    if (range.test(hostname)) {
      return { valid: false, reason: `Private or reserved address not allowed: ${hostname}` };
    }
  }

  // If not allowing custom providers, require a known domain
  if (!opts?.allowCustom) {
    const isKnown = KNOWN_PROVIDER_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
    if (!isKnown) {
      return {
        valid:  false,
        reason: `Unknown provider domain: ${hostname}. Set allow_custom_providers: true in config to allow custom endpoints.`,
      };
    }
  }

  return { valid: true };
}


/**
 * Regex matching private, link-local, loopback, and reserved IP ranges.
 * Covers IPv4 RFC-1918, loopback, APIPA, and common IPv6 loopback forms.
 */
const PRIVATE_HOST_RE =
  /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|localhost|::1|\[::1\]|fd[0-9a-f]{2}:.*)$/i;

/**
 * Validate that a URL is safe to fetch from a server-side context.
 *
 * Rejects:
 *   - Non-HTTP(S) schemes (file://, ftp://, etc.)
 *   - Private / loopback / link-local addresses (SSRF guard)
 *
 * @throws SidjuaError SSRF-001 on scheme violation or invalid URL
 * @throws SidjuaError SSRF-002 on private/loopback host
 */
export function validateOutboundUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (_err) {
    throw SidjuaError.from("SSRF-001", `Invalid URL: ${raw}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw SidjuaError.from(
      "SSRF-001",
      `Only HTTP(S) URLs are allowed for outbound requests (got "${parsed.protocol}")`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host)) {
    throw SidjuaError.from(
      "SSRF-002",
      `Private/loopback/link-local URLs are not allowed for outbound requests (host: "${host}")`,
    );
  }
}

/**
 * Async version of validateOutboundUrl with DNS rebinding protection.
 *
 * Performs the same synchronous checks as validateOutboundUrl, then resolves
 * the hostname via DNS and rejects if any returned address is private/loopback.
 * This prevents attackers from registering a public domain that resolves to an
 * internal address (DNS rebinding attack).
 *
 * @throws SidjuaError SSRF-001 on scheme violation or invalid URL
 * @throws SidjuaError SSRF-002 on private/loopback host (static check)
 * @throws SidjuaError SSRF-003 on private/loopback DNS resolution
 */
export async function validateOutboundUrlAsync(raw: string): Promise<void> {
  // Run static checks first (fast path — no network I/O)
  validateOutboundUrl(raw);

  const { hostname } = new URL(raw);

  // Skip DNS lookup for bare IP addresses — already covered by static check
  if (/^[\d.:]+$/.test(hostname)) return;

  let addresses: string[];
  try {
    const results = await dnsLookup(hostname, { all: true });
    addresses = results.map((r) => r.address);
  } catch (_e) {
    // DNS failure is non-fatal here; let the downstream fetch fail with a
    // meaningful error rather than blocking on a transient DNS outage.
    return;
  }

  for (const addr of addresses) {
    if (PRIVATE_HOST_RE.test(addr)) {
      throw SidjuaError.from(
        "SSRF-003",
        `DNS rebinding detected: "${hostname}" resolved to private address "${addr}"`,
      );
    }
  }
}

/**
 * Validate that an SSH host is safe to connect to.
 *
 * Rejects private, loopback, and wildcard addresses so that the
 * SSH connectivity test endpoint cannot be used for internal network scanning.
 *
 * @throws SidjuaError SSRF-002 on private/loopback host
 */
export function validateSshHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized === "*" || normalized === "0.0.0.0") {
    throw SidjuaError.from("SSRF-002", `Invalid SSH host: "${host}"`);
  }
  if (PRIVATE_HOST_RE.test(normalized)) {
    throw SidjuaError.from(
      "SSRF-002",
      `Private/loopback hosts are not allowed for SSH connectivity tests (host: "${host}")`,
    );
  }
}
