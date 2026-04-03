// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10/16: `sidjua costs` command
 *
 * Cost breakdown across divisions, agents, and time periods.
 * Reads from cost_ledger (written by CostTracker after every LLM call).
 */

import { join } from "node:path";
import { withCliDatabase } from "../utils/with-cli-database.js";
import { formatTable } from "../formatters/table.js";
import { formatJson } from "../formatters/json.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("costs-cmd");


export interface CostsCommandOptions {
  workDir:  string;
  division: string | undefined;
  agent:    string | undefined;
  period:   string;  // "1h" | "24h" | "7d" | "30d" | "all"
  json:     boolean;
}

interface AgentCostRow {
  agent_id:            string;
  division_code:       string;
  provider:            string;
  model:               string;
  total_input_tokens:  number;
  total_output_tokens: number;
  total_cost_usd:      number;
}


function periodToSql(period: string): string | null {
  switch (period) {
    case "1h":  return "timestamp >= datetime('now', '-1 hour')";
    case "24h": return "timestamp >= datetime('now', '-24 hours')";
    case "7d":  return "timestamp >= datetime('now', '-7 days')";
    case "30d": return "timestamp >= datetime('now', '-30 days')";
    default:    return null; // "all" or unknown — no time filter
  }
}


export function runCostsCommand(opts: CostsCommandOptions): number {
  return withCliDatabase({ workDir: opts.workDir, queryOnly: true }, (db) => {
    // Build dynamic SQL with period + optional filters
    const conditions: string[] = ["1=1"];
    const params: string[] = [];

    const periodClause = periodToSql(opts.period);
    if (periodClause !== null) conditions.push(periodClause);

    if (opts.division !== undefined) {
      conditions.push("division_code = ?");
      params.push(opts.division);
    }

    if (opts.agent !== undefined) {
      conditions.push("agent_id = ?");
      params.push(opts.agent);
    }

    const sql = `
      SELECT
        agent_id,
        division_code,
        provider,
        model,
        SUM(input_tokens)  AS total_input_tokens,
        SUM(output_tokens) AS total_output_tokens,
        SUM(cost_usd)      AS total_cost_usd
      FROM cost_ledger
      WHERE ${conditions.join(" AND ")}
      GROUP BY agent_id, division_code, provider, model
      ORDER BY total_cost_usd DESC
    `;

    let rows: AgentCostRow[];
    try {
      rows = db.prepare<string[], AgentCostRow>(sql).all(...params);
    } catch (e: unknown) {
      logger.debug("costs-cmd", "cost_ledger table not found — no cost data available (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      process.stdout.write("No cost data available.\n");
      return 0;
    }

    if (rows.length === 0) {
      process.stdout.write("No cost data available.\n");
      return 0;
    }

    // ── Aggregation ──────────────────────────────────────────────────────────

    const totalCost   = rows.reduce((s, r) => s + r.total_cost_usd, 0);
    const totalTokens = rows.reduce((s, r) => s + r.total_input_tokens + r.total_output_tokens, 0);

    // ── JSON output ──────────────────────────────────────────────────────────

    if (opts.json) {
      process.stdout.write(formatJson({
        period:       opts.period,
        total_cost:   totalCost,
        total_tokens: totalTokens,
        by_agent:     rows.map((r) => ({
          agent_id:            r.agent_id,
          division_code:       r.division_code,
          provider:            r.provider,
          model:               r.model,
          total_input_tokens:  r.total_input_tokens,
          total_output_tokens: r.total_output_tokens,
          total_cost_usd:      r.total_cost_usd,
        })),
      }) + "\n");
      return 0;
    }

    // ── Text output ──────────────────────────────────────────────────────────

    const periodLabel = opts.period === "all" ? "all time" : `last ${opts.period}`;
    process.stdout.write(`COST SUMMARY (${periodLabel})\n`);
    process.stdout.write(
      `Total: $${totalCost.toFixed(2)}  |  Tokens: ${totalTokens.toLocaleString()}\n`,
    );

    process.stdout.write("\nBy agent:\n");
    const tableRows = rows.map((r) => ({
      agent:    r.agent_id,
      provider: r.provider,
      model:    r.model,
      cost:     `$${r.total_cost_usd.toFixed(2)}`,
      tokens:   (r.total_input_tokens + r.total_output_tokens).toLocaleString(),
    }));

    process.stdout.write(
      formatTable(tableRows, {
        columns: [
          { header: "AGENT",    key: "agent"    },
          { header: "PROVIDER", key: "provider" },
          { header: "MODEL",    key: "model"    },
          { header: "COST",     key: "cost",    align: "right" },
          { header: "TOKENS",   key: "tokens",  align: "right" },
        ],
        maxWidth: 240,
      }) + "\n",
    );

    return 0;
  });
}
