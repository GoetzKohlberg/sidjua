// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua logs` command
 *
 * Enhanced audit trail viewer with pipeline/escalation events and --follow mode.
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { withCliDatabaseAsync } from "../utils/with-cli-database.js";
import { TaskStore } from "../../tasks/store.js";
import { TaskEventBus } from "../../tasks/event-bus.js";
import { TaskTreeManager } from "../../orchestrator/tree-manager.js";
import { writeJsonOutput } from "../utils/output.js";
import type { TaskTreeNode } from "../../orchestrator/types.js";
import { createLogger } from "../../core/logger.js";
import { connectSse } from "../utils/sse-client.js";
import type { SseEvent } from "../utils/sse-client.js";

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


/** Base poll interval in ms — used when server is not running (polling fallback). */
const POLL_BASE_MS = 2_000;
/** Slow poll interval when idle — used when server is not running (polling fallback). */
const POLL_IDLE_MS = 5_000;
/** Number of consecutive empty polls before slowing down — polling fallback. */
const IDLE_THRESHOLD = 3;

/** Default server URL for SSE connection attempts. */
const DEFAULT_SERVER_URL = "http://localhost:3000";
/** Timeout for server reachability check (ms). */
const HEALTH_CHECK_TIMEOUT_MS = 2_000;

/**
 * Try to read the admin token from .system/admin.token.
 * Returns null if the file does not exist or cannot be read.
 */
function readAdminToken(workDir: string): string | null {
  const tokenFile = join(workDir, ".system", "admin.token");
  if (!existsSync(tokenFile)) return null;
  try {
    return readFileSync(tokenFile, "utf8").trim() || null;
  } catch (_err) {
    return null;
  }
}

/**
 * Check whether the server is reachable at the given base URL.
 * Returns true if GET /api/v1/health responds within the timeout.
 */
async function isServerReachable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/v1/health`, { signal: controller.signal });
    return res.ok;
  } catch (_err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Obtain a short-lived SSE ticket from the server.
 * Returns null if the request fails.
 */
async function obtainSseTicket(baseUrl: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/sse/ticket`, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body:    JSON.stringify({}),
    });
    if (!res.ok) return null;
    const body = await res.json() as Record<string, unknown>;
    return typeof body["ticket"] === "string" ? body["ticket"] : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Format an SSE ActivityEvent as a LogEntry for display.
 * Matches the existing polling output format.
 */
function activityEventToEntry(event: SseEvent): LogEntry | null {
  const d = event.data;
  const ts = typeof d["timestamp"] === "string"
    ? d["timestamp"]
    : new Date().toISOString();
  const type  = typeof d["event_type"] === "string" ? d["event_type"] : event.type;
  const agent = typeof d["agent_id"]   === "string" ? d["agent_id"]   : "—";
  const title = typeof d["title"]      === "string" ? d["title"]      : "";
  const taskId = typeof d["task_id"]   === "string" ? d["task_id"]    : "";

  return { ts, type, task_id: taskId, agent, detail: title };
}

async function followLogs(
  opts:    LogsCommandOptions,
  db:      import("../../utils/db.js").Database,
  taskIds: Set<string> | null,
): Promise<number> {
  process.stdout.write("[following log — Ctrl-C to stop]\n\n");

  // Print initial batch from database (always available regardless of mode)
  const initial = fetchEntries(opts, db, taskIds, null, opts.limit);
  let lastSeen  = initial.length > 0 ? initial[initial.length - 1]!.ts : null;
  for (const e of initial) {
    printEntry(e);
  }

  // ── Try SSE mode ─────────────────────────────────────────────────────────
  const adminToken = readAdminToken(opts.workDir);
  const serverUrl  = DEFAULT_SERVER_URL;

  if (adminToken !== null && await isServerReachable(serverUrl)) {
    const ticket = await obtainSseTicket(serverUrl, adminToken);

    if (ticket !== null) {
      // Build SSE URL with ticket + optional filters
      const params = new URLSearchParams({ ticket });
      if (opts.agentId   !== undefined) params.set("agents",    opts.agentId);
      if (opts.division  !== undefined) params.set("divisions", opts.division);
      const sseUrl = `${serverUrl}/api/v1/events?${params.toString()}`;

      const controller = new AbortController();
      process.on("SIGINT", () => {
        controller.abort();
        process.stdout.write("\n");
        process.exit(0);
      });

      // Build client-side type filter (server filters agents/divisions; type is client-side)
      const allowedTypes = opts.type !== undefined && opts.type !== "all"
        ? new Set(TYPE_GROUPS[opts.type] ?? [opts.type.toUpperCase()])
        : null;

      await connectSse({
        url:    sseUrl,
        apiKey: adminToken,
        signal: controller.signal,
        onEvent: (event: SseEvent) => {
          const entry = activityEventToEntry(event);
          if (entry === null) return;
          if (allowedTypes !== null && !allowedTypes.has(entry.type)) return;
          printEntry(entry);
        },
        onError: (err: Error) => {
          logger.debug("logs-cmd", "SSE stream error", { metadata: { error: err.message } });
        },
      });

      return 0;
    }
  }

  // ── Polling fallback (server not running or no admin token) ───────────────
  logger.debug("logs-cmd", "Server not reachable — falling back to database polling", {});
  process.stdout.write("[server not running — using database polling]\n");

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
