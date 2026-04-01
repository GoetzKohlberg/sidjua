// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Pre-Action Governance Pipeline
 *
 * Entry point: evaluateAction()
 *
 * Runs the 5-stage governance pipeline BEFORE every agent action:
 *   Stage 1: Forbidden  — is the action on the forbidden list?
 *   Stage 2: Approval   — does the action require prior approval?
 *   Stage 3: Budget     — will the action exceed cost limits?
 *   Stage 4: Classification — does the agent have clearance for the data?
 *   Stage 5: Policy     — does the action comply with active policies?
 *
 * Every evaluation writes an audit trail entry (ALLOW, BLOCK, and PAUSE alike).
 * Fail-closed: any unhandled error results in a BLOCK verdict.
 */

import type {
  ActionRequest,
  GovernanceConfig,
  PipelineResult,
  StageName,
  StageResult,
  Warning,
} from "../types/pipeline.js";
import type { Database } from "../utils/db.js";
import { logger } from "../utils/logger.js";
import { checkForbidden }       from "./forbidden.js";
import { checkApproval }        from "./approval.js";
import { checkBudget }          from "./budget.js";
import { checkClassification }  from "./classification.js";
import { checkPolicy }          from "./policy.js";
import { checkSecurityFilters } from "./security-filter.js";
import { generateResumeToken, getOrCreateSystemSecret } from "./resume.js";
import { toolRbacChecker } from "../tool-integration/tool-rbac.js";


interface AuditEntryInput {
  agent_id:        string;
  division_code:   string | null;
  action_type:     string;
  action_detail:   string;
  governance_check: string | null;
  input_summary:   string | null;
  output_summary:  string | null;
  token_count:     number | null;
  cost_usd:        number | null;
  classification:  string;
  parent_task_id:  string | null;
  metadata:        string | null;
}


/**
 * Main pipeline function. Called BEFORE every agent action.
 *
 * Runs all 5 stages in order, short-circuiting on BLOCK or PAUSE.
 * Always writes an audit trail entry — even on BLOCK.
 *
 * Fail-closed: any unexpected error results in a BLOCK verdict.
 */
export function evaluateAction(
  request:    ActionRequest,
  governance: GovernanceConfig,
  db:         Database,
): PipelineResult {
  try {
    return runPipeline(request, governance, db);
  } catch (err) {
    // Fail-closed: pipeline error = action blocked
    logger.error("SYSTEM", "Pipeline execution failed (fail-closed BLOCK)", {
      request_id: request.request_id,
      error:      err instanceof Error ? err.message : String(err),
    });

    // Best-effort audit write — if this also fails, return synthetic BLOCK
    // (never throw: fail-closed means BLOCK, not exception)
    let auditId = -1;
    try {
      auditId = writeAuditEntry(db, {
        agent_id:         request.agent_id,
        division_code:    request.division_code,
        action_type:      "governance_check",
        action_detail:    `BLOCK(error): ${request.action.type} on ${request.action.target}`,
        governance_check: null,
        input_summary:    truncate(JSON.stringify(request.action), 500),
        output_summary:   "Pipeline error — fail-closed BLOCK",
        token_count:      null,
        cost_usd:         null,
        classification:   request.action.data_classification ?? "INTERNAL",
        parent_task_id:   request.context.task_id ?? null,
        metadata:         JSON.stringify({
          verdict:        "BLOCK",
          error:          err instanceof Error ? err.message : String(err),
          blocking_stage: "system",
        }),
      });
    } catch (e: unknown) {
      // Audit write failed too (e.g. DB tables missing) — proceed with -1
      void e; // cleanup-ignore: already has logger.error call immediately after
      logger.error("SYSTEM", "Audit write failed during fail-closed BLOCK", {
        request_id: request.request_id,
      });
    }

    return {
      request_id:      request.request_id,
      timestamp:       new Date().toISOString(),
      verdict:         "BLOCK",
      stage_results:   [],
      blocking_stage:  "forbidden" as StageName,
      blocking_reason: "Internal pipeline error",
      warnings:        [],
      audit_entry_id:  auditId,
    };
  }
}


function runPipeline(
  request:    ActionRequest,
  governance: GovernanceConfig,
  db:         Database,
): PipelineResult {
  const stageResults: StageResult[] = [];
  const warnings: Warning[] = [];

  logger.debug("SYSTEM", "Pipeline start", {
    request_id:  request.request_id,
    action_type: request.action.type,
    agent_id:    request.agent_id,
  });

  // Stage 0: Tool RBAC (skipped when request.tools or action.tool_name is absent)
  if (request.tools !== undefined && request.action.tool_name !== undefined) {
    const t0start = Date.now();
    const toolName = request.action.tool_name;
    const toolType = request.action.tool_type ?? "internal";
    const rbacResult = toolRbacChecker.check(
      { agent_id: request.agent_id, tier: request.agent_tier, division: request.division_code, tools: request.tools },
      toolName,
      toolType,
    );
    const t0: StageResult = {
      stage:         "rbac",
      verdict:       rbacResult.allowed ? "PASS" : "BLOCK",
      duration_ms:   Date.now() - t0start,
      rules_checked: [{
        rule_id:     `rbac.${toolType}.${toolName}`,
        rule_source: "role-yaml/tools",
        matched:     !rbacResult.allowed,
        verdict:     rbacResult.allowed ? "PASS" : "BLOCK",
        ...(rbacResult.reason !== undefined ? { reason: rbacResult.reason } : {}),
      }],
    };
    stageResults.push(t0);
    if (t0.verdict === "BLOCK") {
      return finalize(request, "BLOCK", stageResults, warnings, "rbac", t0, db);
    }
  }

  // Stage 0.5: Security Filter (optional — skipped when not configured)
  if (governance.security !== undefined) {
    const s0 = checkSecurityFilters(request, governance.security.filter);
    stageResults.push(s0);
    if (s0.verdict === "BLOCK") {
      return finalize(request, "BLOCK", stageResults, warnings, "security", s0, db);
    }
  }

  // Stage 1: Forbidden
  const s1 = checkForbidden(request, governance.forbidden);
  stageResults.push(s1);
  if (s1.verdict === "BLOCK") {
    return finalize(request, "BLOCK", stageResults, warnings, "forbidden", s1, db);
  }

  // Stage 2: Approval
  const s2 = checkApproval(request, governance.approval, db);
  stageResults.push(s2);
  if (s2.verdict === "BLOCK") {
    return finalize(request, "BLOCK", stageResults, warnings, "approval", s2, db);
  }
  if (s2.verdict === "PAUSE") {
    return finalize(request, "PAUSE", stageResults, warnings, "approval", s2, db);
  }

  // Stage 3: Budget
  const s3 = checkBudget(request, db);
  stageResults.push(s3);
  if (s3.verdict === "PAUSE") {
    return finalize(request, "PAUSE", stageResults, warnings, "budget", s3, db);
  }
  if (s3.verdict === "WARN") {
    warnings.push(...extractWarnings(s3, "budget"));
  }

  // Stage 4: Classification
  const s4 = checkClassification(request, governance.classification);
  stageResults.push(s4);
  if (s4.verdict === "BLOCK") {
    return finalize(request, "BLOCK", stageResults, warnings, "classification", s4, db);
  }

  // Stage 5: Policy
  const s5 = checkPolicy(request, governance.policies);
  stageResults.push(s5);
  if (s5.verdict === "BLOCK") {
    return finalize(request, "BLOCK", stageResults, warnings, "policy", s5, db);
  }
  if (s5.verdict === "WARN") {
    warnings.push(...extractWarnings(s5, "policy"));
  }

  // All stages passed
  return finalize(request, "ALLOW", stageResults, warnings, null, null, db);
}


/**
 * Write the audit trail entry and build the final PipelineResult.
 * Called for every verdict: ALLOW, BLOCK, and PAUSE.
 */
export function finalize(
  request:        ActionRequest,
  verdict:        "ALLOW" | "BLOCK" | "PAUSE",
  stageResults:   StageResult[],
  warnings:       Warning[],
  blockingStage:  StageName | null,
  blockingResult: StageResult | null,
  db:             Database,
): PipelineResult {
  const blockingReason = blockingResult !== null
    ? (blockingResult.rules_checked.find((r) => r.matched)?.reason ?? "Unknown reason")
    : undefined;

  const auditId = writeAuditEntry(db, {
    agent_id:         request.agent_id,
    division_code:    request.division_code,
    action_type:      "governance_check",
    action_detail:    `${verdict}: ${request.action.type} on ${request.action.target}`,
    governance_check: JSON.stringify(stageResults),
    input_summary:    truncate(JSON.stringify(request.action), 500),
    output_summary:   blockingReason ?? "Allowed",
    token_count:      null,
    cost_usd:         null,
    classification:   request.action.data_classification ?? "INTERNAL",
    parent_task_id:   request.context.task_id ?? null,
    metadata:         JSON.stringify({
      verdict,
      warnings,
      blocking_stage: blockingStage,
    }),
  });

  let approvalId: number | undefined;
  let resumeToken: string | undefined;

  if (verdict === "PAUSE") {
    approvalId  = getOrCreateApprovalId(db, request, blockingStage ?? "system");
    const secret = getOrCreateSystemSecret(db);
    resumeToken = generateResumeToken(request.request_id, approvalId, secret);
  }

  logger.info("SYSTEM", `Pipeline verdict: ${verdict}`, {
    request_id:     request.request_id,
    action_type:    request.action.type,
    blocking_stage: blockingStage ?? undefined,
  });

  return {
    request_id:     request.request_id,
    timestamp:      new Date().toISOString(),
    verdict,
    stage_results:  stageResults,
    ...(blockingStage !== null ? { blocking_stage: blockingStage } : {}),
    ...(blockingReason !== undefined ? { blocking_reason: blockingReason } : {}),
    warnings,
    audit_entry_id: auditId,
    ...(approvalId  !== undefined ? { approval_id: approvalId }   : {}),
    ...(resumeToken !== undefined ? { resume_token: resumeToken } : {}),
  };
}


/**
 * Convert WARN-verdict rule checks in a StageResult into Warning objects.
 */
export function extractWarnings(stage: StageResult, stageName: string): Warning[] {
  return stage.rules_checked
    .filter((r) => r.verdict === "WARN")
    .map((r) => ({
      stage:    stageName,
      rule_id:  r.rule_id,
      message:  r.reason ?? "Governance warning",
      severity: "medium" as const,
    }));
}


/**
 * Insert a row into audit_trail and return the new row's id.
 */
export function writeAuditEntry(db: Database, entry: AuditEntryInput): number {
  const result = db
    .prepare<
      [
        string, string | null, string, string, string | null,
        string | null, string | null, number | null, number | null,
        string, string | null, string | null,
      ],
      void
    >(
      `INSERT INTO audit_trail
         (agent_id, division_code, action_type, action_detail, governance_check,
          input_summary, output_summary, token_count, cost_usd, classification,
          parent_task_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.agent_id,
      entry.division_code,
      entry.action_type,
      entry.action_detail,
      entry.governance_check,
      entry.input_summary,
      entry.output_summary,
      entry.token_count,
      entry.cost_usd,
      entry.classification,
      entry.parent_task_id,
      entry.metadata,
    );

  return Number(result.lastInsertRowid);
}


interface ApprovalIdRow {
  id: number;
}

/**
 * Find the pending approval_queue entry for this request (created by Stage 2),
 * or create a new one (for Stage 3 budget PAUSE, which doesn't create one).
 */
function getOrCreateApprovalId(
  db:            Database,
  request:       ActionRequest,
  blockingStage: string,
): number {
  // Find by request_id in metadata (set by Stage 2's createApprovalRequest)
  const row = db
    .prepare<[string, string], ApprovalIdRow>(
      `SELECT id FROM approval_queue
       WHERE agent_id = ?
         AND status = 'pending'
         AND json_extract(metadata, '$.request_id') = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(request.agent_id, request.request_id);

  if (row !== undefined) return row.id;

  // No existing entry (e.g. budget PAUSE) — create one
  const result = db
    .prepare<[string, string | null, string, string, string], void>(
      `INSERT INTO approval_queue
         (agent_id, division_code, action_description, rule_triggered, status, metadata)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      request.agent_id,
      request.division_code,
      JSON.stringify(request.action),
      blockingStage,
      JSON.stringify({ request_id: request.request_id, blocking_stage: blockingStage }),
    );

  return Number(result.lastInsertRowid);
}


function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max) + "…" : str;
}
