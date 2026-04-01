// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * OrgChartSeeder — applies default C-Suite role titles and hierarchy.
 *
 * Reads org-chart-default.json (shipped alongside the compiled code) and
 * updates agents that still have role_title = NULL, mapping them to their
 * C-level position.  All operations are idempotent — safe to call on every
 * `sidjua apply`.
 *
 * Schema columns used (all added by P345 V3 migration):
 *   agents.role_title   TEXT — C-level or position title
 *   agents.reports_to   TEXT — FK to agents.id (org parent)
 *   agents.org_level    INTEGER — 0=CEO, 1=C-Suite, 2=managers, 3=workers
 *   divisions.parent_division_code TEXT
 *   divisions.budget_allocation    REAL
 */

import { readFileSync, existsSync } from "node:fs";
import { join }                     from "node:path";
import { fileURLToPath }            from "node:url";
import type Database                from "better-sqlite3";
import { createLogger }             from "../core/logger.js";

const logger = createLogger("org-chart-seeder");

// ---------------------------------------------------------------------------
// JSON types
// ---------------------------------------------------------------------------

interface OrgChartAgentSeed {
  match:            { division: string; fallback_name: string };
  role_title:       string;
  reports_to_root?: boolean;
  org_level:        number;
}

interface OrgChartDivisionSeed {
  code:                 string;
  parent_division_code: string | null;
  budget_allocation:    number;
}

interface OrgChartDefault {
  version:             string;
  agents:              OrgChartAgentSeed[];
  divisions_hierarchy: OrgChartDivisionSeed[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDefaultPath(overrideDir?: string): string {
  if (overrideDir) {
    return join(overrideDir, "org-chart-default.json");
  }
  // Resolves relative to compiled file: dist/org-chart/ → dist/defaults/
  const selfDir = fileURLToPath(new URL(".", import.meta.url));
  return join(selfDir, "..", "defaults", "org-chart-default.json");
}

function loadConfig(seedPath: string): OrgChartDefault | null {
  if (!existsSync(seedPath)) {
    logger.warn("org-chart-seeder", "org-chart-default.json not found, skipping seed", { metadata: { seedPath } });
    return null;
  }
  try {
    const raw = readFileSync(seedPath, "utf-8");
    return JSON.parse(raw) as OrgChartDefault;
  } catch (err) {
    logger.error("org-chart-seeder", "Failed to parse org-chart-default.json", { metadata: { error: String(err) } });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Seeds C-Suite role titles and hierarchy for the 6 core agents.
 *
 * Matches agents by division_code first; falls back to LIKE name match.
 * Only updates agents with role_title IS NULL — preserves user customisations.
 *
 * @param db          Open better-sqlite3 database handle.
 * @param defaultsDir Optional override for the directory containing
 *                    org-chart-default.json (used in tests).
 * @returns Number of agents updated.
 */
export function seedOrgChart(
  db:           InstanceType<typeof Database>,
  defaultsDir?: string,
): number {
  const seedPath = resolveDefaultPath(defaultsDir);
  const config   = loadConfig(seedPath);
  if (!config) return 0;

  if (!Array.isArray(config.agents)) {
    logger.warn("org-chart-seeder", "No agents array in org chart defaults");
    return 0;
  }

  // Prepare statements — uses P345 actual column names (role_title, reports_to, org_level)
  const byDivision = db.prepare<[string, number, string], void>(`
    UPDATE agents
    SET    role_title = ?,  org_level = ?
    WHERE  division_code = ?
      AND  role_title IS NULL
      AND  active = 1
  `);

  const byName = db.prepare<[string, number, string], void>(`
    UPDATE agents
    SET    role_title = ?,  org_level = ?
    WHERE  name LIKE ?
      AND  role_title IS NULL
      AND  active = 1
  `);

  let updated = 0;

  const seedTx = db.transaction(() => {
    for (const seed of config.agents) {
      // Try division_code match first
      let res = byDivision.run(seed.role_title, seed.org_level, seed.match.division);

      if (res.changes === 0) {
        // Fallback: LIKE match on agent name
        res = byName.run(seed.role_title, seed.org_level, `%${seed.match.fallback_name}%`);
      }

      updated += res.changes;
      if (res.changes > 0) {
        logger.info("org-chart-seeder", `Assigned '${seed.role_title}' to ${seed.match.division} agent`);
      }
    }

    // Seed division hierarchy
    if (Array.isArray(config.divisions_hierarchy)) {
      const updateDiv = db.prepare<[string | null, number, string], void>(`
        UPDATE divisions
        SET    parent_division_code = ?,
               budget_allocation    = ?
        WHERE  code   = ?
          AND  active = 1
      `);

      for (const div of config.divisions_hierarchy) {
        try {
          updateDiv.run(div.parent_division_code, div.budget_allocation, div.code);
        } catch (err) {
          logger.warn("org-chart-seeder", `Division hierarchy update failed for ${div.code}`, { metadata: { error: String(err) } });
        }
      }
    }
  });

  seedTx();
  logger.info("org-chart-seeder", `Seed complete: ${updated} agents positioned`);
  return updated;
}

/**
 * Assigns agents that still have no role_title or reports_to to their
 * division's org_level-1 agent (their "division head").
 *
 * Sets org_level = 2 for these worker agents.
 * Idempotent — runs on every apply, never overwrites existing assignments.
 *
 * @returns Number of agents updated.
 */
export function assignOrphanAgents(
  db: InstanceType<typeof Database>,
): number {
  const result = db.prepare<[], void>(`
    UPDATE agents
    SET    reports_to = (
             SELECT a2.id
             FROM   agents a2
             WHERE  a2.division_code = agents.division_code
               AND  a2.org_level = 1
               AND  a2.active    = 1
             LIMIT  1
           ),
           org_level = 2
    WHERE  role_title IS NULL
      AND  reports_to IS NULL
      AND  active = 1
      AND  EXISTS (
             SELECT 1
             FROM   agents a2
             WHERE  a2.division_code = agents.division_code
               AND  a2.org_level = 1
               AND  a2.active    = 1
           )
  `).run();

  if (result.changes > 0) {
    logger.info("org-chart-seeder", `Assigned ${result.changes} orphan agents to division heads`);
  }
  return result.changes;
}
