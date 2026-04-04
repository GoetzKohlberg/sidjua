// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13c: Execution REST Endpoints
 *
 * POST   /api/v1/tasks/run        — submit and start a task
 * GET    /api/v1/tasks/:id/status — live task tree status
 * GET    /api/v1/tasks/:id/result — completed task result
 * GET    /api/v1/tasks/:id/tree   — delegation tree
 * POST   /api/v1/tasks/:id/cancel — cancel task + all sub-tasks
 */

import type Database       from "better-sqlite3";
import { SidjuaError }     from "../../core/error-codes.js";
import { createLogger }    from "../../core/logger.js";
import { TaskStore }       from "../../tasks/store.js";
import { TaskEventBus }    from "../../tasks/event-bus.js";
import { ExecutionBridge } from "../../orchestrator/execution-bridge.js";
import { Hono }            from "hono";
import { DIVISION_REGEX }  from "./agents.js";
import { requireScope, CALLER_CONTEXT_KEY } from "../middleware/require-scope.js";
import type { CallerContext }                from "../caller-context.js";

// ---------------------------------------------------------------------------
// Task submission schema validation
// Division format validation
// ---------------------------------------------------------------------------

/**
 * Allowed top-level keys in a POST /api/v1/tasks/run body.
 * Requests with unknown keys are rejected (.strict() equivalent).
 *
 * Accepting arbitrary JSON without validation allows prototype
 * pollution, unexpected field injection, and type-coercion bypass.
 */
const TASK_RUN_ALLOWED_KEYS = new Set([
  "description",
  "priority",
  "division",
  "budget_usd",
  "budget_tokens",
  "timeout_seconds",
]);

/** Max description length — guards against OOM in downstream processing. */
const DESCRIPTION_MAX_LEN = 10_000;
/** Estimated token ceiling — guards against exceeding LLM context windows. */
const DESCRIPTION_MAX_TOKENS = 8_000;

/**
 * Validate the POST /api/v1/tasks/run request body.
 * Returns a typed subset of the body on success; throws SidjuaError on error.
 *
 * Strict key allowlist + per-field type + bounds validation.
 * Division format validated via DIVISION_REGEX.
 */
function validateTaskRunBody(body: Record<string, unknown>): {
  description:     string;
  priority?:       number;
  division?:       string;
  budget_usd?:     number;
  budget_tokens?:  number;
  timeout_seconds?: number;
} {
  // Strict: reject unknown keys
  for (const key of Object.keys(body)) {
    if (!TASK_RUN_ALLOWED_KEYS.has(key)) {
      throw SidjuaError.from(
        "INPUT-001",
        `Unknown field in task submission: "${key}". Allowed: ${[...TASK_RUN_ALLOWED_KEYS].join(", ")}`,
      );
    }
  }

  // description — required, non-empty string, max 10000 chars
  const description = body["description"];
  if (typeof description !== "string" || description.trim() === "") {
    throw SidjuaError.from("EXEC-003", "description must be a non-empty string");
  }
  if (description.length > DESCRIPTION_MAX_LEN) {
    throw SidjuaError.from(
      "INPUT-002",
      `description too long: ${description.length} chars (max ${DESCRIPTION_MAX_LEN})`,
    );
  }
  // Rough token estimate: max(words * 1.33, chars / 3) — guards dense/CJK content
  const wordCount      = description.trim().split(/\s+/).filter(Boolean).length;
  const estimatedTokens = Math.max(Math.ceil(wordCount * 1.33), Math.ceil(description.length / 3));
  if (estimatedTokens > DESCRIPTION_MAX_TOKENS) {
    throw SidjuaError.from(
      "INPUT-007",
      `description estimated token count (${estimatedTokens}) exceeds limit (${DESCRIPTION_MAX_TOKENS})`,
    );
  }

  // priority — optional number
  const priority = body["priority"];
  if (priority !== undefined && (typeof priority !== "number" || !Number.isFinite(priority))) {
    throw SidjuaError.from("EXEC-003", "priority must be a finite number");
  }

  // division — optional, validated format
  const division = body["division"];
  if (division !== undefined) {
    if (typeof division !== "string") {
      throw SidjuaError.from("EXEC-003", "division must be a string");
    }
    if (!DIVISION_REGEX.test(division)) {
      throw SidjuaError.from(
        "INPUT-001",
        `Invalid division format: "${division}". Must start with a letter, ` +
        "contain only alphanumeric/underscore/hyphen, and be at most 64 chars",
      );
    }
  }

  // budget_usd — optional non-negative number
  const budget_usd = body["budget_usd"];
  if (budget_usd !== undefined && (typeof budget_usd !== "number" || budget_usd < 0)) {
    throw SidjuaError.from("EXEC-003", "budget_usd must be a non-negative number");
  }

  // budget_tokens — optional non-negative number
  const budget_tokens = body["budget_tokens"];
  if (budget_tokens !== undefined && (typeof budget_tokens !== "number" || budget_tokens < 0)) {
    throw SidjuaError.from("EXEC-003", "budget_tokens must be a non-negative number");
  }

  // timeout_seconds — optional non-negative number
  const timeout_seconds = body["timeout_seconds"];
  if (timeout_seconds !== undefined && (typeof timeout_seconds !== "number" || timeout_seconds < 0)) {
    throw SidjuaError.from("EXEC-003", "timeout_seconds must be a non-negative number");
  }

  return {
    description:     description.trim(),
    ...(priority       !== undefined && { priority:       priority as number }),
    ...(division       !== undefined && { division:       division as string }),
    ...(budget_usd     !== undefined && { budget_usd:     budget_usd as number }),
    ...(budget_tokens  !== undefined && { budget_tokens:  budget_tokens as number }),
    ...(timeout_seconds !== undefined && { timeout_seconds: timeout_seconds as number }),
  };
}

const logger = createLogger("api-execution");

/** Extract CallerContext set by auth middleware. Works around Hono's generic Variable typing. */
function getCallerCtx(c: import("hono").Context): CallerContext | undefined {
  return c.get(CALLER_CONTEXT_KEY) as CallerContext | undefined;
}


export interface ExecutionRouteServices {
  db:        InstanceType<typeof Database>;
  /** Optional shared event bus — allows messaging gateway to subscribe to task events. */
  eventBus?: TaskEventBus;
}


export function registerExecutionRoutes(app: Hono, services: ExecutionRouteServices): void {
  const eventBus = services.eventBus ?? new TaskEventBus(services.db);
  const bridge   = new ExecutionBridge(services.db, eventBus);
  const store    = new TaskStore(services.db);

  // ---- POST /api/v1/tasks/run --------------------------------------------

  app.post("/api/v1/tasks/run", requireScope("operator"), async (c) => {
    const rawBody = await c.req.json() as Record<string, unknown>;

    // Strict schema validation — rejects unknown keys + validates formats
    const validated = validateTaskRunBody(rawBody);

    logger.info("task_run_requested", `POST /api/v1/tasks/run`, {
      metadata: {
        description: validated.description.slice(0, 60),
        division:    validated.division,
        budget_usd:  validated.budget_usd,
      },
    });

    const callerCtx = getCallerCtx(c);
    const handle = await bridge.submitTask({
      description:    validated.description,
      priority:       validated.priority ?? 5,
      ...(validated.division        !== undefined && { division:      validated.division }),
      ...(validated.budget_usd      !== undefined && { budget_usd:    validated.budget_usd }),
      ...(validated.budget_tokens   !== undefined && { budget_tokens: validated.budget_tokens }),
      ...(validated.timeout_seconds !== undefined && { ttl_seconds:   validated.timeout_seconds }),
      ...(callerCtx?.division !== undefined && { callerDivision: callerCtx.division }),
      ...(callerCtx?.role     !== undefined && { callerRole:     callerCtx.role }),
    });

    return c.json(handle, 201);
  });

  // ---- GET /api/v1/tasks/:id/status -------------------------------------

  app.get("/api/v1/tasks/:id/status", requireScope("readonly"), async (c) => {
    const { id } = c.req.param();

    logger.debug("task_status_requested", `GET /api/v1/tasks/${id}/status`);

    const status = await bridge.getTaskStatus(id);
    return c.json(status);
  });

  // ---- GET /api/v1/tasks/:id/result ------------------------------------

  app.get("/api/v1/tasks/:id/result", requireScope("readonly"), (c) => {
    const { id } = c.req.param();

    const task = store.get(id);
    if (task === null) {
      throw SidjuaError.from("EXEC-004", `Task not found: ${id}`);
    }

    const TERMINAL = new Set(["DONE", "FAILED", "ESCALATED", "CANCELLED"]);

    if (!TERMINAL.has(task.status)) {
      return c.json({
        task_id: id,
        status:  task.status,
        message: "Task is still running — check back when status is DONE",
      });
    }

    const allTasks    = store.getByRoot(id);
    const totalTokens = allTasks.reduce((s, t) => s + t.token_used, 0);
    const totalCost   = allTasks.reduce((s, t) => s + t.cost_used,  0);

    return c.json({
      task_id:        id,
      status:         task.status,
      result_summary: task.result_summary,
      result_file:    task.result_file,
      confidence:     task.confidence,
      total_tokens:   totalTokens,
      total_cost_usd: totalCost,
      completed_at:   task.completed_at,
    });
  });

  // ---- GET /api/v1/tasks/:id/tree -------------------------------------

  app.get("/api/v1/tasks/:id/tree", requireScope("readonly"), async (c) => {
    const { id } = c.req.param();

    logger.debug("task_tree_requested", `GET /api/v1/tasks/${id}/tree`);

    const tree = await bridge.getTaskTree(id);
    return c.json(tree);
  });

  // ---- POST /api/v1/tasks/:id/cancel ----------------------------------

  app.post("/api/v1/tasks/:id/cancel", requireScope("operator"), async (c) => {
    const { id } = c.req.param();

    // Pre-flight: check for already-terminal state without division check
    const task = store.get(id);
    if (task === null) {
      throw SidjuaError.from("EXEC-004", `Task not found: ${id}`);
    }

    const TERMINAL = new Set(["DONE", "FAILED", "ESCALATED", "CANCELLED"]);
    if (TERMINAL.has(task.status)) {
      return c.json({
        cancelled: false,
        message:   `Task is already in terminal state: ${task.status}`,
      });
    }

    // Route through ExecutionBridge — enforces division isolation
    const callerCtx = getCallerCtx(c);
    const { cancelled } = await bridge.cancelTask(id, {
      division: callerCtx?.division,
      role:     callerCtx?.role,
    });

    return c.json({ cancelled: true, tasks_cancelled: cancelled });
  });
}
