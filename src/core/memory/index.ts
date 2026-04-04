// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Governed Memory Consolidation (barrel export)
 */

export type {
  MemoryEntry,
  MemoryIndex,
  OrientResult,
  GatherResult,
  GatheredEvent,
  ConsolidateResult,
  ConsolidationDecision,
  PruneResult,
  PruneDecision,
  ConsolidationResult,
  ConsolidationLock,
  PendingApproval,
  ApprovalStatus,
} from "./types.js";

export { MemoryIndexManager }  from "./memory-index.js";
export { MemoryConsolidator }  from "./memory-consolidator.js";
export { MemoryGovernance }    from "./memory-governance.js";
export {
  acquireConsolidationLock,
  releaseConsolidationLock,
  getConsolidationLock,
  shouldConsolidate,
  recordLastConsolidationRun,
} from "./memory-trigger.js";
