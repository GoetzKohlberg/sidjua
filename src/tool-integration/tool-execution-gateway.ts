// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — ToolExecutionGateway
 *
 * Centralised enforcement choke-point for ALL tool-adapter executions.
 * Every adapter.execute() call must pass through this gateway.
 *
 * Pipeline:
 *   1. accessCheck     — caller-restriction (orchestrator-only tools)
 *   2. governanceCheck — ToolGovernance.check() with fail-closed on error
 *   3. auditPreExec    — write pre-execution audit event to DB
 *   4. adapter.execute — delegate to the actual adapter
 *   5. auditPostExec   — write post-execution audit event to DB
 *
 * Fail-closed: any error in steps 1–2 prevents execution.
 * governance === null ⟹ always blocks (never executes).
 */

import { randomUUID }           from "node:crypto";
import type { ToolAdapter, ToolAction, ToolResult } from "./types.js";
import type { ToolGovernance }  from "./tool-governance.js";
import type { SlidingWindowRateLimiter, RateLimitConfig } from "./rate-limiter.js";
import type { Database }        from "../utils/db.js";
import { createLogger }         from "../core/logger.js";

const logger = createLogger("tool-execution-gateway");

const NULL_RATE_LIMITER: SlidingWindowRateLimiter = {
  check: () => ({ allowed: true }),
  record: () => {},
} as unknown as SlidingWindowRateLimiter;


// ---------------------------------------------------------------------------
// CallerContext
// ---------------------------------------------------------------------------

export interface CallerContext {
  agent_id:        string;
  division:        string;
  tier:            1 | 2 | 3;
  /** Optional scope list for future fine-grained access control. */
  scopes?:         string[];
  task_id?:        string;
  /** "agent" (default) is most restrictive; "orchestrator" allows restricted tools. */
  caller_source?:  "agent" | "orchestrator";
}


// ---------------------------------------------------------------------------
// ToolExecutionGateway
// ---------------------------------------------------------------------------

export class ToolExecutionGateway {
  constructor(
    private readonly governance:   ToolGovernance | null,
    private readonly db:           Database | null,
    private readonly rateLimiter:  SlidingWindowRateLimiter = NULL_RATE_LIMITER,
    private readonly rateConfig:   RateLimitConfig = {},
  ) {}

  // -------------------------------------------------------------------------
  // execute — main entry point
  // -------------------------------------------------------------------------

  async execute(
    adapter:    ToolAdapter,
    action:     ToolAction,
    callerCtx:  CallerContext,
  ): Promise<ToolResult> {
    const start = Date.now();

    // 1. Access check — throws on caller-restriction violation (hard block, not a result)
    this.accessCheck(adapter, callerCtx);

    // 2. Governance check — fail-closed: null governance blocks unconditionally
    if (this.governance === null) {
      logger.warn(
        "tool_gateway_no_governance",
        "No governance configured — blocking execution (fail-closed)",
        { metadata: { tool_id: adapter.id, agent_id: callerCtx.agent_id } },
      );
      return {
        success:     false,
        error:       "Governance not configured — execution blocked (fail-closed)",
        duration_ms: Date.now() - start,
      };
    }

    const govError = await this.runGovernanceCheck(adapter.id, action);
    if (govError !== null) {
      this.writeAudit(action, callerCtx, "blocked", govError);
      return {
        success:     false,
        error:       govError,
        duration_ms: Date.now() - start,
      };
    }

    // 3. Pre-exec audit
    const auditId = this.writeAudit(action, callerCtx, "allowed");

    // 4. Execute
    let result: ToolResult;
    try {
      result = await adapter.execute(action);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.writePostAudit(auditId, false, errMsg, callerCtx, action);
      return { success: false, error: errMsg, duration_ms: Date.now() - start };
    }

    // 5. Post-exec audit
    this.writePostAudit(auditId, result.success, result.error, callerCtx, action);
    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Check caller-restriction on the adapter.
   * Throws (not returns) on violation so callers cannot catch and continue.
   */
  private accessCheck(adapter: ToolAdapter, callerCtx: CallerContext): void {
    // InternalToolAdapter exposes callerRestriction; other adapters do not — safe cast
    const maybeRestricted = adapter as { callerRestriction?: string };
    if (
      maybeRestricted.callerRestriction === "orchestrator" &&
      callerCtx.caller_source !== "orchestrator"
    ) {
      throw new Error(
        `Tool '${adapter.id}' is restricted to orchestrator-level callers`,
      );
    }
  }

  /**
   * Run ToolGovernance.check(). Returns the block reason string on block/approval,
   * or null if execution is permitted.
   *
   * Always fail-closed: governance errors prevent execution.
   */
  private async runGovernanceCheck(
    toolId: string,
    action: ToolAction,
  ): Promise<string | null> {
    try {
      const govResult = await this.governance!.check(
        toolId,
        action,
        this.rateLimiter,
        this.rateConfig,
      );

      if (govResult.blocked) {
        const reason = govResult.checks.find((c) => !c.passed)?.reason ?? "governance policy";
        return `Tool execution blocked by governance: ${reason}`;
      }

      if (govResult.requiresApproval) {
        return "Tool requires human approval before execution";
      }

      return null;
    } catch (govErr) {
      const msg = govErr instanceof Error ? govErr.message : String(govErr);
      logger.error(
        "tool_gateway_gov_error",
        "Governance check threw — blocking execution (fail-closed)",
        { metadata: { tool_id: toolId, error: msg } },
      );
      return "Governance check failed — execution blocked for safety";
    }
  }

  /**
   * Write an audit event. Returns the audit event ID so the post-exec row can
   * reference it. Non-fatal: errors are logged and swallowed.
   */
  private writeAudit(
    action:    ToolAction,
    callerCtx: CallerContext,
    status:    "allowed" | "blocked",
    detail?:   string,
  ): string {
    const auditId = randomUUID();
    if (this.db === null) return auditId;

    try {
      this.db.prepare(
        `INSERT INTO audit_events
           (id, agent_id, division, event_type, rule_id, action, severity, details, task_id)
         VALUES (?, ?, ?, 'tool_call', '', ?, ?, ?, ?)`,
      ).run(
        auditId,
        callerCtx.agent_id,
        callerCtx.division,
        status,
        status === "blocked" ? "medium" : "low",
        JSON.stringify({
          tool:       action.tool_id,
          capability: action.capability,
          phase:      "pre_exec",
          ...(detail !== undefined ? { reason: detail } : {}),
        }),
        callerCtx.task_id ?? null,
      );
    } catch (err) {
      logger.warn("tool_gateway_audit_error", "Pre-exec audit write failed (non-fatal)", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    return auditId;
  }

  /** Write a post-execution audit row referencing the pre-exec audit ID. Non-fatal. */
  private writePostAudit(
    preExecAuditId: string,
    success:        boolean,
    detail:         string | undefined,
    callerCtx:      CallerContext,
    action:         ToolAction,
  ): void {
    if (this.db === null) return;
    try {
      this.db.prepare(
        `INSERT INTO audit_events
           (id, agent_id, division, event_type, rule_id, action, severity, details, task_id)
         VALUES (?, ?, ?, 'tool_call', '', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        callerCtx.agent_id,
        callerCtx.division,
        success ? "allowed" : "blocked",
        success ? "low" : "medium",
        JSON.stringify({
          tool:             action.tool_id,
          capability:       action.capability,
          phase:            "post_exec",
          success,
          pre_exec_audit:   preExecAuditId,
          ...(detail !== undefined ? { error: detail } : {}),
        }),
        callerCtx.task_id ?? null,
      );
    } catch (_auditErr) {
      // Non-fatal — post-exec audit failure must not block the caller
    }
  }
}
