// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Bouncer Sensitive Data Filter
 *
 * Pure stateless function that scans text for sensitive data patterns.
 * No I/O — safe to use in any context.
 *
 * Overlap resolution: longer match wins.
 * Scan limit: 100 KiB input cap.
 */

import type { SensitivityLevel, SensitiveMatch, ScanResult } from "./bouncer-types.js";

const MAX_SCAN_BYTES = 100 * 1024; // 100 KiB

/** Definition of a single detection pattern. */
interface PatternDef {
  label:       string;
  /** Source and flags for the pattern. The /g flag must NOT be included here —
   *  a fresh RegExp with the g flag is created per scan call to avoid lastIndex
   *  state leaking between concurrent scans (stateful regex bug). */
  pattern:     RegExp;
  confidence:  "high" | "medium";
}

/**
 * All detection patterns.
 *
 * High confidence: tight vendor-specific prefixes or strong structural markers
 * Medium confidence: broader heuristics (labeled passwords, generic hex, etc.)
 */
const PATTERNS: PatternDef[] = [
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  {
    label:      "openai_key",
    pattern:    /\bsk-[A-Za-z0-9]{32,}\b/,
    confidence: "high",
  },
  {
    label:      "openai_proj",
    pattern:    /\bsk-proj-[A-Za-z0-9_-]{32,}\b/,
    confidence: "high",
  },

  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    label:      "anthropic_key",
    pattern:    /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
    confidence: "high",
  },

  // ── Stripe ─────────────────────────────────────────────────────────────────
  {
    label:      "stripe_live",
    pattern:    /\bsk_live_[A-Za-z0-9]{24,}\b/,
    confidence: "high",
  },
  {
    label:      "stripe_secret",
    pattern:    /\brk_live_[A-Za-z0-9]{24,}\b/,
    confidence: "high",
  },

  // ── GitHub ─────────────────────────────────────────────────────────────────
  {
    label:      "github_pat",
    pattern:    /\bghp_[A-Za-z0-9]{36}\b/,
    confidence: "high",
  },
  {
    label:      "github_fine",
    pattern:    /\bgithub_pat_[A-Za-z0-9_]{80,}\b/,
    confidence: "high",
  },

  // ── AWS ────────────────────────────────────────────────────────────────────
  {
    label:      "aws_access",
    pattern:    /\bAKIA[A-Z0-9]{16}\b/,
    confidence: "high",
  },

  // ── Google ─────────────────────────────────────────────────────────────────
  {
    label:      "google_api",
    pattern:    /\bAIza[A-Za-z0-9_-]{35}\b/,
    confidence: "high",
  },

  // ── Slack ──────────────────────────────────────────────────────────────────
  {
    label:      "slack_token",
    pattern:    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    confidence: "high",
  },

  // ── Discord ────────────────────────────────────────────────────────────────
  {
    label:      "discord_token",
    pattern:    /\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/,
    confidence: "high",
  },

  // ── JWT ────────────────────────────────────────────────────────────────────
  {
    label:      "jwt_token",
    pattern:    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    confidence: "high",
  },

  // ── SSH private key ────────────────────────────────────────────────────────
  {
    label:      "ssh_private",
    pattern:    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    confidence: "high",
  },

  // ── Database connection strings ────────────────────────────────────────────
  {
    label:      "db_connection",
    pattern:    /(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^:@\s]+:[^@\s]+@[^\s]+/i,
    confidence: "high",
  },

  // ── URLs with credentials ──────────────────────────────────────────────────
  {
    label:      "basic_auth_url",
    pattern:    /https?:\/\/[^:@\s]+:[^@\s]+@[^\s]+/,
    confidence: "high",
  },

  // ── Bearer tokens ─────────────────────────────────────────────────────────
  {
    label:      "bearer_token",
    pattern:    /\bBearer\s+([A-Za-z0-9_\-./+]{20,})\b/,
    confidence: "high",
  },

  // ── Labeled passwords (medium — requires label context) ───────────────────
  {
    label:      "labeled_password",
    pattern:    /(?:password|passwd|pwd|secret|api[_-]?key)\s*[=:]\s*["']?([^\s"']{8,})["']?/i,
    confidence: "medium",
  },

  // ── Generic hex secrets (medium — long hex strings with label context) ─────
  {
    label:      "hex_secret",
    pattern:    /(?:secret|token|key|hash)\s*[=:]\s*["']?([0-9a-fA-F]{32,})["']?/i,
    confidence: "medium",
  },
];

/** Patterns active at each sensitivity level. */
const LEVEL_FILTER: Record<SensitivityLevel, (p: PatternDef) => boolean> = {
  strict:  ()             => true,
  normal:  (p)            => p.confidence === "high" || p.label === "labeled_password",
  relaxed: (p)            => p.confidence === "high",
};

/**
 * Scan `text` for sensitive data patterns.
 *
 * @param text       - Input text to scan (capped at 100 KiB)
 * @param level      - Sensitivity level; defaults to "normal"
 * @returns          - ScanResult with detected flag, matches, and redacted text
 */
export function scanForSensitiveData(
  text:  string,
  level: SensitivityLevel = "normal",
): ScanResult {
  // Enforce scan limit
  const input = Buffer.byteLength(text, "utf8") > MAX_SCAN_BYTES
    ? text.slice(0, MAX_SCAN_BYTES)
    : text;

  const activePatterns = PATTERNS.filter(LEVEL_FILTER[level]);

  // Collect raw matches
  const rawMatches: SensitiveMatch[] = [];

  for (const def of activePatterns) {
    // Create a fresh regex with the global flag each scan to prevent lastIndex
    // leaking between concurrent calls (stateful /g regex bug).
    const re = new RegExp(def.pattern.source, def.pattern.flags + "g");

    for (const m of input.matchAll(re)) {
      if (m.index === undefined) continue;
      const start = m.index;
      const end   = start + m[0].length;
      rawMatches.push({
        label:      def.label,
        value:      m[0],
        start,
        end,
        confidence: def.confidence,
      });
    }
  }

  if (rawMatches.length === 0) {
    return { detected: false, matches: [], redacted: input };
  }

  // Sort by start offset, then by length descending (longer match wins at same start)
  rawMatches.sort((a, b) => a.start !== b.start ? a.start - b.start : (b.end - b.start) - (a.end - a.start));

  // Resolve overlaps: longer match wins
  const resolved: SensitiveMatch[] = [];
  let cursor = 0;
  for (const m of rawMatches) {
    if (m.start < cursor) {
      // Overlaps with previous — skip (previous was longer or same start)
      continue;
    }
    resolved.push(m);
    cursor = m.end;
  }

  // Build redacted string
  const parts: string[] = [];
  let pos = 0;
  for (const m of resolved) {
    if (m.start > pos) {
      parts.push(input.slice(pos, m.start));
    }
    parts.push(`[REDACTED:${m.label}]`);
    pos = m.end;
  }
  if (pos < input.length) {
    parts.push(input.slice(pos));
  }

  return {
    detected: true,
    matches:  resolved,
    redacted: parts.join(""),
  };
}
