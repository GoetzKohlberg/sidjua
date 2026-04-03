// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua queue` command
 *
 * View Task Pipeline queue status by priority and agent.
 */

import { join } from "node:path";
import { withCliDatabase } from "../utils/with-cli-database.js";
import { formatAge } from "../utils/format.js";
import { formatTable } from "../formatters/table.js";
import { formatJson } from "../formatters/json.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("queue-cmd");


export interface QueueCommandOptions {
  workDir: string;
  agent:   string | undefined;
  json:    boolean;
}

interface PriorityCount {
  priority: number;
  count:    number;
}

interface AgentQueueRow {
  agent_id: string;
  active:   number;
  queued:   number;
}

// Priority labels
const PRIORITY_LABELS: Record<number, string> = {
  0: "CRITICAL",
  1: "URGENT",
  2: "REGULAR",
  3: "LOW",
  4: "BACKGROUND",
};


export function runQueueCommand(opts: QueueCommandOptions): number {
  return withCliDatabase({ workDir: opts.workDir, queryOnly: true }, (db) => {
    // ── Priority breakdown ─────────────────────────────────────────────────

    let priorityCounts: PriorityCount[] = [];
    let totalQueued = 0;
    let oldestQueued: string | null = null;

    try {
      priorityCounts = db.prepare<[], PriorityCount>(
        "SELECT priority, COUNT(*) as count FROM pipeline_queue WHERE ack_state = 'QUEUED' GROUP BY priority ORDER BY priority",
      ).all();
      totalQueued = priorityCounts.reduce((s, r) => s + r.count, 0);

      const oldestRow = db.prepare<[], { queued_at: string }>(
        "SELECT queued_at FROM pipeline_queue WHERE ack_state = 'QUEUED' ORDER BY queued_at ASC LIMIT 1",
      ).get();
      oldestQueued = oldestRow?.queued_at ?? null;
    } catch (e: unknown) {
      logger.debug("queue-cmd", "pipeline_queue table not found — queue may not be initialized (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    }

    // ── Agent breakdown ────────────────────────────────────────────────────

    let agentQueues: AgentQueueRow[] = [];

    try {
      // Get active (RUNNING/ACCEPTED) counts per agent
      const activeCounts = db.prepare<[], { agent_id: string; count: number }>(
        "SELECT consumer_agent_id as agent_id, COUNT(*) as count FROM pipeline_queue WHERE ack_state IN ('ACCEPTED','RUNNING') GROUP BY consumer_agent_id",
      ).all();
      const activeMap = new Map(activeCounts.map((r) => [r.agent_id, r.count]));

      // Get queued counts per agent
      const queuedParams: string[] = [];
      let queuedSql = "SELECT consumer_agent_id as agent_id, COUNT(*) as count FROM pipeline_queue WHERE ack_state = 'QUEUED'";
      if (opts.agent !== undefined) {
        queuedSql += " AND consumer_agent_id = ?";
        queuedParams.push(opts.agent);
      }
      queuedSql += " GROUP BY consumer_agent_id";
      const queuedCounts = db.prepare<string[], { agent_id: string; count: number }>(queuedSql).all(...queuedParams);
      const queuedMap = new Map(queuedCounts.map((r) => [r.agent_id, r.count]));

      // Combine: all agent IDs seen in either active or queued
      const allAgentIds = new Set([...activeMap.keys(), ...queuedMap.keys()]);
      agentQueues = [...allAgentIds]
        .filter((id) => opts.agent === undefined || id === opts.agent)
        .map((id) => ({
          agent_id: id,
          active:   activeMap.get(id) ?? 0,
          queued:   queuedMap.get(id) ?? 0,
        }));
    } catch (e: unknown) {
      logger.debug("queue-cmd", "Pipeline tables not found — returning empty stats (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    }

    // ── JSON output ────────────────────────────────────────────────────────

    if (opts.json) {
      process.stdout.write(formatJson({
        total_queued:    totalQueued,
        oldest_queued:   oldestQueued,
        by_priority:     priorityCounts,
        by_agent:        agentQueues,
      }) + "\n");
      return 0;
    }

    // ── Text output ────────────────────────────────────────────────────────

    const oldestAge = oldestQueued !== null
      ? formatAge(oldestQueued)
      : "—";

    process.stdout.write("PIPELINE STATUS\n");
    process.stdout.write(`Total queued: ${totalQueued}  |  Oldest: ${oldestAge}\n\n`);

    if (priorityCounts.length > 0) {
      process.stdout.write("By priority:\n");
      const countMap = new Map(priorityCounts.map((r) => [r.priority, r.count]));
      for (let p = 0; p <= 4; p++) {
        const label = PRIORITY_LABELS[p] ?? `P${p}`;
        const cnt   = countMap.get(p) ?? 0;
        process.stdout.write(`  ${label.padEnd(12)} ${cnt}\n`);
      }
      process.stdout.write("\n");
    }

    if (agentQueues.length > 0) {
      const rows = agentQueues.map((a) => ({
        agent:  a.agent_id,
        active: String(a.active),
        queued: String(a.queued),
      }));

      const out = formatTable(rows, {
        columns: [
          { header: "AGENT",  key: "agent"  },
          { header: "ACTIVE", key: "active", align: "right" },
          { header: "QUEUED", key: "queued", align: "right" },
        ],
        maxWidth: 200,
      });

      process.stdout.write("By agent:\n");
      process.stdout.write(out + "\n\n");
    } else {
      process.stdout.write("No agent data available.\n");
    }

    return 0;
  });
}


