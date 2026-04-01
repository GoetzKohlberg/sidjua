// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * import-validator — validate OrgPosition[] before import.
 *
 * Checks:
 *  - Duplicate names (dedup with warning)
 *  - Circular reporting chains (DFS cycle detection)
 *  - Orphan references (reports_to name not found in the set)
 *
 * P350: Org Chart Import Pipeline
 */

import type { OrgPosition, ValidationResult } from "./import-types.js";

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Validate a list of OrgPosition objects.
 *
 * Returns a ValidationResult with:
 *  - valid = true if there are no hard errors (cycles, etc.)
 *  - positions = deduplicated list (duplicates are warned, first occurrence kept)
 */
export function validateHierarchy(positions: OrgPosition[]): ValidationResult {
  const errors:   string[] = [];
  const warnings: string[] = [];

  // ── Step 1: Deduplicate by name (case-insensitive, keep first) ──────────
  const seen    = new Map<string, OrgPosition>();
  const deduped: OrgPosition[] = [];

  for (const pos of positions) {
    const key = pos.name.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`Duplicate name skipped: "${pos.name}" (keeping first occurrence)`);
    } else {
      seen.set(key, pos);
      deduped.push(pos);
    }
  }

  // ── Step 2: Build name set for reference checks ──────────────────────────
  const nameSet = new Set(deduped.map((p) => p.name.toLowerCase()));

  // ── Step 3: Warn about orphan references ────────────────────────────────
  for (const pos of deduped) {
    if (pos.reports_to !== null && pos.reports_to !== "") {
      if (!nameSet.has(pos.reports_to.toLowerCase())) {
        warnings.push(
          `"${pos.name}" reports to "${pos.reports_to}" which is not in the import set — will be set to null`,
        );
      }
    }
  }

  // ── Step 4: Cycle detection (DFS with color marking) ────────────────────
  // Build adjacency: name → reports_to name (only within the set)
  const reportsToMap = new Map<string, string | null>();
  for (const pos of deduped) {
    const managerKey =
      pos.reports_to !== null && nameSet.has(pos.reports_to.toLowerCase())
        ? pos.reports_to.toLowerCase()
        : null;
    reportsToMap.set(pos.name.toLowerCase(), managerKey);
  }

  // 0 = unvisited, 1 = in-progress (on current stack), 2 = done
  const color = new Map<string, 0 | 1 | 2>();
  for (const key of nameSet) {
    color.set(key, 0);
  }

  const cycleNames = new Set<string>();

  const dfs = (node: string, path: string[]): void => {
    const c = color.get(node);
    if (c === 2) return;       // already fully explored
    if (c === 1) {
      // Back edge — cycle detected
      const cycleStart = path.indexOf(node);
      const cycleNodes = cycleStart >= 0 ? path.slice(cycleStart) : path;
      for (const n of cycleNodes) {
        cycleNames.add(n);
      }
      return;
    }

    color.set(node, 1);
    const manager = reportsToMap.get(node) ?? null;
    if (manager !== null) {
      dfs(manager, [...path, node]);
    }
    color.set(node, 2);
  };

  for (const key of nameSet) {
    if ((color.get(key) ?? 0) === 0) {
      dfs(key, []);
    }
  }

  if (cycleNames.size > 0) {
    const displayNames = deduped
      .filter((p) => cycleNames.has(p.name.toLowerCase()))
      .map((p) => `"${p.name}"`)
      .join(", ");
    errors.push(`Circular reporting chain detected involving: ${displayNames}`);
  }

  return {
    valid:     errors.length === 0,
    errors,
    warnings,
    positions: deduped,
  };
}
