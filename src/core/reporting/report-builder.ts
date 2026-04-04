// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import type { ReportDataAggregator } from "./report-data-aggregator.js";
import { escapeHtml } from "./report-template.js";
import type {
  ReportData,
  ReportSection,
  ReportTable,
  AgentActivityData,
  GovernanceEventSummary,
  SystemHealthData,
} from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMonth(d: Date): string {
  return d.toLocaleString("en-US", { month: "long", year: "numeric" });
}

function fmtUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function fmtPct(rate: number): string {
  return `${rate.toFixed(1)}%`;
}

// ─── Section builders ─────────────────────────────────────────────────────────

function buildExecutiveSummary(
  activity: AgentActivityData[],
  governance: GovernanceEventSummary,
  health: SystemHealthData,
): ReportSection {
  const totalTasks   = activity.reduce((s, a) => s + a.taskCount, 0);
  const totalSuccess = activity.reduce((s, a) => s + a.successCount, 0);
  const overallRate  = totalTasks > 0 ? Math.round((totalSuccess / totalTasks) * 100) : 0;
  const totalBudget  = activity.reduce((s, a) => s + a.budgetUsed, 0);

  const content = `
<div class="summary-box">
  <strong>Tasks Completed:</strong> ${totalSuccess} / ${totalTasks}
  (${overallRate}% success rate)<br>
  <strong>Governance Blocks:</strong> ${governance.totalBlocks}
  &nbsp;|&nbsp; <strong>Escalations:</strong> ${governance.escalations}<br>
  <strong>Total Budget Used:</strong> ${fmtUsd(totalBudget)}<br>
  <strong>Active Agents:</strong> ${health.activeAgents}
  &nbsp;|&nbsp; <strong>MCP Servers:</strong> ${health.mcpServersHealthy}/${health.mcpServersTotal} healthy<br>
  <strong>System Uptime:</strong> ${Math.floor(health.uptimeSeconds / 3600)}h
</div>`.trim();

  return { heading: "Executive Summary", content };
}

function buildAgentPerformanceSection(activity: AgentActivityData[]): ReportSection {
  if (activity.length === 0) {
    return {
      heading: "Agent Performance",
      content: "<p>No agent activity recorded for this period.</p>",
    };
  }

  const table: ReportTable = {
    headers: ["Agent", "Division", "Tasks", "Success", "Failed", "Success Rate"],
    rows: activity.map((a) => [
      escapeHtml(a.agentId),
      escapeHtml(a.division),
      String(a.taskCount),
      String(a.successCount),
      String(a.failedCount),
      fmtPct(a.successRate),
    ]),
  };

  return {
    heading: "Agent Performance",
    content: "<p>Task completion statistics for each agent in the reporting period.</p>",
    table,
  };
}

function buildBudgetOverviewSection(activity: AgentActivityData[]): ReportSection {
  if (activity.length === 0) {
    return {
      heading: "Budget Overview",
      content: "<p>No budget data available for this period.</p>",
    };
  }

  const table: ReportTable = {
    headers: ["Agent", "Budget Used", "Budget Limit", "Utilisation"],
    rows: activity.map((a) => {
      const utilisation = a.budgetLimit > 0
        ? fmtPct((a.budgetUsed / a.budgetLimit) * 100)
        : "—";
      return [
        escapeHtml(a.agentId),
        fmtUsd(a.budgetUsed),
        a.budgetLimit > 0 ? fmtUsd(a.budgetLimit) : "—",
        utilisation,
      ];
    }),
  };

  return {
    heading: "Budget Overview",
    content: "<p>Per-agent budget consumption for the reporting period.</p>",
    table,
  };
}

function buildGovernanceSection(governance: GovernanceEventSummary): ReportSection {
  const stageRows = Object.entries(governance.byStage)
    .sort(([, a], [, b]) => b - a)
    .map(([stage, count]) => [escapeHtml(stage), String(count)]);

  const agentRows = governance.topBlockedAgents.map((a) => [
    escapeHtml(a.agentId),
    String(a.count),
  ]);

  let content = `<p>
  <strong>Total Blocks:</strong> ${governance.totalBlocks} &nbsp;|&nbsp;
  <strong>Escalations:</strong> ${governance.escalations}
</p>`;

  if (stageRows.length > 0) {
    content += `<h3>Blocks by Rule</h3>`;
    content += buildHtmlTable(["Rule / Stage", "Block Count"], stageRows);
  }

  if (agentRows.length > 0) {
    content += `<h3>Top Blocked Agents</h3>`;
    content += buildHtmlTable(["Agent", "Block Count"], agentRows);
  }

  return { heading: "Governance Events", content };
}

function buildSystemHealthSection(health: SystemHealthData): ReportSection {
  const uptimeHours = Math.floor(health.uptimeSeconds / 3600);
  const uptimeMins  = Math.floor((health.uptimeSeconds % 3600) / 60);

  const content = `
<div class="summary-box">
  <strong>Uptime:</strong> ${uptimeHours}h ${uptimeMins}m<br>
  <strong>Active Agents:</strong> ${health.activeAgents}<br>
  <strong>MCP Servers:</strong> ${health.mcpServersHealthy} healthy / ${health.mcpServersTotal} total
</div>`.trim();

  return { heading: "System Health", content };
}

function buildRecommendationsSection(
  activity: AgentActivityData[],
  governance: GovernanceEventSummary,
): ReportSection {
  const recommendations: string[] = [];

  // High budget utilisation
  for (const a of activity) {
    if (a.budgetLimit > 0 && a.budgetUsed / a.budgetLimit > 0.8) {
      recommendations.push(
        `Agent <strong>${escapeHtml(a.agentId)}</strong> used ${fmtPct((a.budgetUsed / a.budgetLimit) * 100)} ` +
        `of its budget. Consider increasing the daily limit or reducing task frequency.`,
      );
    }
  }

  // High governance block rate
  if (governance.totalBlocks > 10) {
    recommendations.push(
      `${governance.totalBlocks} governance blocks were recorded this period. ` +
      `Review governance rules — some may be too restrictive for current workflows.`,
    );
  }

  // Low success rate agents
  for (const a of activity) {
    if (a.taskCount >= 5 && a.successRate < 70) {
      recommendations.push(
        `Agent <strong>${escapeHtml(a.agentId)}</strong> has a low success rate ` +
        `(${fmtPct(a.successRate)}). Review task instructions and tool configuration.`,
      );
    }
  }

  if (recommendations.length === 0) {
    recommendations.push("No significant issues detected. System is operating within normal parameters.");
  }

  const content = recommendations
    .map((r) => `<div class="recommendation">${r}</div>`)
    .join("\n");

  return { heading: "Recommendations", content };
}

// ─── Inline table helper (for governance section which embeds two tables) ─────

function buildHtmlTable(headers: string[], rows: string[][]): string {
  const headerCells = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const bodyRows = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

// ─── Compliance-specific section builders ─────────────────────────────────────

function buildAuditTrailSection(governance: GovernanceEventSummary): ReportSection {
  const rows = governance.topBlockedAgents.map((a) => [
    escapeHtml(a.agentId),
    String(a.count),
    "blocked",
  ]);

  const content = `<p>Audit trail summary for the compliance period. Full audit log available via <code>sidjua audit export</code>.</p>`;

  return {
    heading: "Audit Trail Summary",
    content,
    ...(rows.length > 0 ? { table: { headers: ["Agent", "Events", "Action"], rows } } : {}),
  };
}

// ─── Public report builders ───────────────────────────────────────────────────

export async function buildMonthlyReport(
  aggregator: ReportDataAggregator,
  period: { from: Date; to: Date },
): Promise<ReportData> {
  const [activity, governance] = await Promise.all([
    aggregator.getAgentActivity(period.from, period.to),
    aggregator.getGovernanceEvents(period.from, period.to),
  ]);
  const health = aggregator.getSystemHealth();

  return {
    title:       `SIDJUA Monthly Report — ${formatMonth(period.from)}`,
    period,
    generatedAt: new Date(),
    generatedBy: "ceo-assistant",
    sections: [
      buildExecutiveSummary(activity, governance, health),
      buildAgentPerformanceSection(activity),
      buildBudgetOverviewSection(activity),
      buildGovernanceSection(governance),
      buildSystemHealthSection(health),
      buildRecommendationsSection(activity, governance),
    ],
  };
}

export async function buildComplianceReport(
  aggregator: ReportDataAggregator,
  period: { from: Date; to: Date },
): Promise<ReportData> {
  const [activity, governance] = await Promise.all([
    aggregator.getAgentActivity(period.from, period.to),
    aggregator.getGovernanceEvents(period.from, period.to),
  ]);

  const title = period.from.getFullYear() === period.to.getFullYear()
    ? `SIDJUA Compliance Report — ${period.from.getFullYear()}`
    : `SIDJUA Compliance Report — ${period.from.toISOString().slice(0, 10)} to ${period.to.toISOString().slice(0, 10)}`;

  return {
    title,
    period,
    generatedAt: new Date(),
    generatedBy: "ceo-assistant",
    sections: [
      buildExecutiveSummary(activity, governance, aggregator.getSystemHealth()),
      buildGovernanceSection(governance),
      buildAuditTrailSection(governance),
      buildAgentPerformanceSection(activity),
      buildRecommendationsSection(activity, governance),
    ],
  };
}
