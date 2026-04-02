// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

// API response types matching SIDJUA server routes

// ---- System ----------------------------------------------------------------

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime_ms: number;
  components: Record<string, unknown>;
}

export interface SystemInfo {
  name: string;
  version: string;
  description: string;
  started_at: string;
  uptime_ms: number;
  request_id: string;
}

// ---- Divisions -------------------------------------------------------------

export interface Division {
  code: string;
  name: string;
  active: boolean;
  scope?: string;
  required?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface DivisionsResponse {
  divisions: Division[];
}

export interface DivisionResponse {
  division: Division;
}

// ---- Agents ----------------------------------------------------------------

export type AgentLifecycleStatus =
  | 'stopped'
  | 'starting'
  | 'active'
  | 'idle'
  | 'stopping'
  | 'error';

export interface Agent {
  id: string;
  name: string;
  /** Division code — server field name is `division` (AgentDefinitionRow). */
  division: string;
  tier: number;
  provider: string;
  model: string;
  /** Resolved model: "auto" resolved to actual provider+model, or same as model. */
  resolved_model?: string;
  skill_path: string;
  status: AgentLifecycleStatus;
  created_at: string;
  created_by: string;
  updated_at: string;
}

export interface AgentsResponse {
  agents: Agent[];
}

export interface AgentResponse {
  agent: Agent;
  message?: string;
}

// ---- Starter agents --------------------------------------------------------

export interface StarterAgent {
  id:           string;
  name:         string;
  description:  string;
  icon:         string;
  tier:         1 | 2 | 3;
  division:     string;
  domains:      string[];
  capabilities: string[];
  status:       'active' | 'inactive';
}

export interface StarterAgentsResponse {
  agents: StarterAgent[];
}

export interface StarterAgentResponse {
  agent: StarterAgent;
}

export interface StarterDivision {
  id:          string;
  name:        string;
  protected:   boolean;
  description: string;
  agent_count: number;
  agents:      string[];
  budget: {
    daily_limit_usd: number;
    monthly_cap_usd: number;
  };
}

export interface StarterDivisionsResponse {
  divisions: StarterDivision[];
}

// ---- Tasks -----------------------------------------------------------------

export type TaskStatus =
  | 'CREATED'
  | 'PENDING'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'WAITING'
  | 'REVIEW'
  | 'DONE'
  | 'FAILED'
  | 'ESCALATED'
  | 'CANCELLED';

export interface Task {
  id: string;
  parent_id?: string;
  root_id?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  division_code?: string;
  agent_id?: string;
  priority?: number;
  tier?: number;
  cost_used?: number;
  budget_usd?: number;
  created_at: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface TasksResponse {
  tasks: Task[];
  total: number;
  limit: number;
  offset: number;
}

export interface TaskResponse {
  task: Task;
}

// ---- Audit -----------------------------------------------------------------

export interface AuditEntry {
  id: string | number;
  timestamp: string;
  action_type: string;
  agent_id?: string;
  division_code?: string;
  parent_task_id?: string;
  outcome?: string;
  metadata?: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ---- Costs -----------------------------------------------------------------

export interface CostTotal {
  total_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  entries: number;
}

export interface CostBreakdownEntry {
  division_code: string;
  agent_id: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  entries: number;
}

export interface CostPeriod {
  from: string;
  to: string;
}

export interface CostsResponse {
  period: CostPeriod;
  total: CostTotal;
  breakdown: CostBreakdownEntry[];
}

// ---- Governance ------------------------------------------------------------

export interface GovernancePolicy {
  id: string;
  name: string;
  division_code?: string;
  type?: string;
  enabled: boolean;
  created_at?: string;
}

export interface GovernanceSnapshot {
  id:                  string;
  timestamp:           string;
  version:             number;
  trigger:             'apply' | 'manual';
  divisions_yaml_hash: string;
}

export interface GovernanceStatus {
  snapshot_count:  number;
  latest_snapshot: GovernanceSnapshot | null;
  last_apply_at:   string | null;
  work_dir:        string;
}

export interface GovernanceHistory {
  snapshots: GovernanceSnapshot[];
}

// ---- Logging ---------------------------------------------------------------

export interface LoggingStatus {
  global:       string;
  format:       'json' | 'text';
  output:       'stdout' | 'file' | 'both';
  components:   Record<string, string>;
  errorLogging: boolean;
}

// ---- Provider catalog ------------------------------------------------------

export interface ApprovedProvider {
  id:             string;
  name:           string;
  model:          string;
  display_name:   string;
  tier:           'free' | 'paid';
  quality:        string;
  input_price:    number;
  output_price:   number;
  rate_limit:     string;
  api_base:       string;
  signup_url:     string;
  info:           string;
  recommended:    boolean;
  api_compatible: 'openai';
}

export interface ProviderCatalogResponse {
  version:       string;
  updated:       string;
  price_ceiling: { input_per_1m: number; output_per_1m: number };
  min_quality:   string;
  providers:     ApprovedProvider[];
}

export interface ProviderPublic {
  provider_id:     string;
  display_name:    string;
  api_key_set:     boolean;
  api_key_preview: string;
  api_base?:       string;
  model?:          string;
  custom_name?:    string;
}

export interface ProviderConfigResponse {
  configured:       boolean;
  mode:             'simple' | 'advanced';
  default_provider: ProviderPublic | null;
  agent_overrides:  Record<string, ProviderPublic>;
}

export interface ProviderTestResult {
  status:            'ok' | 'error';
  model?:            string;
  response_time_ms?: number;
  message?:          string;
  error?:            string;
  details?:          string;
}

// ---- Chat ------------------------------------------------------------------

export interface ChatMessage {
  role:      'user' | 'assistant';
  content:   string;
  timestamp: string;
}

export interface ChatHistoryResponse {
  conversation_id: string | null;
  agent_id:        string;
  messages:        ChatMessage[];
}

// ---- Workspace config ------------------------------------------------------

export interface WorkspaceConfigResponse {
  firstRunCompleted: boolean;
}

export interface FirstRunCompleteResponse {
  success: boolean;
}

// ---- Locale (i18n) ---------------------------------------------------------

export interface LocaleMetaResponse {
  current:      string;
  available:    string[];
  completeness: Record<string, number>;
}

export interface LocaleStringsResponse {
  locale:       string;
  strings:      Record<string, string>;
  completeness: number;
}

export interface LocaleSetResponse {
  success: boolean;
  locale:  string;
}

// ---- Org Chart (P345) ------------------------------------------------------

export interface OrgAgentNode {
  id:            string;
  name:          string;
  tier:          number;
  division_code: string | null;
  role_title:    string | null;
  reports_to:    string | null;
  delegate_to:   string | null;
  active:        boolean;
}

export interface OrgDivisionNode {
  code:                 string;
  name_en:              string;
  parent_division_code: string | null;
  budget_allocation:    number | null;
  active:               boolean;
  head_agent:           string | null;
  head_role:            string | null;
}

export interface OrgNode {
  division: OrgDivisionNode;
  agents:   OrgAgentNode[];
  children: OrgNode[];
}

export interface OrgTreeResponse {
  roots: OrgNode[];
}

export interface OrgAgentDetail {
  agent:             OrgAgentNode;
  division:          OrgDivisionNode | null;
  reports_to_agent:  OrgAgentNode | null;
  delegate_to_agent: OrgAgentNode | null;
  direct_reports:    OrgAgentNode[];
}

export interface OrgDivisionDetail {
  division:          OrgDivisionNode;
  parent:            OrgDivisionNode | null;
  children:          OrgDivisionNode[];
  agents:            OrgAgentNode[];
  head_agent_detail: OrgAgentNode | null;
}

// ---- Tokens ----------------------------------------------------------------

export interface TokenCreateResponse {
  id:       string;
  rawToken: string;
  warning:  string;
}

// ---- API Error -------------------------------------------------------------

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    request_id: string;
  };
}

// ---- Bouncer (sensitive data filter) ---------------------------------------

export interface ScanMatch {
  label:      string;
  start:      number;
  end:        number;
  confidence: 'high' | 'medium';
}

export interface ScanResult {
  detected:  boolean;
  matches:   ScanMatch[];
  redacted:  string;
}

export interface BouncerConfigResponse {
  enabled:     boolean;
  sensitivity: 'strict' | 'normal' | 'relaxed';
}

// ---- Org Chart Status (P359) ------------------------------------------------

export interface AgentStatus {
  agent_id:          string;
  health:            'healthy' | 'unhealthy' | 'unknown';
  last_heartbeat:    string | null;
  recent_task_count: number;
  is_busy:           boolean;
}

export interface AgentStatusResponse {
  agents:      Record<string, AgentStatus>;
  server_time: string;
}

export interface TaskHistoryEntry {
  id:         string;
  event_type: string;
  title:      string;
  timestamp:  string;
  details:    Record<string, unknown>;
}

export interface AgentTaskHistoryResponse {
  agent_id: string;
  tasks:    TaskHistoryEntry[];
}
