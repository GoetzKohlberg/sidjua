// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Bouncer Sensitive Data Filter: Types
 *
 * Type definitions for the bouncer regex engine that scans text
 * for sensitive data patterns (API keys, credentials, tokens, etc.)
 */

/**
 * Sensitivity level controls which pattern categories are active.
 *
 * - strict:  All patterns including medium-confidence heuristics
 * - normal:  High-confidence patterns + labeled medium-confidence (default)
 * - relaxed: High-confidence patterns only
 */
export type SensitivityLevel = "strict" | "normal" | "relaxed";

/**
 * A single sensitive match found in scanned text.
 */
export interface SensitiveMatch {
  /** Label identifying the type of sensitive data (e.g. "openai_key") */
  label:      string;
  /** The matched string (raw value, before redaction) */
  value:      string;
  /** Start byte offset within the original text */
  start:      number;
  /** End byte offset within the original text (exclusive) */
  end:        number;
  /** Confidence level for this match */
  confidence: "high" | "medium";
}

/**
 * The result of scanning a piece of text for sensitive data.
 */
export interface ScanResult {
  /** True if any sensitive patterns were found */
  detected:  boolean;
  /** All matches found, sorted by start offset */
  matches:   SensitiveMatch[];
  /** Version of the text with all matches replaced by [REDACTED:<label>] */
  redacted:  string;
}
