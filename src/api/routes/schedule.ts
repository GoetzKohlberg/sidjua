// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V1.1: Schedule REST API routes
 *
 * GET    /api/v1/schedules              — list (query: agent_id, division)
 * GET    /api/v1/schedules/:id          — get single
 * POST   /api/v1/schedules              — create
 * PATCH  /api/v1/schedules/:id          — update
 * DELETE /api/v1/schedules/:id          — delete
 * POST   /api/v1/schedules/:id/enable   — enable
 * POST   /api/v1/schedules/:id/disable  — disable
 * GET    /api/v1/schedules/:id/history  — execution history (query: limit)
 */

import { Hono } from "hono";
import type { ScheduleDefinition, ScheduleCreateInput } from "../../scheduler/types.js";
import type { Task } from "../../tasks/types.js";
import { requireScope } from "../middleware/require-scope.js";


export interface CronSchedulerLike {
  listSchedules(agentId?: string): ScheduleDefinition[];
  getSchedule(id: string): ScheduleDefinition | null;
  createSchedule(input: ScheduleCreateInput): ScheduleDefinition;
  updateSchedule(id: string, updates: Partial<ScheduleDefinition>): void;
  deleteSchedule(id: string): void;
  enableSchedule(id: string): void;
  disableSchedule(id: string): void;
}

export interface TaskStoreLike {
  getByScheduleId(scheduleId: string): Task[];
}

export interface ScheduleRouteServices {
  scheduler?: CronSchedulerLike | null;
  taskStore?: TaskStoreLike | null;
}


const NOT_CONFIGURED = {
  error: { code: "SCH-503", message: "Scheduler not configured", recoverable: true },
} as const;


export function registerScheduleRoutes(app: Hono, services: ScheduleRouteServices = {}): void {
  const { scheduler = null, taskStore = null } = services;

  // GET /api/v1/schedules
  app.get("/api/v1/schedules", requireScope("readonly"), (c) => {
    if (scheduler === null) return c.json(NOT_CONFIGURED, 503);
    const agentId  = c.req.query("agent_id");
    const division = c.req.query("division");
    let schedules  = scheduler.listSchedules(agentId);
    if (division !== undefined) {
      schedules = schedules.filter((s) => s.division === division);
    }
    return c.json({ schedules });
  });

  // GET /api/v1/schedules/:id
  app.get("/api/v1/schedules/:id", requireScope("readonly"), (c) => {
    if (scheduler === null) return c.json(NOT_CONFIGURED, 503);
    const id    = c.req.param("id");
    const sched = scheduler.getSchedule(id);
    if (sched === null) {
      return c.json({ error: { code: "SCH-404", message: `Schedule '${id}' not found` } }, 404);
    }
    return c.json({ schedule: sched });
  });

  // POST /api/v1/schedules
  app.post("/api/v1/schedules", requireScope("operator"), async (c) => {
    if (scheduler === null) return c.json(NOT_CONFIGURED, 503);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch (_err) {
      return c.json({ error: { code: "SCH-400", message: "Invalid JSON body" } }, 400);
    }

    // Validate required fields
    const { agent_id, division, cron_expression, task_template } = body;
    if (typeof agent_id      !== "string" || agent_id.trim()      === "") {
      return c.json({ error: { code: "SCH-400", message: "agent_id is required" } }, 400);
    }
    if (typeof division      !== "string" || division.trim()      === "") {
      return c.json({ error: { code: "SCH-400", message: "division is required" } }, 400);
    }
    if (typeof cron_expression !== "string" || cron_expression.trim() === "") {
      return c.json({ error: { code: "SCH-400", message: "cron_expression is required" } }, 400);
    }
    if (typeof task_template !== "object" || task_template === null) {
      return c.json({ error: { code: "SCH-400", message: "task_template is required" } }, 400);
    }
    const tmpl = task_template as Record<string, unknown>;
    if (typeof tmpl["description"] !== "string" || (tmpl["description"] as string).trim() === "") {
      return c.json({ error: { code: "SCH-400", message: "task_template.description is required" } }, 400);
    }

    const taskTemplate: ScheduleCreateInput["task_template"] = {
      description: (tmpl["description"] as string).trim(),
      priority:    typeof tmpl["priority"] === "number" ? (tmpl["priority"] as number) : 5,
    };
    if (typeof tmpl["budget_tokens"] === "number") taskTemplate.budget_tokens = tmpl["budget_tokens"] as number;
    if (typeof tmpl["budget_usd"]    === "number") taskTemplate.budget_usd    = tmpl["budget_usd"] as number;
    if (typeof tmpl["ttl_seconds"]   === "number") taskTemplate.ttl_seconds   = tmpl["ttl_seconds"] as number;

    const input: ScheduleCreateInput = {
      agent_id:        agent_id.trim(),
      division:        division.trim(),
      cron_expression: cron_expression.trim(),
      task_template:   taskTemplate,
      ...(typeof body["enabled"]    === "boolean" ? { enabled:    body["enabled"] as boolean } : {}),
      ...(typeof body["governance"] === "object" && body["governance"] !== null
        ? { governance: body["governance"] as Partial<ScheduleDefinition["governance"]> }
        : {}),
    };

    try {
      const created = scheduler.createSchedule(input);
      return c.json({ schedule: created }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: "SCH-422", message: msg } }, 422);
    }
  });

  // PATCH /api/v1/schedules/:id
  app.patch("/api/v1/schedules/:id", requireScope("operator"), async (c) => {
    if (scheduler === null) return c.json(NOT_CONFIGURED, 503);
    const id = c.req.param("id");
    if (scheduler.getSchedule(id) === null) {
      return c.json({ error: { code: "SCH-404", message: `Schedule '${id}' not found` } }, 404);
    }
    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch (_err) {
      return c.json({ error: { code: "SCH-400", message: "Invalid JSON body" } }, 400);
    }

    // Whitelist: only these top-level fields may be patched
    const ALLOWED_PATCH_FIELDS = new Set([
      "cron_expression",
      "enabled",
      "task_template",
      "governance",
    ]);
    const patch: Partial<ScheduleDefinition> = {};
    for (const key of Object.keys(body)) {
      if (ALLOWED_PATCH_FIELDS.has(key)) {
        (patch as Record<string, unknown>)[key] = body[key];
      }
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: { code: "SCH-400", message: "No patchable fields provided. Allowed: cron_expression, enabled, task_template, governance" } }, 400);
    }

    try {
      scheduler.updateSchedule(id, patch);
      const updated = scheduler.getSchedule(id);
      return c.json({ schedule: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: "SCH-422", message: msg } }, 422);
    }
  });

  // DELETE /api/v1/schedules/:id
  app.delete("/api/v1/schedules/:id", requireScope("operator"), (c) => {
    if (scheduler === null) return c.json(NOT_CONFIGURED, 503);
    const id = c.req.param("id");
    if (scheduler.getSchedule(id) === null) {
      return c.json({ error: { code: "SCH-404", message: `Schedule '${id}' not found` } }, 404);
    }
    scheduler.deleteSchedule(id);
    return c.json({ deleted: true, id });
  });

  // POST /api/v1/schedules/:id/enable
  app.post("/api/v1/schedules/:id/enable", requireScope("operator"), (c) => {
    if (scheduler === null) return c.json(NOT_CONFIGURED, 503);
    const id = c.req.param("id");
    try {
      scheduler.enableSchedule(id);
      const updated = scheduler.getSchedule(id);
      return c.json({ enabled: true, schedule: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return c.json({ error: { code: "SCH-404", message: msg } }, 404);
      }
      return c.json({ error: { code: "SCH-500", message: msg } }, 500);
    }
  });

  // POST /api/v1/schedules/:id/disable
  app.post("/api/v1/schedules/:id/disable", requireScope("operator"), (c) => {
    if (scheduler === null) return c.json(NOT_CONFIGURED, 503);
    const id = c.req.param("id");
    scheduler.disableSchedule(id);
    const updated = scheduler.getSchedule(id);
    return c.json({ enabled: false, schedule: updated });
  });

  // GET /api/v1/schedules/:id/history
  app.get("/api/v1/schedules/:id/history", requireScope("readonly"), (c) => {
    if (taskStore === null) return c.json(NOT_CONFIGURED, 503);
    const id    = c.req.param("id");
    const limit = parseInt(c.req.query("limit") ?? "10", 10);
    const tasks = taskStore.getByScheduleId(id).slice(0, isNaN(limit) || limit < 1 ? 10 : limit);
    return c.json({ tasks, schedule_id: id });
  });
}
