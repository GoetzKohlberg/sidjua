// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Governed Memory Consolidation Engine
 *
 * 4-phase consolidation pipeline:
 *   Phase 1 — Orient:      Survey existing memory index state
 *   Phase 2 — Gather:      Query audit_events for new memory-relevant events
 *   Phase 3 — Consolidate: Deduplicate and merge similar entries
 *   Phase 4 — Prune:       Mark stale or redundant entries for removal
 *
 * Results are staged for mandatory T1 approval before any writes occur.
 */

import { randomUUID, createHash } from "node:crypto";
import { createLogger } from "../logger.js";
import type Database from "better-sqlite3";
import type {
  MemoryEntry,
  OrientResult,
  GatherResult,
  GatheredEvent,
  ConsolidateResult,
  ConsolidationDecision,
  PruneResult,
  PruneDecision,
  ConsolidationResult,
} from "./types.js";
import { MemoryIndexManager } from "./memory-index.js";

const logger = createLogger("memory-consolidator");

/** Maximum entries per agent before pruning is triggered. */
const MAX_ENTRIES_PER_AGENT = 100;

/** How many days back to gather audit events (default). */
const GATHER_DAYS_BACK = 7;

/** Minimum content similarity threshold for dedup (Jaccard, 0–1). */
const DEDUP_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Simple Jaccard similarity on word tokens. */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  const intersection = new Set([...setA].filter((w) => setB.has(w)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 1;
  return intersection.size / union.size;
}

/** Convert a GatheredEvent to a MemoryEntry. */
function eventToEntry(event: GatheredEvent): MemoryEntry {
  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(event.details) as Record<string, unknown>;
  } catch (_e) {
    // non-JSON details — use raw string
    details = { raw: event.details };
  }

  const content = typeof details["summary"] === "string"
    ? details["summary"]
    : `${event.event_type} by ${event.agent_id} in ${event.division}`;

  const entry: MemoryEntry = {
    id:         event.id,
    agent_id:   event.agent_id,
    division:   event.division,
    content,
    source:     "audit_event",
    timestamp:  event.timestamp,
    event_type: event.event_type,
    checksum:   contentChecksum(content),
  };
  if (event.task_id !== undefined) entry.task_id = event.task_id;
  return entry;
}

// ---------------------------------------------------------------------------
// MemoryConsolidator
// ---------------------------------------------------------------------------

export class MemoryConsolidator {
  constructor(private readonly _indexManager: MemoryIndexManager) {}

  // ---------------------------------------------------------------------------
  // Phase 1: Orient
  // ---------------------------------------------------------------------------

  orient(): OrientResult {
    const stats = this._indexManager.getStats();
    const needsConsolidation = stats.total > MAX_ENTRIES_PER_AGENT * 2;

    logger.info("consolidation_orient", "Orient phase complete", {
      metadata: { total: stats.total, agents: stats.agents, needsConsolidation },
    });

    return {
      total_entries:       stats.total,
      unique_agents:       stats.agents,
      oldest_entry_ts:     stats.oldest,
      newest_entry_ts:     stats.newest,
      needs_consolidation: needsConsolidation,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Gather
  // ---------------------------------------------------------------------------

  gather(db: InstanceType<typeof Database>, since?: string): GatherResult {
    const cutoff = since ?? (() => {
      const d = new Date();
      d.setDate(d.getDate() - GATHER_DAYS_BACK);
      return d.toISOString();
    })();

    let events: GatheredEvent[] = [];
    try {
      type AuditRow = {
        id: string;
        timestamp: string;
        agent_id: string;
        division: string;
        event_type: string;
        details: string;
        task_id: string | null;
      };

      const rows = db.prepare<[string], AuditRow>(
        `SELECT id, timestamp, agent_id, division, event_type, details, task_id
         FROM audit_events
         WHERE timestamp >= ?
           AND event_type IN ('task_completed', 'task_failed', 'decision_made',
                               'escalation', 'delegation', 'tool_call_completed')
         ORDER BY timestamp ASC
         LIMIT 1000`,
      ).all(cutoff);

      events = rows.map((row): GatheredEvent => {
        const ev: GatheredEvent = {
          id:         row.id,
          timestamp:  row.timestamp,
          agent_id:   row.agent_id,
          division:   row.division,
          event_type: row.event_type,
          details:    row.details,
        };
        if (row.task_id !== null) ev.task_id = row.task_id;
        return ev;
      });
    } catch (err: unknown) {
      logger.warn("consolidation_gather_error", "Failed to gather audit events", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    logger.info("consolidation_gather", "Gather phase complete", {
      metadata: { count: events.length, since: cutoff },
    });

    return { events, since: cutoff, count: events.length };
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Consolidate
  // ---------------------------------------------------------------------------

  consolidate(gatherResult: GatherResult, existing: MemoryEntry[]): ConsolidateResult {
    const newEntries = gatherResult.events.map(eventToEntry);
    const allEntries = [...existing, ...newEntries];
    const decisions:  ConsolidationDecision[] = [];

    // Dedup by checksum (exact duplicates)
    const seenChecksums = new Map<string, string>(); // checksum → first entry id
    const dedupedIds    = new Set<string>();

    for (const entry of allEntries) {
      const existing = seenChecksums.get(entry.checksum);
      if (existing !== undefined) {
        dedupedIds.add(entry.id);
        decisions.push({
          action:   "deduplicated",
          entry_id: entry.id,
          reason:   `Exact duplicate of ${existing}`,
        });
      } else {
        seenChecksums.set(entry.checksum, entry.id);
      }
    }

    const afterDedup = allEntries.filter((e) => !dedupedIds.has(e.id));

    // Near-duplicate merge (Jaccard similarity)
    const merged = new Set<string>();
    const mergedEntries: MemoryEntry[] = [];

    for (let i = 0; i < afterDedup.length; i++) {
      const a = afterDedup[i];
      if (a === undefined || merged.has(a.id)) continue;

      const mergedFrom: string[] = [];

      for (let j = i + 1; j < afterDedup.length; j++) {
        const b = afterDedup[j];
        if (b === undefined || merged.has(b.id)) continue;
        if (a.agent_id !== b.agent_id) continue; // only merge within same agent

        const sim = jaccardSimilarity(a.content, b.content);
        if (sim >= DEDUP_THRESHOLD) {
          merged.add(b.id);
          mergedFrom.push(b.id);
          decisions.push({
            action:      "merged",
            entry_id:    b.id,
            merged_from: [a.id],
            reason:      `Near-duplicate of ${a.id} (similarity=${sim.toFixed(2)})`,
          });
        }
      }

      const resultEntry: MemoryEntry = mergedFrom.length > 0
        ? { ...a, merged_ids: mergedFrom }
        : a;

      mergedEntries.push(resultEntry);
      decisions.push({
        action:   "kept",
        entry_id: a.id,
        ...(mergedFrom.length > 0 ? { merged_from: mergedFrom } : {}),
        reason:   mergedFrom.length > 0 ? `Merged ${mergedFrom.length} near-duplicate(s)` : "Unique entry",
      });
    }

    logger.info("consolidation_consolidate", "Consolidate phase complete", {
      metadata: {
        totalIn:  allEntries.length,
        totalOut: mergedEntries.length,
        deduped:  dedupedIds.size,
        merged:   merged.size,
      },
    });

    return {
      entries:   mergedEntries,
      decisions,
      total_in:  allEntries.length,
      total_out: mergedEntries.length,
      merged:    merged.size,
      deduped:   dedupedIds.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Prune
  // ---------------------------------------------------------------------------

  prune(consolidateResult: ConsolidateResult): PruneResult {
    const entries   = consolidateResult.entries;
    const decisions: PruneDecision[] = [];

    // Group by agent
    const byAgent = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const list = byAgent.get(entry.agent_id) ?? [];
      list.push(entry);
      byAgent.set(entry.agent_id, list);
    }

    const kept:   MemoryEntry[] = [];
    const pruned: MemoryEntry[] = [];

    for (const [agentId, agentEntries] of byAgent.entries()) {
      // Sort by timestamp desc (newest first)
      const sorted = [...agentEntries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

      for (let i = 0; i < sorted.length; i++) {
        const entry = sorted[i];
        if (entry === undefined) continue;
        if (i < MAX_ENTRIES_PER_AGENT) {
          kept.push(entry);
          decisions.push({ action: "keep", entry_id: entry.id, reason: "Within retention limit" });
        } else {
          pruned.push(entry);
          decisions.push({
            action:   "prune",
            entry_id: entry.id,
            reason:   `Agent ${agentId} exceeded ${MAX_ENTRIES_PER_AGENT} entry limit`,
          });
        }
      }
    }

    logger.info("consolidation_prune", "Prune phase complete", {
      metadata: { kept: kept.length, pruned: pruned.length },
    });

    return { kept, pruned, decisions };
  }

  // ---------------------------------------------------------------------------
  // Full run (all 4 phases)
  // ---------------------------------------------------------------------------

  /**
   * Run all 4 phases and return a ConsolidationResult staged for approval.
   * Does NOT modify the index — changes are only applied after T1 approval.
   */
  run(db: InstanceType<typeof Database>, since?: string): ConsolidationResult {
    const runId     = randomUUID();
    const startedAt = new Date().toISOString();

    logger.info("consolidation_run_start", `Consolidation run ${runId} started`, {
      metadata: { runId },
    });

    const existing = this._indexManager.getEntries();

    // Phase 1: Orient
    const orientResult = this.orient();

    // Phase 2: Gather
    const gatherResult = this.gather(db, since);

    // Phase 3: Consolidate
    const consolidateResult = this.consolidate(gatherResult, existing);

    // Phase 4: Prune
    const pruneResult = this.prune(consolidateResult);

    // Compute proposed changes
    const existingIds     = new Set(existing.map((e) => e.id));
    const keptIds         = new Set(pruneResult.kept.map((e) => e.id));
    const proposed_additions = pruneResult.kept.filter((e) => !existingIds.has(e.id));
    const proposed_removals  = existing
      .filter((e) => !keptIds.has(e.id))
      .map((e) => e.id);

    const completedAt = new Date().toISOString();

    logger.info("consolidation_run_complete", `Consolidation run ${runId} complete`, {
      metadata: {
        runId,
        additions: proposed_additions.length,
        removals:  proposed_removals.length,
      },
    });

    return {
      run_id:       runId,
      started_at:   startedAt,
      completed_at: completedAt,
      orient:       orientResult,
      gather:       gatherResult,
      consolidate:  consolidateResult,
      prune:        pruneResult,
      proposed_additions,
      proposed_removals,
    };
  }

  // ---------------------------------------------------------------------------
  // Apply approved changes
  // ---------------------------------------------------------------------------

  /**
   * Apply a previously approved consolidation result to the index.
   * Writes are only performed here — never during the run phase.
   */
  applyApproved(result: ConsolidationResult): void {
    const index = this._indexManager.getIndex();

    // Remove pruned entries
    if (result.proposed_removals.length > 0) {
      this._indexManager.removeEntries(result.proposed_removals);
    }

    // Add new entries
    for (const entry of result.proposed_additions) {
      // Avoid duplicates on replay
      const already = index.entries.some((e) => e.id === entry.id);
      if (!already) {
        this._indexManager.addEntry(entry);
      }
    }

    this._indexManager.save();

    logger.info("consolidation_applied", "Approved consolidation result applied to index", {
      metadata: {
        runId:    result.run_id,
        added:    result.proposed_additions.length,
        removed:  result.proposed_removals.length,
      },
    });
  }
}
