// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.7: Environment & Tool Integration — Types
 */


export type ToolType =
  | "mcp"
  | "rest"
  | "shell"
  | "filesystem"
  | "database"
  | "computer_use"
  | "adb"
  | "composite"
  | "internal";

export type ToolStatus = "active" | "inactive" | "error" | "starting" | "stopping";


export type PlatformType =
  | "macos"
  | "windows-11"
  | "windows-10"
  | "ubuntu"
  | "android"
  | "ios";


export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolCapability {
  id: string;
  tool_id: string;
  name: string;
  description: string;
  risk_level: RiskLevel;
  requires_approval: boolean;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}


export interface ToolDefinition {
  id: string;
  name: string;
  type: ToolType;
  config: ToolConfig;
  status: ToolStatus;
  pid?: number;
  error_message?: string;
  created_at: string;
  updated_at: string;
}


export interface McpToolConfig {
  type: "mcp";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout_ms?: number;
}

/** Per-capability route definition for template-based REST tools. */
export interface RestCapabilityRoute {
  method:        "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path_template: string;
}

export interface RestToolConfig {
  type: "rest";
  base_url: string;
  auth?: {
    type: "bearer" | "basic" | "header";
    token?: string;
    username?: string;
    password?: string;
    header_name?: string;
    header_value?: string;
  };
  timeout_ms?: number;
  retry_count?: number;
  /**
   * Per-capability routing map populated by RestToolFactory.
   * key = capability name (e.g. "search"), value = method + path_template.
   */
  routes?: Record<string, RestCapabilityRoute>;
}

export interface ShellToolConfig {
  type: "shell";
  platform?: PlatformType;
  allowed_commands?: string[];
  blocked_commands?: string[];
  working_dir?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  max_output_bytes?: number;
}

export interface FilesystemToolConfig {
  type: "filesystem";
  allowed_paths: string[];
  blocked_paths?: string[];
  read_only?: boolean;
}

export interface DatabaseToolConfig {
  type: "database";
  db_type: "sqlite" | "postgresql";
  path?: string;         // sqlite
  connection_string?: string;  // postgresql
  max_rows?: number;
  /**
   * Access mode for the database adapter.
   * "readonly" (default): SELECT queries only — write queries are rejected.
   * "readwrite": All SQL statements are permitted.
   * Requires governance approval to configure as "readwrite".
   */
  access_mode?: "readonly" | "readwrite";
}

export interface ComputerUseToolConfig {
  type: "computer_use";
  platform?: PlatformType;
  screenshot_quality?: number;
  action_delay_ms?: number;
}

export interface AdbToolConfig {
  type: "adb";
  adb_path?: string;
  serial?: string;       // USB device serial
  wifi_address?: string; // WiFi ADB address host:port
  timeout_ms?: number;
}

export interface CompositeToolConfig {
  type: "composite";
  sub_tools: string[];   // tool IDs in preference order
  strategy: "fallback" | "parallel" | "round_robin";
}

export interface InternalToolConfig {
  type: "internal";
}

export type ToolConfig =
  | McpToolConfig
  | RestToolConfig
  | ShellToolConfig
  | FilesystemToolConfig
  | DatabaseToolConfig
  | ComputerUseToolConfig
  | AdbToolConfig
  | CompositeToolConfig
  | InternalToolConfig;


export interface ToolAccess {
  id: number;
  tool_id: string;
  division_code?: string;
  agent_id?: string;
  tier_max?: number;
  classification_max?: string;
}


export type GovernanceRuleType =
  | "forbidden"
  | "approval_required"
  /** Blocks access to any file path that matches or is below the pattern path. */
  | "path_deny"
  /** @deprecated Use "path_deny". Kept for backward compatibility with stored rules. */
  | "path_restriction"
  | "domain_restriction"
  | "rate_limit";

export type GovernanceEnforcement = "block" | "approve" | "log";

export interface ToolGovernanceRule {
  id: number;
  tool_id: string;
  rule_type: GovernanceRuleType;
  pattern?: string;
  condition?: string;
  enforcement: GovernanceEnforcement;
  reason?: string;
  config?: Record<string, unknown>;
  active: boolean;
  created_at: string;
}


export type ToolActionStatus = "success" | "blocked" | "error" | "pending";

export interface ToolActionRecord {
  id: number;
  tool_id: string;
  agent_id: string;
  capability: string;
  params: Record<string, unknown>;
  result_summary?: string;
  status: ToolActionStatus;
  governance_checks: GovernanceCheck[];
  duration_ms: number;
  cost_usd: number;
  task_id?: string;
  timestamp: string;
}


export interface GovernanceCheck {
  rule_type: GovernanceRuleType | "rate_limit";
  passed: boolean;
  reason?: string;
  requires_approval?: boolean;
}


export interface ToolAction {
  tool_id: string;
  capability: string;
  params: Record<string, unknown>;
  agent_id: string;
  task_id?: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;
  requires_approval?: boolean;
  governance_checks?: GovernanceCheck[];
}


export interface ToolAdapter {
  readonly id: string;
  readonly type: ToolType;
  connect(): Promise<void>;
  execute(action: ToolAction): Promise<ToolResult>;
  healthCheck(): Promise<boolean>;
  disconnect(): Promise<void>;
  getCapabilities(): ToolCapability[];
}


export type EnvironmentType = "local" | "remote" | "container" | "virtual";
export type EnvironmentStatus = "active" | "inactive" | "unknown" | "error";

export interface EnvironmentConnectionConfig {
  type: "local" | "ssh" | "adb" | "winrm";
  host?: string;
  port?: number;
  user?: string;
  key_secret?: string;
  password_secret?: string;
  serial?: string;  // ADB device serial
}

export interface EnvironmentConfig {
  id: string;
  name: string;
  type: EnvironmentType;
  platform?: PlatformType;
  platform_version?: string;
  knowledge_collections?: string[];
  connection?: EnvironmentConnectionConfig;
  tools?: string[];  // tool IDs available on this environment
}

export interface Environment {
  id: string;
  name: string;
  type: EnvironmentType;
  platform?: PlatformType;
  platform_version?: string;
  config: EnvironmentConfig;
  status: EnvironmentStatus;
  last_tested_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateEnvironmentInput {
  id: string;
  name: string;
  type: EnvironmentType;
  platform?: PlatformType;
  platform_version?: string;
  config: EnvironmentConfig;
}


export interface CreateToolInput {
  id: string;
  name: string;
  type: ToolType;
  config: ToolConfig;
  capabilities?: Omit<ToolCapability, "id" | "tool_id">[];
}


export interface ToolDescription {
  tool_id: string;
  name: string;
  type: ToolType;
  summary: string;
  capabilities: CapabilityDescription[];
}

export interface CapabilityDescription {
  name: string;
  description: string;
  risk_level: RiskLevel;
  requires_approval: boolean;
  example_params?: Record<string, unknown>;
}
