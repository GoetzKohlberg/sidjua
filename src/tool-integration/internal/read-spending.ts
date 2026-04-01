// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * read-spending — detailed spending breakdown from cost_ledger.
 * Agent: Finance (CFO)
 */

import type { InternalToolDef } from "../adapters/internal-adapter.js";
import type { Database }        from "../../utils/db.js";

let _db: Database | null = null;
export function setSpendingToolDb(db: Database): void { _db = db; }

/** Map group_by alias to actual SQL column expression. */
function groupByCol(groupBy: string): string {
  if (groupBy === "day")      return "strftime('%Y-%m-%d', timestamp)";
  if (groupBy === "provider") return "provider";
  if (groupBy === "model")    return "model";
  if (groupBy === "division") return "division_code";
  return "agent_id"; // default: agent
}

export const readSpendingTool: InternalToolDef = {
  id:          "internal-read-spending",
  name:        "read_spending",
  description: "Detailed spending breakdown per provider, model, agent, division, or day",
  capabilities: [
    {
      name:              "spending_report",
      description:       "Returns cost breakdown by provider, model, agent, or division for a time period",
      risk_level:        "low",
      requires_approval: false,
      input_schema: {
        type: "object",
        properties: {
          since:    { type: "string", description: "Start date ISO (default: 30 days ago)" },
          until:    { type: "string", description: "End date ISO (default: now)" },
          group_by: { type: "string", description: "Group by: provider|model|agent|division|day (default: agent)", default: "agent" },
          agent_id: { type: "string", description: "Optional: restrict to one agent" },
          division: { type: "string", description: "Optional: restrict to one division" },
        },
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    if (!_db) return { error: "Database not initialized" };

    const since   = (params["since"] as string)    || new Date(Date.now() - 30 * 86400_000).toISOString();
    const until   = (params["until"] as string)    || new Date().toISOString();
    const groupBy = (params["group_by"] as string) || "agent";
    const col     = groupByCol(groupBy);

    const wheres: string[] = ["timestamp >= ?", "timestamp <= ?"];
    const values: unknown[] = [since, until];

    if (params["agent_id"]) { wheres.push("agent_id = ?");     values.push(params["agent_id"]); }
    if (params["division"]) { wheres.push("division_code = ?"); values.push(params["division"]); }

    const where = wheres.join(" AND ");

    const rows = _db
      .prepare(
        `SELECT ${col}            AS group_key,
                SUM(cost_usd)      AS total_cost_usd,
                SUM(input_tokens)  AS total_input_tokens,
                SUM(output_tokens) AS total_output_tokens,
                COUNT(*)           AS call_count
         FROM cost_ledger
         WHERE ${where}
         GROUP BY group_key
         ORDER BY total_cost_usd DESC`,
      )
      .all(...values) as Array<{ total_cost_usd: number }>;

    const grandTotal = rows.reduce((sum, r) => sum + (r.total_cost_usd || 0), 0);

    return { since, until, group_by: groupBy, grand_total_usd: grandTotal, breakdown: rows };
  },
};
