// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * import-types — shared type definitions for the org chart import pipeline.
 *
 * P350: Org Chart Import Pipeline
 */

// ---------------------------------------------------------------------------
// Raw parsed row (one row from the uploaded file)
// ---------------------------------------------------------------------------

export interface RawOrgRow {
  /** Original column name → raw cell value (always string after parsing) */
  [column: string]: string;
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/** Canonical field names we understand */
export type OrgField =
  | "name"
  | "role_title"
  | "division"
  | "reports_to"
  | "tier"
  | "provider"
  | "model"
  | "email";

export interface ColumnMapping {
  /** Maps canonical field name → source column name in the raw file */
  fieldToColumn: Partial<Record<OrgField, string>>;
  /** Columns that were not mapped to any canonical field */
  unmappedColumns: string[];
}

// ---------------------------------------------------------------------------
// Normalized position (after mapping)
// ---------------------------------------------------------------------------

export interface OrgPosition {
  name:       string;
  role_title: string | null;
  division:   string | null;
  reports_to: string | null;
  tier:       number;
  provider:   string | null;
  model:      string | null;
  email:      string | null;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid:    boolean;
  errors:   string[];
  warnings: string[];
  /** Positions that survived deduplication and validation */
  positions: OrgPosition[];
}

// ---------------------------------------------------------------------------
// Import preview
// ---------------------------------------------------------------------------

export interface PreviewAgent {
  name:       string;
  role_title: string | null;
  division:   string | null;
  reports_to: string | null;
  tier:       number;
  org_level:  number;
}

export interface PreviewDivision {
  code:      string;
  name_en:   string;
  is_new:    boolean;
}

export interface ImportPreview {
  id:           string;   // UUID — used to confirm the import
  expires_at:   number;   // Unix ms — TTL 10 minutes
  agents:       PreviewAgent[];
  divisions:    PreviewDivision[];
  /** Human-readable tree rendering */
  tree_text:    string;
  total_agents: number;
  new_divisions: number;
}

// ---------------------------------------------------------------------------
// Import result
// ---------------------------------------------------------------------------

export interface ImportResult {
  agents_created:    number;
  divisions_created: number;
  duration_ms:       number;
}
