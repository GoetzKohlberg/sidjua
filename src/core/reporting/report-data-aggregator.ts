// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import type Database from "better-sqlite3";
import { createLogger } from "../logger.js";
import type { MetricsCollector } from "../metrics/metrics-collector.js";
import type { AgentActivityData, GovernanceEventSummary, SystemHealthData } from "./types.js";

const logger = createLogger("report-data");

// ─── Internal row shapes ──────────────────────────────────────────────────────

interface TaskAggRow {
  agent_id:   string;
  division:   string;
  status:     string;
  cost_sum:   number;
  count:      number;
}

interface ToolUsageRow {
  agent_id:  string;
  tool_name: string;
  count:     number;
}

interface BudgetRow {
  agent_id:    string;
  cost_budget: number;
}

interface GovernanceCountRow {
  agent_id: string;
  count:    number;
}

interface StageCountRow {
  rule_id: string;
  count:   number;
}

interface EscalationCountRow {
  count: number;
}

// ─── ReportDataAggregator ────────────────────────────────────────────────────

export class ReportDataAggregator {
  constructor(
    private readonly db: InstanceType<typeof Database>,
    private readonly metrics: MetricsCollector,
  ) {}

  /**
   * Aggregate agent activity data for a time period.
   * Queries the tasks table for task counts and cost data.
   */
  async getAgentActivity(from: Date, to: Date): Promise<AgentActivityData[]> {
    const fromIso = from.toISOString();
    const toIso   = to.toISOString();

    // Task counts per agent and status
    let taskRows: TaskAggRow[] = [];
    try {
      taskRows = this.db
        .prepare<[string, string], TaskAggRow>(
          `SELECT assigned_agent AS agent_id, division,
                  status, SUM(cost_used) AS cost_sum, COUNT(*) AS count
           FROM tasks
           WHERE created_at >= ? AND created_at <= ?
             AND assigned_agent IS NOT NULL
           GROUP BY assigned_agent, division, status`,
        )
        .all(fromIso, toIso);
    } catch (err: unknown) {
      logger.warn("report-data", "Task aggregation query failed — returning empty activity", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return [];
    }

    // Tool usage per agent from audit_events
    let toolRows: ToolUsageRow[] = [];
    try {
      toolRows = this.db
        .prepare<[string, string], ToolUsageRow>(
          `SELECT agent_id, rule_id AS tool_name, COUNT(*) AS count
           FROM audit_events
           WHERE timestamp >= ? AND timestamp <= ?
             AND event_type = 'tool.called'
           GROUP BY agent_id, rule_id
           ORDER BY count DESC`,
        )
        .all(fromIso, toIso);
    } catch (_err: unknown) {
      // Tool usage data is optional — non-fatal
    }

    // Budget limits per agent (max cost_budget from tasks in period)
    let budgetRows: BudgetRow[] = [];
    try {
      budgetRows = this.db
        .prepare<[string, string], BudgetRow>(
          `SELECT assigned_agent AS agent_id, MAX(cost_budget) AS cost_budget
           FROM tasks
           WHERE created_at >= ? AND created_at <= ?
             AND assigned_agent IS NOT NULL
           GROUP BY assigned_agent`,
        )
        .all(fromIso, toIso);
    } catch (_err: unknown) {
      // Budget limit data is optional — non-fatal
    }

    // Build per-agent map
    const agentMap = new Map<string, AgentActivityData>();

    for (const row of taskRows) {
      let entry = agentMap.get(row.agent_id);
      if (entry === undefined) {
        entry = {
          agentId:      row.agent_id,
          agentName:    row.agent_id,
          division:     row.division,
          taskCount:    0,
          successCount: 0,
          failedCount:  0,
          successRate:  0,
          budgetUsed:   0,
          budgetLimit:  0,
          topTools:     [],
        };
        agentMap.set(row.agent_id, entry);
      }
      entry.taskCount    += row.count;
      entry.budgetUsed   += row.cost_sum ?? 0;

      if (row.status === "DONE") {
        entry.successCount += row.count;
      } else if (row.status === "FAILED") {
        entry.failedCount += row.count;
      }
    }

    // Compute success rate
    for (const entry of agentMap.values()) {
      entry.successRate = entry.taskCount > 0
        ? Math.round((entry.successCount / entry.taskCount) * 100)
        : 0;
    }

    // Apply budget limits
    for (const row of budgetRows) {
      const entry = agentMap.get(row.agent_id);
      if (entry !== undefined) entry.budgetLimit = row.cost_budget;
    }

    // Apply top tools (top 5 per agent)
    const toolsByAgent = new Map<string, Array<{ name: string; count: number }>>();
    for (const row of toolRows) {
      let tools = toolsByAgent.get(row.agent_id);
      if (tools === undefined) {
        tools = [];
        toolsByAgent.set(row.agent_id, tools);
      }
      tools.push({ name: row.tool_name, count: row.count });
    }
    for (const [agentId, tools] of toolsByAgent) {
      const entry = agentMap.get(agentId);
      if (entry !== undefined) {
        entry.topTools = tools.slice(0, 5);
      }
    }

    return Array.from(agentMap.values());
  }

  /**
   * Aggregate governance events for a time period.
   * Queries the audit_events table.
   */
  async getGovernanceEvents(from: Date, to: Date): Promise<GovernanceEventSummary> {
    const fromIso = from.toISOString();
    const toIso   = to.toISOString();

    let totalBlocks = 0;
    let escalations = 0;
    const byStage: Record<string, number> = {};
    const topBlockedAgents: Array<{ agentId: string; count: number }> = [];

    try {
      const blockRow = this.db
        .prepare<[string, string], { count: number }>(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE timestamp >= ? AND timestamp <= ?
             AND action = 'blocked'`,
        )
        .get(fromIso, toIso);
      totalBlocks = blockRow?.count ?? 0;
    } catch (err: unknown) {
      logger.warn("report-data", "Governance block count query failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    try {
      const escRow = this.db
        .prepare<[string, string], EscalationCountRow>(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE timestamp >= ? AND timestamp <= ?
             AND action = 'escalated'`,
        )
        .get(fromIso, toIso);
      escalations = escRow?.count ?? 0;
    } catch (_err: unknown) {
      // Non-fatal
    }

    try {
      const stageRows = this.db
        .prepare<[string, string], StageCountRow>(
          `SELECT rule_id, COUNT(*) AS count FROM audit_events
           WHERE timestamp >= ? AND timestamp <= ?
             AND action = 'blocked'
           GROUP BY rule_id`,
        )
        .all(fromIso, toIso);

      for (const row of stageRows) {
        byStage[row.rule_id] = row.count;
      }
    } catch (_err: unknown) {
      // Non-fatal
    }

    try {
      const agentRows = this.db
        .prepare<[string, string], GovernanceCountRow>(
          `SELECT agent_id, COUNT(*) AS count FROM audit_events
           WHERE timestamp >= ? AND timestamp <= ?
             AND action = 'blocked'
           GROUP BY agent_id
           ORDER BY count DESC
           LIMIT 5`,
        )
        .all(fromIso, toIso);

      for (const row of agentRows) {
        topBlockedAgents.push({ agentId: row.agent_id, count: row.count });
      }
    } catch (_err: unknown) {
      // Non-fatal
    }

    return { totalBlocks, byStage, escalations, topBlockedAgents };
  }

  /**
   * Get current system health snapshot from the in-memory metrics collector.
   */
  getSystemHealth(): SystemHealthData {
    const uptimeSeconds = this.metrics.uptimeSeconds.getValue({});
    const activeAgents  = this.metrics.activeAgents.getValue({});

    const mcpEntries = this.metrics.mcpServerHealth.getAllEntries();
    const mcpServersTotal   = mcpEntries.length;
    const mcpServersHealthy = mcpEntries.filter((e) => e.value === 1).length;

    return { uptimeSeconds, activeAgents, mcpServersHealthy, mcpServersTotal };
  }
}
