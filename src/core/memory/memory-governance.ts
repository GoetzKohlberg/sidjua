// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Memory Consolidation Governance
 *
 * Manages the T1 approval workflow for memory consolidation results.
 * Consolidation results are staged as "pending" approvals in workspace_config.
 * A T1 agent must explicitly approve before changes are applied to the index.
 *
 * Storage: workspace_config key = "consolidation_approval_{id}"
 * Every approval action is logged to audit_events for immutable audit trail.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type Database from "better-sqlite3";
import type { ConsolidationResult, PendingApproval, ApprovalStatus } from "./types.js";
import { runAuditMigrations } from "../audit/audit-migrations.js";
import { ensureWorkspaceConfigTable } from "../../api/workspace-config-migration.js";

const logger = createLogger("memory-governance");

const APPROVAL_KEY_PREFIX = "consolidation_approval_";

// ---------------------------------------------------------------------------
// MemoryGovernance
// ---------------------------------------------------------------------------

export class MemoryGovernance {
  private _auditEnsured = false;

  constructor(private readonly _db: InstanceType<typeof Database>) {}

  /**
   * Submit a consolidation result for T1 approval.
   * Returns the approval ID.
   */
  submitForApproval(result: ConsolidationResult): string {
    const approvalId   = randomUUID();
    const submittedAt  = new Date().toISOString();

    const approval: PendingApproval = {
      approval_id:  approvalId,
      run_id:       result.run_id,
      submitted_at: submittedAt,
      result,
      status:       "pending",
    };

    try {
      this._ensureWorkspaceConfig();
      this._db.prepare(
        `INSERT OR REPLACE INTO workspace_config (key, value, updated_at)
         VALUES (?, ?, datetime('now'))`,
      ).run(`${APPROVAL_KEY_PREFIX}${approvalId}`, JSON.stringify(approval));

      this._writeAuditEvent("memory_consolidation_submitted", "system", {
        approval_id: approvalId,
        run_id:      result.run_id,
        additions:   result.proposed_additions.length,
        removals:    result.proposed_removals.length,
      });

      logger.info("consolidation_approval_submitted", "Consolidation result submitted for approval", {
        metadata: { approvalId, runId: result.run_id },
      });
    } catch (err: unknown) {
      logger.warn("consolidation_approval_submit_error", "Failed to submit for approval", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }

    return approvalId;
  }

  /**
   * Process an approval decision (approve or reject).
   * Returns the updated PendingApproval record.
   */
  processApproval(
    approvalId: string,
    approved: boolean,
    approvedBy?: string,
    reason?: string,
  ): PendingApproval {
    const existing = this.getApproval(approvalId);
    if (existing === null) {
      throw new Error(`Approval ${approvalId} not found`);
    }
    if (existing.status !== "pending") {
      throw new Error(`Approval ${approvalId} is already ${existing.status}`);
    }

    const status: ApprovalStatus = approved ? "approved" : "rejected";
    const decidedAt = new Date().toISOString();

    const updated: PendingApproval = {
      ...existing,
      status,
      decided_at: decidedAt,
    };
    if (approvedBy !== undefined) updated.approved_by = approvedBy;
    if (reason    !== undefined) updated.reason       = reason;

    try {
      this._db.prepare(
        `INSERT OR REPLACE INTO workspace_config (key, value, updated_at)
         VALUES (?, ?, datetime('now'))`,
      ).run(`${APPROVAL_KEY_PREFIX}${approvalId}`, JSON.stringify(updated));

      this._writeAuditEvent("memory_consolidation_decision", approvedBy ?? "system", {
        approval_id: approvalId,
        run_id:      existing.run_id,
        decision:    status,
        reason:      reason ?? "",
      });

      logger.info("consolidation_approval_decided", `Consolidation approval ${status}`, {
        metadata: { approvalId, status, approvedBy },
      });
    } catch (err: unknown) {
      logger.warn("consolidation_approval_decide_error", "Failed to persist approval decision", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }

    return updated;
  }

  /** Get a single approval by ID. Returns null if not found. */
  getApproval(approvalId: string): PendingApproval | null {
    try {
      this._ensureWorkspaceConfig();
      const row = this._db.prepare<[string], { value: string }>(
        "SELECT value FROM workspace_config WHERE key = ?",
      ).get(`${APPROVAL_KEY_PREFIX}${approvalId}`);
      if (row === undefined) return null;
      return JSON.parse(row.value) as PendingApproval;
    } catch (_e) {
      return null;
    }
  }

  /** List all pending approvals (status = "pending"). */
  getPendingApprovals(): PendingApproval[] {
    return this._getAllApprovals().filter((a) => a.status === "pending");
  }

  /** List all approvals regardless of status. */
  getAllApprovals(): PendingApproval[] {
    return this._getAllApprovals();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _getAllApprovals(): PendingApproval[] {
    try {
      this._ensureWorkspaceConfig();
      const rows = this._db.prepare<[string], { value: string }>(
        "SELECT value FROM workspace_config WHERE key LIKE ?",
      ).all(`${APPROVAL_KEY_PREFIX}%`);
      return rows.map((r) => JSON.parse(r.value) as PendingApproval);
    } catch (_e) {
      return [];
    }
  }

  private _ensureWorkspaceConfig(): void {
    ensureWorkspaceConfigTable(this._db);
  }

  private _writeAuditEvent(
    eventType: string,
    agentId: string,
    details: Record<string, unknown>,
  ): void {
    try {
      if (!this._auditEnsured) {
        runAuditMigrations(this._db);
        this._auditEnsured = true;
      }
      this._db.prepare(
        `INSERT INTO audit_events
           (id, agent_id, division, event_type, rule_id, action, severity, details)
         VALUES (?, ?, 'memory', ?, '', 'allowed', 'low', ?)`,
      ).run(randomUUID(), agentId, eventType, JSON.stringify(details));
    } catch (err: unknown) {
      logger.warn("consolidation_audit_error", "Failed to write audit event", {
        metadata: { eventType, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
