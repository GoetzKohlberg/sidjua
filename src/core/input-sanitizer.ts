// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.8: Input Sanitizer
 *
 * Detects and blocks prompt injection, delimiter injection, encoding attacks,
 * and privilege escalation attempts in task descriptions and tool parameters.
 *
 * Three modes:
 *   block — reject input, return INPUT-001 error
 *   warn  — allow but attach warnings, log to audit trail
 *   off   — no-op, zero overhead
 *
 * Configuration per division in divisions.yaml:
 *   security:
 *     input_sanitization:
 *       mode: block | warn | off
 *       max_length: 200000
 *       custom_patterns: []
 */

import { SidjuaError } from "./error-codes.js";


export type SanitizationMode = "block" | "warn" | "off";

export interface SanitizationWarning {
  type:     "injection_pattern" | "encoding_attack" | "excessive_length" | "suspicious_structure" | "unicode_manipulation";
  detail:   string;
  position: number;
}

export interface SanitizationResult {
  sanitized:  string;
  /** NFKC-normalized, zero-width-stripped text used for pattern analysis. */
  normalized: string;
  warnings:   SanitizationWarning[];
  blocked:    boolean;
  blockReason?: string;
}

export interface SanitizerConfig {
  mode:            SanitizationMode;
  maxLength:       number;
  customPatterns?: string[];
}

export const DEFAULT_SANITIZER_CONFIG: SanitizerConfig = {
  mode:      "block",
  maxLength: 200_000,
};


interface DetectionPattern {
  type:    SanitizationWarning["type"];
  pattern: RegExp;
  detail:  string;
}

/** System prompt override attempts */
const INJECTION_PATTERNS: DetectionPattern[] = [
  { type: "injection_pattern", pattern: /ignore\s+previous\s+instructions?/i,     detail: "System prompt override: 'ignore previous instructions'" },
  { type: "injection_pattern", pattern: /you\s+are\s+now\b/i,                     detail: "System prompt override: 'you are now'" },
  { type: "injection_pattern", pattern: /\bact\s+as\b/i,                          detail: "System prompt override: 'act as'" },
  { type: "injection_pattern", pattern: /\bpretend\s+to\s+be\b/i,                 detail: "System prompt override: 'pretend to be'" },
  { type: "injection_pattern", pattern: /\bsystem\s*:/i,                          detail: "System prompt override: 'system:'" },
  { type: "injection_pattern", pattern: /\[SYSTEM\]/i,                            detail: "System prompt override: '[SYSTEM]'" },
  { type: "injection_pattern", pattern: /<\|system\|>/i,                          detail: "Delimiter injection: '<|system|>'" },
  { type: "injection_pattern", pattern: /<<SYS>>/i,                               detail: "Delimiter injection: '<<SYS>>'" },
  { type: "injection_pattern", pattern: /new\s+instructions?\s*:/i,               detail: "System prompt override: 'new instructions:'" },
  { type: "injection_pattern", pattern: /\boverride\s*:/i,                        detail: "System prompt override: 'override:'" },
  { type: "injection_pattern", pattern: /forget\s+everything/i,                   detail: "System prompt override: 'forget everything'" },
];

/** Delimiter / structure injection */
const DELIMITER_PATTERNS: DetectionPattern[] = [
  { type: "suspicious_structure", pattern: /^-{5,}$/m,                            detail: "Delimiter injection: section separator (---)" },
  { type: "suspicious_structure", pattern: /^={5,}$/m,                            detail: "Delimiter injection: section separator (===)" },
  { type: "suspicious_structure", pattern: /^\*{5,}$/m,                           detail: "Delimiter injection: section separator (***)" },
  { type: "suspicious_structure", pattern: /<instructions\s*>/i,                  detail: "Delimiter injection: '<instructions>' tag" },
  { type: "suspicious_structure", pattern: /<system\s*>/i,                        detail: "Delimiter injection: '<system>' tag" },
  { type: "suspicious_structure", pattern: /<prompt\s*>/i,                        detail: "Delimiter injection: '<prompt>' tag" },
  { type: "suspicious_structure", pattern: /\{"role"\s*:\s*"system"/i,            detail: "JSON injection: '{\"role\": \"system\"...}'" },
];

/** Encoding attacks */
const ENCODING_PATTERNS: DetectionPattern[] = [
  { type: "encoding_attack", pattern: /[\u200B-\u200F\uFEFF\u2028\u2029]/,       detail: "Zero-width or line-separator character detected" },
];

/** Privilege escalation */
const ESCALATION_PATTERNS: DetectionPattern[] = [
  { type: "injection_pattern", pattern: /\bas\s+T1\b/i,                          detail: "Privilege escalation: 'as T1'" },
  { type: "injection_pattern", pattern: /with\s+T1\s+authority/i,                detail: "Privilege escalation: 'with T1 authority'" },
  { type: "injection_pattern", pattern: /\bescalate\s+to\b/i,                    detail: "Privilege escalation: 'escalate to'" },
  { type: "injection_pattern", pattern: /\baccess\s+division\b/i,                detail: "Division boundary crossing: 'access division'" },
  { type: "injection_pattern", pattern: /\bread\s+from\s+\[/i,                   detail: "Division boundary crossing: 'read from [...]'" },
  { type: "injection_pattern", pattern: /\bskip\s+approval\b/i,                  detail: "Governance bypass: 'skip approval'" },
  { type: "injection_pattern", pattern: /\bignore\s+policy\b/i,                  detail: "Governance bypass: 'ignore policy'" },
  { type: "injection_pattern", pattern: /\bbypass\s+governance\b/i,              detail: "Governance bypass: 'bypass governance'" },
];

/** All built-in patterns combined */
const ALL_PATTERNS: DetectionPattern[] = [
  ...INJECTION_PATTERNS,
  ...DELIMITER_PATTERNS,
  ...ENCODING_PATTERNS,
  ...ESCALATION_PATTERNS,
];


/**
 * Estimate the maximum character length a regex could match.
 *
 * Rules:
 *   - Open quantifiers (+, *, {n,}) → conservative upper bound of 500.
 *   - Bounded quantifiers ({n,m})    → m × estimated segment length.
 *   - Literal / simple patterns      → source.length.
 */
function estimateMaxMatchLength(pattern: RegExp): number {
  const src = pattern.source;
  // Open quantifiers: match could extend arbitrarily → conservative bound
  if (/[+*]|{\d+,}/.test(src)) return 500;
  // Bounded quantifier {n,m}: extract m and multiply by a segment estimate
  const bounded = /\{(\d+),(\d+)\}/.exec(src);
  if (bounded !== null) {
    const m           = parseInt(bounded[2] ?? "0", 10);
    const segEstimate = 4; // conservative chars per unit
    return m * segEstimate;
  }
  // No quantifiers → source length is a safe upper bound
  return src.length;
}

/**
 * Compute the chunk overlap needed to detect patterns that span chunk boundaries.
 *
 * The overlap must be at least as long as the longest possible pattern match.
 * A floor of 500 preserves backward compatibility.
 */
function computeChunkOverlap(patterns: DetectionPattern[]): number {
  const maxPatternLength = patterns.reduce<number>((max, p) => {
    return Math.max(max, estimateMaxMatchLength(p.pattern));
  }, 0);
  const overlap = Math.max(maxPatternLength * 2, 500);
  // Safety assertion: overlap should not exceed half the chunk size (5000)
  // to avoid scanning the same region three times.
  if (overlap > 2_500) {
    // Non-fatal: log but do not throw — a large overlap is safe but wasteful.
    // Using process.stderr to avoid circular dependency with logger.
    process.stderr.write(
      `[input-sanitizer] Warning: CHUNK_OVERLAP=${overlap} exceeds CHUNK_SIZE/2 (2500). ` +
      `Consider splitting long patterns.\n`,
    );
  }
  return overlap;
}


/**
 * Characters valid in base64 (standard + URL-safe alphabet).
 *
 * Stored as a Set for O(1) per-character lookup in the linear scan.
 * The original regex `/[A-Za-z0-9+/\-_]{200,}={0,2}/g` used an open
 * quantifier `{200,}` which triggers catastrophic backtracking on inputs
 * such as "AAAA…A!" (200 near-base64 chars followed by an invalid char).
 * The Set-based linear scan below is O(n) with no backtracking.
 */
const BASE64_CHAR_SET = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_".split(""),
);

/** Minimum consecutive base64 chars before flagging as suspicious. */
const BASE64_MIN_RUN = 200;

/**
 * Detect base64 blocks longer than 200 chars — potential encoded instructions.
 *
 * Threshold raised from 50 to 200 to avoid false positives on JWTs,
 * Bearer tokens, and other short legitimate base64 payloads.
 *
 * Strip any leading auth header prefix (Bearer/Basic) before scanning
 * so that a payload of the form "Bearer <token> <b64-payload>" is not
 * silently ignored.  The prefix itself is skipped, but the remainder is
 * fully scanned.
 *
 * Implementation: linear O(n) character-by-character scan — no regex
 * backtracking risk.
 */
function detectBase64(text: string): SanitizationWarning[] {
  // Strip a leading auth header prefix so the remainder is still scanned.
  // A plain "Bearer <token>" is legitimate; any base64 AFTER it is suspicious.
  const authPrefixMatch = /^(Bearer|Basic)\s+\S+\s*/i.exec(text);
  const scanText   = authPrefixMatch !== null ? text.slice(authPrefixMatch[0].length) : text;
  const baseOffset = authPrefixMatch !== null ? authPrefixMatch[0].length : 0;

  const warnings: SanitizationWarning[] = [];
  let runStart = -1;
  let runLen   = 0;

  for (let i = 0; i <= scanText.length; i++) {
    // Use a sentinel value past the end to flush the last run
    const ch = i < scanText.length ? scanText[i]! : "\0";

    if (BASE64_CHAR_SET.has(ch)) {
      if (runStart === -1) runStart = i;
      runLen++;
    } else {
      if (runLen >= BASE64_MIN_RUN) {
        warnings.push({
          type:     "encoding_attack",
          detail:   "Possible base64-encoded instruction block (>200 chars)",
          position: runStart + baseOffset,
        });
      }
      runStart = -1;
      runLen   = 0;
    }
  }

  return warnings;
}


export class InputSanitizer {
  private readonly config:          SanitizerConfig;
  private readonly customPatterns:  DetectionPattern[];

  constructor(config: Partial<SanitizerConfig> = {}) {
    this.config = { ...DEFAULT_SANITIZER_CONFIG, ...config };
    this.customPatterns = (config.customPatterns ?? []).map((p) => {
      // Validate custom pattern to prevent ReDoS attacks via crafted user-supplied regexes.

      // 1. Length guard: very long patterns consume CPU at compile time
      if (p.length > 500) {
        throw SidjuaError.from(
          "INPUT-003",
          `Custom pattern too long: ${p.length} chars (max 500)`,
        );
      }

      // 2. Nested-quantifier guard: detect groups/classes followed by a quantifier
      //    when the group/class itself already contains a quantifier — the classic
      //    catastrophic-backtracking pattern (e.g. (a+)+ or (.+){2,}).
      const innerGroupMatch = /\(([^)]+)\)[+*{]/.exec(p);
      if (innerGroupMatch !== null && /[+*{]/.test(innerGroupMatch[1]!)) {
        throw SidjuaError.from(
          "INPUT-003",
          `Custom pattern contains nested quantifiers (potential ReDoS): "${p.slice(0, 80)}"`,
        );
      }

      // 3. Syntax check — compile the regex inside a try/catch so that invalid
      //    patterns produce a clear error rather than throwing mid-sanitize.
      try {
        return {
          type:    "injection_pattern" as const,
          pattern: new RegExp(p, "gi"),
          detail:  `Custom pattern: ${p}`,
        };
      } catch (err: unknown) {
        throw SidjuaError.from(
          "INPUT-003",
          `Invalid custom regex pattern: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  /**
   * Zero-width and invisible Unicode characters that can split injection patterns.
   * These are stripped from the input before pattern matching (after NFKC normalization).
   */
  private static readonly ZERO_WIDTH_RE =
    /[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E]/g;

  /**
   * Normalize a text string for pattern analysis:
   *   1. NFKC decomposition — collapses fullwidth chars, ligatures, compatibility equivalents
   *   2. Zero-width stripping — removes invisible chars that could split injection keywords
   */
  private static normalizeForAnalysis(text: string): string {
    return text.normalize("NFKC").replace(InputSanitizer.ZERO_WIDTH_RE, "");
  }

  /**
   * Sanitize input text.
   *
   * - `off`  : returns unchanged, empty warnings, blocked=false
   * - `warn` : detects and returns warnings, blocked=false
   * - `block`: throws SidjuaError INPUT-001 if any pattern matches
   *
   * ReDoS protection: Inputs longer than CHUNK_THRESHOLD chars are processed in
   * CHUNK_SIZE-char segments to limit the worst-case regex backtracking scope.
   * Unicode bypass protection: NFKC normalization + zero-width stripping applied
   * before pattern matching to prevent fullwidth / invisible-char bypass.
   *
   * @throws SidjuaError (INPUT-001 | INPUT-002 | INPUT-003) in block mode
   */
  sanitize(text: string): SanitizationResult {
    // Off mode — zero overhead
    if (this.config.mode === "off") {
      return { sanitized: text, normalized: text, warnings: [], blocked: false };
    }

    const _sanitizeStart = Date.now();

    // Apply NFKC normalization + zero-width stripping BEFORE any analysis.
    // This prevents bypass via fullwidth characters or invisible splitters.
    const normalizedText = InputSanitizer.normalizeForAnalysis(text);

    // Collect unicode_manipulation warning when the input was altered by normalization
    const unicodeWarnings: SanitizationWarning[] =
      normalizedText !== text
        ? [{
            type:     "unicode_manipulation",
            detail:   "Input contained zero-width or compatibility-mapped Unicode characters that were normalized before analysis",
            position: 0,
          }]
        : [];

    // Length check (measured on normalized text to prevent length confusion)
    if (normalizedText.length > this.config.maxLength) {
      const warn: SanitizationWarning = {
        type:     "excessive_length",
        detail:   `Input length ${normalizedText.length} exceeds limit ${this.config.maxLength}`,
        position: this.config.maxLength,
      };

      if (this.config.mode === "block") {
        throw SidjuaError.from(
          "INPUT-002",
          `Input length ${normalizedText.length} > max ${this.config.maxLength}`,
        );
      }

      return {
        sanitized:  text,
        normalized: normalizedText,
        warnings:   [...unicodeWarnings, warn],
        blocked:    false,
      };
    }

    // Chunk long inputs to limit ReDoS exposure.
    // Inputs > CHUNK_THRESHOLD chars are split into CHUNK_SIZE-char segments.
    // Each segment is scanned independently; position offsets are adjusted.
    // All scanning operates on normalizedText (NFKC + zero-width stripped).
    const CHUNK_THRESHOLD = 10_000;
    const CHUNK_SIZE      = 5_000;
    // CHUNK_OVERLAP is derived from the longest possible pattern match
    // length rather than being a magic constant. This guarantees detection even
    // when a pattern spans a chunk boundary.
    const CHUNK_OVERLAP   = computeChunkOverlap([...ALL_PATTERNS, ...this.customPatterns]);

    const warnings: SanitizationWarning[] = [...unicodeWarnings];
    const seenPositions = new Set<string>();
    const allPatterns = [...ALL_PATTERNS, ...this.customPatterns];

    if (normalizedText.length > CHUNK_THRESHOLD) {
      // Chunked scan with overlap to prevent boundary-splitting bypass
      for (let start = 0; start < normalizedText.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
        const chunk = normalizedText.slice(start, start + CHUNK_SIZE);
        for (const def of allPatterns) {
          def.pattern.lastIndex = 0;
          const match = def.pattern.exec(chunk);
          if (match !== null) {
            const absPos  = start + match.index;
            const dedupKey = `${def.type}:${absPos}`;
            if (!seenPositions.has(dedupKey)) {
              seenPositions.add(dedupKey);
              warnings.push({ type: def.type, detail: def.detail, position: absPos });
            }
          }
        }
        // Base64 detection per chunk (deduplicated)
        for (const w of detectBase64(chunk)) {
          const absPos   = start + w.position;
          const dedupKey = `base64:${absPos}`;
          if (!seenPositions.has(dedupKey)) {
            seenPositions.add(dedupKey);
            warnings.push({ ...w, position: absPos });
          }
        }
      }
    } else {
      // Standard scan — single pass for short inputs
      for (const def of allPatterns) {
        def.pattern.lastIndex = 0;
        const match = def.pattern.exec(normalizedText);
        if (match !== null) {
          warnings.push({ type: def.type, detail: def.detail, position: match.index });
        }
      }
      warnings.push(...detectBase64(normalizedText));
    }

    if (warnings.length > 0 && this.config.mode === "block") {
      const reason = warnings[0]?.detail ?? "Injection pattern detected";
      throw SidjuaError.from("INPUT-001", reason);
    }

    // Performance warning: if sanitize() exceeds 100ms, log a warning.
    // This can indicate an unusually large or complex input worth investigating.
    const _sanitizeElapsed = Date.now() - _sanitizeStart;
    if (_sanitizeElapsed > 100) {
      process.stderr.write(
        `[input-sanitizer] Performance warning: sanitize() took ${_sanitizeElapsed}ms ` +
        `(>100ms threshold). Input length: ${text.length} chars.\n`,
      );
    }

    return {
      sanitized:  text,          // Original text returned unchanged — detection is advisory
      normalized: normalizedText,
      warnings,
      blocked: false,
    };
  }

  /**
   * Sanitize a record of parameters (used for tool action params).
   * Recursively traverses nested objects and arrays — prevents bypass
   * via nested payloads that were previously skipped by the flat top-level check.
   *
   * @throws SidjuaError in block mode if any string value triggers a pattern
   */
  sanitizeParams(params: Record<string, unknown>): SanitizationResult {
    const allWarnings: SanitizationWarning[] = [];
    const MAX_DEPTH  = 50;
    const seen       = new WeakSet<object>();

    const traverse = (obj: unknown, path: string, depth: number): void => {
      if (depth > MAX_DEPTH) {
        // Throw instead of silently returning — a deeply nested object
        // that exceeds the limit is treated as a structural violation, not a
        // harmless no-op.  This prevents bypass via deeply-nested payloads.
        throw SidjuaError.from(
          "INPUT-002",
          `Object nesting depth ${depth} exceeds limit ${MAX_DEPTH}`,
        );
      }

      if (typeof obj === "string") {
        // sanitize() throws in block mode, collects in warn mode
        const result = this.sanitize(obj);
        for (const w of result.warnings) {
          allWarnings.push({ ...w, detail: path ? `[${path}] ${w.detail}` : w.detail });
        }
      } else if (Array.isArray(obj)) {
        if (seen.has(obj)) return;
        seen.add(obj);
        (obj as unknown[]).forEach((item, index) => {
          traverse(item, path ? `${path}[${index}]` : `[${index}]`, depth + 1);
        });
      } else if (obj !== null && typeof obj === "object") {
        if (seen.has(obj as object)) return;
        seen.add(obj as object);
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
          // Scan key itself as a string — prevents injection via JSON key names
          traverse(key, path ? `${path}.__key__` : "__key__", depth + 1);
          traverse(value, path ? `${path}.${key}` : key, depth + 1);
        }
      }
      // number / boolean / null are not injectable — skip
    };

    traverse(params, "", 0);

    let serialized: string;
    try {
      serialized = JSON.stringify(params);
    } catch (e: unknown) { void e; /* cleanup-ignore: JSON.stringify circular structure — traversal has already checked all reachable strings; JSON.stringify is only used for display */
      serialized = "[circular structure]";
    }

    return { sanitized: serialized, normalized: serialized, warnings: allWarnings, blocked: false };
  }
}


let _singleton: InputSanitizer | null = null;

/**
 * Get or create the module-level sanitizer singleton.
 * Call configureSanitizer() first to customize behavior.
 */
export function getSanitizer(): InputSanitizer {
  if (_singleton === null) {
    _singleton = new InputSanitizer(DEFAULT_SANITIZER_CONFIG);
  }
  return _singleton;
}

/**
 * Configure the module-level singleton.
 * Typically called from the CLI command handler after loading divisions.yaml.
 */
export function configureSanitizer(config: Partial<SanitizerConfig>): void {
  _singleton = new InputSanitizer(config);
}

/** Reset singleton (for tests) */
export function resetSanitizer(): void {
  _singleton = null;
}
