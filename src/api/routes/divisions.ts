// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11b: Division REST Endpoints
 *
 * GET    /api/v1/divisions           — list all divisions with summary
 * GET    /api/v1/divisions/:name     — division detail
 */

import Database from "better-sqlite3";
import { Hono } from "hono";
import { createLogger } from "../../core/logger.js";
import { hasTable } from "../../core/db/helpers.js";
import { notFound } from "../utils/responses.js";
import { requireScope } from "../middleware/require-scope.js";
import { PROTECTED_DIVISION_CODES } from "../../apply/database.js";

const logger = createLogger("api-divisions");


export interface DivisionRouteServices {
  db: InstanceType<typeof Database>;
}


export function registerDivisionRoutes(app: Hono, services: DivisionRouteServices): void {
  const { db } = services;

  // ---- GET /api/v1/divisions ---------------------------------------------

  app.get("/api/v1/divisions", requireScope("readonly"), (c) => {
    if (!hasTable(db, "divisions")) {
      logger.info("divisions_table_missing", "divisions table not yet created — run sidjua apply first", {});
      return c.json({ divisions: [] });
    }
    const rows = db.prepare("SELECT * FROM divisions ORDER BY code").all() as Record<string, unknown>[];
    const enriched = rows.map((row) => {
      const code = row["code"] as string | undefined;
      if (code && PROTECTED_DIVISION_CODES.has(code)) {
        return {
          ...row,
          name_key:        `gui.divisions.system_seed.${code}.name`,
          description_key: `gui.divisions.system_seed.${code}.description`,
        };
      }
      return row;
    });
    return c.json({ divisions: enriched });
  });

  // ---- GET /api/v1/divisions/:name ---------------------------------------

  app.get("/api/v1/divisions/:name", requireScope("readonly"), (c) => {
    const name = c.req.param("name");
    if (!hasTable(db, "divisions")) {
      return notFound(c, `Division ${name} not found`);
    }
    const row = db
      .prepare("SELECT * FROM divisions WHERE code = ?")
      .get(name) as Record<string, unknown> | undefined;

    if (row === undefined) {
      return notFound(c, `Division ${name} not found`);
    }
    const code = row["code"] as string | undefined;
    const enrichedRow = (code && PROTECTED_DIVISION_CODES.has(code))
      ? {
          ...row,
          name_key:        `gui.divisions.system_seed.${code}.name`,
          description_key: `gui.divisions.system_seed.${code}.description`,
        }
      : row;
    return c.json({ division: enrichedRow });
  });
}
