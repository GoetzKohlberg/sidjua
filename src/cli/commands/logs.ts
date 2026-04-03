// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua logs` command
 *
 * Enhanced audit trail viewer with pipeline/escalation events and --follow mode.
 */

import { join } from "node:path";
import { withCliDatabaseAsync } from "../utils/with-cli-database.js";
import { TaskStore } from "../../tasks/store.js";
import { TaskEventBus } from "../../tasks/event-bus.js";
import { TaskTreeManager } from "../../orchestrator/tree-manager.js";
import { writeJsonOutput } from "../utils/output.js";
import type { TaskTreeNode } from "../../orchestrator/types.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("logs-cmd");


export interface LogsCommandOptions {
  workDir:  string;
  taskId:   string | undefined;
  agentId:  string | undefined;
  division: string | undefined;
  type:     string | undefined;
  since:    string | undefined;
  follow:   boolean;
  limit:    number;
  json:     boolean;
}

interface LogEntry {
  ts:       string;
  type:     string;
  task_id:  string;
  agent:    string;
  detail:   string;
}

// Event type groups
const TYPE_GROUPS: Record<string, string[]> = {
  delegation:  ["TASK_DELEGATED", "TASK_ASSIGNED"],
  escalation:  ["TASK_ESCALATED", "HUMAN_REQUIRED", "ESCALATION"],
  pipeline:    ["PIPELINE_ACK_UPDATE", "PIPELINE_QUEUED", "PIPELINE_ACCEPT"],
  governance:  ["APPLY_STEP", "POLICY_VIOLATION", "BUDGET_ALERT"],
};


export async function runLogsCommand(opts: LogsCommandOptions): Promise<number> {
  return withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
    const store   = new TaskStore(db);
    const eventBus = new TaskEventBus(db);
    const treeManager = new TaskTreeManager(db, eventBus);

    // Resolve task tree IDs if --task is set
    let taskIds: Set<string> | null = null;
    if (opts.taskId !== undefined) {
      taskIds = new Set<string>();
      taskIds.add(opts.taskId);
      const tree = treeManager.getTree(opts.taskId);
      if (tree !== null) {
        collectIds(tree, taskIds);
      }
    }

    if (opts.follow) {
      return await followLogs(opts, db, taskIds);
    }

    return printLogs(opts, db, taskIds);
  });
}


function printLogs(
  opts:    LogsCommandOptions,
  db:      import("../../utils/db.js").Database,
  taskIds: Set<string> | null,
): number {
  const entries = fetchEntries(opts, db, taskIds, null, opts.limit);

  if (writeJsonOutput(entries, opts)) return 0;

  if (entries.length === 0) {
    process.stdout.write("No log entries found.\n");
    return 0;
  }

  for (const e of entries) {
    printEntry(e);
  }

  return 0;
}


/** Base poll interval in ms — reduced from 500ms. */
const POLL_BASE_MS = 2_000;
/** Slow poll interval when idle for several consecutive cycles. */
const POLL_IDLE_MS = 5_000;
/** Number of consecutive empty polls before slowing down. */
const IDLE_THRESHOLD = 3;

async function followLogs(
  opts:    LogsCommandOptions,
  db:      import("../../utils/db.js").Database,
  taskIds: Set<string> | null,
): Promise<number> {
  process.stdout.write("[following log — Ctrl-C to stop]\n\n");

  // Print initial batch
  const initial = fetchEntries(opts, db, taskIds, null, opts.limit);
  let lastSeen  = initial.length > 0 ? initial[initial.length - 1]!.ts : null;

  for (const e of initial) {
    printEntry(e);
  }

  // Adaptive poll loop: starts at 2s, backs off to 5s after 3 idle cycles,
  // resets to 2s immediately when new entries arrive.
  let pollInterval     = POLL_BASE_MS;
  let consecutiveEmpty = 0;
  let running          = true;

  process.on("SIGINT", () => {
    running = false;
    process.stdout.write("\n");
    process.exit(0);
  });

  while (running) {
    await sleep(pollInterval);
    const newEntries = fetchEntries(opts, db, taskIds, lastSeen, 100);

    if (newEntries.length > 0) {
      for (const e of newEntries) {
        printEntry(e);
      }
      lastSeen         = newEntries[newEntries.length - 1]!.ts;
      consecutiveEmpty = 0;
      pollInterval     = POLL_BASE_MS;
    } else {
      consecutiveEmpty++;
      if (consecutiveEmpty >= IDLE_THRESHOLD) {
        pollInterval = POLL_IDLE_MS;
      }
    }
  }

  return 0;
}


function fetchEntries(
  opts:       LogsCommandOptions,
  db:         import("../../utils/db.js").Database,
  taskIds:    Set<string> | null,
  afterTs:    string | null,
  limit:      number,
): LogEntry[] {
  const entries: LogEntry[] = [];

  try {
    let sql = `
      SELECT event_type, task_id, agent_from, agent_to, data, created_at
      FROM task_events
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (afterTs !== null) {
      sql += " AND created_at > ?";
      params.push(afterTs);
    }

    if (opts.since !== undefined) {
      sql += " AND created_at >= ?";
      params.push(opts.since);
    }

    if (opts.agentId !== undefined) {
      sql += " AND (agent_from = ? OR agent_to = ?)";
      params.push(opts.agentId, opts.agentId);
    }

    sql += " ORDER BY created_at ASC LIMIT ?";
    params.push(limit);

    type EventRow = {
      event_type: string;
      task_id:    string;
      agent_from: string | null;
      agent_to:   string | null;
      data:       string;
      created_at: string;
    };

    const rows = db.prepare<unknown[], EventRow>(sql).all(...params);

    // Apply type filter
    const allowedTypes = opts.type !== undefined && opts.type !== "all"
      ? new Set(TYPE_GROUPS[opts.type] ?? [opts.type.toUpperCase()])
      : null;

    for (const row of rows) {
      if (allowedTypes !== null && !allowedTypes.has(row.event_type)) continue;

      // Filter by task tree
      if (taskIds !== null && !taskIds.has(row.task_id)) continue;

      const agent  = row.agent_from ?? row.agent_to ?? "—";
      const dataObj = (() => {
        try { return JSON.parse(row.data) as Record<string, unknown>; }
        catch (e: unknown) { logger.debug("logs-cmd", "Event data JSON parse failed — returning empty object", { metadata: { error: e instanceof Error ? e.message : String(e) } }); return {} as Record<string, unknown>; }
      })();
      const detail = Object.entries(dataObj)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ");

      entries.push({
        ts:      row.created_at,
        type:    row.event_type,
        task_id: row.task_id,
        agent,
        detail,
      });
    }
  } catch (e: unknown) {
    logger.debug("logs-cmd", "task_events table not found — no events to display (pre-migration)", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }

  return entries;
}


function printEntry(e: LogEntry): void {
  const ts      = e.ts.slice(11, 19); // HH:MM:SS
  const type    = e.type.padEnd(22);
  const taskId  = e.task_id.slice(-16).padEnd(18);
  const agent   = e.agent.padEnd(20);
  process.stdout.write(`${ts}  ${type} ${taskId} ${agent} ${e.detail}\n`);
}


function collectIds(node: TaskTreeNode, out: Set<string>): void {
  out.add(node.task.id);
  for (const child of node.children) {
    collectIds(child, out);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
