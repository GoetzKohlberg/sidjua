// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Stage 0: Security Filter (Dual-Mode)
 *
 * Evaluates URL, command, file-access, and network targets against a
 * security filter config that supports two modes:
 *
 *   blacklist — block targets matching `blocked` patterns; allow everything else
 *   whitelist — allow only targets matching `allowed` patterns; block everything else
 *
 * Runs BEFORE Stage 1 (Forbidden).  Missing config = stage skipped entirely.
 *
 * Pattern forms for matchPattern():
 *   "*"                    — matches everything
 *   "*.example.com"        — matches any subdomain of example.com
 *   "api.example.com/*"    — matches any path under api.example.com
 *   "api.example.com"      — exact match
 *
 * Network-action CIDR matching (IPv4 only in V1):
 *   "10.0.0.0/8", "192.168.0.0/16", "10.0.0.5" (bare IP = /32) // pipeline-ok
 */

import type {
  ActionRequest,
  SecurityConfig,
  SecurityFilterConfig,
  SecurityFilterEntry,
  StageResult,
} from "../types/pipeline.js";
import { matchAction } from "./matcher.js";


const SECURITY_SOURCE = "governance/security/security.yaml";

/**
 * Action types subject to CIDR-based network enforcement.
 * Whitelist mode also applies to these (and only these) action types.
 */
const NETWORK_ACTION_TYPES = ["web.fetch", "web.post", "api.call"] as const;


/**
 * Match a `target` string against a security filter `pattern`.
 *
 * Supported forms:
 *   "*"                   — matches everything
 *   "*.example.com"       — wildcard prefix: any subdomain of example.com
 *   "api.example.com/*"   — wildcard suffix: any path under that host
 *   "api.example.com"     — exact match
 */
export function matchPattern(target: string, pattern: string): boolean {
  if (pattern === "*") return true;

  // Wildcard prefix: *.example.com
  if (pattern.startsWith("*.")) {
    const requiredSuffix = pattern.slice(1); // ".example.com"
    const bare           = pattern.slice(2); // "example.com"
    return target === bare || target.endsWith(requiredSuffix);
  }

  // Wildcard suffix: api.example.com/*
  if (pattern.endsWith("/*")) {
    const prefix  = pattern.slice(0, -1); // "api.example.com/"
    const noSlash = pattern.slice(0, -2); // "api.example.com"
    return target === noSlash || target.startsWith(prefix);
  }

  return target === pattern;
}


/**
 * Return true if `ip` (dotted-decimal IPv4) falls within the `cidr` range.
 *
 * Supports:
 *   "10.0.0.0/8"    — standard CIDR notation
 *   "10.0.0.5"      — bare IP treated as /32 (exact match)
 *
 * Returns false for any malformed IP or CIDR, and for IPv6 (not supported in V1).
 */
export function matchCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf("/");

  // Bare IP — exact match
  if (slashIdx === -1) return ip === cidr;

  const network = cidr.slice(0, slashIdx);
  const prefix  = parseInt(cidr.slice(slashIdx + 1), 10);

  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;

  const ipInt  = ipToUint32(ip);
  const netInt = ipToUint32(network);
  if (ipInt === null || netInt === null) return false;

  // /0 matches everything; otherwise build prefix mask (unsigned 32-bit)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/**
 * Convert a dotted-decimal IPv4 string to an unsigned 32-bit integer.
 * Returns null if the string is not a valid IPv4 address.
 */
function ipToUint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (isNaN(octet) || octet < 0 || octet > 255 || part.trim() !== String(octet)) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}


/**
 * Stage 0: Evaluate the security filter against the incoming action request.
 *
 * Blacklist mode: block if target matches any blocked pattern for the action type.
 * Whitelist mode: for network-facing actions, block unless target matches an allowed pattern.
 * CIDR check:     for network-facing actions, block if target IP is outside allowed_networks.
 *
 * @param request  The incoming action request
 * @param config   Parsed security filter config (from security.yaml)
 * @returns        StageResult with stage = "security"
 */
export function checkSecurityFilters(
  request: ActionRequest,
  config:  SecurityFilterConfig,
): StageResult {
  const start      = Date.now();
  const checks     = [];
  const target     = request.action.target;
  const actionType = request.action.type;

  // ── Blacklist mode ─────────────────────────────────────────────────────────
  if (config.mode === "blacklist") {
    for (const entry of config.blocked ?? []) {
      if (!entryApplies(entry, actionType)) continue;

      if (matchPattern(target, entry.pattern)) {
        checks.push(makeCheck(`security.blacklist.${entry.pattern}`, true, "BLOCK", entry.reason));
        return makeResult("BLOCK", start, checks);
      }
      checks.push(makeCheck(`security.blacklist.${entry.pattern}`, false, "PASS"));
    }
  }

  // ── Whitelist mode (network actions only) ──────────────────────────────────
  if (config.mode === "whitelist" && isNetworkAction(actionType)) {
    const allowedEntries = config.allowed ?? [];
    const matched = allowedEntries.some(
      (entry) => entryApplies(entry, actionType) && matchPattern(target, entry.pattern),
    );

    if (!matched) {
      const reason = `Whitelist mode: target "${target}" is not on the security allowlist`;
      checks.push(makeCheck("security.whitelist.no_match", true, "BLOCK", reason));
      return makeResult("BLOCK", start, checks);
    }
    checks.push(makeCheck("security.whitelist.matched", false, "PASS"));
  }

  // ── CIDR enforcement (network actions only, both modes) ───────────────────
  const allowedNetworks = config.allowed_networks ?? [];
  if (allowedNetworks.length > 0 && isNetworkAction(actionType)) {
    const ip = extractIpFromTarget(target);
    if (ip !== null) {
      const permitted = allowedNetworks.some((cidr) => matchCidr(ip, cidr));
      if (!permitted) {
        const reason = `Network access to "${ip}" is not in any allowed CIDR range`;
        checks.push(makeCheck("security.network.cidr_block", true, "BLOCK", reason));
        return makeResult("BLOCK", start, checks);
      }
      checks.push(makeCheck("security.network.cidr_ok", false, "PASS"));
    }
  }

  return makeResult("PASS", start, checks);
}


function isNetworkAction(actionType: string): boolean {
  return NETWORK_ACTION_TYPES.some((t) => matchAction(actionType, t));
}

function entryApplies(entry: SecurityFilterEntry, actionType: string): boolean {
  return entry.applies_to.some((pat) => matchAction(actionType, pat));
}

/**
 * Try to extract an IPv4 address from a URL or bare IP string.
 * Returns null if the target is a hostname (not an IP).
 */
function extractIpFromTarget(target: string): string | null {
  const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

  // Bare IP
  if (IPV4_RE.test(target)) return target;

  // URL — try to parse and extract hostname
  try {
    const url = new URL(target);
    if (IPV4_RE.test(url.hostname)) return url.hostname;
    return null;
  } catch (e: unknown) {
    void e; // cleanup-ignore: invalid URL in pure helper function — return null is control flow
    return null;
  }
}

interface RuleCheck {
  rule_id:     string;
  rule_source: string;
  matched:     boolean;
  verdict:     "PASS" | "BLOCK";
  reason?:     string;
}

function makeCheck(
  ruleId:  string,
  matched: boolean,
  verdict: "PASS" | "BLOCK",
  reason?: string,
): RuleCheck {
  return {
    rule_id:     ruleId,
    rule_source: SECURITY_SOURCE,
    matched,
    verdict,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function makeResult(
  verdict: "PASS" | "BLOCK",
  start:   number,
  checks:  RuleCheck[],
): StageResult {
  return {
    stage:         "security",
    verdict,
    duration_ms:   Date.now() - start,
    rules_checked: checks,
  };
}


/**
 * Default security config: blacklist mode, nothing blocked.
 * Used as a starting point by the CLI `security-mode` command and in tests.
 */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  filter: {
    mode:             "blacklist",
    blocked:          [],
    allowed:          [],
    allowed_networks: [],
  },
};
