// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/** Top-level report document. */
export interface ReportData {
  title:       string;
  period:      { from: Date; to: Date };
  generatedAt: Date;
  generatedBy: string;   // agent ID
  sections:    ReportSection[];
}

/** A single named section within a report. */
export interface ReportSection {
  heading:  string;
  content:  string;          // HTML content
  charts?:  ChartImage[];    // embedded chart images
  table?:   ReportTable;     // optional data table
}

/** An embedded chart image (base64 data URI or file path). */
export interface ChartImage {
  title:   string;
  src:     string;
  alt:     string;
  width?:  number;
  height?: number;
}

/** A tabular data structure with headers and rows. */
export interface ReportTable {
  headers: string[];
  rows:    string[][];
}

/** Per-agent activity summary for a reporting period. */
export interface AgentActivityData {
  agentId:     string;
  agentName:   string;
  division:    string;
  taskCount:   number;
  successCount: number;
  failedCount: number;
  successRate: number;    // percentage (0–100)
  budgetUsed:  number;    // USD
  budgetLimit: number;    // USD (0 = unknown)
  topTools:    Array<{ name: string; count: number }>;
}

/** Governance event summary for a reporting period. */
export interface GovernanceEventSummary {
  totalBlocks:      number;
  byStage:          Record<string, number>;  // stage → count
  escalations:      number;
  topBlockedAgents: Array<{ agentId: string; count: number }>;
}

/** Current system health snapshot. */
export interface SystemHealthData {
  uptimeSeconds:      number;
  activeAgents:       number;
  mcpServersHealthy:  number;
  mcpServersTotal:    number;
}

/** Request body for POST /api/v1/reports/generate */
export interface ReportGenerateRequest {
  type:    "monthly" | "compliance" | "custom";
  period:  { from: string; to: string };  // ISO 8601
  title?:  string;
}
