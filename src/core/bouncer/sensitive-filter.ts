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
  /**
   * GUARDRAILS — rules for all patterns in this array:
   *
   * 1. NO NESTED QUANTIFIERS — every regex must be linear-time.
   *    Forbidden: (a+)+  (a|b)*c*  ([a-z]+)*
   *    Required: every quantifier applies to a character class or literal, never a group with quantifiers.
   *    Reason: ReDoS protection. Input is untrusted user text, adversarial input possible.
   *
   * 2. ANCHORED WITH \b — every pattern must start and end with \b word boundary.
   *    Reason: prevents partial matches inside longer strings (e.g. URLs, base64 blobs).
   *
   * 3. NO /g FLAG — patterns are defined without the global flag.
   *    The scanning engine creates a fresh RegExp with /g per call to prevent lastIndex leaking.
   *
   * 4. PREFIX-BASED ONLY for high confidence — patterns with distinctive vendor prefixes
   *    (sk-, gsk_, hf_, ghp_, AIza, etc.) get confidence: "high".
   *    Generic patterns without vendor prefix get confidence: "medium" and are
   *    only active in "strict" sensitivity mode.
   *
   * 5. MINIMUM LENGTH — every pattern must require a minimum token length that
   *    eliminates common English words and short identifiers. Minimum 20 chars
   *    for the variable portion after prefix.
   *
   * 6. FALSE POSITIVE REVIEW — before adding a pattern, verify it does NOT match:
   *    - Common English words or abbreviations
   *    - Git commit hashes (40-char hex)
   *    - UUIDs (8-4-4-4-12 format)
   *    - CSS color codes (#rrggbb)
   *    - Standard base64-encoded content (unless labeled as token)
   *
   * 7. LABEL CONVENTION — labels use lowercase snake_case: "{vendor}_{type}".
   *    Examples: openai_key, github_pat, anthropic_key.
   *
   * 8. OVERLAP RESOLUTION — if a string matches multiple patterns, the longest
   *    match wins (handled by scanning engine, not pattern definition).
   *    More specific patterns (sk-proj-) must appear BEFORE less specific (sk-).
   *
   * 9. ORDERING — patterns are ordered: specific vendor prefix first, then
   *    generic structural patterns last. Within vendors: more-specific before
   *    less-specific (sk-proj- before sk-, sk_live_ before sk_test_).
   *
   * 10. IMMUTABLE IN PRODUCTION — these patterns are the system baseline.
   *     Users extend via custom-patterns.yaml (V1.2), never by editing this file.
   *     System patterns cannot be disabled by user configuration.
   */

  // ── LLM Providers ─────────────────────────────────────────────────────────────
  // sk-proj- must appear BEFORE sk-compatible (more specific wins on overlap)
  {
    label:      "openai_proj",
    pattern:    /\bsk-proj-[A-Za-z0-9_-]{32,}\b/,
    confidence: "high",
  },
  {
    label:      "openai_compatible_key",
    pattern:    /\bsk-[A-Za-z0-9]{32,}\b/,
    confidence: "high",
  },

  // ── Anthropic ─────────────────────────────────────────────────────────────────
  {
    label:      "anthropic_key",
    pattern:    /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
    confidence: "high",
  },

  // ── xAI / Groq ────────────────────────────────────────────────────────────────
  {
    label:      "xai_groq_key",
    pattern:    /\bgsk_[A-Za-z0-9]{20,}\b/,
    confidence: "high",
  },

  // ── HuggingFace ───────────────────────────────────────────────────────────────
  {
    label:      "huggingface_token",
    pattern:    /\bhf_[A-Za-z0-9]{20,}\b/,
    confidence: "high",
  },

  // ── Replicate ─────────────────────────────────────────────────────────────────
  {
    label:      "replicate_token",
    pattern:    /\br8_[A-Za-z0-9]{20,}\b/,
    confidence: "high",
  },

  // ── Perplexity ────────────────────────────────────────────────────────────────
  {
    label:      "perplexity_key",
    pattern:    /\bpplx-[A-Za-z0-9]{48,}\b/,
    confidence: "high",
  },

  // ── Fireworks AI ──────────────────────────────────────────────────────────────
  {
    label:      "fireworks_key",
    pattern:    /\bfw_[A-Za-z0-9]{20,}\b/,
    confidence: "high",
  },

  // ── Google ────────────────────────────────────────────────────────────────────
  {
    label:      "google_api",
    pattern:    /\bAIza[A-Za-z0-9_-]{35}\b/,
    confidence: "high",
  },

  // ── Cloud / Infra ─────────────────────────────────────────────────────────────
  {
    label:      "aws_access",
    pattern:    /\bAKIA[A-Z0-9]{16}\b/,
    confidence: "high",
  },

  // ── DigitalOcean ──────────────────────────────────────────────────────────────
  {
    label:      "digitalocean_token",
    pattern:    /\bdop_v1_[a-f0-9]{64}\b/,
    confidence: "high",
  },

  // ── Databricks ────────────────────────────────────────────────────────────────
  {
    label:      "databricks_token",
    pattern:    /\bdapi[a-f0-9]{32,}\b/,
    confidence: "high",
  },

  // ── Vercel ────────────────────────────────────────────────────────────────────
  {
    label:      "vercel_token",
    pattern:    /\bvercel_[A-Za-z0-9]{24,}\b/,
    confidence: "high",
  },

  // ── Netlify ───────────────────────────────────────────────────────────────────
  {
    label:      "netlify_token",
    pattern:    /\bnfp_[A-Za-z0-9]{40,}\b/,
    confidence: "high",
  },

  // ── Payment ───────────────────────────────────────────────────────────────────
  // sk_live_ before sk_test_ (more specific first within Stripe)
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

  // ── Stripe test keys ──────────────────────────────────────────────────────────
  {
    label:      "stripe_test",
    pattern:    /\bsk_test_[A-Za-z0-9]{24,}\b/,
    confidence: "high",
  },

  // ── Stripe publishable ────────────────────────────────────────────────────────
  {
    label:      "stripe_publishable",
    pattern:    /\bpk_(live|test)_[A-Za-z0-9]{24,}\b/,
    confidence: "high",
  },

  // ── Shopify ───────────────────────────────────────────────────────────────────
  {
    label:      "shopify_token",
    pattern:    /\bshp(at|ss|ca|pa)_[a-f0-9]{32,}\b/,
    confidence: "high",
  },

  // ── DevTools ──────────────────────────────────────────────────────────────────
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

  // ── GitLab PAT ────────────────────────────────────────────────────────────────
  {
    label:      "gitlab_pat",
    pattern:    /\bglpat-[A-Za-z0-9_-]{20,}\b/,
    confidence: "high",
  },

  // ── npm token ─────────────────────────────────────────────────────────────────
  {
    label:      "npm_token",
    pattern:    /\bnpm_[A-Za-z0-9]{36,}\b/,
    confidence: "high",
  },

  // ── PyPI token ────────────────────────────────────────────────────────────────
  {
    label:      "pypi_token",
    pattern:    /\bpypi-[A-Za-z0-9_-]{50,}\b/,
    confidence: "high",
  },

  // ── Communication ─────────────────────────────────────────────────────────────
  {
    label:      "slack_token",
    pattern:    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    confidence: "high",
  },
  {
    label:      "discord_token",
    pattern:    /\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/,
    confidence: "high",
  },

  // ── Telegram Bot ──────────────────────────────────────────────────────────────
  {
    label:      "telegram_bot",
    pattern:    /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
    confidence: "high",
  },

  // ── Twilio ────────────────────────────────────────────────────────────────────
  {
    label:      "twilio_key",
    pattern:    /\bSK[a-f0-9]{32}\b/,
    confidence: "high",
  },

  // ── SendGrid ──────────────────────────────────────────────────────────────────
  {
    label:      "sendgrid_key",
    pattern:    /\bSG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}\b/,
    confidence: "high",
  },

  // ── Mailgun ───────────────────────────────────────────────────────────────────
  {
    label:      "mailgun_key",
    pattern:    /\bkey-[a-f0-9]{32}\b/,
    confidence: "high",
  },

  // ── Linear ────────────────────────────────────────────────────────────────────
  {
    label:      "linear_key",
    pattern:    /\blin_api_[A-Za-z0-9]{30,}\b/,
    confidence: "high",
  },

  // ── Notion ────────────────────────────────────────────────────────────────────
  {
    label:      "notion_token",
    pattern:    /\bntn_[A-Za-z0-9]{40,}\b/,
    confidence: "high",
  },

  // ── Structural ────────────────────────────────────────────────────────────────

  // ── JWT ───────────────────────────────────────────────────────────────────────
  {
    label:      "jwt_token",
    pattern:    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    confidence: "high",
  },

  // ── SSH private key ───────────────────────────────────────────────────────────
  {
    label:      "ssh_private",
    pattern:    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    confidence: "high",
  },

  // ── SSH public key ────────────────────────────────────────────────────────────
  {
    label:      "ssh_public_key",
    pattern:    /\bssh-(ed25519|rsa|ecdsa|dsa)\s+[A-Za-z0-9+\/]{20,}/,
    confidence: "high",
  },

  // ── Database connection strings ───────────────────────────────────────────────
  {
    label:      "db_connection",
    pattern:    /(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^:@\s]+:[^@\s]+@[^\s]+/i,
    confidence: "high",
  },

  // ── URLs with credentials ─────────────────────────────────────────────────────
  {
    label:      "basic_auth_url",
    pattern:    /https?:\/\/[^:@\s]+:[^@\s]+@[^\s]+/,
    confidence: "high",
  },

  // ── Bearer tokens ─────────────────────────────────────────────────────────────
  {
    label:      "bearer_token",
    pattern:    /\bBearer\s+([A-Za-z0-9_\-./+]{20,})\b/,
    confidence: "high",
  },

  // ── Heuristic / medium (active in "strict" mode only, except labeled_password) ─

  // ── Labeled passwords (medium — requires label context) ───────────────────────
  {
    label:      "labeled_password",
    pattern:    /(?:password|passwd|pwd|secret|api[_-]?key)\s*[=:]\s*["']?([^\s"']{8,})["']?/i,
    confidence: "medium",
  },

  // ── Generic hex secrets (medium — long hex strings with label context) ─────────
  {
    label:      "hex_secret",
    pattern:    /(?:secret|token|key|hash)\s*[=:]\s*["']?([0-9a-fA-F]{32,})["']?/i,
    confidence: "medium",
  },

  // ── Mistral (medium — key:secret format, no distinctive prefix) ───────────────
  {
    label:      "mistral_key",
    pattern:    /\b[A-Za-z0-9]{32}:[A-Za-z0-9]{32}\b/,
    confidence: "medium",
  },

  // ── Cohere (medium — 40-char alphanumeric, no distinctive prefix) ─────────────
  {
    label:      "cohere_key",
    pattern:    /\b[a-zA-Z0-9]{40}\b/,
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
