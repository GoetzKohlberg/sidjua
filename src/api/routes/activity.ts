// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: REST API Routes
 *
 * GET  /api/v1/activity/stream             — Paginated event query
 * GET  /api/v1/activity/timeline           — Bucketed counts for charts
 * GET  /api/v1/activity/stats              — Today's quick summary
 * GET  /api/v1/activity/digest/daily       — Daily digest (generates on demand)
 * GET  /api/v1/activity/digest/weekly      — Weekly digest (generates on demand)
 * GET  /api/v1/activity/digest/agent/:id   — Agent drilldown
 * GET  /api/v1/activity/digest/division/:id — Division drilldown
 * POST /api/v1/activity/webhook            — Ingest external events
 */

import type { Hono }           from "hono";
import { requireScope }        from "../middleware/require-scope.js";
import { activityEmitter }     from "../../core/activity/activity-emitter.js";
import { digestEngine }        from "../../core/activity/digest-engine.js";
import type { ActivityFilters } from "../../core/activity/activity-types.js";
import { createLogger }        from "../../core/logger.js";

const logger = createLogger("activity-routes");


export interface ActivityRouteServices {
  db?: unknown; // present for interface consistency with other routes
}


/** Helpers */
function yesterdayStr(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0] ?? "";
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0] ?? "";
}

function lastMondayStr(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().split("T")[0] ?? "";
}

function safeInt(val: string | undefined, fallback: number): number {
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}


export function registerActivityRoutes(app: Hono, _services: ActivityRouteServices = {}): void {

  // ── GET /api/v1/activity/stream ─────────────────────────────────────────
  app.get("/api/v1/activity/stream", requireScope("readonly"), (c) => {
    try {
      const limit  = Math.min(safeInt(c.req.query("limit"),  100), 1000);
      const offset = Math.max(safeInt(c.req.query("offset"), 0),   0);

      const filters: ActivityFilters = {
        since:      c.req.query("since")      || undefined,
        until:      c.req.query("until")      || undefined,
        category:   c.req.query("category")   as ActivityFilters["category"]   || undefined,
        agent_id:   c.req.query("agent_id")   || undefined,
        division:   c.req.query("division")   || undefined,
        severity:   c.req.query("severity")   as ActivityFilters["severity"]   || undefined,
        source:     c.req.query("source")     as ActivityFilters["source"]     || undefined,
        event_type: c.req.query("event_type") || undefined,
        session_id: c.req.query("session_id") || undefined,
        limit,
        offset,
      };

      const events = activityEmitter.query(filters);
      const total  = activityEmitter.count({ ...filters, limit: undefined, offset: undefined });
      return c.json({ events, total, limit, offset });
    } catch (err: unknown) {
      logger.warn("stream_query_failed", "Activity stream query failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── GET /api/v1/activity/timeline ───────────────────────────────────────
  app.get("/api/v1/activity/timeline", requireScope("readonly"), (c) => {
    try {
      const granularity = c.req.query("granularity") ?? "hour";
      if (!["hour", "day", "week"].includes(granularity)) {
        return c.json({ error: "granularity must be hour|day|week" }, 400);
      }
      const timeline = activityEmitter.getTimeline({
        since:       c.req.query("since")    || undefined,
        until:       c.req.query("until")    || undefined,
        division:    c.req.query("division") || undefined,
        agent_id:    c.req.query("agent_id") || undefined,
        granularity: granularity as "hour" | "day" | "week",
      });
      return c.json({ timeline });
    } catch (err: unknown) {
      logger.warn("timeline_query_failed", "Timeline query failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── GET /api/v1/activity/stats ──────────────────────────────────────────
  app.get("/api/v1/activity/stats", requireScope("readonly"), (c) => {
    try {
      const since  = c.req.query("since") || todayStr() + "T00:00:00.000Z";
      const total  = activityEmitter.count({ since });
      const events = activityEmitter.query({ since, limit: 10_000 });

      const byCategory: Record<string, number> = {};
      const bySeverity: Record<string, number> = {};
      for (const e of events) {
        byCategory[e.category]          = (byCategory[e.category]          || 0) + 1;
        bySeverity[e.severity ?? "info"] = (bySeverity[e.severity ?? "info"] || 0) + 1;
      }

      return c.json({ total, since, by_category: byCategory, by_severity: bySeverity });
    } catch (err: unknown) {
      logger.warn("stats_query_failed", "Stats query failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── GET /api/v1/activity/digest/daily ───────────────────────────────────
  app.get("/api/v1/activity/digest/daily", requireScope("readonly"), (c) => {
    try {
      const date     = c.req.query("date")     || yesterdayStr();
      const division = c.req.query("division") || undefined;
      const digest   = digestEngine.generateDaily(date, division);
      return c.json(digest);
    } catch (err: unknown) {
      logger.warn("daily_digest_failed", "Daily digest generation failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── GET /api/v1/activity/digest/weekly ──────────────────────────────────
  app.get("/api/v1/activity/digest/weekly", requireScope("readonly"), (c) => {
    try {
      const weekStart = c.req.query("week_start") || lastMondayStr();
      const division  = c.req.query("division")   || undefined;
      const digest    = digestEngine.generateWeekly(weekStart, division);
      return c.json(digest);
    } catch (err: unknown) {
      logger.warn("weekly_digest_failed", "Weekly digest generation failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── GET /api/v1/activity/digest/agent/:agentId ──────────────────────────
  app.get("/api/v1/activity/digest/agent/:agentId", requireScope("readonly"), (c) => {
    try {
      const agentId = c.req.param("agentId");
      const since   = c.req.query("since") || yesterdayStr() + "T00:00:00.000Z";
      const until   = c.req.query("until") || new Date().toISOString();
      const digest  = digestEngine.generateAgentDrilldown(agentId, since, until);
      return c.json(digest);
    } catch (err: unknown) {
      logger.warn("agent_digest_failed", "Agent digest failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── GET /api/v1/activity/digest/division/:divisionId ────────────────────
  app.get("/api/v1/activity/digest/division/:divisionId", requireScope("readonly"), (c) => {
    try {
      const divisionId = c.req.param("divisionId");
      const since      = c.req.query("since") || yesterdayStr() + "T00:00:00.000Z";
      const until      = c.req.query("until") || new Date().toISOString();
      const digest     = digestEngine.generateDivisionDrilldown(divisionId, since, until);
      return c.json(digest);
    } catch (err: unknown) {
      logger.warn("division_digest_failed", "Division digest failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── POST /api/v1/activity/webhook ───────────────────────────────────────
  // Ingests external events (CI pipelines, git hooks, monitoring systems).
  // Protected by operator scope — callers must present a valid API token.
  app.post("/api/v1/activity/webhook", requireScope("operator"), async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const eventType = body["event_type"];
      const title     = body["title"];

      if (typeof eventType !== "string" || eventType.length === 0) {
        return c.json({ error: "event_type is required" }, 400);
      }
      if (typeof title !== "string" || title.length === 0) {
        return c.json({ error: "title is required" }, 400);
      }

      const id = activityEmitter.emit({
        event_type: eventType,
        category:   (body["category"] as ActivityFilters["category"]) ?? "external",
        title,
        division:   typeof body["division"] === "string" ? body["division"] : undefined,
        agent_id:   typeof body["agent_id"] === "string" ? body["agent_id"] : undefined,
        details:    typeof body["details"]  === "object" && body["details"] !== null
          ? body["details"] as Record<string, unknown>
          : undefined,
        source:     "webhook",
      });

      return c.json({ id }, 201);
    } catch (err: unknown) {
      logger.warn("webhook_ingest_failed", "Webhook ingest failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ error: "Internal server error" }, 500);
    }
  });
}
