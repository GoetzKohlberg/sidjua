// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Org Chart REST routes — P345
 *
 *   GET /api/v1/org/tree           — full org-chart tree
 *   GET /api/v1/org/agent/:id      — single agent detail
 *   GET /api/v1/org/division/:code — single division detail
 */

import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { requireScope } from "../middleware/require-scope.js";
import { OrgChartStore } from "../../org-chart/org-chart-store.js";

export interface OrgChartRouteServices {
  db: InstanceType<typeof Database>;
}

export function registerOrgChartRoutes(
  app: Hono,
  { db }: OrgChartRouteServices,
): void {
  const store = new OrgChartStore(db);

  // GET /api/v1/org/tree
  app.get("/api/v1/org/tree", requireScope("readonly"), (c) => {
    const tree = store.getTree();
    return c.json(tree);
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
