// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Internal Tool Index — Part 1 (IT/System) + Part 2 (Governance + Knowledge).
 *
 * These tools are registered automatically during orchestrator bootstrap
 * and are available to any agent with tool access.
 */

import type { InternalToolDef }    from "../adapters/internal-adapter.js";

// ── Part 1: IT / System ────────────────────────────────────────────────────
import { systemHealthTool }        from "./system-health.js";
import { dockerInfoTool }          from "./docker-info.js";
import { backupStatusTool }        from "./backup-status.js";
import { logReaderTool }           from "./log-reader.js";
import { systemOverviewTool }      from "./system-overview.js";

// ── Part 2: Governance / Finance ───────────────────────────────────────────
import { auditTrailTool }          from "./audit-trail.js";
import { readBudgetTool }          from "./read-budget.js";
import { readSpendingTool }        from "./read-spending.js";
import { writeBudgetTool }         from "./write-budget.js";

// ── Part 2: Knowledge / Librarian ─────────────────────────────────────────
import { searchKnowledgeBaseTool } from "./search-knowledge-base.js";
import { listDocumentsTool }       from "./list-documents.js";
import { ingestDocumentTool }      from "./ingest-document.js";

// ── Exports ────────────────────────────────────────────────────────────────

/** IT/System internal tools (P338). */
export const INTERNAL_TOOLS_SYSTEM: InternalToolDef[] = [
  systemHealthTool,
  dockerInfoTool,
  backupStatusTool,
  logReaderTool,
  systemOverviewTool,
];

/** Governance/Finance/Audit internal tools (P339). */
export const INTERNAL_TOOLS_GOVERNANCE: InternalToolDef[] = [
  auditTrailTool,
  readBudgetTool,
  readSpendingTool,
  writeBudgetTool,
];

/** Knowledge/Librarian internal tools (P339). */
export const INTERNAL_TOOLS_KNOWLEDGE: InternalToolDef[] = [
  searchKnowledgeBaseTool,
  listDocumentsTool,
  ingestDocumentTool,
];

/** All 12 internal tools. */
export const ALL_INTERNAL_TOOLS: InternalToolDef[] = [
  ...INTERNAL_TOOLS_SYSTEM,
  ...INTERNAL_TOOLS_GOVERNANCE,
  ...INTERNAL_TOOLS_KNOWLEDGE,
];

export {
  systemHealthTool,
  dockerInfoTool,
  backupStatusTool,
  logReaderTool,
  systemOverviewTool,
  auditTrailTool,
  readBudgetTool,
  readSpendingTool,
  writeBudgetTool,
  searchKnowledgeBaseTool,
  listDocumentsTool,
  ingestDocumentTool,
};
