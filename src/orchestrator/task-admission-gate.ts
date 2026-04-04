// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Governance Admission Gate
 *
 * Enforces governance pre-checks before any external task creation.
 * All public task entry points (CLI run, REST API, messaging, delegation)
 * MUST call admitTask() and receive an admission token before calling
 * TaskStore.create() / TaskManager.createTask().
 *
 * Checks (in order):
 *   1. Division exists (or is the built-in "general" division)
 *   2. Budget pre-check — would the task's estimated cost exceed division limits?
 *
 * Fail-closed: any internal error results in denial, never silent admission.
 * Admission tokens are single-use with a 60-second TTL.
 */

import { randomUUID }  from "node:crypto";
import { CostTracker } from "../provider/cost-tracker.js";
import { createLogger } from "../core/logger.js";
import type { Database } from "../utils/db.js";

const logger = createLogger("admission-gate");

/** TTL for issued admission tokens (milliseconds). */
const TOKEN_TTL_MS = 60_000;


export interface AdmissionInput {
  /** Human-readable task description (used for audit logging). */
  description: string;
  /** Target division. Must exist in the divisions table, or be "general". */
  division: string;
  /** Estimated cost in USD used for budget pre-check. Defaults to 0 (no check). */
  budget_usd?: number;
  /** Optional caller identifier for audit purposes. */
  caller?: string;
  /**
   * Division the caller belongs to (from CallerContext).
   * When set, cross-division submission is denied unless callerRole is "admin".
   * Omit for CLI and internal paths that bypass division restrictions.
   */
  callerDivision?: string;
  /** Role of the caller (from CallerContext). "admin" bypasses cross-division check. */
  callerRole?: string;
  /**
   * Explicit bootstrap-mode flag for pre-apply task creation.
   *
   * When true AND workspace_config.bootstrap_complete is NOT set (i.e. `sidjua apply`
   * has not yet been run), missing governance tables are tolerated and the admission
   * check falls back to fail-open behaviour.
   *
   * MUST NOT be set to true once `sidjua apply` has completed.
   * The CLI `sidjua run` passes this flag; the REST API never does.
   */
  bootstrap_mode?: boolean;
}

export type AdmissionResult =
  | { admitted: true;  token: string }
  | { admitted: false; reason: string };


/**
 * Governance admission gate for external task creation.
 *
 * Instantiate once per request/session and hold a reference to it.
 * The token Map is per-instance; tokens cannot be shared across instances.
 */
export class TaskAdmissionGate {
  /** Active admission tokens: token → expiry timestamp (ms). */
  private readonly _tokens = new Map<string, number>();

  constructor(private readonly db: Database) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run admission checks for a new task request.
   *
   * Returns `{ admitted: true, token }` when all checks pass.
   * Returns `{ admitted: false, reason }` when any check fails.
   * Never throws — internal errors produce a fail-closed denial.
   */
  admitTask(input: AdmissionInput): AdmissionResult {
    try {
      // 1. Division check
      if (!this._divisionAllowed(input.division, input.bootstrap_mode)) {
        logger.warn("admission-gate", "Task denied — unknown division", {
          metadata: { division: input.division, caller: input.caller },
        });
        return { admitted: false, reason: `Unknown division: ${input.division}` };
      }

      // 1.5. Cross-division isolation — caller may only submit to their own division unless admin
      if (!this._callerAllowedForDivision(input.division, input.callerDivision, input.callerRole)) {
        logger.warn("admission-gate", "Task denied — cross-division access", {
          metadata: { division: input.division, callerDivision: input.callerDivision, caller: input.caller },
        });
        return {
          admitted: false,
          reason:   `Cross-division access denied: caller division "${input.callerDivision}" may not submit tasks to division "${input.division}"`,
        };
      }

      // 2. Budget pre-check
      const costUsd = input.budget_usd ?? 0;
      if (!this._budgetAllowed(input.division, costUsd, input.bootstrap_mode)) {
        logger.warn("admission-gate", "Task denied — budget limit exceeded", {
          metadata: { division: input.division, budget_usd: costUsd, caller: input.caller },
        });
        return {
          admitted: false,
          reason:   `Budget limit exceeded for division: ${input.division}`,
        };
      }

      // All checks passed — issue single-use token
      this._pruneExpired();
      const token  = randomUUID();
      const expiry = Date.now() + TOKEN_TTL_MS;
      this._tokens.set(token, expiry);

      return { admitted: true, token };
    } catch (err: unknown) {
      logger.error("admission-gate", "Admission check threw unexpectedly — fail-closed deny", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return { admitted: false, reason: "Internal error — admission denied (fail-closed)" };
    }
  }

  /**
   * Verify and consume an admission token.
   *
   * Returns `true` if the token is valid and not expired.
   * The token is removed from the store on first use (single-use).
   * Returns `false` for unknown, expired, or already-consumed tokens.
   */
  verifyAndConsumeToken(token: string): boolean {
    const expiry = this._tokens.get(token);
    if (expiry === undefined) return false;
    this._tokens.delete(token); // consume regardless of expiry
    return Date.now() <= expiry;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Check that the division is the built-in "general" division or exists
   * in the divisions table.
   *
   * Fail-closed by default: when the divisions table does not exist, the task
   * is DENIED. Exception: when `bootstrapMode` is true AND
   * workspace_config.bootstrap_complete has not been set (i.e. `sidjua apply`
   * has not yet completed), the gate fails-open so that CLI users can run tasks
   * before first-time provisioning.
   */
  private _divisionAllowed(division: string, bootstrapMode?: boolean): boolean {
    if (division === "general") return true;
    try {
      const row = this.db
        .prepare<[string], { code: string }>("SELECT code FROM divisions WHERE code = ?")
        .get(division);
      return row !== undefined;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such table")) {
        if (bootstrapMode === true && !this._isBootstrapComplete()) {
          logger.debug("admission-gate", "Divisions table absent (pre-apply bootstrap) — allowing task", {
            metadata: { division },
          });
          return true;
        }
        logger.warn("admission-gate", "Divisions table absent — blocking task (fail-closed)", {
          metadata: { division },
        });
        return false;
      }
      // Other DB errors → fail-closed
      return false;
    }
  }

  /**
   * Check whether estimated cost stays within the division's budget limits.
   * Uses the existing CostTracker which queries cost_budgets + cost_ledger.
   *
   * Fail-closed by default: when budget tables are absent, the task is DENIED.
   * Exception: when `bootstrapMode` is true AND workspace_config.bootstrap_complete
   * has not been set (pre-apply state), the check fails-open because no budgets
   * have been configured yet.
   *
   * All other errors (database I/O failure, corrupt row) are fail-closed to
   * prevent silent over-spend.
   */
  private _budgetAllowed(division: string, estimatedCostUsd: number, bootstrapMode?: boolean): boolean {
    if (estimatedCostUsd <= 0) return true; // nothing to check
    try {
      const tracker = new CostTracker(this.db);
      const result  = tracker.checkBudget(division, estimatedCostUsd);
      return result.allowed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such table")) {
        if (bootstrapMode === true && !this._isBootstrapComplete()) {
          logger.debug("admission-gate", "Budget tables absent (pre-apply bootstrap) — allowing task", {
            metadata: { division, estimated_usd: estimatedCostUsd },
          });
          return true;
        }
        logger.warn("admission-gate", "Budget tables absent — blocking task (fail-closed)", {
          metadata: { division, estimated_usd: estimatedCostUsd },
        });
        return false;
      }
      // Any other error → fail-closed
      logger.error("admission-gate", "Budget check threw — blocking task (fail-closed)", {
        metadata: { division, estimated_usd: estimatedCostUsd, error: msg },
      });
      return false;
    }
  }

  /**
   * Check whether `sidjua apply` has completed by reading bootstrap_complete
   * from workspace_config. Returns false (not complete) when the table or key
   * are absent so that bootstrap-mode tasks can proceed pre-apply.
   */
  private _isBootstrapComplete(): boolean {
    try {
      const row = this.db
        .prepare<[string], { value: string }>(
          "SELECT value FROM workspace_config WHERE key = ?",
        )
        .get("bootstrap_complete") as { value: string } | undefined;
      return row?.value === "true";
    } catch (_err: unknown) {
      return false; // workspace_config absent → not yet applied
    }
  }

  /**
   * Enforce cross-division isolation.
   *
   * Returns false (deny) when ALL of these are true:
   *   - A callerDivision is present (i.e., request came through an authenticated API path)
   *   - callerDivision differs from the target division
   *   - callerRole is not "admin"
   *   - target division is not "general" (general is open to all callers)
   *
   * Absent callerDivision (CLI, internal paths) → allow (skip check).
   */
  private _callerAllowedForDivision(
    targetDivision: string,
    callerDivision?: string,
    callerRole?:     string,
  ): boolean {
    if (callerDivision === undefined) return true;           // no caller context — CLI / internal
    if (callerRole === "admin")        return true;           // admin bypass
    if (targetDivision === "general")  return true;           // general is open
    return callerDivision === targetDivision;
  }

  /** Remove all tokens whose TTL has elapsed. */
  private _pruneExpired(): void {
    const now = Date.now();
    for (const [tok, exp] of this._tokens) {
      if (now > exp) this._tokens.delete(tok);
    }
  }
}
