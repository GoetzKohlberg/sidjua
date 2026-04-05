// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.8: Standardized Error Codes
 *
 * Unified error taxonomy across all SIDJUA subsystems.
 * SidjuaError extends Error for backward compatibility with existing catch blocks.
 *
 * Usage:
 *   throw SidjuaError.from('GOV-001', 'purchase.execute on accounts-payable');
 *   throw SidjuaError.from('TASK-002', 'injection pattern detected in description');
 */


export enum ErrorCategory {
  GOVERNANCE      = "GOV",
  TASK            = "TASK",
  AGENT           = "AGT",
  PROVIDER        = "PROV",
  PROVIDER_CONFIG = "PCFG",
  TOOL            = "TOOL",
  SYSTEM          = "SYS",
  INPUT           = "INPUT",
  OUTPUT          = "OUTPUT",
  SUMMARY         = "SUMMARY",
  COMM            = "COMM",
  SECURITY        = "SEC",
  EMBEDDING       = "EMB",
  GATEWAY         = "IGW",
  CHAT            = "CHAT",
  MODULE          = "MOD",
  LIMIT           = "LIMIT",
  LOCK            = "LOCK",
  BACKUP          = "BACKUP",
  SSRF            = "SSRF",
  SERVER          = "SERVER",
}


export interface ErrorCodeEntry {
  readonly code:        string;
  readonly category:    ErrorCategory;
  readonly message:     string;
  readonly recoverable: boolean;
  readonly suggestion?: string;
}


const ERROR_REGISTRY: Readonly<Record<string, ErrorCodeEntry>> = {
  // Governance
  "GOV-001": { code: "GOV-001", category: ErrorCategory.GOVERNANCE, message: "Action forbidden by policy",          recoverable: false, suggestion: "Request different approach" },
  "GOV-002": { code: "GOV-002", category: ErrorCategory.GOVERNANCE, message: "Approval required",                  recoverable: true,  suggestion: "Submit approval request" },
  "GOV-003": { code: "GOV-003", category: ErrorCategory.GOVERNANCE, message: "Budget exceeded",                    recoverable: false, suggestion: "Request budget increase" },
  "GOV-004": { code: "GOV-004", category: ErrorCategory.GOVERNANCE, message: "Classification violation",           recoverable: false, suggestion: "Check data classification" },
  "GOV-005": { code: "GOV-005", category: ErrorCategory.GOVERNANCE, message: "Policy rule violation",              recoverable: false, suggestion: "Review applicable policies" },
  "GOV-006": { code: "GOV-006", category: ErrorCategory.GOVERNANCE, message: "Tier escalation denied",             recoverable: false, suggestion: "Use authorized tier" },
  "GOV-007": { code: "GOV-007", category: ErrorCategory.GOVERNANCE, message: "Division boundary violation",        recoverable: false, suggestion: "Request cross-division access" },
  "GOV-008": { code: "GOV-008", category: ErrorCategory.GOVERNANCE, message: "Governance rollback in progress",    recoverable: true,  suggestion: "Retry after rollback completes" },

  // Task
  "TASK-001": { code: "TASK-001", category: ErrorCategory.TASK, message: "Invalid task description",            recoverable: false, suggestion: "Fix description format" },
  "TASK-002": { code: "TASK-002", category: ErrorCategory.TASK, message: "Task description blocked (injection)", recoverable: false, suggestion: "Remove suspicious content" },
  "TASK-003": { code: "TASK-003", category: ErrorCategory.TASK, message: "Task dependency not met",             recoverable: true,  suggestion: "Wait for dependency" },
  "TASK-004": { code: "TASK-004", category: ErrorCategory.TASK, message: "Task timeout exceeded",               recoverable: true,  suggestion: "Retry with simpler scope" },
  "TASK-005": { code: "TASK-005", category: ErrorCategory.TASK, message: "Parent task cancelled",               recoverable: false },

  // Agent
  "AGT-001": { code: "AGT-001", category: ErrorCategory.AGENT, message: "Agent not found",              recoverable: false, suggestion: "Check agent ID" },
  "AGT-002": { code: "AGT-002", category: ErrorCategory.AGENT, message: "Agent not ready (wrong state)", recoverable: true,  suggestion: "Wait for agent ready" },
  "AGT-003": { code: "AGT-003", category: ErrorCategory.AGENT, message: "Agent crashed",                 recoverable: true,  suggestion: "Auto-restart in progress" },
  "AGT-004": { code: "AGT-004", category: ErrorCategory.AGENT, message: "Agent context overflow",        recoverable: true,  suggestion: "Summarize and retry" },
  "AGT-005": { code: "AGT-005", category: ErrorCategory.AGENT, message: "Agent heartbeat timeout",       recoverable: true,  suggestion: "Restart agent" },
  "AGT-006": { code: "AGT-006", category: ErrorCategory.AGENT, message: "Agent limit reached",           recoverable: false, suggestion: "Remove unused agents or upgrade to Enterprise" },

  // Provider
  "PROV-001": { code: "PROV-001", category: ErrorCategory.PROVIDER, message: "LLM provider unavailable",          recoverable: true,  suggestion: "Retry or failover" },
  "PROV-002": { code: "PROV-002", category: ErrorCategory.PROVIDER, message: "LLM rate limited",                   recoverable: true,  suggestion: "Retry after backoff" },
  "PROV-003": { code: "PROV-003", category: ErrorCategory.PROVIDER, message: "LLM response invalid",               recoverable: true,  suggestion: "Retry with different prompt" },
  "PROV-004": { code: "PROV-004", category: ErrorCategory.PROVIDER, message: "All providers exhausted",            recoverable: false, suggestion: "Manual intervention" },
  "PROV-005": { code: "PROV-005", category: ErrorCategory.PROVIDER, message: "LLM authentication failed",          recoverable: false, suggestion: "Check API key" },
  "PROV-006": { code: "PROV-006", category: ErrorCategory.PROVIDER, message: "LLM bad request",                   recoverable: false, suggestion: "Fix request parameters" },
  "PROV-007": { code: "PROV-007", category: ErrorCategory.PROVIDER, message: "LLM returned no tool call",         recoverable: true,  suggestion: "Retry with stronger tool-use instruction" },
  "PROV-008": { code: "PROV-008", category: ErrorCategory.PROVIDER, message: "LLM tool response malformed",       recoverable: true,  suggestion: "Retry with corrected prompt" },

  // Tool
  "TOOL-001": { code: "TOOL-001", category: ErrorCategory.TOOL, message: "Tool not found",           recoverable: false, suggestion: "Check tool registry" },
  "TOOL-002": { code: "TOOL-002", category: ErrorCategory.TOOL, message: "Tool not ready",            recoverable: true,  suggestion: "Wait for tool startup" },
  "TOOL-003": { code: "TOOL-003", category: ErrorCategory.TOOL, message: "Tool execution failed",     recoverable: true,  suggestion: "Retry or use fallback" },
  "TOOL-004": { code: "TOOL-004", category: ErrorCategory.TOOL, message: "Tool rate limited",         recoverable: true,  suggestion: "Retry after cooldown" },
  "TOOL-005": { code: "TOOL-005", category: ErrorCategory.TOOL, message: "Tool path blocked",         recoverable: false, suggestion: "Use allowed path" },
  "TOOL-006": { code: "TOOL-006", category: ErrorCategory.TOOL, message: "Tool command blocked",      recoverable: false, suggestion: "Use allowed command" },

  // System
  "SYS-001": { code: "SYS-001", category: ErrorCategory.SYSTEM, message: "Database error",                    recoverable: true,  suggestion: "Retry" },
  "SYS-002": { code: "SYS-002", category: ErrorCategory.SYSTEM, message: "Filesystem error",                  recoverable: true,  suggestion: "Check permissions" },
  "SYS-003": { code: "SYS-003", category: ErrorCategory.SYSTEM, message: "Configuration invalid",             recoverable: false, suggestion: "Fix configuration" },
  "SYS-004": { code: "SYS-004", category: ErrorCategory.SYSTEM, message: "Resource exhausted (memory/disk)", recoverable: false, suggestion: "Free resources" },
  "SYS-005": { code: "SYS-005", category: ErrorCategory.SYSTEM, message: "Backup checksum mismatch",        recoverable: false, suggestion: "Re-create backup — archive may be corrupt" },
  "SYS-006": { code: "SYS-006", category: ErrorCategory.SYSTEM, message: "Backup version incompatible",     recoverable: false, suggestion: "Use a backup from the same SIDJUA version" },
  "SYS-007": { code: "SYS-007", category: ErrorCategory.SYSTEM, message: "Agents still running",            recoverable: true,  suggestion: "Stop all agents before restoring" },
  "SYS-008": { code: "SYS-008", category: ErrorCategory.SYSTEM, message: "Backup not found",               recoverable: false, suggestion: "Check backup ID or path" },
  "SYS-009": { code: "SYS-009", category: ErrorCategory.SYSTEM, message: "Security violation",             recoverable: false, suggestion: "Check archive integrity and path" },
  "SYS-010": { code: "SYS-010", category: ErrorCategory.SYSTEM, message: "Embedding dimension mismatch",  recoverable: false, suggestion: "Run `sidjua memory re-embed` to rebuild vectors with the current provider" },
  "SYS-011": { code: "SYS-011", category: ErrorCategory.SYSTEM, message: "Sandbox provider unavailable",  recoverable: false, suggestion: "Ensure bubblewrap (bwrap) or required sandbox runtime is installed" },
  "SYS-012": { code: "SYS-012", category: ErrorCategory.SYSTEM, message: "Archive file count exceeded",   recoverable: false, suggestion: "Archive contains too many files — use a smaller backup or contact support" },
  "SYS-013": { code: "SYS-013", category: ErrorCategory.SYSTEM, message: "Archive entry too large",       recoverable: false, suggestion: "A single archive entry exceeds the size limit — archive may be invalid" },

  // Input
  "INPUT-001": { code: "INPUT-001", category: ErrorCategory.INPUT, message: "Input sanitization blocked", recoverable: false, suggestion: "Remove injection patterns" },
  "INPUT-002": { code: "INPUT-002", category: ErrorCategory.INPUT, message: "Input too long",             recoverable: false, suggestion: "Shorten input" },
  "INPUT-003": { code: "INPUT-003", category: ErrorCategory.INPUT, message: "Input encoding invalid",     recoverable: false, suggestion: "Use UTF-8" },
  "INPUT-004": { code: "INPUT-004", category: ErrorCategory.INPUT, message: "Invalid env var name",       recoverable: false, suggestion: "Env var names must be uppercase letters, digits, and underscores, starting with a letter or underscore" },
  "INPUT-005": { code: "INPUT-005", category: ErrorCategory.INPUT, message: "Unsupported Content-Type",   recoverable: false, suggestion: "Set Content-Type: application/json for POST/PUT/PATCH requests" },
  "INPUT-006": { code: "INPUT-006", category: ErrorCategory.INPUT, message: "Invalid identifier format",  recoverable: false, suggestion: "Use only alphanumeric characters, hyphens, and underscores (max 64 chars)" },
  "INPUT-007": { code: "INPUT-007", category: ErrorCategory.INPUT, message: "Input exceeds token limit",  recoverable: false, suggestion: "Shorten the description to reduce estimated token count" },

  // Provider (Phase 13d extensions)
  "PROV-009": { code: "PROV-009", category: ErrorCategory.PROVIDER, message: "Custom provider validation failed",  recoverable: false, suggestion: "Check provider ID or URL" },
  "PROV-010": { code: "PROV-010", category: ErrorCategory.PROVIDER, message: "Auto-detection probe failed",        recoverable: true,  suggestion: "Provider added with warnings — verify manually" },
  "PROV-011": { code: "PROV-011", category: ErrorCategory.PROVIDER, message: "Setup Assistant unavailable",        recoverable: true,  suggestion: "Configure manually with `sidjua provider add`" },

  // Configuration
  "CONFIG-001": { code: "CONFIG-001", category: ErrorCategory.SYSTEM, message: "Configuration file not found",     recoverable: false, suggestion: "Run `sidjua apply` first" },
  "CONFIG-002": { code: "CONFIG-002", category: ErrorCategory.SYSTEM, message: "Configuration parse error",        recoverable: false, suggestion: "Fix YAML syntax" },
  "CONFIG-003": { code: "CONFIG-003", category: ErrorCategory.SYSTEM, message: "Configuration validation failed",  recoverable: false, suggestion: "Fix config schema" },
  "CONFIG-004": { code: "CONFIG-004", category: ErrorCategory.SYSTEM, message: "No providers configured",          recoverable: true,  suggestion: "Run `sidjua setup` to configure providers" },
  "CONFIG-005": { code: "CONFIG-005", category: ErrorCategory.SYSTEM, message: "Agent has no provider or model",   recoverable: true,  suggestion: "Run `sidjua setup` to assign models to agents" },

  // Task Output (Phase 14)
  "OUTPUT-001": { code: "OUTPUT-001", category: ErrorCategory.OUTPUT,  message: "Task output must have content_text or content_binary", recoverable: false, suggestion: "Provide at least one content field" },
  "OUTPUT-002": { code: "OUTPUT-002", category: ErrorCategory.OUTPUT,  message: "Task output not found",                               recoverable: false, suggestion: "Check output ID" },
  "OUTPUT-003": { code: "OUTPUT-003", category: ErrorCategory.OUTPUT,  message: "Content hash verification failed",                    recoverable: false, suggestion: "Re-fetch output — content may be corrupt" },

  // Task Summary (Phase 14)
  "SUMMARY-001": { code: "SUMMARY-001", category: ErrorCategory.SUMMARY, message: "Summary validation failed: key_facts required (min 1)", recoverable: false, suggestion: "Add at least one key fact to the summary" },
  "SUMMARY-002": { code: "SUMMARY-002", category: ErrorCategory.SUMMARY, message: "Summary validation failed: invalid status",             recoverable: false, suggestion: "Use completed | failed | partial | escalated" },
  "SUMMARY-003": { code: "SUMMARY-003", category: ErrorCategory.SUMMARY, message: "Summary validation failed: exceeds max length",         recoverable: false, suggestion: "Shorten summary_text below 8000 characters" },
  "SUMMARY-004": { code: "SUMMARY-004", category: ErrorCategory.SUMMARY, message: "Summary references non-existent output IDs",            recoverable: true,  suggestion: "Store outputs before creating summary" },

  // Communication (Phase 14)
  "COMM-001": { code: "COMM-001", category: ErrorCategory.COMM, message: "Semantic search unavailable — no embedder configured, using direct query fallback", recoverable: true, suggestion: "Configure an embedding provider for semantic search" },

  // Security
  "SEC-010": { code: "SEC-010", category: ErrorCategory.SECURITY, message: "Path traversal detected",              recoverable: false, suggestion: "Skill paths must not contain '..' or escape the work directory" },
  "SEC-011": { code: "SEC-011", category: ErrorCategory.SECURITY, message: "Invalid module ID",                    recoverable: false, suggestion: "Module IDs must be 2-64 chars, lowercase alphanumeric and hyphens, starting and ending with alphanumeric" },
  "SEC-012": { code: "SEC-012", category: ErrorCategory.SECURITY, message: "Env var value injection attempt",      recoverable: false, suggestion: "Remove newline or carriage-return characters from environment variable values" },
  "SEC-013": { code: "SEC-013", category: ErrorCategory.SECURITY, message: "Disallowed module capability",          recoverable: false, suggestion: "Remove the disallowed capability from the module manifest" },
  "SEC-014": { code: "SEC-014", category: ErrorCategory.SECURITY, message: "Export path traversal blocked",         recoverable: false, suggestion: "Use an output path within the allowed base directory" },

  // WAL integrity
  "WAL-001": { code: "WAL-001", category: ErrorCategory.SECURITY, message: "WAL integrity violation",              recoverable: false, suggestion: "WAL entry checksum mismatch detected — agent execution halted. Check for tampering or storage corruption." },

  // Sandbox
  "SANDBOX-001": { code: "SANDBOX-001", category: ErrorCategory.SYSTEM, message: "Sandbox provider not explicitly configured", recoverable: false, suggestion: "Set SIDJUA_ALLOW_NO_SANDBOX=true to explicitly acknowledge running without process isolation, or configure a real sandbox provider." },
  "SANDBOX-002": { code: "SANDBOX-002", category: ErrorCategory.SYSTEM, message: "Sandbox initialization permanently failed", recoverable: false, suggestion: "Manual intervention required — check sandbox runtime installation." },

  // Embedding
  "EMB-001": { code: "EMB-001", category: ErrorCategory.EMBEDDING, message: "No real embedding provider configured",     recoverable: true,  suggestion: "Configure an embedding provider before running migration. See: sidjua config --help" },
  "EMB-002": { code: "EMB-002", category: ErrorCategory.EMBEDDING, message: "Embedding provider returned a zero vector", recoverable: false, suggestion: "Check your API key and embedding provider configuration" },
  "EMB-003": { code: "EMB-003", category: ErrorCategory.EMBEDDING, message: "Embedding dimension mismatch",              recoverable: false, suggestion: "Ensure the embedding provider model matches the expected dimensions in config" },

  // Integration Gateway
  "IGW-001": { code: "IGW-001", category: ErrorCategory.GATEWAY, message: "Service not found in adapter registry",      recoverable: false, suggestion: "Register the adapter or enable intelligent path" },
  "IGW-002": { code: "IGW-002", category: ErrorCategory.GATEWAY, message: "Action not found for service",               recoverable: false, suggestion: "Check the action name in the adapter definition" },
  "IGW-003": { code: "IGW-003", category: ErrorCategory.GATEWAY, message: "Invalid adapter definition",                 recoverable: false, suggestion: "Fix the adapter YAML — check required fields" },
  "IGW-004": { code: "IGW-004", category: ErrorCategory.GATEWAY, message: "Gateway request missing required fields",    recoverable: false, suggestion: "Provide agent_id, service, action, and request_id" },
  "IGW-005": { code: "IGW-005", category: ErrorCategory.GATEWAY, message: "External call blocked by governance",        recoverable: false, suggestion: "Check division web access policy or request approval" },
  "IGW-006": { code: "IGW-006", category: ErrorCategory.GATEWAY, message: "Credential resolution failed",              recoverable: false, suggestion: "Set the required secret via: sidjua secrets set <namespace> <key>" },
  "IGW-007": { code: "IGW-007", category: ErrorCategory.GATEWAY, message: "External call timed out",                   recoverable: true,  suggestion: "Increase timeout_seconds in adapter governance config" },
  "IGW-008": { code: "IGW-008", category: ErrorCategory.GATEWAY, message: "Response injection pattern detected",       recoverable: false, suggestion: "The external service response contained suspicious content" },
  "IGW-009": { code: "IGW-009", category: ErrorCategory.GATEWAY, message: "Response size limit exceeded",              recoverable: true,  suggestion: "Use a more specific action or increase max_response_bytes" },
  "IGW-010": { code: "IGW-010", category: ErrorCategory.GATEWAY, message: "Unsupported protocol",                      recoverable: false, suggestion: "Use rest, graphql, local_script, cli, or mcp" },

  // Chat
  "CHAT-001": { code: "CHAT-001", category: ErrorCategory.CHAT, message: "Message must not be empty",           recoverable: false, suggestion: "Provide a non-empty message" },
  "CHAT-002": { code: "CHAT-002", category: ErrorCategory.CHAT, message: "Agent not found",                    recoverable: false, suggestion: "Check agent ID" },
  "CHAT-003": { code: "CHAT-003", category: ErrorCategory.CHAT, message: "No LLM provider configured",         recoverable: true,  suggestion: "Configure a provider in Settings" },
  "CHAT-004": { code: "CHAT-004", category: ErrorCategory.CHAT, message: "LLM request failed",                 recoverable: true,  suggestion: "Check your API key and provider status. Free providers may have rate limits or temporary outages." },

  // Provider config
  "PCFG-001": { code: "PCFG-001", category: ErrorCategory.PROVIDER_CONFIG, message: "Provider not found in catalog",          recoverable: false, suggestion: "Use a provider id from GET /api/v1/provider/catalog" },
  "PCFG-002": { code: "PCFG-002", category: ErrorCategory.PROVIDER_CONFIG, message: "Invalid API base URL",                   recoverable: false, suggestion: "Use an https:// URL or http://localhost for local providers" },
  "PCFG-003": { code: "PCFG-003", category: ErrorCategory.PROVIDER_CONFIG, message: "Provider not configured",                recoverable: true,  suggestion: "Configure a provider via PUT /api/v1/provider/config" },
  "PCFG-004": { code: "PCFG-004", category: ErrorCategory.PROVIDER_CONFIG, message: "Invalid provider config request",        recoverable: false, suggestion: "Provide mode and default_provider with provider_id and api_key" },

  // Execution (reasoning loop)
  "EXEC-001": { code: "EXEC-001", category: ErrorCategory.AGENT, message: "Reasoning loop max turns exceeded",  recoverable: false, suggestion: "Escalate to higher tier or simplify task" },
  "EXEC-002": { code: "EXEC-002", category: ErrorCategory.AGENT, message: "Reasoning turn timeout",            recoverable: true,  suggestion: "Retry with simpler task scope" },
  "EXEC-003": { code: "EXEC-003", category: ErrorCategory.AGENT, message: "Task submission invalid",           recoverable: false, suggestion: "Fix task description or budget" },
  "EXEC-004": { code: "EXEC-004", category: ErrorCategory.AGENT, message: "Task not found",                   recoverable: false, suggestion: "Check task ID" },
  "EXEC-005": { code: "EXEC-005", category: ErrorCategory.AGENT, message: "Budget exhausted",                 recoverable: false, suggestion: "Increase budget or simplify task" },
  "EXEC-006": { code: "EXEC-006", category: ErrorCategory.AGENT, message: "Task cancelled",                   recoverable: false, suggestion: "Submit a new task" },
  "EXEC-007": { code: "EXEC-007", category: ErrorCategory.AGENT, message: "Synthesis failed",                 recoverable: true,  suggestion: "Retry or review sub-task results" },

  // Free tier limits
  "LIMIT-001": { code: "LIMIT-001", category: ErrorCategory.LIMIT, message: "Free tier agent limit reached", recoverable: false, suggestion: "Remove unused agents or upgrade to Sidjua Enterprise for unlimited agents" },

  // Update lock manager
  "LOCK-001": { code: "LOCK-001", category: ErrorCategory.LOCK,   message: "Lock held by active process",         recoverable: true,  suggestion: "Wait for the current operation to complete or use --force-unlock if the lock is stale" },
  "LOCK-002": { code: "LOCK-002", category: ErrorCategory.LOCK,   message: "Malformed lock file too recent to reclaim", recoverable: false, suggestion: "Remove the lock file manually if the process is no longer running" },

  // Backup engine
  "BACKUP-001": { code: "BACKUP-001", category: ErrorCategory.BACKUP, message: "WAL checkpoint failed — backup aborted", recoverable: true, suggestion: "Retry after active DB transactions complete. Check for long-running agent tasks." },

  // Provider config disk persistence
  "PCFG-005": { code: "PCFG-005", category: ErrorCategory.PROVIDER_CONFIG, message: "Provider config disk write failed", recoverable: false, suggestion: "Ensure the data directory is writable or set SIDJUA_EPHEMERAL=true for in-memory mode" },

  // Module sandbox
  "MOD-001": { code: "MOD-001", category: ErrorCategory.MODULE, message: "Module tool execution failed in sandbox", recoverable: true,  suggestion: "Check module configuration and retry" },
  "MOD-002": { code: "MOD-002", category: ErrorCategory.MODULE, message: "Module network policy violation",         recoverable: false, suggestion: "Module attempted connection to a domain not in its allowlist" },
  "MOD-003": { code: "MOD-003", category: ErrorCategory.MODULE, message: "Module not recognized as first-party",    recoverable: false, suggestion: "Only built-in modules are supported in V1.0" },
  "MOD-004": { code: "MOD-004", category: ErrorCategory.MODULE, message: "Module sandbox initialization failed",    recoverable: false, suggestion: "Check sandbox provider configuration" },
  "MOD-005": { code: "MOD-005", category: ErrorCategory.MODULE, message: "Module tool execution timeout",           recoverable: true,  suggestion: "Retry or increase module_timeout_ms in division config" },
  "MOD-006": { code: "MOD-006", category: ErrorCategory.MODULE, message: "Module requires network sandbox",          recoverable: false, suggestion: "Configure a real sandbox provider (bubblewrap) or remove network capabilities from the module manifest" },

  // Shell tool security
  "SHELL-SEC-001": { code: "SHELL-SEC-001", category: ErrorCategory.SECURITY, message: "Shell metacharacter detected in command argument", recoverable: false, suggestion: "Remove metacharacters (;, |, &, $, backticks, etc.) from the command" },

  // REST tool security
  "REST-SEC-001": { code: "REST-SEC-001", category: ErrorCategory.SECURITY, message: "Request to private or local address blocked", recoverable: false, suggestion: "Use a publicly routable URL or configure an explicit allowlist" },
  "REST-SEC-002": { code: "REST-SEC-002", category: ErrorCategory.SECURITY, message: "Request domain not in allowlist",             recoverable: false, suggestion: "Add the domain to SIDJUA_REST_ALLOWLIST or use an allowed endpoint" },
  // REST tool routing
  "REST-001": { code: "REST-001", category: ErrorCategory.INPUT, message: "Missing required path parameter in URL template", recoverable: false, suggestion: "Provide all required path parameters in the tool action params" },

  // SSRF protection
  "SSRF-001": { code: "SSRF-001", category: ErrorCategory.SSRF, message: "Invalid or non-HTTP(S) outbound URL",  recoverable: false, suggestion: "Use an http:// or https:// URL for outbound requests" },
  "SSRF-002": { code: "SSRF-002", category: ErrorCategory.SSRF, message: "Private or loopback address blocked", recoverable: false, suggestion: "Use a publicly routable hostname for outbound requests" },
  "SSRF-003": { code: "SSRF-003", category: ErrorCategory.SSRF, message: "DNS rebinding: hostname resolved to private address", recoverable: false, suggestion: "The hostname resolves to a private/loopback IP; use a publicly routable host" },

  // Server-side errors
  "SERVER-500": { code: "SERVER-500", category: ErrorCategory.SERVER, message: "Internal server error", recoverable: true, suggestion: "Retry the request or check server logs" },
} as const;


/** Regex matching context keys that likely contain credentials. */
const REDACT_KEYS = /key|token|secret|password|credential|auth/i;
/** Regex matching context values that look like credential strings. */
const REDACT_VALUES = /sk-|Bearer |ghp_|glpat-/;
const REDACTED = "[REDACTED]";

/** Regex matching absolute Unix or Windows file paths in string context values. */
const REDACT_PATHS_IN_CTX =
  /(?:\/home\/|\/Users\/|\/root\/|\/var\/|\/tmp\/|\/etc\/|\/opt\/|\/app\/|\/srv\/)[^\s"',;)\]]+|[A-Za-z]:\\[^\s"',;)\]]+/g;
const REDACTED_PATH = "<path>";

/**
 * Sanitize error context before exposing it in debug output.
 *
 * Keys matching REDACT_KEYS (e.g. "apiKey", "password") are always redacted.
 * String values matching REDACT_VALUES (e.g. "sk-…", "Bearer …") are fully redacted.
 * String values containing absolute file paths have the path segments replaced.
 * Non-string values and unmatched keys/values are passed through unchanged.
 */
export function sanitizeErrorContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (REDACT_KEYS.test(k)) {
      out[k] = REDACTED;
    } else if (typeof v === "string" && REDACT_VALUES.test(v)) {
      out[k] = REDACTED;
    } else if (typeof v === "string") {
      // Replace absolute path segments but keep surrounding context (e.g. error messages).
      out[k] = v.replace(REDACT_PATHS_IN_CTX, REDACTED_PATH);
    } else {
      out[k] = v;
    }
  }
  return out;
}


/**
 * Structured error with a typed code, category, recoverability flag, and
 * optional suggestion for agent self-correction.
 *
 * Extends Error so existing catch blocks remain unchanged — backward compatible.
 */
export class SidjuaError extends Error {
  /** Typed error code: e.g. "GOV-001", "TASK-002" */
  readonly code: string;
  /** Coarse category matching the code prefix */
  readonly category: ErrorCategory;
  /** Whether the agent/system can retry without human intervention */
  readonly recoverable: boolean;
  /** Technical detail appended to the human-readable message */
  readonly detail?: string;
  /** What the agent should do to recover */
  readonly suggestion?: string;
  /** Structured metadata for debugging */
  readonly context?: Record<string, unknown>;

  constructor(
    entry:    ErrorCodeEntry,
    detail?:  string,
    context?: Record<string, unknown>,
  ) {
    super(entry.message + (detail !== undefined ? `: ${detail}` : ""));
    this.name       = "SidjuaError";
    this.code       = entry.code;
    this.category   = entry.category;
    this.recoverable = entry.recoverable;
    if (entry.suggestion !== undefined) this.suggestion = entry.suggestion;
    if (detail  !== undefined) this.detail  = detail;
    if (context !== undefined) this.context = context;

    // Restore prototype chain (required when extending built-ins)
    Object.setPrototypeOf(this, SidjuaError.prototype);
  }

  /**
   * Factory method — the primary API for creating SidjuaErrors.
   *
   * @param code    Error code string, e.g. "GOV-001"
   * @param detail  Optional technical detail appended to the message
   * @param context Optional key-value metadata for debugging
   *
   * @throws Error if the code is not in the registry
   */
  static from(
    code:     string,
    detail?:  string,
    context?: Record<string, unknown>,
  ): SidjuaError {
    const entry = ERROR_REGISTRY[code];
    if (entry === undefined) {
      throw new Error(`SidjuaError.from: unknown error code "${code}"`);
    }
    return new SidjuaError(entry, detail, context);
  }

  /**
   * Serialize to a plain object — ready for JSON.stringify and REST API responses.
   */
  toJSON(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      code:        this.code,
      category:    this.category,
      message:     this.message,
      recoverable: this.recoverable,
    };
    if (this.detail    !== undefined) obj["detail"]     = this.detail;
    if (this.suggestion !== undefined) obj["suggestion"] = this.suggestion;
    // Context may contain sensitive data (DB queries, file paths, keys)
    // — only expose when debug mode is explicitly enabled, and sanitize before exposing
    if (this.context !== undefined && process.env["SIDJUA_DEBUG"] === "1") {
      obj["context"] = sanitizeErrorContext(this.context);
    }
    return obj;
  }
}


/** Type guard: checks if an unknown value is a SidjuaError */
export function isSidjuaError(err: unknown): err is SidjuaError {
  return err instanceof SidjuaError;
}

/**
 * Type guard: checks if an unknown thrown value is an HTTP error with a
 * specific status code.
 *
 * Replaces fragile `err.message.includes("429")` patterns. HTTP client
 * libraries (OpenAI SDK, Anthropic SDK, node-fetch) attach a `.status`
 * property to their error objects.
 *
 * @example
 * if (isHttpError(err, 429)) { ... // rate limited }
 * if (isHttpError(err, 404)) { ... // not found }
 */
export function isHttpError(err: unknown, status: number): boolean {
  return (
    err instanceof Error &&
    "status" in err &&
    (err as { status: unknown }).status === status
  );
}

/** Look up an entry from the registry without constructing an error object */
export function lookupErrorCode(code: string): ErrorCodeEntry | undefined {
  return ERROR_REGISTRY[code];
}

/** List all registered error codes (sorted) — useful for documentation/CLI */
export function listErrorCodes(): ErrorCodeEntry[] {
  return Object.values(ERROR_REGISTRY).sort((a, b) => a.code.localeCompare(b.code));
}
