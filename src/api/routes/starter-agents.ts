// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Starter agent and starter division REST endpoints.
 *
 * GET /api/v1/starter-agents          — list all 6 starter agent definitions
 * GET /api/v1/starter-agents/:id      — single starter agent detail
 * GET /api/v1/starter-divisions       — list starter divisions
 * GET /api/v1/starter-divisions/:id   — single starter division
 */

import { Hono }              from "hono";
import { SidjuaError }       from "../../core/error-codes.js";
import { getStarterAgents, loadDefaultDivisions } from "../../defaults/index.js";

export function registerStarterAgentRoutes(app: Hono): void {

  // Cache on first request — data is static for the process lifetime
  let _agents: ReturnType<typeof getStarterAgents> | undefined;
  let _divisions: ReturnType<typeof loadDefaultDivisions> | undefined;

  function agents() {
    if (!_agents) _agents = getStarterAgents();
    return _agents;
  }

  function divisions() {
    if (!_divisions) _divisions = loadDefaultDivisions();
    return _divisions;
  }

  // ── GET /api/v1/starter-agents ──────────────────────────────────────────
  // SCOPE: public (read-only agent catalog, no secrets)
  app.get("/api/v1/starter-agents", (c) => {
    return c.json({ agents: agents() });
  });

  // ── GET /api/v1/starter-agents/:id ─────────────────────────────────────
  // SCOPE: public (read-only agent catalog, no secrets)
  app.get("/api/v1/starter-agents/:id", (c) => {
    const id    = c.req.param("id");
    const agent = agents().find((a) => a.id === id);
    if (!agent) {
      throw SidjuaError.from("AGT-001", `Starter agent "${id}" not found`);
    }
    return c.json({ agent });
  });

  // ── GET /api/v1/starter-divisions ──────────────────────────────────────
  // SCOPE: public (read-only agent catalog, no secrets)
  app.get("/api/v1/starter-divisions", (c) => {
    const divs = divisions().map((d) => ({
      id:              d.id,
      name:            d.name,
      name_key:        d.name_key,
      description_key: d.description_key,
      protected:       d.protected,
      description:     d.description,
      agent_count:     d.agents.length,
      agents:          d.agents,
      budget:          d.budget,
    }));
    return c.json({ divisions: divs });
  });

  // ── GET /api/v1/starter-divisions/:id ──────────────────────────────────
  // SCOPE: public (read-only agent catalog, no secrets)
  app.get("/api/v1/starter-divisions/:id", (c) => {
    const id  = c.req.param("id");
    const div = divisions().find((d) => d.id === id);
    if (!div) {
      throw SidjuaError.from("AGT-001", `Starter division "${id}" not found`);
    }
    return c.json({
      division: {
        id:              div.id,
        name:            div.name,
        name_key:        div.name_key,
        description_key: div.description_key,
        protected:       div.protected,
        description:     div.description,
        agent_count:     div.agents.length,
        agents:          div.agents,
        budget:          div.budget,
      },
    });
  });
}
