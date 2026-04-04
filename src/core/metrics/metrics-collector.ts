// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Prometheus-compatible metrics collector.
 *
 * In-memory counters and gauges serialized to Prometheus exposition format
 * on each scrape. Labels are sanitized: no PII, no secrets, no user data.
 *
 * Cardinality safety: each Counter/Gauge hard-caps at MAX_ENTRIES label
 * combinations — excess increments/sets are dropped to prevent unbounded
 * memory growth from unexpected label values.
 */

import { createLogger } from "../logger.js";

const logger = createLogger("metrics");

/** Maximum number of distinct label-set combinations per metric. */
const MAX_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface MetricEntry {
  labels: Record<string, string>;
  value:  number;
}

// ---------------------------------------------------------------------------
// Counter — monotonically increasing value
// ---------------------------------------------------------------------------

class Counter {
  private readonly entries = new Map<string, MetricEntry>();

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  /**
   * Increment the counter for the given label set.
   * Silently drops the increment when the cardinality cap is reached.
   */
  inc(labels: Record<string, string>, amount = 1): void {
    const key   = labelsToKey(labels);
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      entry.value += amount;
    } else if (this.entries.size < MAX_ENTRIES) {
      this.entries.set(key, { labels, value: amount });
    } else {
      logger.debug("metrics", "Counter cardinality cap reached — dropping increment", {
        metadata: { metric: this.name, labels },
      });
    }
  }

  serialize(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);
    for (const entry of this.entries.values()) {
      lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    return lines.join("\n");
  }

  /** Reset all counters — used in tests. */
  reset(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Gauge — value that can go up and down
// ---------------------------------------------------------------------------

class Gauge {
  private readonly entries = new Map<string, MetricEntry>();

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  /**
   * Set the gauge value for the given label set.
   * Silently drops when the cardinality cap is reached for a NEW label set.
   * Always allows updating an existing label set.
   */
  set(labels: Record<string, string>, value: number): void {
    const key   = labelsToKey(labels);
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      entry.value = value;
    } else if (this.entries.size < MAX_ENTRIES) {
      this.entries.set(key, { labels, value });
    } else {
      logger.debug("metrics", "Gauge cardinality cap reached — dropping set", {
        metadata: { metric: this.name, labels },
      });
    }
  }

  serialize(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} gauge`);
    for (const entry of this.entries.values()) {
      lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    return lines.join("\n");
  }

  /** Reset all gauges — used in tests. */
  reset(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

function labelsToKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g,  '\\"')
    .replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string>): string {
  const pairs = Object.entries(labels).map(
    ([k, v]) => `${k}="${escapeLabel(v)}"`,
  );
  return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
}

// ---------------------------------------------------------------------------
// MetricsCollector — singleton holding all metrics
// ---------------------------------------------------------------------------

export class MetricsCollector {
  // ── Counters ───────────────────────────────────────────────────────────────

  /** Total tasks processed per agent and status. Labels: agent, division, status */
  readonly agentTasksTotal = new Counter(
    "sidjua_agent_tasks_total",
    "Total tasks processed per agent and status",
  );

  /** Total governance blocks per agent and stage. Labels: agent, stage */
  readonly governanceBlocksTotal = new Counter(
    "sidjua_governance_blocks_total",
    "Total governance blocks per agent and stage",
  );

  /** Total MCP tool calls per agent and tool. Labels: agent, tool */
  readonly toolCallsTotal = new Counter(
    "sidjua_tool_calls_total",
    "Total MCP tool calls per agent and tool",
  );

  /** Total escalations per agent and type. Labels: agent, type */
  readonly escalationsTotal = new Counter(
    "sidjua_escalations_total",
    "Total escalations per agent and type",
  );

  /** Total webhook requests per agent and source. Labels: agent, source */
  readonly webhookReceivedTotal = new Counter(
    "sidjua_webhook_received_total",
    "Total webhook requests per agent and source",
  );

  /** Total LLM API requests per agent and model. Labels: agent, model */
  readonly llmRequestsTotal = new Counter(
    "sidjua_llm_requests_total",
    "Total LLM API requests per agent and model",
  );

  /** Total LLM tokens used per agent, model, and direction. Labels: agent, model, direction */
  readonly llmTokensTotal = new Counter(
    "sidjua_llm_tokens_total",
    "Total LLM tokens used per agent, model, and direction",
  );

  // ── Gauges ─────────────────────────────────────────────────────────────────

  /** Budget used per agent in USD. Labels: agent, division */
  readonly agentBudgetUsedUsd = new Gauge(
    "sidjua_agent_budget_used_usd",
    "Budget used per agent in USD",
  );

  /** Budget remaining per agent in USD. Labels: agent, division */
  readonly agentBudgetRemainingUsd = new Gauge(
    "sidjua_agent_budget_remaining_usd",
    "Budget remaining per agent in USD",
  );

  /** MCP server health status (1=healthy, 0=unhealthy). Labels: server */
  readonly mcpServerHealth = new Gauge(
    "sidjua_mcp_server_health",
    "MCP server health status (1=healthy, 0=unhealthy)",
  );

  /** SIDJUA uptime in seconds. Labels: none */
  readonly uptimeSeconds = new Gauge(
    "sidjua_uptime_seconds",
    "SIDJUA uptime in seconds",
  );

  /** Number of currently active agents. Labels: none */
  readonly activeAgents = new Gauge(
    "sidjua_active_agents",
    "Number of currently active agents",
  );

  private readonly startTime = Date.now();

  /**
   * Serialize all metrics to Prometheus text exposition format (version 0.0.4).
   * Always updates the uptime gauge before serializing.
   */
  serialize(): string {
    this.uptimeSeconds.set({}, (Date.now() - this.startTime) / 1000);

    const sections = [
      this.agentTasksTotal.serialize(),
      this.governanceBlocksTotal.serialize(),
      this.toolCallsTotal.serialize(),
      this.escalationsTotal.serialize(),
      this.webhookReceivedTotal.serialize(),
      this.llmRequestsTotal.serialize(),
      this.llmTokensTotal.serialize(),
      this.agentBudgetUsedUsd.serialize(),
      this.agentBudgetRemainingUsd.serialize(),
      this.mcpServerHealth.serialize(),
      this.uptimeSeconds.serialize(),
      this.activeAgents.serialize(),
    ];

    // Only include sections that have at least one data line (not just HELP + TYPE)
    return sections
      .filter((s) => s.split("\n").length > 2)
      .join("\n\n") + "\n";
  }

  /** Reset all metrics — for testing. */
  _reset(): void {
    this.agentTasksTotal.reset();
    this.governanceBlocksTotal.reset();
    this.toolCallsTotal.reset();
    this.escalationsTotal.reset();
    this.webhookReceivedTotal.reset();
    this.llmRequestsTotal.reset();
    this.llmTokensTotal.reset();
    this.agentBudgetUsedUsd.reset();
    this.agentBudgetRemainingUsd.reset();
    this.mcpServerHealth.reset();
    this.uptimeSeconds.reset();
    this.activeAgents.reset();
  }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let _instance: MetricsCollector | null = null;

/** Return the global MetricsCollector singleton. Created on first call. */
export function getMetrics(): MetricsCollector {
  if (_instance === null) {
    _instance = new MetricsCollector();
    logger.debug("metrics", "MetricsCollector initialized", {});
  }
  return _instance;
}

/** Replace the singleton — for testing only. */
export function _setMetricsInstance(instance: MetricsCollector | null): void {
  _instance = instance;
}
