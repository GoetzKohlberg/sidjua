// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * import-executor — atomically write an approved org chart import to SQLite.
 *
 * P350: Org Chart Import Pipeline
 */

import type Database from "better-sqlite3";
import type { OrgPosition, ImportResult } from "./import-types.js";
import type { ImportPreview } from "./import-types.js";

// ---------------------------------------------------------------------------
// Service interfaces
// ---------------------------------------------------------------------------

export interface ImportStoreServices {
  db: InstanceType<typeof Database>;
}

// ---------------------------------------------------------------------------
// Execute import
// ---------------------------------------------------------------------------

/**
 * Execute an approved org chart import inside a single SQLite transaction.
 *
 * Steps:
 *  1. Upsert divisions (derived from positions[].division)
 *  2. Two-pass agent insert:
 *     - Pass 1: build name→id map for all positions
 *     - Pass 2: insert agents ordered by org_level (ascending) so managers
 *               exist before direct reports
 *
 * @param services  DB connection
 * @param preview   The approved preview (provides agents + org_level data)
 * @param positions Validated OrgPosition[] (same set that built the preview)
 */
export function executeImport(
  { db }: ImportStoreServices,
  preview: ImportPreview,
  positions: OrgPosition[],
): ImportResult {
  const start = Date.now();

  // Build org-level lookup from preview
  const orgLevels = new Map<string, number>();
  for (const a of preview.agents) {
    orgLevels.set(a.name.toLowerCase(), a.org_level);
  }

  // ── Pass 1: build name→id map ────────────────────────────────────────────
  const nameToId = new Map<string, string>();
  for (const p of positions) {
    const id = p.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agent";
    // Ensure uniqueness if two names generate the same slug
    let finalId = id;
    let counter = 2;
    while ([...nameToId.values()].includes(finalId)) {
      finalId = `${id}-${counter}`;
      counter++;
    }
    nameToId.set(p.name.toLowerCase(), finalId);
  }

  let agentsCreated    = 0;
  let divisionsCreated = 0;

  const run = db.transaction(() => {
    // ── Upsert divisions ───────────────────────────────────────────────────
    const divNames = new Set<string>();
    for (const p of positions) {
      if (p.division !== null && p.division !== "") {
        divNames.add(p.division);
      }
    }

    const insertDiv = db.prepare(`
      INSERT INTO divisions (code, name_en, active, required)
      VALUES (?, ?, 1, 0)
      ON CONFLICT(code) DO NOTHING
    `);

    for (const divName of divNames) {
      const code = divName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "div";
      const info = insertDiv.run(code, divName);
      if (info.changes > 0) divisionsCreated++;
    }

    // ── Pass 2: insert agents ordered by org_level (ascending) ────────────
    const sorted = [...positions].sort((a, b) => {
      const la = orgLevels.get(a.name.toLowerCase()) ?? 99;
      const lb = orgLevels.get(b.name.toLowerCase()) ?? 99;
      return la - lb;
    });

    const insertAgent = db.prepare(`
      INSERT INTO agents
        (id, name, tier, provider, model, division_code,
         role_title, reports_to, active, org_level)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO NOTHING
    `);

    for (const p of sorted) {
      const id           = nameToId.get(p.name.toLowerCase()) ?? "agent";
      const managerId    =
        p.reports_to !== null
          ? (nameToId.get(p.reports_to.toLowerCase()) ?? null)
          : null;
      const divCode      =
        p.division !== null && p.division !== ""
          ? p.division.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || null
          : null;
      const orgLevel     = orgLevels.get(p.name.toLowerCase()) ?? 0;

      const info = insertAgent.run(
        id,
        p.name,
        p.tier,
        p.provider ?? "openai",
        p.model    ?? "gpt-4o",
        divCode,
        p.role_title,
        managerId,
        orgLevel,
      );
      if (info.changes > 0) agentsCreated++;
    }
  });

  run();

  return {
    agents_created:    agentsCreated,
    divisions_created: divisionsCreated,
    duration_ms:       Date.now() - start,
  };
}
