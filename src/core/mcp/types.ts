// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP (Model Context Protocol) client types.
 *
 * These follow the MCP specification (JSON-RPC 2.0 over STDIO / SSE).
 * https://modelcontextprotocol.io
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MCP Tool Schema
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string } };

// ---------------------------------------------------------------------------
// Tool Risk Classification
// ---------------------------------------------------------------------------

export type ToolRiskLevel = "low" | "medium" | "high";

export interface McpToolDefinition extends McpTool {
  /** Risk level assigned at discovery time. Default: "medium" */
  riskLevel: ToolRiskLevel;
}

/** Default risk levels by tool name prefix — matched by startsWith() */
export const DEFAULT_RISK_LEVELS: Record<string, ToolRiskLevel> = {
  // Low risk — T3 agents can invoke
  file_read: "low", search: "low", list: "low", get: "low", read: "low", query: "low",
  // Medium risk — T2+ agents required
  file_write: "medium", file_edit: "medium", create: "medium", update: "medium", send: "medium",
  // High risk — T1 agents only
  bash: "high", deploy: "high", delete: "high", drop: "high", exec: "high", shell: "high",
};

/** Minimum agent tiers permitted per risk level */
export const RISK_TIER_MAP: Record<ToolRiskLevel, string[]> = {
  low:    ["T1", "T2", "T3"],
  medium: ["T1", "T2"],
  high:   ["T1"],
};

// ---------------------------------------------------------------------------
// MCP Server Config (from mcp-servers.yaml)
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  /**
   * Environment variables to set for the MCP child process.
   * By default the child does NOT inherit the parent process environment
   * (to prevent API key leakage). Only PATH, HOME, USER, TMPDIR, and TEMP
   * are inherited automatically. Set inherit_env: true to pass the full
   * parent environment (not recommended for production).
   */
  env?: Record<string, string>;
  /**
   * When true, the MCP child process inherits the full parent environment
   * (including all SIDJUA_* env vars and API keys). Default: false.
   * Only enable for trusted local servers that explicitly require parent env.
   */
  inherit_env?: boolean;
  headers?: Record<string, string>;
  description: string;
  governance: McpGovernanceConfig;
}

export interface McpGovernanceConfig {
  allowed_divisions: string[];
  allowed_tiers: string[];
  max_calls_per_minute: number;
  forbidden_patterns: string[];
  classification_ceiling: string;
  budget_per_call: number;
  /** Per-tool risk overrides — key is tool name, value overrides DEFAULT_RISK_LEVELS */
  tool_risk_overrides?: Record<string, ToolRiskLevel>;
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export interface GovernanceDecision {
  allowed: boolean;
  reason?: string;
  stage?: number;
  escalation?: { message: string; args: Record<string, unknown> };
}

export interface GovernanceContext {
  agentId: string;
  division: string;
  tier: string;
  budgetRemaining: number;
  conversationId: string;
  taskClassification?: string;
}

// ---------------------------------------------------------------------------
// Server Health / Status
// ---------------------------------------------------------------------------

export type McpServerHealth = "healthy" | "unhealthy" | "starting" | "stopped";

export interface McpServerStatus {
  name: string;
  transport: "stdio" | "sse";
  health: McpServerHealth;
  toolCount: number;
  lastError?: string;
  restartCount: number;
}
