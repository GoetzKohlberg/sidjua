// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Provider Layer: Cost Tracker
 *
 * Integrates with the existing cost_ledger and cost_budgets tables provisioned
 * by `sidjua apply` Step 9 (COST_CENTERS) and Step 3 (DATABASE).
 *
 * Responsibilities:
 *   1. Pre-call budget check — reads cost_budgets + cost_ledger to determine
 *      whether a division's daily/monthly limit would be exceeded.
 *   2. Post-call cost recording — inserts a row into cost_ledger.
 *
 * All operations are synchronous (better-sqlite3) to avoid event-loop latency
 * on the hot path of every LLM call.
 *
 * Tables used (read + write):
 *   cost_budgets  — limits per division (provisioned by sidjua apply)
 *   cost_ledger   — per-call cost rows (inserted by this module)
 */

import type { Database } from "../utils/db.js";
import type { BudgetCheckResult, ModelId, ProviderName, TokenUsage } from "../types/provider.js";


interface BudgetRow {
  division_code: string;
  monthly_limit_usd: number | null;
  daily_limit_usd: number | null;
  alert_threshold_percent: number;
}

interface SumRow {
  total: number;
}


/**
 * Tracks LLM API costs against per-division budgets.
 *
 * The DB handle must point to the main sidjua.db which contains both
 * cost_budgets and cost_ledger (provisioned by sidjua apply Steps 3+9).
 */
export class CostTracker {
  constructor(private readonly db: Database) {}

  // ---------------------------------------------------------------------------
  // Prepared statement helpers (inline — avoids field-type declaration complexity)
  // ---------------------------------------------------------------------------

  private getBudgetStmt() {
    return this.db.prepare<[string], BudgetRow>(
      `SELECT division_code, monthly_limit_usd, daily_limit_usd, alert_threshold_percent
       FROM cost_budgets WHERE division_code = ?`,
    );
  }

  private getDailyStmt() {
    return this.db.prepare<[string], SumRow>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM cost_ledger
       WHERE division_code = ? AND date(timestamp) = date('now')`,
    );
  }

  private getMonthlyStmt() {
    return this.db.prepare<[string], SumRow>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM cost_ledger
       WHERE division_code = ?
         AND strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')`,
    );
  }

  private insertCostStmt() {
    return this.db.prepare<
      [string, string, string, string, number, number, number, string | null, string],
      void
    >(
      `INSERT INTO cost_ledger
         (division_code, agent_id, provider, model, input_tokens, output_tokens, cost_usd, task_id, cost_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  // ---------------------------------------------------------------------------
  // Pre-call budget check
  // ---------------------------------------------------------------------------

  /**
   * Check whether a call with the given estimated cost is within budget.
   *
   * Logic:
   *   1. If no budget row exists: ALLOW (unlimited).
   *   2. Daily limit: currentDaily + estimatedCost > dailyLimit → denied.
   *   3. Monthly limit: currentMonthly + estimatedCost > monthlyLimit → denied.
   *   4. Alert threshold: (current + estimated) / limit >= threshold% → nearLimit.
   *
   * Daily check takes priority over monthly when both are configured.
   *
   * @param divisionCode - Division to check against.
   * @param estimatedCostUsd - Estimated call cost in USD.
   */
  checkBudget(divisionCode: string, estimatedCostUsd: number): BudgetCheckResult {
    const txFn = this.db.transaction((): BudgetCheckResult => {
      return this._checkBudgetInner(divisionCode, estimatedCostUsd);
    });
    return txFn();
  }

  private _checkBudgetInner(divisionCode: string, estimatedCostUsd: number): BudgetCheckResult {
    const budget = this.getBudgetStmt().get(divisionCode) as BudgetRow | undefined;

    const currentDailyUsd   = this.getDailySpend(divisionCode);
    const currentMonthlyUsd = this.getMonthlySpend(divisionCode);

    if (budget === undefined) {
      // No budget configured — unlimited spend allowed.
      return {
        allowed:               true,
        divisionCode,
        currentDailyUsd,
        currentMonthlyUsd,
        dailyLimitUsd:         null,
        monthlyLimitUsd:       null,
        alertThresholdPercent: 80,
        nearLimit:             false,
      };
    }

    const { daily_limit_usd: dailyLimit, monthly_limit_usd: monthlyLimit, alert_threshold_percent: threshold } = budget;

    // Check daily limit first
    if (dailyLimit !== null) {
      const projected = currentDailyUsd + estimatedCostUsd;

      if (projected > dailyLimit) {
        return {
          allowed:               false,
          divisionCode,
          currentDailyUsd,
          currentMonthlyUsd,
          dailyLimitUsd:         dailyLimit,
          monthlyLimitUsd:       monthlyLimit,
          alertThresholdPercent: threshold,
          nearLimit:             false,
          reason:                `Daily limit $${dailyLimit} would be exceeded (current: $${currentDailyUsd.toFixed(4)}, estimated: $${estimatedCostUsd.toFixed(4)})`,
        };
      }

      const dailyRatio  = dailyLimit > 0 ? projected / dailyLimit : 0;
      const dailyNear   = dailyRatio >= threshold / 100;

      // Daily limit OK — check monthly
      if (monthlyLimit !== null) {
        const projectedMonthly = currentMonthlyUsd + estimatedCostUsd;

        if (projectedMonthly > monthlyLimit) {
          return {
            allowed:               false,
            divisionCode,
            currentDailyUsd,
            currentMonthlyUsd,
            dailyLimitUsd:         dailyLimit,
            monthlyLimitUsd:       monthlyLimit,
            alertThresholdPercent: threshold,
            nearLimit:             false,
            reason:                `Monthly limit $${monthlyLimit} would be exceeded (current: $${currentMonthlyUsd.toFixed(4)}, estimated: $${estimatedCostUsd.toFixed(4)})`,
          };
        }

        const monthlyRatio = monthlyLimit > 0 ? projectedMonthly / monthlyLimit : 0;
        const nearLimit    = dailyNear || monthlyRatio >= threshold / 100;

        return {
          allowed:               true,
          divisionCode,
          currentDailyUsd,
          currentMonthlyUsd,
          dailyLimitUsd:         dailyLimit,
          monthlyLimitUsd:       monthlyLimit,
          alertThresholdPercent: threshold,
          nearLimit,
        };
      }

      return {
        allowed:               true,
        divisionCode,
        currentDailyUsd,
        currentMonthlyUsd,
        dailyLimitUsd:         dailyLimit,
        monthlyLimitUsd:       null,
        alertThresholdPercent: threshold,
        nearLimit:             dailyNear,
      };
    }

    // No daily limit — check monthly only
    if (monthlyLimit !== null) {
      const projected = currentMonthlyUsd + estimatedCostUsd;

      if (projected > monthlyLimit) {
        return {
          allowed:               false,
          divisionCode,
          currentDailyUsd,
          currentMonthlyUsd,
          dailyLimitUsd:         null,
          monthlyLimitUsd:       monthlyLimit,
          alertThresholdPercent: threshold,
          nearLimit:             false,
          reason:                `Monthly limit $${monthlyLimit} would be exceeded (current: $${currentMonthlyUsd.toFixed(4)}, estimated: $${estimatedCostUsd.toFixed(4)})`,
        };
      }

      const ratio   = monthlyLimit > 0 ? projected / monthlyLimit : 0;
      const nearLimit = ratio >= threshold / 100;

      return {
        allowed:               true,
        divisionCode,
        currentDailyUsd,
        currentMonthlyUsd,
        dailyLimitUsd:         null,
        monthlyLimitUsd:       monthlyLimit,
        alertThresholdPercent: threshold,
        nearLimit,
      };
    }

    // Both limits null — unlimited
    return {
      allowed:               true,
      divisionCode,
      currentDailyUsd,
      currentMonthlyUsd,
      dailyLimitUsd:         null,
      monthlyLimitUsd:       null,
      alertThresholdPercent: threshold,
      nearLimit:             false,
    };
  }

  // ---------------------------------------------------------------------------
  // Atomic budget check + cost reservation
  // ---------------------------------------------------------------------------

  /**
   * Atomically check the budget and insert an estimated-cost reservation.
   *
   * Uses BEGIN EXCLUSIVE so no reader or writer can interleave between
   * the current-spend read and the reservation insert.  Concurrent callers
   * that arrive while this transaction holds the write lock will see the
   * reserved cost when they run their own check, preventing double-allocation.
   *
   * If the budget is exceeded, no reservation is inserted and `reservationId`
   * is `null`.  On success, `reservationId` is the cost_ledger row id; call
   * `finalizeReservation()` with the actual call cost once the LLM call
   * completes, or `cancelReservation()` if the call fails.
   */
  atomicCheckAndReserve(
    divisionCode:    string,
    agentId:         string,
    provider:        ProviderName,
    model:           ModelId,
    estimatedCostUsd: number,
    taskId?:         string,
  ): { result: BudgetCheckResult; reservationId: number | null } {
    const txFn = this.db.transaction((): { result: BudgetCheckResult; reservationId: number | null } => {
      const result = this._checkBudgetInner(divisionCode, estimatedCostUsd);
      if (!result.allowed) {
        return { result, reservationId: null };
      }

      // Reserve estimated cost immediately so concurrent checks see the allocation.
      const info = this.db
        .prepare<[string, string, string, string, number, string | null], void>(
          `INSERT INTO cost_ledger
             (division_code, agent_id, provider, model, input_tokens, output_tokens, cost_usd, task_id, cost_type)
           VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'reserved')`,
        )
        .run(String(divisionCode), String(agentId), String(provider), String(model), estimatedCostUsd, taskId ?? null);

      return { result, reservationId: Number(info.lastInsertRowid) };
    });

    return txFn.exclusive();
  }

  /**
   * Update a reservation row with actual call values after a successful LLM call.
   * Marks the row `cost_type = 'actual'` with real token usage and cost.
   */
  finalizeReservation(
    reservationId: number,
    provider:      ProviderName,
    model:         ModelId,
    usage:         TokenUsage,
    costUsd:       number,
  ): void {
    this.db
      .prepare<[string, string, number, number, number, number], void>(
        `UPDATE cost_ledger
         SET provider = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, cost_type = 'actual'
         WHERE id = ?`,
      )
      .run(String(provider), String(model), usage.inputTokens, usage.outputTokens, costUsd, reservationId);
  }

  /**
   * Cancel a reservation when the associated LLM call fails.
   * Sets cost_usd = 0 and marks the row cancelled so it does not
   * permanently inflate the division's budget spend.
   */
  cancelReservation(reservationId: number): void {
    this.db
      .prepare<[number], void>(
        `UPDATE cost_ledger SET cost_usd = 0, cost_type = 'cancelled' WHERE id = ?`,
      )
      .run(reservationId);
  }

  /**
   * Delete all rows with cost_type='reserved' from the cost_ledger.
   * Called on startup to clean up reservations orphaned by a crash.
   * Returns the number of rows deleted.
   */
  cleanupOrphanedReservations(): number {
    const result = this.db
      .prepare("DELETE FROM cost_ledger WHERE cost_type = 'reserved'")
      .run();
    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Post-call cost recording
  // ---------------------------------------------------------------------------

  /**
   * Insert a cost_ledger row after a successful provider call.
   * Called by ProviderRegistry after every successful call.
   */
  recordCost(
    divisionCode: string,
    agentId: string,
    provider: ProviderName,
    model: ModelId,
    usage: TokenUsage,
    costUsd: number,
    taskId?: string,
    costType: "llm_call" | "tool_execution" = "llm_call",
  ): void {
    this.insertCostStmt().run(
      divisionCode,
      agentId,
      provider,
      model,
      usage.inputTokens,
      usage.outputTokens,
      costUsd,
      taskId ?? null,
      costType,
    );
  }

  // ---------------------------------------------------------------------------
  // Spend queries (also used by RetryHandler for logging)
  // ---------------------------------------------------------------------------

  /**
   * Return the total cost_usd charged to a division today (UTC).
   */
  getDailySpend(divisionCode: string): number {
    const row = this.getDailyStmt().get(divisionCode) as SumRow | undefined;
    return row?.total ?? 0;
  }

  /**
   * Return the total cost_usd charged to a division this calendar month (UTC).
   */
  getMonthlySpend(divisionCode: string): number {
    const row = this.getMonthlyStmt().get(divisionCode) as SumRow | undefined;
    return row?.total ?? 0;
  }
}
