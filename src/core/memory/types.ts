// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Governed Memory Consolidation Types
 *
 * Defines the data structures for the 4-phase memory consolidation engine:
 * Orient → Gather → Consolidate → Prune
 * All consolidation results require mandatory T1 approval before being applied.
 */

// ---------------------------------------------------------------------------
// Memory entries
// ---------------------------------------------------------------------------

/** A single indexed memory entry (fact/observation stored in the memory index). */
export interface MemoryEntry {
  id:         string;
  agent_id:   string;
  division:   string;
  content:    string;
  source:     "audit_event" | "manual" | "consolidated";
  timestamp:  string;
  event_type: string;
  task_id?:   string;
  merged_ids?: string[];   // IDs of entries merged into this one during consolidation
  checksum:   string;      // SHA-256 of content (for dedup)
}

/** In-memory index of all known memory entries. */
export interface MemoryIndex {
  version:      string;     // index format version
  created_at:   string;
  updated_at:   string;
  total_entries: number;
  entries:      MemoryEntry[];
}

// ---------------------------------------------------------------------------
// Consolidation phases
// ---------------------------------------------------------------------------

/** Result of the Orient phase: overall state survey. */
export interface OrientResult {
  total_entries:    number;
  unique_agents:    number;
  oldest_entry_ts:  string | null;
  newest_entry_ts:  string | null;
  needs_consolidation: boolean;
}

/** A single gathered event from audit_events. */
export interface GatheredEvent {
  id:         string;
  timestamp:  string;
  agent_id:   string;
  division:   string;
  event_type: string;
  details:    string;
  task_id?:   string;
}

/** Result of the Gather phase: raw events collected from the audit trail. */
export interface GatherResult {
  events:    GatheredEvent[];
  since:     string | null;
  count:     number;
}

/** A single consolidation decision (what happened after dedup/merge). */
export interface ConsolidationDecision {
  action:      "kept" | "merged" | "deduplicated";
  entry_id:    string;
  merged_from?: string[];   // IDs of entries that were merged into this one
  reason:      string;
}

/** Result of the Consolidate phase: deduplicated and merged entries. */
export interface ConsolidateResult {
  entries:    MemoryEntry[];
  decisions:  ConsolidationDecision[];
  total_in:   number;
  total_out:  number;
  merged:     number;
  deduped:    number;
}

/** A single prune decision. */
export interface PruneDecision {
  action:     "keep" | "prune";
  entry_id:   string;
  reason:     string;
}

/** Result of the Prune phase: entries marked for removal. */
export interface PruneResult {
  kept:       MemoryEntry[];
  pruned:     MemoryEntry[];
  decisions:  PruneDecision[];
}

/** Full result of a single consolidation run (all 4 phases). */
export interface ConsolidationResult {
  run_id:      string;
  started_at:  string;
  completed_at: string;
  orient:      OrientResult;
  gather:      GatherResult;
  consolidate: ConsolidateResult;
  prune:       PruneResult;
  /** Entries that would be added to the index upon approval. */
  proposed_additions: MemoryEntry[];
  /** IDs of entries that would be removed upon approval. */
  proposed_removals:  string[];
}

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

/** Advisory lock preventing concurrent consolidation runs. */
export interface ConsolidationLock {
  holder:      string;   // process or run ID that holds the lock
  acquired_at: string;
  expires_at:  string;   // stale lock auto-released after 1 hour
}

// ---------------------------------------------------------------------------
// Governance / approval
// ---------------------------------------------------------------------------

export type ApprovalStatus = "pending" | "approved" | "rejected";

/** A pending consolidation result awaiting T1 approval. */
export interface PendingApproval {
  approval_id:  string;
  run_id:       string;
  submitted_at: string;
  result:       ConsolidationResult;
  status:       ApprovalStatus;
  approved_by?: string;
  decided_at?:  string;
  reason?:      string;
}
