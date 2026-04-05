// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.8: Structured Logger
 *
 * Drop-in structured logging with:
 *  - JSON + text output formats
 *  - Global and per-component log levels (including 'off' for zero output)
 *  - Hot-reload: runtime level changes without restart
 *  - PII/secret redaction
 *  - Correlation ID, agentId, divisionId thread-through
 *  - Child loggers with inherited defaults
 *  - Duration tracking helpers
 *
 * Usage:
 *   const logger = createLogger('pre-action-pipeline');
 *   logger.info('governance_check_start', 'Evaluating action', { metadata: { agent_id } });
 *   logger.child({ correlationId: taskId }).warn('task_blocked', 'Task blocked');
 */

import { createWriteStream, mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { rename as renameAsync } from "node:fs/promises";
import type { WriteStream } from "node:fs";
import { dirname } from "node:path";


export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal" | "off";

/** Numeric order — higher = more severe */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
  fatal: 4,
  off:   5,
};

export interface LogEntry {
  timestamp:      string;
  level:          Exclude<LogLevel, "off">;
  component:      string;
  event:          string;
  message:        string;
  correlationId?: string;
  agentId?:       string;
  divisionId?:    string;
  duration_ms?:   number;
  error?: {
    code:    string;
    message: string;
    stack?:  string;
  };
  metadata?: Record<string, unknown>;
}

export interface LoggerConfig {
  level:           LogLevel;
  format:          "json" | "text";
  output:          "stdout" | "file" | "both";
  filePath?:       string;
  components?:     Record<string, LogLevel>;
  redactPatterns?: string[];
  hotReload?:      boolean;
}

export interface Logger {
  debug(event: string, message: string, meta?: Partial<LogEntry>): void;
  info(event: string, message: string, meta?: Partial<LogEntry>): void;
  warn(event: string, message: string, meta?: Partial<LogEntry>): void;
  error(event: string, message: string, meta?: Partial<LogEntry>): void;
  fatal(event: string, message: string, meta?: Partial<LogEntry>): void;
  child(defaults: Partial<LogEntry>): Logger;
  /** Convenience: returns Date.now() — pass result to duration_ms later */
  startTimer(): number;
}


let _globalLevel:  LogLevel         = "info";
let _globalFormat: "json" | "text"  = "json";
let _globalOutput: "stdout" | "file" | "both" = "stdout";
let _globalFilePath: string | undefined;

const _componentLevels = new Map<string, LogLevel>();

/** Default built-in redact patterns — always retained; user patterns appended after these. */
const _defaultRedactPatterns: readonly RegExp[] = [
  // Auth headers (Bearer / Basic)
  /Bearer [A-Za-z0-9+/=_-]+/g,
  /Basic [A-Za-z0-9+/=]{10,}/g,
  // Provider API keys — sk-* family (OpenAI, Anthropic sk-ant-*, OpenAI sk-proj-*)
  // Must allow dashes so sk-ant-api03-xxx and sk-proj-xxx are fully redacted
  /\bsk-[a-zA-Z0-9_-]+/g,
  // xAI / Grok API keys
  /\bxai-[A-Za-z0-9_-]+/g,
  // Generic key- prefix tokens
  /\bkey-[a-zA-Z0-9_-]+/g,
  // Password assignments in log strings
  /"?password"?\s*[:=]\s*"?[^"\s,}]*/gi,
  // AWS access keys (AKIA*)
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub tokens
  /\b(ghp_|ghr_|gho_|ghs_|ghu_)[A-Za-z0-9_]{36,}\b/g,
  // Slack tokens
  /\b(xoxb-|xoxp-|xapp-)[A-Za-z0-9-]+/g,
  // JWT tokens (header.payload.sig)
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

const _redactPatterns: RegExp[] = [..._defaultRedactPatterns];

/**
 * Two-tier sensitive key detection.
 *
 * Tier 1 — exact normalized match: covers well-known compound keys like
 *   api_key, api-key, private_key, access_token, etc.
 *
 * Tier 2 — word-component match: splits the key on `_`, `-`, spaces, and
 *   camelCase boundaries then checks each word against a curated set of
 *   unambiguous secret words. This catches compound keys such as `db_password`,
 *   `authToken`, `aws_secret_access_key` that are not in Tier 1 while avoiding
 *   false positives for generic keys like `key` or `name`.
 */
const SENSITIVE_EXACT_KEYS = new Set([
  "token", "password", "secret", "apikey", "api_key", "api-key",
  "authorization", "credential", "private_key", "privatekey", "private-key",
  "access_token", "refresh_token", "session_token", "client_secret",
  "client_id", "signing_key", "encryption_key", "database_url",
  "connection_string", "dsn", "webhook_secret", "webhook_url",
  "access_key", "access_key_id", "secret_key", "secret_access_key",
]);

/**
 * Unambiguous secret word components: each of these, when appearing as a
 * whole word component of a key name, indicates the key holds a secret.
 * Note: bare "key" and "api" are intentionally excluded (too generic).
 */
const SENSITIVE_WORD_COMPONENTS = new Set([
  "password", "secret", "token", "authorization",
  "credential", "webhook",
]);

/**
 * Tier 3 — compound key detection: catch patterns like aws_access_key_id,
 * my_secret_key_value that combine "access" or "secret" with "key".
 */
function isSensitiveCompoundKey(key: string): boolean {
  const lower = key.toLowerCase();
  const hasKey = lower.includes("key");
  const hasQualifier = lower.includes("access") || lower.includes("secret");
  return hasKey && hasQualifier;
}

function splitKeyWords(key: string): string[] {
  // Insert separator at camelCase transitions (e.g. authToken → auth_Token)
  const withSep = key.replace(/([a-z])([A-Z])/g, "$1_$2");
  return withSep.toLowerCase().split(/[_\-\s.]+/).filter((w) => w.length > 0);
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  // Tier 1: exact match against known keys (covers api_key, access_token, etc.)
  if (SENSITIVE_EXACT_KEYS.has(lower)) return true;
  // Tier 2: word-component match for compound keys not in Tier 1
  const words = splitKeyWords(key);
  for (const word of words) {
    if (SENSITIVE_WORD_COMPONENTS.has(word)) return true;
  }
  // Tier 3: compound key detection (access+key, secret+key patterns)
  if (isSensitiveCompoundKey(key)) return true;
  return false;
}


const MAX_LOG_SIZE  = 50 * 1024 * 1024; // 50 MB
const MAX_LOG_FILES = 5;

// Rotation queue: serialises concurrent rotation calls via a Promise chain.
// Replaces the `_rotating` boolean which was susceptible to race conditions
// when concurrent writes both passed the flag check before either set it
// (xAI-ROAST). Each rotation is appended to the chain; the chain never grows
// unboundedly because we only enqueue when the file actually exceeds the limit.
let _rotationChain: Promise<void> = Promise.resolve();

function checkRotation(filePath: string): void {
  try {
    const stats = statSync(filePath);
    if (stats.size >= MAX_LOG_SIZE) {
      // Chain next rotation after the current one completes (serialised, not concurrent)
      _rotationChain = _rotationChain
        .then(() => rotateLog(filePath))
        .catch((e: unknown) => { void e; /* cleanup-ignore: rotation error — cannot use logger inside logger */ });
    }
  } catch (e: unknown) { void e; /* cleanup-ignore: log file may not exist yet — cannot use logger inside logger */ }
}

async function rotateLog(filePath: string): Promise<void> {
  // Close current stream so we can rename the file
  const stream = _fileStreams.get(filePath);
  if (stream !== undefined) {
    try { stream.end(); } catch (e: unknown) { void e; /* cleanup-ignore: stream end failure during log rotation — cannot use logger inside logger */ }
    _fileStreams.delete(filePath);
  }
  // Rotate in reverse order: .5 → delete, .4 → .5, …, .1 → .2, current → .1
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    const older = `${filePath}.${i + 1}`;
    const newer = `${filePath}.${i}`;
    try { unlinkSync(older); } catch (e: unknown) { void e; /* cleanup-ignore: older log file may not exist — expected during rotation */ }
    try { await renameAsync(newer, older); } catch (e: unknown) { void e; /* cleanup-ignore: log rotation rename is best-effort — cannot use logger inside logger */ }
  }
  try { await renameAsync(filePath, `${filePath}.1`); } catch (e: unknown) { void e; /* cleanup-ignore: log rotation rename is best-effort — cannot use logger inside logger */ }
  // Stream will be recreated on next write via getFileStream()
}

/** Open write streams keyed by file path (non-blocking file I/O) */
const _fileStreams = new Map<string, WriteStream>();

function getFileStream(filePath: string): WriteStream {
  let stream = _fileStreams.get(filePath);
  if (stream === undefined || stream.destroyed) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    stream = createWriteStream(filePath, { flags: "a", mode: 0o600 });  // Restrict log file to owner
    _fileStreams.set(filePath, stream);
  }
  return stream;
}


/**
 * Configure the global logger state.
 * All createLogger() instances see changes immediately (hot-reload).
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
  if (config.level    !== undefined) _globalLevel  = config.level;
  if (config.format   !== undefined) _globalFormat = config.format;
  if (config.output   !== undefined) _globalOutput = config.output;
  if (config.filePath !== undefined) _globalFilePath = config.filePath;

  if (config.components !== undefined) {
    for (const [comp, lvl] of Object.entries(config.components)) {
      _componentLevels.set(comp, lvl as LogLevel);
    }
  }

  if (config.redactPatterns !== undefined) {
    // Build a set of already-registered pattern sources to avoid accumulating
    // duplicate RegExp objects when configureLogger() is called multiple times.
    const existingSources = new Set(_redactPatterns.map((r) => r.source));
    for (const pat of config.redactPatterns) {
      if (!existingSources.has(pat)) {
        _redactPatterns.push(new RegExp(pat, "g"));
        existingSources.add(pat);
      }
    }
  }
}

/** Hot-reload: change the global default level at runtime */
export function setGlobalLevel(level: LogLevel): void {
  _globalLevel = level;
}

/** Hot-reload: change the level for a specific component at runtime */
export function setComponentLevel(component: string, level: LogLevel): void {
  _componentLevels.set(component, level as LogLevel);
}

/** Return current global + per-component levels (for CLI status command) */
export function getLoggerStatus(): {
  global:     LogLevel;
  format:     "json" | "text";
  output:     "stdout" | "file" | "both";
  components: Record<string, LogLevel>;
} {
  return {
    global:     _globalLevel,
    format:     _globalFormat,
    output:     _globalOutput,
    components: Object.fromEntries(_componentLevels),
  };
}

/** Reset all runtime overrides (used in tests) */
export function resetLogger(): void {
  _globalLevel  = "info";
  _globalFormat = "json";
  _globalOutput = "stdout";
  _globalFilePath = undefined;
  _componentLevels.clear();
  // Keep built-in redact patterns; remove any user-added extras
  _redactPatterns.splice(_defaultRedactPatterns.length);
  // Close open file streams
  for (const stream of _fileStreams.values()) {
    try { stream.end(); } catch (e: unknown) { void e; /* cleanup-ignore: stream end failure during logger reset — cannot use logger inside logger */ }
  }
  _fileStreams.clear();
  // Reset rotation queue so tests start with a clean chain
  _rotationChain = Promise.resolve();
}


function effectiveLevel(component: string): LogLevel {
  return _componentLevels.get(component) ?? _globalLevel;
}

function shouldLog(component: string, level: Exclude<LogLevel, "off">): boolean {
  const eff = effectiveLevel(component);
  if (eff === "off") return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[eff];
}

function redact(text: string): string {
  let out = text;
  for (const pat of _redactPatterns) {
    // Reset lastIndex for global regexps
    pat.lastIndex = 0;
    out = out.replace(pat, "[REDACTED]");
  }
  return out;
}

/** Pre-serialization object redaction — catches secrets in nested metadata.
 *  WeakSet tracks visited objects to prevent infinite recursion on circular refs.
 *  @internal exported for testing */
export function redactObject<T>(val: T, seen?: WeakSet<object>): T {
  if (typeof val === "string") return redact(val) as T;
  if (val === null || val === undefined) return val;
  if (typeof val !== "object") return val;

  const s = seen ?? new WeakSet<object>();
  const obj = val as object;
  if (s.has(obj)) return "[Circular]" as T; // Safe: only used for display, never runtime access
  s.add(obj);

  // Error objects have non-enumerable message/stack — extract explicitly
  if (obj instanceof Error) {
    const errObj: Record<string, unknown> = {
      name:    obj.name,
      message: redact(obj.message),
      stack:   obj.stack !== undefined ? redact(obj.stack) : undefined,
    };
    // Also capture any enumerable extra properties (e.g. SidjuaError.code)
    // Cast through object (Error IS-A object) to avoid the Error↔Record<string,unknown> overlap error
    for (const [k, v] of Object.entries(obj as object) as Array<[string, unknown]>) {
      errObj[k] = isSensitiveKey(k) ? "[REDACTED]" : redactObject(v, s);
    }
    return errObj as T; // Safe: Error objects are serialized for display only
  }

  if (Array.isArray(val)) {
    // Cast to unknown[] first (element type unknown at call sites), then widen back to T
    const arr: unknown[] = val;
    return arr.map((item) => redactObject(item, s)) as T; // Safe: Array.isArray confirms T is an array type
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    // Redact by key name regardless of value content
    out[k] = isSensitiveKey(k) ? "[REDACTED]" : redactObject(v, s);
  }
  return out as T;
}

function formatEntry(entry: LogEntry): string {
  const safe = redactObject(entry);
  if (_globalFormat === "json") {
    return JSON.stringify(safe);
  }
  // Text format: [timestamp] LEVEL [component] event: message {meta}
  const meta = safe.metadata !== undefined
    ? " " + JSON.stringify(safe.metadata)
    : "";
  const corr = safe.correlationId !== undefined
    ? ` (${safe.correlationId})`
    : "";
  return redact(
    `[${safe.timestamp}] ${safe.level.toUpperCase().padEnd(5)} [${safe.component}]${corr} ${safe.event}: ${safe.message}${meta}`,
  );
}

function writeEntry(entry: LogEntry): void {
  const line = formatEntry(entry) + "\n";
  const isErr        = entry.level === "error" || entry.level === "fatal";
  const isWarnOrAbove = entry.level === "warn" || isErr;

  if (_globalOutput === "stdout" || _globalOutput === "both") {
    if (isErr) {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  // Always write warn/error/fatal to file when a log file is configured — these
  // must be visible in the error log regardless of the global output mode setting.
  // Lower-severity levels follow the output mode (file/both).
  const filePath = _globalFilePath;
  if (filePath !== undefined &&
      (isWarnOrAbove || _globalOutput === "file" || _globalOutput === "both")) {
    checkRotation(filePath);  // Rotate before write if file is too large
    try {
      getFileStream(filePath).write(line);
    } catch (err) {
      // Fall back to stderr so audit trail loss is visible
      process.stderr.write(`[SIDJUA] Log write failed: ${err instanceof Error ? err.message : "unknown"}\n`);
      process.stderr.write(line);
    }
  }
}


class LoggerImpl implements Logger {
  private readonly _defaults: Partial<LogEntry>;

  constructor(defaults: Partial<LogEntry> = {}) {
    this._defaults = defaults;
  }

  private _log(
    level:   Exclude<LogLevel, "off">,
    event:   string,
    message: string,
    meta?:   Partial<LogEntry>,
  ): void {
    const component = meta?.component ?? this._defaults.component ?? "unknown";
    if (!shouldLog(component, level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      event,
      message,
      ...this._defaults,
      ...meta,
    };
    writeEntry(entry);
  }

  debug(event: string, message: string, meta?: Partial<LogEntry>): void {
    this._log("debug", event, message, meta);
  }
  info(event: string, message: string, meta?: Partial<LogEntry>): void {
    this._log("info", event, message, meta);
  }
  warn(event: string, message: string, meta?: Partial<LogEntry>): void {
    this._log("warn", event, message, meta);
  }
  error(event: string, message: string, meta?: Partial<LogEntry>): void {
    this._log("error", event, message, meta);
  }
  fatal(event: string, message: string, meta?: Partial<LogEntry>): void {
    this._log("fatal", event, message, meta);
  }

  child(defaults: Partial<LogEntry>): Logger {
    return new LoggerImpl({ ...this._defaults, ...defaults });
  }

  startTimer(): number {
    return Date.now();
  }
}


/**
 * Create a module-scoped logger for a specific component.
 * The component name determines which level override applies.
 *
 * @example
 * const logger = createLogger('pre-action-pipeline');
 */
export function createLogger(component: string): Logger {
  return new LoggerImpl({ component });
}

/**
 * Create a no-op logger that discards all output.
 * Intended for use in unit tests where log noise should be suppressed.
 *
 * @example
 * const logger = createSilentLogger();
 * new MyService(logger); // logs suppressed in test
 */
/** No-op Logger implementation used in tests to suppress output. */
class SilentLogger implements Logger {
  debug(): void   { /* no-op */ }
  info(): void    { /* no-op */ }
  warn(): void    { /* no-op */ }
  error(): void   { /* no-op */ }
  fatal(): void   { /* no-op */ }
  child(): Logger { return _silentInstance; }
  startTimer(): number { return 0; }
}

const _silentInstance: Logger = new SilentLogger();

/**
 * Create a no-op logger that discards all output.
 * Intended for use in unit tests where log noise should be suppressed.
 *
 * @example
 * const logger = createSilentLogger();
 * new MyService(logger); // logs suppressed in test
 */
export function createSilentLogger(): Logger {
  return _silentInstance;
}
