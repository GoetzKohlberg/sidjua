// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * read-budget — current budget allocations and spending per agent/division.
 * Agent: Finance (CFO)
 * Tables: cost_ledger (spending), cost_budgets (division limits), agent_budgets (agent limits)
 */

import type { InternalToolDef } from "../adapters/internal-adapter.js";
import type { Database }        from "../../utils/db.js";

let _db: Database | null = null;
export function setBudgetToolDb(db: Database): void { _db = db; }

/** Returns an ISO timestamp string for the start of the given period. */
function periodStart(period: string): string {
  if (period === "daily")   return new Date(Date.now() - 86400_000).toISOString();
  if (period === "weekly")  return new Date(Date.now() - 7 * 86400_000).toISOString();
  return new Date(Date.now() - 30 * 86400_000).toISOString(); // monthly default
}

export const readBudgetTool: InternalToolDef = {
  id:          "internal-read-budget",
  name:        "read_budget",
  description: "Read current budget allocations and spending per agent/division",
  capabilities: [
    {
      name:              "read_budget",
      description:       "Returns budget limits and current spending by agent or division",
      risk_level:        "low",
      requires_approval: false,
      input_schema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Filter by agent ID" },
          division: { type: "string", description: "Filter by division code" },
          period:   { type: "string", description: "Period: daily|weekly|monthly (default: monthly)", default: "monthly" },
        },
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    if (!_db) return { error: "Database not initialized" };

    const period = (params["period"] as string) || "monthly";
    const since  = periodStart(period);

    const wheres: string[] = ["timestamp >= ?"];
    const values: unknown[] = [since];

    if (params["agent_id"]) { wheres.push("agent_id = ?");       values.push(params["agent_id"]); }
    if (params["division"]) { wheres.push("division_code = ?");   values.push(params["division"]); }

    const where = wheres.join(" AND ");

    // Spending from cost_ledger
    const spending = _db
      .prepare(
        `SELECT agent_id, division_code, provider, model,
                SUM(input_tokens)  AS total_input_tokens,
                SUM(output_tokens) AS total_output_tokens,
                SUM(cost_usd)      AS total_cost_usd,
                COUNT(*)           AS call_count
         FROM cost_ledger WHERE ${where}
         GROUP BY agent_id, division_code
         ORDER BY total_cost_usd DESC`,
      )
      .all(...values);

    // Division limits from cost_budgets
    const budgetWheres: string[] = [];
    const budgetValues: unknown[] = [];
    if (params["division"]) { budgetWheres.push("division_code = ?"); budgetValues.push(params["division"]); }
    const divisionLimits = _db
      .prepare(
        `SELECT division_code, monthly_limit_usd, daily_limit_usd, alert_threshold_percent
         FROM cost_budgets${budgetWheres.length > 0 ? " WHERE " + budgetWheres.join(" AND ") : ""}`,
      )
      .all(...budgetValues);

    return { period, since, spending, division_limits: divisionLimits };
  },
};
