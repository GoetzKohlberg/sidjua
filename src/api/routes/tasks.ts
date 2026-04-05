// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11b: Task REST Endpoints
 *
 * POST   /api/v1/tasks              — create task
 * GET    /api/v1/tasks              — list tasks (paginated, filterable)
 * GET    /api/v1/tasks/:id          — task detail with delegation tree
 * GET    /api/v1/tasks/:id/summary  — management summary only
 * GET    /api/v1/tasks/:id/result   — result file path + content from task_outputs
 * DELETE /api/v1/tasks/:id          — cancel + cascade to children
 */

import Database from "better-sqlite3";
import { Hono } from "hono";
import { TaskStore }       from "../../tasks/store.js";
import { TaskManager }     from "../../tasks/task-manager.js";
import { getSanitizer }    from "../../core/input-sanitizer.js";
import { SidjuaError }     from "../../core/error-codes.js";
import { createLogger }    from "../../core/logger.js";
import { reqId }           from "../utils/request-id.js";
import { notFound }        from "../utils/responses.js";
import { parsePagination } from "../utils/route-helpers.js";
import { requireScope } from "../middleware/require-scope.js";
import type { Task, CreateTaskInput, TaskStatus } from "../../tasks/types.js";

const logger = createLogger("api-tasks");


export interface TaskRouteServices {
  db: InstanceType<typeof Database>;
}


const VALID_STATUSES = new Set<string>([
  "CREATED", "PENDING", "ASSIGNED", "RUNNING", "WAITING",
  "REVIEW", "DONE", "FAILED", "ESCALATED", "CANCELLED",
]);

/** Parse metadata JSON for rows returned from raw SQL (not via TaskStore). */
function parseTaskRow(row: Record<string, unknown>): Task {
  const meta = row["metadata"];
  const metadata: Record<string, unknown> =
    typeof meta === "string" ? JSON.parse(meta) as Record<string, unknown> : ((meta ?? {}) as Record<string, unknown>);
  return {
    id:                 row["id"] as string,
    parent_id:          row["parent_id"] as string | null,
    root_id:            row["root_id"] as string,
    division:           row["division"] as string,
    type:               row["type"] as Task["type"],
    tier:               row["tier"] as Task["tier"],
    title:              row["title"] as string,
    description:        row["description"] as string,
    assigned_agent:     row["assigned_agent"] as string | null,
    status:             row["status"] as Task["status"],
    priority:           row["priority"] as number,
    classification:     row["classification"] as string,
    created_at:         row["created_at"] as string,
    updated_at:         row["updated_at"] as string,
    started_at:         row["started_at"] as string | null,
    completed_at:       row["completed_at"] as string | null,
    result_file:        row["result_file"] as string | null,
    result_summary:     row["result_summary"] as string | null,
    confidence:         row["confidence"] as number | null,
    token_budget:       row["token_budget"] as number,
    token_used:         row["token_used"] as number,
    cost_budget:        row["cost_budget"] as number,
    cost_used:          row["cost_used"] as number,
    ttl_seconds:        row["ttl_seconds"] as number,
    retry_count:        row["retry_count"] as number,
    max_retries:        row["max_retries"] as number,
    checkpoint:         row["checkpoint"] as string | null,
    sub_tasks_expected: row["sub_tasks_expected"] as number,
    sub_tasks_received: row["sub_tasks_received"] as number,
    embedding_id:          row["embedding_id"] as string | null,
    metadata,
    recurring_schedule_id: (row["recurring_schedule_id"] as string | null | undefined) ?? null,
    is_recurring:          Boolean(row["is_recurring"]),
  };
}


export function registerTaskRoutes(app: Hono, services: TaskRouteServices): void {
  const store = new TaskStore(services.db);
  store.initialize();

  // ---- POST /api/v1/tasks ------------------------------------------------

  app.post("/api/v1/tasks", requireScope("operator"), async (c) => {
    const body = await c.req.json() as Record<string, unknown>;

    if (typeof body["description"] !== "string" || body["description"].trim() === "") {
      throw SidjuaError.from("TASK-001", "description is required and must be a non-empty string");
    }

    const input: CreateTaskInput = {
      title:        String(body["title"] ?? (body["description"] as string)).slice(0, 120),
      description:  body["description"] as string,
      division:     typeof body["division"] === "string" ? body["division"] : "default",
      type:         "root",
      tier:         1,
      token_budget: 100_000,
      cost_budget:  10.0,
      ...(body["priority"]    !== undefined ? { priority:    Number(body["priority"])    } : {}),
      ...(body["ttl_seconds"] !== undefined ? { ttl_seconds: Number(body["ttl_seconds"]) } : {}),
    };

    // Route through TaskManager for input sanitization (defense-in-depth behind HTTP middleware)
    const manager = new TaskManager(store, getSanitizer());
    const task = manager.createTask(input);
    logger.info("task_created", `Task created: ${task.id}`, {
      correlationId: reqId(c),
      metadata: { task_id: task.id, division: task.division },
    });
    return c.json({ task }, 201);
  });

  // ---- GET /api/v1/tasks -------------------------------------------------

  /** Whitelist of allowed filter params for GET /api/v1/tasks (column name never derived from user input). */
  const TASK_FILTER_PARAMS = new Set(["status", "division", "agent", "limit", "offset"]);

  app.get("/api/v1/tasks", requireScope("readonly"), (c) => {
    // Reject unknown query params — column names are hardcoded; unknown params are not silently ignored
    for (const key of Object.keys(c.req.queries())) {
      if (!TASK_FILTER_PARAMS.has(key)) {
        return c.json({ error: `Invalid filter parameter: ${key}` }, 400);
      }
    }

    const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
    if ("error" in pagination) throw SidjuaError.from("INPUT-003", pagination.error);
    const { limit, offset } = pagination;

    const statusFilter   = c.req.query("status");
    const divisionFilter = c.req.query("division");
    const agentFilter    = c.req.query("agent");

    if (statusFilter !== undefined && !VALID_STATUSES.has(statusFilter.toUpperCase())) {
      throw SidjuaError.from("INPUT-003", `Invalid status value: ${statusFilter}`);
    }

    const conditions: string[] = [];
    const params: unknown[]    = [];
    if (statusFilter)   { conditions.push("status = ?");          params.push(statusFilter.toUpperCase()); }
    if (divisionFilter) { conditions.push("division = ?");         params.push(divisionFilter); }
    if (agentFilter)    { conditions.push("assigned_agent = ?");   params.push(agentFilter); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = services.db
      .prepare(`SELECT COUNT(*) AS total FROM tasks ${where}`)
      .get(...params) as { total: number } | undefined;

    const total = countRow?.total ?? 0;

    const rows = services.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];

    return c.json({ tasks: rows.map(parseTaskRow), total, limit, offset });
  });

  // ---- GET /api/v1/tasks/:id ---------------------------------------------

  app.get("/api/v1/tasks/:id", requireScope("readonly"), (c) => {
    const id   = c.req.param("id");
    const task = store.get(id);

    if (task === null) {
      return notFound(c, `Task ${id} not found`);
    }

    // Build delegation tree: children + parent chain
    const children = (services.db
      .prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at")
      .all(id) as Record<string, unknown>[])
      .map(parseTaskRow);

    const parentChain: Task[] = [];
    let current: Task = task;
    while (current.parent_id !== null) {
      const parent = store.get(current.parent_id);
      if (parent === null) break;
      parentChain.unshift(parent);
      current = parent;
    }

    return c.json({ task: { ...task, children, parent_chain: parentChain } });
  });

  // ---- GET /api/v1/tasks/:id/summary -------------------------------------

  app.get("/api/v1/tasks/:id/summary", requireScope("readonly"), (c) => {
    const id   = c.req.param("id");
    const task = store.get(id);

    if (task === null) {
      return notFound(c, `Task ${id} not found`);
    }

    if (task.status !== "DONE") {
      throw SidjuaError.from("TASK-003", `Task ${id} is not yet complete (status: ${task.status})`);
    }

    return c.json({
      task_id:      task.id,
      summary:      task.result_summary,
      confidence:   task.confidence,
      agent:        task.assigned_agent,
      completed_at: task.completed_at,
    });
  });

  // ---- GET /api/v1/tasks/:id/result --------------------------------------

  app.get("/api/v1/tasks/:id/result", requireScope("readonly"), (c) => {
    const id   = c.req.param("id");
    const task = store.get(id);

    if (task === null) {
      return notFound(c, `Task ${id} not found`);
    }

    if (task.result_file === null) {
      return notFound(c, `Task ${id} has no result file`);
    }

    // Read content from task_outputs table (latest output for this task).
    // Falls back to path-only response when no output row exists yet.
    type OutputRow = { content_text: string | null; mime_type: string | null };
    let outputRow: OutputRow | null = null;
    try {
      const hasOutputs = services.db.prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      ).get("task_outputs");
      if (hasOutputs !== undefined) {
        outputRow = services.db.prepare<[string], OutputRow>(
          "SELECT content_text, mime_type FROM task_outputs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
        ).get(id) ?? null;
      }
    } catch (err) {
      logger.warn("task_result_read_failed", `Could not read task_outputs for task ${id}`, {
        correlationId: reqId(c),
        metadata: { task_id: id, error: String(err) },
      });
    }

    return c.json({
      task_id:          task.id,
      result_file_path: task.result_file,
      content:          outputRow?.content_text ?? null,
      mime_type:        outputRow?.mime_type ?? "text/markdown",
    });
  });

  // ---- DELETE /api/v1/tasks/:id ------------------------------------------

  app.delete("/api/v1/tasks/:id", requireScope("operator"), (c) => {
    const id   = c.req.param("id");
    const task = store.get(id);

    if (task === null) {
      return notFound(c, `Task ${id} not found`);
    }

    const terminal: ReadonlySet<TaskStatus> = new Set(["DONE", "FAILED", "ESCALATED", "CANCELLED"]);
    let cancelled = 0;

    if (!terminal.has(task.status)) {
      store.update(id, { status: "CANCELLED" });
      cancelled++;
    }

    // Cancel non-terminal descendants
    const descendants = services.db
      .prepare("SELECT id, status FROM tasks WHERE root_id = ? AND id != ?")
      .all(id, id) as { id: string; status: string }[];

    for (const row of descendants) {
      if (!terminal.has(row.status as TaskStatus)) {
        store.update(row.id, { status: "CANCELLED" });
        cancelled++;
      }
    }

    logger.info("task_cancelled", `Cancelled ${cancelled} task(s) in tree`, {
      correlationId: reqId(c),
      metadata: { root_task_id: id, cancelled },
    });

    return c.json({ cancelled });
  });
}
