// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * import-mapper — fuzzy column mapping for org chart import.
 *
 * Attempts to map source file columns to canonical OrgField names.
 * P350: Org Chart Import Pipeline
 */

import type { RawOrgRow, OrgField, ColumnMapping, OrgPosition } from "./import-types.js";

// ---------------------------------------------------------------------------
// Canonical aliases
// ---------------------------------------------------------------------------

/** Maps canonical field → list of aliases (all lower-case, trimmed) */
const FIELD_ALIASES: Record<OrgField, string[]> = {
  name: [
    "name", "full name", "fullname", "employee name", "agent name",
    "employee", "agent", "display name",
  ],
  role_title: [
    "role_title", "role title", "title", "job title", "position",
    "role", "job", "designation",
  ],
  division: [
    "division", "department", "dept", "team", "group", "unit",
    "business unit", "org unit",
  ],
  reports_to: [
    "reports_to", "reports to", "manager", "supervisor", "boss",
    "direct manager", "reporting to", "managed by",
  ],
  tier: ["tier", "level", "grade", "seniority level"],
  provider: ["provider", "llm provider", "ai provider", "model provider"],
  model: ["model", "llm model", "ai model", "model name"],
  email: ["email", "e-mail", "email address", "work email", "corporate email"],
};

// ---------------------------------------------------------------------------
// Auto-map
// ---------------------------------------------------------------------------

/**
 * Attempt to automatically map source columns to canonical OrgField names.
 *
 * Each source column is matched (case-insensitive) against the alias lists.
 * The first match wins; if no match is found the column goes to unmappedColumns.
 */
export function autoMapColumns(sourceColumns: string[]): ColumnMapping {
  const fieldToColumn: Partial<Record<OrgField, string>> = {};
  const unmappedColumns: string[] = [];

  for (const col of sourceColumns) {
    const normalized = col.toLowerCase().trim();
    let matched = false;

    for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [OrgField, string[]][]) {
      if (aliases.includes(normalized)) {
        // Only take the first match per field
        if (fieldToColumn[field] === undefined) {
          fieldToColumn[field] = col;
        }
        matched = true;
        break;
      }
    }

    if (!matched) {
      unmappedColumns.push(col);
    }
  }

  return { fieldToColumn, unmappedColumns };
}

// ---------------------------------------------------------------------------
// Apply mapping
// ---------------------------------------------------------------------------

/**
 * Convert raw rows to OrgPosition[] using the provided column mapping.
 *
 * Rows where `name` resolves to empty string are skipped.
 */
export function applyMapping(rows: RawOrgRow[], mapping: ColumnMapping): OrgPosition[] {
  const { fieldToColumn } = mapping;

  const get = (row: RawOrgRow, field: OrgField): string => {
    const col = fieldToColumn[field];
    if (col === undefined) return "";
    return (row[col] ?? "").trim();
  };

  const positions: OrgPosition[] = [];

  for (const row of rows) {
    const name = get(row, "name");
    if (name === "") continue;

    const tierRaw = get(row, "tier");
    let tier = 2; // default T2
    if (tierRaw !== "") {
      const n = parseInt(tierRaw, 10);
      if (!isNaN(n) && n >= 1 && n <= 3) tier = n;
    }

    positions.push({
      name,
      role_title: get(row, "role_title") || null,
      division:   get(row, "division")   || null,
      reports_to: get(row, "reports_to") || null,
      tier,
      provider:   get(row, "provider")   || null,
      model:      get(row, "model")      || null,
      email:      get(row, "email")      || null,
    });
  }

  return positions;
}
