// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Org Chart REST routes — P345 + P359
 *
 *   GET /api/v1/org/tree                  — full org-chart tree
 *   GET /api/v1/org/agent/:id             — single agent detail
 *   GET /api/v1/org/division/:code        — single division detail
 *   GET /api/v1/org/status                — agent health + task status map
 *   GET /api/v1/org/agent/:id/tasks       — recent task history for one agent
 */

import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { requireScope } from "../middleware/require-scope.js";
import { OrgChartStore } from "../../org-chart/org-chart-store.js";
import type { HeartbeatMonitor } from "../../agents/heartbeat.js";

// ---------------------------------------------------------------------------
// Public response types
// ---------------------------------------------------------------------------

export interface AgentStatus {
  agent_id:          string;
  health:            'healthy' | 'unhealthy' | 'unknown';
  last_heartbeat:    string | null;
  recent_task_count: number;
  is_busy:           boolean;
}

export interface AgentStatusResponse {
  agents:      Record<string, AgentStatus>;
  server_time: string;
}

export interface TaskHistoryEntry {
  id:         string;
  event_type: string;
  title:      string;
  timestamp:  string;
  details:    Record<string, unknown>;
}

export interface AgentTaskHistoryResponse {
  agent_id: string;
  tasks:    TaskHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface OrgChartRouteServices {
  db:         InstanceType<typeof Database>;
  heartbeat?: HeartbeatMonitor | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ActivityRow {
  id:         string;
  event_type: string;
  title:      string;
  timestamp:  string;
  details:    string;
}

function hasActivityTable(db: InstanceType<typeof Database>): boolean {
  const row = db.prepare<[], { name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='activity_events'",
  ).get() as { name: string } | undefined;
  return row !== undefined;
}

function getRecentTaskCount(db: InstanceType<typeof Database>, agentId: string): number {
  if (!hasActivityTable(db)) return 0;
  const row = db.prepare<[string], { cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM activity_events
     WHERE category = 'task' AND agent_id = ?
       AND timestamp >= datetime('now', '-1 hour')`,
  ).get(agentId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function getIsBusy(db: InstanceType<typeof Database>, agentId: string): boolean {
  if (!hasActivityTable(db)) return false;
  const row = db.prepare<[string], { event_type: string }>(
    `SELECT event_type FROM activity_events
     WHERE category = 'task' AND agent_id = ?
     ORDER BY rowid DESC
     LIMIT 1`,
  ).get(agentId) as { event_type: string } | undefined;
  if (!row) return false;
  const et = row.event_type;
  return et === 'task.started' || et === 'task.start';
}

function buildAgentStatus(
  db:        InstanceType<typeof Database>,
  agentId:   string,
  heartbeat: HeartbeatMonitor | null | undefined,
): AgentStatus {
  let health: 'healthy' | 'unhealthy' | 'unknown' = 'unknown';
  let last_heartbeat: string | null = null;

  if (heartbeat != null) {
    const registered = heartbeat.getRegisteredAgents().includes(agentId);
    if (registered) {
      health         = heartbeat.isHealthy(agentId) ? 'healthy' : 'unhealthy';
      last_heartbeat = heartbeat.getLastHeartbeatTime(agentId);
    }
  }

  const recent_task_count = getRecentTaskCount(db, agentId);
  const is_busy           = getIsBusy(db, agentId);

  return { agent_id: agentId, health, last_heartbeat, recent_task_count, is_busy };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerOrgChartRoutes(
  app: Hono,
  { db, heartbeat }: OrgChartRouteServices,
): void {
  const store = new OrgChartStore(db);

  // GET /api/v1/org/tree
  app.get("/api/v1/org/tree", requireScope("readonly"), (c) => {
    const tree = store.getTree();
    return c.json(tree);
  });

  // GET /api/v1/org/status — registered before /agent/:id to avoid param capture
  app.get("/api/v1/org/status", requireScope("readonly"), (c) => {
    const agentIds   = store.getAllAgentIds();
    const monitorIds = heartbeat != null ? heartbeat.getRegisteredAgents() : [];
    const allIds     = [...new Set([...agentIds, ...monitorIds])];

    const agents: Record<string, AgentStatus> = {};
    for (const id of allIds) {
      agents[id] = buildAgentStatus(db, id, heartbeat);
    }

    const resp: AgentStatusResponse = { agents, server_time: new Date().toISOString() };
    return c.json(resp);
  });

  // GET /api/v1/org/agent/:id/tasks — registered before /:id to avoid shadowing
  app.get("/api/v1/org/agent/:id/tasks", requireScope("readonly"), (c) => {
    const id     = c.req.param("id");
    const detail = store.getAgentDetail(id);
    if (detail === null) {
      return c.json({ error: { code: "ORG-001", message: "Agent not found" } }, 404);
    }

    const rawLimit = c.req.query("limit");
    const since    = c.req.query("since");

    let limit = 10;
    if (rawLimit !== undefined) {
      const parsed = parseInt(rawLimit, 10);
      if (!isNaN(parsed) && parsed > 0) limit = Math.min(parsed, 50);
    }

    if (!hasActivityTable(db)) {
      const resp: AgentTaskHistoryResponse = { agent_id: id, tasks: [] };
      return c.json(resp);
    }

    let rows: ActivityRow[];
    if (since !== undefined) {
      rows = db.prepare<[string, string, number], ActivityRow>(
        `SELECT id, event_type, title, timestamp, details
         FROM activity_events
         WHERE category = 'task' AND agent_id = ? AND timestamp >= ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      ).all(id, since, limit) as ActivityRow[];
    } else {
      rows = db.prepare<[string, number], ActivityRow>(
        `SELECT id, event_type, title, timestamp, details
         FROM activity_events
         WHERE category = 'task' AND agent_id = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      ).all(id, limit) as ActivityRow[];
    }

    const tasks: TaskHistoryEntry[] = rows.map((r) => {
      let details: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(r.details);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          details = parsed as Record<string, unknown>;
        }
      } catch (_err) {
        // leave details as empty object
      }
      return { id: r.id, event_type: r.event_type, title: r.title, timestamp: r.timestamp, details };
    });

    const resp: AgentTaskHistoryResponse = { agent_id: id, tasks };
    return c.json(resp);
  });

  // GET /api/v1/org/agent/:id
  app.get("/api/v1/org/agent/:id", requireScope("readonly"), (c) => {
    const id     = c.req.param("id");
    const detail = store.getAgentDetail(id);
    if (detail === null) {
      return c.json({ error: { code: "ORG-001", message: "Agent not found" } }, 404);
    }
    return c.json(detail);
  });

  // GET /api/v1/org/division/:code
  app.get("/api/v1/org/division/:code", requireScope("readonly"), (c) => {
    const code   = c.req.param("code");
    const detail = store.getDivisionDetail(code);
    if (detail === null) {
      return c.json({ error: { code: "ORG-002", message: "Division not found" } }, 404);
    }
    return c.json(detail);
  });
}
