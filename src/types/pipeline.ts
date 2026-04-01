// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Pre-Action Governance Pipeline types
 *
 * Every agent action passes through the 6-stage pipeline BEFORE execution.
 * The pipeline is synchronous and blocking. An agent that bypasses it is a bug.
 *
 * Stages: Forbidden → Security → Approval → Budget → Classification → Policy
 *
 * Source: PRE-ACTION-PIPELINE-SPEC-V1.md
 */

import type { RoleToolConfig } from "../defaults/loader.js";
export type { RoleToolConfig };

/** Canonical pipeline stages in execution order. */
export const PIPELINE_STAGES = [
  "rbac",
  "forbidden",
  "security",
  "approval",
  "budget",
  "classification",
  "policy",
] as const;

export type ActionRisk = "low" | "medium" | "high" | "critical";

export type DataClassification =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "SECRET"
  | "FYEO";

export interface ActionTypeConfig {
  readonly risk: ActionRisk;
  readonly default_classification: Exclude<DataClassification, "FYEO">;
}

export const ACTION_TYPES = {
  // File operations
  "file.read":         { risk: "low",      default_classification: "INTERNAL" },
  "file.write":        { risk: "low",      default_classification: "INTERNAL" },
  "file.delete":       { risk: "medium",   default_classification: "INTERNAL" },

  // Communication
  "email.send":        { risk: "high",     default_classification: "CONFIDENTIAL" },
  "email.draft":       { risk: "low",      default_classification: "INTERNAL" },
  "message.send":      { risk: "medium",   default_classification: "INTERNAL" },

  // External
  "api.call":          { risk: "low",      default_classification: "INTERNAL" },
  "web.fetch":         { risk: "low",      default_classification: "PUBLIC" },
  "web.post":          { risk: "high",     default_classification: "CONFIDENTIAL" },

  // Code
  "code.execute":      { risk: "medium",   default_classification: "INTERNAL" },
  "code.deploy":       { risk: "high",     default_classification: "CONFIDENTIAL" },
  "git.push":          { risk: "medium",   default_classification: "INTERNAL" },
  "git.commit":        { risk: "low",      default_classification: "INTERNAL" },

  // Financial
  "purchase.initiate": { risk: "critical", default_classification: "CONFIDENTIAL" },
  "invoice.create":    { risk: "high",     default_classification: "CONFIDENTIAL" },

  // Data
  "data.export":       { risk: "high",     default_classification: "CONFIDENTIAL" },
  "data.import":       { risk: "medium",   default_classification: "INTERNAL" },
  "data.delete":       { risk: "critical", default_classification: "CONFIDENTIAL" },

  // Agent
  "agent.delegate":    { risk: "medium",   default_classification: "INTERNAL" },
  "agent.escalate":    { risk: "low",      default_classification: "INTERNAL" },

  // Memory Lifecycle
  "memory.archive":      { risk: "low",    default_classification: "INTERNAL" },
  "memory.compact":      { risk: "low",    default_classification: "INTERNAL" },
  "memory.migrate":      { risk: "medium", default_classification: "INTERNAL" },
  "memory.delete":       { risk: "high",   default_classification: "CONFIDENTIAL" },
  "memory.pool_write":   { risk: "medium", default_classification: "INTERNAL" },
  "memory.skill_update": { risk: "medium", default_classification: "CONFIDENTIAL" },

  // Contract / Legal
  "contract.sign":     { risk: "critical", default_classification: "SECRET" },
  "contract.draft":    { risk: "medium",   default_classification: "CONFIDENTIAL" },

  // Catch-all
  "unknown":           { risk: "high",     default_classification: "CONFIDENTIAL" },
} as const satisfies Record<string, ActionTypeConfig>;

export type ActionType = keyof typeof ACTION_TYPES;


export interface ActionDescriptor {
  /** Canonical action type from ACTION_TYPES registry, or "custom.<name>" for extensions */
  type: ActionType | `custom.${string}`;
  /** What is being acted on (file path, URL, entity name) */
  target: string;
  /** Human-readable summary */
  description: string;
  /** Estimated cost, if known (e.g. for LLM API calls) */
  estimated_cost_usd?: number;
  /** Classification of data involved, if known */
  data_classification?: DataClassification;
  /** Action-specific parameters */
  parameters?: Record<string, unknown>;
  /** For tool invocations: the specific tool name (e.g. "system_health") */
  tool_name?: string;
  /** For tool invocations: whether the tool is internal or MCP */
  tool_type?: "internal" | "mcp";
}

export interface ActionContext {
  /** Parent task chain reference */
  task_id?: string;
  /** If this action is part of a larger sequence */
  parent_request_id?: string;
  /** Agent's home division */
  division_code: string;
  /** If acting on another division's resources */
  target_division?: string;
  /** Current agent session identifier */
  session_id: string;
}

export interface ActionRequest {
  /** UUID, generated per request */
  request_id: string;
  /** ISO 8601 */
  timestamp: string;
  agent_id: string;
  agent_tier: 1 | 2 | 3;
  /**
   * Agent's home division. Must equal context.division_code.
   * context.division_code is authoritative for pipeline stage evaluation.
   */
  division_code: string;
  action: ActionDescriptor;
  context: ActionContext;
  /** Agent's tool RBAC config from role YAML. Optional; if absent, RBAC stage is skipped. */
  tools?: RoleToolConfig;
}


export type PipelineVerdict = "ALLOW" | "BLOCK" | "PAUSE";
export type StageVerdict = "PASS" | "BLOCK" | "PAUSE" | "WARN";
export type StageName = "rbac" | "security" | "forbidden" | "approval" | "budget" | "classification" | "policy";


export interface RuleCheckResult {
  /** e.g. "forbidden.sign_contract" */
  rule_id: string;
  /** File path: "governance/boundaries/forbidden-actions.yaml" */
  rule_source: string;
  matched: boolean;
  verdict: StageVerdict;
  reason?: string;
}

export interface StageResult {
  stage: StageName;
  verdict: StageVerdict;
  duration_ms: number;
  rules_checked: RuleCheckResult[];
}

export interface Warning {
  stage: string;
  rule_id: string;
  message: string;
  severity: "low" | "medium" | "high";
}


export interface PipelineResult {
  /** Echoed from ActionRequest */
  request_id: string;
  timestamp: string;
  verdict: PipelineVerdict;
  stage_results: StageResult[];
  /** Which stage caused BLOCK/PAUSE; undefined if ALLOW */
  blocking_stage?: StageName;
  /** Human-readable reason; undefined if ALLOW */
  blocking_reason?: string;
  /** Soft warnings — action still allowed */
  warnings: Warning[];
  /** ID of the audit_trail entry created (always written) */
  audit_entry_id: number;
  /** If PAUSE: ID in approval_queue */
  approval_id?: number;
  /** Token to resume after approval is granted */
  resume_token?: string;
}


export interface ForbiddenRule {
  /** Action type or glob pattern ("data.*" | "*" | "email.send") */
  action: string;
  /** Optional condition expression (V1: simple comparisons only) */
  condition?: string;
  reason: string;
  /** Role, agent_id, or "SYSTEM_BLOCK" */
  escalate_to: string;
}

export interface ForbiddenConfig {
  forbidden: ForbiddenRule[];
}


export interface ApprovalTrigger {
  action: string;
  condition?: string;
}

export interface ApprovalWorkflow {
  trigger: ApprovalTrigger;
  /** "division_head" | "CEO" | specific agent_id */
  require: string;
  timeout_hours: number;
}

export interface ApprovalWorkflowsConfig {
  workflows: ApprovalWorkflow[];
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRecord {
  id: number;
  created_at: string;
  agent_id: string;
  division_code: string | null;
  action_description: string;
  rule_triggered: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  metadata: Record<string, unknown> | null;
}


export interface BudgetRule {
  division_code: string;
  monthly_limit_usd: number | null;
  daily_limit_usd: number | null;
  alert_threshold_percent: number;
}

/**
 * V1: Budget limits are read from the cost_budgets DB table provisioned by
 * `sidjua apply`. This config type is reserved for future YAML overrides.
 */
export type BudgetConfig = Record<string, never>;


export interface ClassificationLevel {
  code: string;
  rank: number;
  description: string;
}

export interface ClassificationConfig {
  levels: ClassificationLevel[];
  /** Maps "tier_1" → "SECRET", "tier_2" → "CONFIDENTIAL", etc. */
  agent_clearance: Record<string, string>;
  /** Per-division overrides: division_code → tier_key → clearance */
  division_overrides?: Record<string, Record<string, string>>;
}


export type PolicyEnforcement = "hard" | "soft";

export interface PolicyRule {
  id: string;
  description: string;
  /** Action types or globs this rule applies to */
  action_types: string[];
  /** Condition expression or "always" */
  check: string;
  /** hard = BLOCK, soft = WARN */
  enforcement: PolicyEnforcement;
}

export interface PolicyConfig {
  /** Source YAML file path */
  source_file: string;
  rules: PolicyRule[];
}


/**
 * Full governance configuration loaded from governance/ YAML files.
 * Passed to the pipeline evaluator.
 */
export interface GovernanceConfig {
  forbidden: ForbiddenRule[];
  approval: ApprovalWorkflow[];
  /** V1: Budget limits come from DB; this is reserved for future YAML overrides */
  budgets: BudgetConfig;
  classification: ClassificationConfig;
  policies: PolicyConfig[];
  /** Stage 0: Optional security filter config (absent = stage skipped entirely) */
  security?: SecurityConfig;
  /** ISO 8601 timestamp of when this config was loaded */
  loaded_at: string;
  /** SHA-256 hashes of loaded files, keyed by path */
  file_hashes: Record<string, string>;
}


/**
 * Filter mode:
 *   blacklist — block targets matching `blocked` patterns; allow everything else (default)
 *   whitelist — allow only targets matching `allowed` patterns; block everything else
 */
export type SecurityFilterMode = "blacklist" | "whitelist";

/**
 * A single entry in the security filter pattern lists.
 *
 * `pattern`    — URL/host/path glob, or a bare IP/CIDR for network_access checks
 * `applies_to` — action type globs this entry covers (e.g. ["web.fetch", "api.*"])
 * `reason`     — human-readable message emitted on BLOCK
 */
export interface SecurityFilterEntry {
  pattern:    string;
  applies_to: string[];
  reason:     string;
}

/**
 * Per-layer security filter configuration.
 * Loaded from governance/security/security.yaml.
 */
export interface SecurityFilterConfig {
  /** Blacklist = block on match; whitelist = block unless matched (default: "blacklist") */
  mode:             SecurityFilterMode;
  /** Patterns to block in blacklist mode */
  blocked?:         SecurityFilterEntry[];
  /** Patterns to allow in whitelist mode */
  allowed?:         SecurityFilterEntry[];
  /** CIDR ranges permitted for network-facing actions (web.fetch, api.call, web.post) */
  allowed_networks?: string[];
}

export interface SecurityConfig {
  filter: SecurityFilterConfig;
}


export type PersonalEnforce = "block" | "ask_first" | "warn";

export interface PersonalRule {
  action: string;
  enforce: PersonalEnforce;
  reason: string;
  condition?: string;
}

export interface PersonalMemoryConfig {
  /** Automatically compact when exceeding threshold */
  auto_compact?: boolean;
  /** Short-term memory limit in KB (default: 20) */
  short_term_limit_kb?: number;
  /** Archival target: "file" for personal mode */
  archive_to?: "file" | "qdrant";
  /** Relative path to archive directory */
  archive_path?: string;
}

export interface MyRulesConfig {
  my_rules: PersonalRule[];
  budget?: {
    daily_limit_usd?: number;
    monthly_limit_usd?: number;
    alert_threshold_percent?: number;
  };
  memory?: PersonalMemoryConfig;
}


export interface ScheduledPolicy {
  /** Source YAML file path */
  source_file: string;
  schedule: {
    type: "cron";
    /** Cron expression, e.g. "0 2 * * *" */
    expression: string;
    timezone: string;
    /** Whether the policy can also be triggered on demand */
    on_demand: boolean;
  };
  thresholds: Record<string, unknown>;
  retention: Record<string, unknown>;
  archival: Record<string, unknown>;
  compaction: Record<string, unknown>;
  /** Standard rules for Stage 5 policy evaluation */
  rules: PolicyRule[];
}


export type ConditionOperator = ">" | "<" | ">=" | "<=" | "==" | "!=" | "contains";

export interface ParsedCondition {
  field: string;
  operator: ConditionOperator;
  value: string | number | boolean;
  /**
   * True when the value token was not a literal (no quotes, not a number,
   * not a boolean) — indicates the value should be resolved as a field ref.
   */
  valueIsFieldRef: boolean;
}
