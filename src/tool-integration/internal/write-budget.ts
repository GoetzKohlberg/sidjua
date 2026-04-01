// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * write-budget — set or update budget limits per agent or division.
 * Agent: Finance (CFO)
 * Risk: medium — governance layer enforces CEO approval for large changes.
 *
 * Division budgets → cost_budgets table (monthly_limit_usd, daily_limit_usd)
 * Agent budgets    → agent_budgets table (limit_usd for current month period)
 */

import type { InternalToolDef } from "../adapters/internal-adapter.js";
import type { Database }        from "../../utils/db.js";

let _db: Database | null = null;
export function setWriteBudgetToolDb(db: Database): void { _db = db; }

/** ISO date string for the first day of the current month. */
function currentMonthStart(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export const writeBudgetTool: InternalToolDef = {
  id:          "internal-write-budget",
  name:        "set_budget_limit",
  description: "Set or update budget limits per agent or division",
  capabilities: [
    {
      name:              "set_budget",
      description:       "Set monthly budget limit for an agent or division. Changes >$50 require CEO approval via governance.",
      risk_level:        "medium",
      requires_approval: false, // Governance layer handles approval threshold
      input_schema: {
        type: "object",
        properties: {
          target_type:       { type: "string", enum: ["agent", "division"], description: "Target type" },
          target_id:         { type: "string", description: "Agent ID or division code" },
          monthly_limit_usd: { type: "number", description: "New monthly limit in USD (>0)" },
          reason:            { type: "string", description: "Reason for change" },
        },
        required:            ["target_type", "target_id", "monthly_limit_usd", "reason"],
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    if (!_db) return { error: "Database not initialized" };

    const targetType      = params["target_type"] as string;
    const targetId        = params["target_id"] as string;
    const monthlyLimit    = Number(params["monthly_limit_usd"]);
    const reason          = params["reason"] as string;

    if (!targetType || !targetId) return { error: "target_type and target_id are required" };
    if (!Number.isFinite(monthlyLimit) || monthlyLimit <= 0) {
      return { error: "monthly_limit_usd must be a positive number" };
    }

    if (targetType === "division") {
      // Upsert into cost_budgets
      _db.prepare(
        `INSERT INTO cost_budgets (division_code, monthly_limit_usd, alert_threshold_percent)
         VALUES (?, ?, 80.0)
         ON CONFLICT(division_code) DO UPDATE SET
           monthly_limit_usd = excluded.monthly_limit_usd`,
      ).run(targetId, monthlyLimit);
    } else if (targetType === "agent") {
      // Upsert into agent_budgets for current month
      const periodStart = currentMonthStart();
      _db.prepare(
        `INSERT INTO agent_budgets (agent_id, period_start, period_type, spent_usd, limit_usd, tokens_used)
         VALUES (?, ?, 'monthly', 0.0, ?, 0)
         ON CONFLICT(agent_id, period_start, period_type) DO UPDATE SET
           limit_usd = excluded.limit_usd`,
      ).run(targetId, periodStart, monthlyLimit);
    } else {
      return { error: "target_type must be 'agent' or 'division'" };
    }

    return {
      success:           true,
      target_type:       targetType,
      target_id:         targetId,
      monthly_limit_usd: monthlyLimit,
      reason,
      note:              monthlyLimit > 50
        ? "Budget >$50 — governance will require CEO approval on next budget check"
        : undefined,
    };
  },
};
