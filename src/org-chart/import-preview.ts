// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * import-preview — build and store import previews with TTL.
 *
 * A preview is computed from validated OrgPosition[] data and stored
 * in-memory with a 10-minute TTL. The caller receives a preview ID
 * which they must supply to the confirm endpoint.
 *
 * P350: Org Chart Import Pipeline
 */

import { randomUUID } from "node:crypto";
import type { OrgPosition, ImportPreview, PreviewAgent, PreviewDivision } from "./import-types.js";

// ---------------------------------------------------------------------------
// Preview TTL
// ---------------------------------------------------------------------------

const PREVIEW_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/** Module-level preview store — keyed by preview ID */
const _previews = new Map<string, ImportPreview>();

// ---------------------------------------------------------------------------
// Build preview
// ---------------------------------------------------------------------------

/**
 * Build an ImportPreview from a validated list of OrgPosition objects.
 *
 * Computes org levels (BFS from roots), derives unique divisions,
 * renders a text tree, and stores the preview in memory with a TTL.
 *
 * @param positions Validated OrgPosition[] (no duplicates, no cycles)
 * @param existingDivisionCodes Set of division codes already in the DB
 */
export function buildPreview(
  positions: OrgPosition[],
  existingDivisionCodes: Set<string> = new Set(),
): ImportPreview {
  // ── Compute org levels ────────────────────────────────────────────────────
  // Build name→position map for level calculation
  const byName = new Map<string, OrgPosition>();
  for (const p of positions) {
    byName.set(p.name.toLowerCase(), p);
  }

  const orgLevels = new Map<string, number>();

  /** DFS to compute level (memoized) */
  const getLevel = (name: string, visited: Set<string> = new Set()): number => {
    if (orgLevels.has(name)) return orgLevels.get(name) as number;
    if (visited.has(name)) return 0; // cycle guard (should not happen after validation)

    visited.add(name);
    const pos = byName.get(name.toLowerCase());
    if (pos === undefined || pos.reports_to === null) {
      orgLevels.set(name, 0);
      return 0;
    }
    const managerKey = pos.reports_to.toLowerCase();
    const managerPos = byName.get(managerKey);
    if (managerPos === undefined) {
      orgLevels.set(name, 0);
      return 0;
    }
    const level = getLevel(managerPos.name, new Set(visited)) + 1;
    orgLevels.set(name, level);
    return level;
  };

  for (const p of positions) {
    getLevel(p.name);
  }

  // ── Collect unique divisions ──────────────────────────────────────────────
  const divisionSet = new Set<string>();
  for (const p of positions) {
    if (p.division !== null && p.division !== "") {
      divisionSet.add(p.division);
    }
  }

  const divisionCode = (name: string): string =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "div";

  const previewDivisions: PreviewDivision[] = [];
  for (const divName of divisionSet) {
    const code  = divisionCode(divName);
    previewDivisions.push({
      code,
      name_en: divName,
      is_new:  !existingDivisionCodes.has(code),
    });
  }

  // ── Build PreviewAgent list ───────────────────────────────────────────────
  const previewAgents: PreviewAgent[] = positions.map((p) => ({
    name:       p.name,
    role_title: p.role_title,
    division:   p.division,
    reports_to: p.reports_to,
    tier:       p.tier,
    org_level:  orgLevels.get(p.name) ?? 0,
  }));

  // ── Render text tree ──────────────────────────────────────────────────────
  const treeText = renderPreviewText(previewAgents);

  // ── Store preview ─────────────────────────────────────────────────────────
  const id         = randomUUID();
  const expires_at = Date.now() + PREVIEW_TTL_MS;

  const preview: ImportPreview = {
    id,
    expires_at,
    agents:        previewAgents,
    divisions:     previewDivisions,
    tree_text:     treeText,
    total_agents:  positions.length,
    new_divisions: previewDivisions.filter((d) => d.is_new).length,
  };

  _previews.set(id, preview);

  return preview;
}

// ---------------------------------------------------------------------------
// Consume preview
// ---------------------------------------------------------------------------

/**
 * Retrieve and remove a preview by ID.
 *
 * Returns null if the ID is unknown or has expired.
 * Once consumed the preview is deleted from the store (single-use).
 */
export function consumePreview(id: string): ImportPreview | null {
  const preview = _previews.get(id);
  if (preview === undefined) return null;
  if (Date.now() > preview.expires_at) {
    _previews.delete(id);
    return null;
  }
  _previews.delete(id);
  return preview;
}

// ---------------------------------------------------------------------------
// Render tree text
// ---------------------------------------------------------------------------

/**
 * Render a human-readable org tree from PreviewAgent[].
 *
 * Output example:
 *   Alice (CEO) [T1]
 *   └─ Bob (CTO) [T2]
 *      └─ Carol (Engineer) [T2]
 */
export function renderPreviewText(agents: PreviewAgent[]): string {
  // Build name→agent map and children map
  const byName    = new Map<string, PreviewAgent>();
  const children  = new Map<string, PreviewAgent[]>();

  for (const a of agents) {
    byName.set(a.name.toLowerCase(), a);
  }

  for (const a of agents) {
    const managerName = a.reports_to !== null ? a.reports_to.toLowerCase() : null;
    if (managerName !== null && byName.has(managerName)) {
      const arr = children.get(managerName) ?? [];
      arr.push(a);
      children.set(managerName, arr);
    }
  }

  // Roots: agents with no manager in the set
  const roots = agents.filter((a) => {
    if (a.reports_to === null) return true;
    return !byName.has(a.reports_to.toLowerCase());
  });

  const lines: string[] = [];

  const render = (agent: PreviewAgent, prefix: string, isLast: boolean): void => {
    const connector = isLast ? "└─" : "├─";
    const title     = agent.role_title !== null ? ` (${agent.role_title})` : "";
    const div       = agent.division   !== null ? ` [${agent.division}]`   : "";
    lines.push(`${prefix}${connector} ${agent.name}${title}${div} T${agent.tier}`);

    const kids    = children.get(agent.name.toLowerCase()) ?? [];
    const newPfx  = prefix + (isLast ? "   " : "│  ");
    for (let i = 0; i < kids.length; i++) {
      render(kids[i] as PreviewAgent, newPfx, i === kids.length - 1);
    }
  };

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i] as PreviewAgent;
    const title = root.role_title !== null ? ` (${root.role_title})` : "";
    const div   = root.division   !== null ? ` [${root.division}]`   : "";
    lines.push(`${root.name}${title}${div} T${root.tier}`);

    const kids = children.get(root.name.toLowerCase()) ?? [];
    for (let j = 0; j < kids.length; j++) {
      render(kids[j] as PreviewAgent, "", j === kids.length - 1);
    }
  }

  return lines.join("\n");
}
