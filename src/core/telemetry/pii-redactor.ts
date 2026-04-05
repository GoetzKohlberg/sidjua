// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA Error Telemetry — PII Redactor and Fingerprint Generation
 *
 * Removes sensitive data (API keys, file paths, IPs, emails, credentials)
 * before any error data leaves the installation.
 */

import { sha256hex } from "../crypto-utils.js";


// API key patterns — sk-* family covers OpenAI (sk-..., sk-proj-...) and Anthropic (sk-ant-...)
// xai- covers xAI / Grok keys; key-xxx covers generic key- prefixed tokens
// All patterns use the /u (Unicode) flag to prevent homoglyph bypass.
// redactPii() also applies NFKC normalization before matching so that visually
// similar Unicode characters (e.g., Cyrillic 'а' for Latin 'a') are collapsed.
const SK_KEY_PATTERN    = /\bsk-[A-Za-z0-9_-]+/gu;
const XAI_KEY_PATTERN   = /\bxai-[A-Za-z0-9_-]+/gu;
const BEARER_PATTERN    = /Bearer\s+[A-Za-z0-9_\-./+=]+/giu;
const KEYWORD_KEY_PATTERN =
  /\b(?:key|token|secret|password|apikey|api_key|access_token|auth_token)\s*[=:]\s*["']?[A-Za-z0-9_\-./+=]{16,}["']?/giu;

// File paths
const UNIX_PATH_PATTERN = /(?:\/home\/|\/Users\/|\/root\/|\/var\/|\/tmp\/|\/etc\/)[^\s"',;)\]]+/gu;
const WIN_PATH_PATTERN  = /[A-Za-z]:\\[^\s"',;)\]]+/gu;

// Network
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const IPV6_PATTERN = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/gu;

// Email
const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/gu;

// URLs with auth (userinfo)
const AUTH_URL_PATTERN = /https?:\/\/[^@\s]+@[^\s"',;)\]]+/giu;


/**
 * Returns true if the input contains any patterns that look like PII.
 *
 * Used as a quick pre-transmission check so drain() can
 * detect and re-apply redaction to events that may have been stored before
 * a pattern was added to redactPii(). Implemented as redactPii comparison
 * to stay in sync with the canonical pattern set without maintaining a
 * separate list.
 */
export function containsPotentialPii(input: string): boolean {
  return redactPii(input) !== input;
}

/**
 * Apply all PII redaction regex patterns to a string.
 * Internal helper — callers should use redactPii() which handles normalization.
 */
function applyRedactionPatterns(s: string): string {
  let result = s;

  // URLs with credentials first (before email/IP patterns)
  result = result.replace(AUTH_URL_PATTERN, '<url-redacted>');

  // API keys
  result = result.replace(SK_KEY_PATTERN,  '<api-key>');
  result = result.replace(XAI_KEY_PATTERN, '<api-key>');
  result = result.replace(BEARER_PATTERN,  'Bearer <redacted>');
  result = result.replace(KEYWORD_KEY_PATTERN, (match) => {
    const eqIdx = match.search(/[=:]/);
    return eqIdx !== -1 ? match.slice(0, eqIdx + 1) + ' <redacted>' : '<redacted>';
  });

  // File paths (Unix then Windows)
  result = result.replace(UNIX_PATH_PATTERN, '<path>');
  result = result.replace(WIN_PATH_PATTERN,  '<path>');

  // Network addresses
  result = result.replace(IPV6_PATTERN, '<ip>');
  result = result.replace(IPV4_PATTERN, '<ip>');

  // Email
  result = result.replace(EMAIL_PATTERN, '<email>');

  return result;
}

/**
 * Strip PII from a string. Idempotent: redactPii(redactPii(x)) === redactPii(x).
 *
 * Multi-pass strategy:
 *   1. NFKC normalization — collapses homoglyphs / full-width characters
 *   2. First-pass redaction — catch plain-text secrets
 *   3. URL-decode pass — catch URL-encoded secrets (e.g. sk-%61%62%63...)
 *
 * The URL-decode pass runs on the output of pass 1 so that already-redacted
 * placeholders are never re-decoded; only genuinely encoded residues are caught.
 */
export function redactPii(input: string): string {
  // Pass 1: NFKC normalization + pattern matching
  let result = applyRedactionPatterns(input.normalize("NFKC"));

  // Pass 2: URL-decode and re-apply patterns to catch percent-encoded secrets.
  // Only performed if decoding changes the string (skip on plain ASCII).
  let urlDecoded: string;
  try {
    urlDecoded = decodeURIComponent(result);
  } catch (_e) {
    // Malformed percent sequences — already redacted above, stop here.
    return result;
  }
  if (urlDecoded !== result) {
    const redactedDecoded = applyRedactionPatterns(urlDecoded);
    if (redactedDecoded !== urlDecoded) {
      // URL-decoded form contained PII — return the redacted decoded version
      return redactedDecoded;
    }
  }

  return result;
}


// Patterns to normalise within a stack trace
const STACK_PATH_PATTERN  = /(?:file:\/\/)?(?:[A-Za-z]:)?(?:\/[^\s():]+|\\[^\s():]+)+(?::\d+:\d+)?/g;
const STACK_ANON_PATTERN  = /\(eval at [^)]+\)/g;
const NODE_INTERNAL       = /node:internal\/[^\s)]+/g;
const LINE_COL_PATTERN    = /:\d+:\d+/g;

/**
 * Normalise a stack trace to a stable pattern:
 * - Replace file paths + line/column numbers with placeholders
 * - Keep function names and error type lines
 */
export function extractStackPattern(stack: string): string {
  let s = stack;
  s = s.replace(NODE_INTERNAL,    'node:<internal>');
  s = s.replace(STACK_PATH_PATTERN, '<file>');
  s = s.replace(STACK_ANON_PATTERN, '(eval)');
  s = s.replace(LINE_COL_PATTERN,   ':<line>');
  // Collapse whitespace changes to avoid diff on indentation
  s = s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return s;
}


/**
 * Generate a deterministic fingerprint for an error.
 * Same root cause from different installations → same fingerprint.
 */
export function generateFingerprint(errorType: string, stack: string): string {
  const stackPattern = extractStackPattern(stack);
  return sha256hex(`${errorType}:${stackPattern}`);
}


const CRITICAL_TYPES = new Set([
  'unhandledRejection',
  'uncaughtException',
  'GovernanceBypassed',
]);

const HIGH_TYPES = new Set([
  'DatabaseError',
  'ProviderAuthError',
  'AuthenticationError',
  'CorruptionError',
]);

const LOW_TYPES = new Set([
  'TimeoutError',
  'AbortError',
  'RetrySucceeded',
]);

/**
 * Classify error severity based on error type and message.
 */
export function classifySeverity(
  errorType: string,
  message: string,
  override?: string,
): 'low' | 'medium' | 'high' | 'critical' {
  if (override === 'critical' || CRITICAL_TYPES.has(errorType)) return 'critical';
  if (override === 'high'     || HIGH_TYPES.has(errorType))     return 'high';
  if (override === 'low'      || LOW_TYPES.has(errorType))      return 'low';
  if (override === 'medium')                                     return 'medium';

  // Heuristic: governance bypass or database corruption → critical/high
  const lower = message.toLowerCase();
  if (lower.includes('governance bypass') || lower.includes('process crash')) return 'critical';
  if (lower.includes('corrupt')           || lower.includes('auth fail'))     return 'high';
  if (lower.includes('timeout')           || lower.includes('retry'))         return 'low';

  return 'medium';
}
