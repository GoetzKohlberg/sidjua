// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * import-org-chart — HR internal tool: import an org chart from CSV/JSON data.
 *
 * Supports a two-step flow:
 *  1. preview mode  — parse + validate + build preview, returns preview ID
 *  2. confirm mode  — consume preview + execute import
 *
 * P350: Org Chart Import Pipeline
 */

import type { InternalToolDef } from "../adapters/internal-adapter.js";
import type Database            from "better-sqlite3";

import { parseCsv, parseJson }          from "../../org-chart/import-parser.js";
import { autoMapColumns, applyMapping } from "../../org-chart/import-mapper.js";
import { validateHierarchy }            from "../../org-chart/import-validator.js";
import { buildPreview, consumePreview } from "../../org-chart/import-preview.js";
import { executeImport }                from "../../org-chart/import-executor.js";

// ---------------------------------------------------------------------------
// Module-level DB reference
// ---------------------------------------------------------------------------

let _storeServices: { db: InstanceType<typeof Database> } | null = null;

export function setImportOrgChartDb(db: InstanceType<typeof Database>): void {
  _storeServices = { db };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const importOrgChartTool: InternalToolDef = {
  id:          "internal-import-org-chart",
  name:        "import_org_chart",
  description: "Import an org chart from CSV or JSON text. Two-step: preview then confirm.",
  capabilities: [
    {
      name:              "import_org_chart",
      description:
        "Parse org chart data (CSV or JSON), validate hierarchy, and optionally execute the import",
      risk_level:        "medium",
      requires_approval: true,
      input_schema: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: {
            type:        "string",
            enum:        ["preview", "confirm"],
            description: "'preview' parses data and returns a preview ID; 'confirm' executes a previously previewed import",
          },
          format: {
            type:        "string",
            enum:        ["csv", "json"],
            description: "File format — required for preview mode",
          },
          data: {
            type:        "string",
            description: "Raw file content as a string — required for preview mode",
          },
          preview_id: {
            type:        "string",
            description: "Preview ID returned by preview mode — required for confirm mode",
          },
        },
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    const mode = params["mode"] as string | undefined;

    // ── Preview ──────────────────────────────────────────────────────────────
    if (mode === "preview") {
      const format = (params["format"] as string | undefined) ?? "csv";
      const data   = params["data"]   as string | undefined;

      if (!data || data.trim() === "") {
        return { error: "IMPORT-001: 'data' parameter is required for preview mode" };
      }

      let rawRows;
      try {
        rawRows = format === "json" ? parseJson(data) : parseCsv(data);
      } catch (_e) {
        return { error: `IMPORT-002: Failed to parse ${format.toUpperCase()} — ${_e instanceof Error ? _e.message : String(_e)}` };
      }

      if (rawRows.length === 0) {
        return { error: "IMPORT-003: No rows found in the provided data" };
      }

      const columns = Object.keys(rawRows[0] ?? {});
      const mapping = autoMapColumns(columns);

      if (mapping.fieldToColumn["name"] === undefined) {
        return {
          error:           "IMPORT-004: Could not find a 'name' column — please include a Name, Employee Name, or Agent Name column",
          detected_columns: columns,
        };
      }

      const positions  = applyMapping(rawRows, mapping);
      const validation = validateHierarchy(positions);

      if (!validation.valid) {
        return {
          error:    "IMPORT-005: Validation failed",
          errors:   validation.errors,
          warnings: validation.warnings,
        };
      }

      // Get existing division codes if DB is available
      const existingDivCodes = new Set<string>();
      if (_storeServices !== null) {
        try {
          const rows = _storeServices.db.prepare("SELECT code FROM divisions").all() as { code: string }[];
          for (const r of rows) {
            existingDivCodes.add(r.code);
          }
        } catch (_e) {
          // Non-fatal — preview still works without existing division data
        }
      }

      const preview = buildPreview(validation.positions, existingDivCodes);

      return {
        preview_id:    preview.id,
        expires_at:    preview.expires_at,
        total_agents:  preview.total_agents,
        new_divisions: preview.new_divisions,
        tree_text:     preview.tree_text,
        warnings:      validation.warnings,
        divisions:     preview.divisions,
        agents:        preview.agents,
      };
    }

    // ── Confirm ──────────────────────────────────────────────────────────────
    if (mode === "confirm") {
      const previewId = params["preview_id"] as string | undefined;

      if (!previewId || previewId.trim() === "") {
        return { error: "IMPORT-006: 'preview_id' is required for confirm mode" };
      }

      const preview = consumePreview(previewId);
      if (preview === null) {
        return { error: "IMPORT-007: Preview not found or has expired — please re-run preview mode" };
      }

      if (_storeServices === null) {
        return { error: "IMPORT-008: Database not initialized" };
      }

      // Re-run parsing from preview agents to reconstruct positions
      // (The preview stores agent data; we reconstruct OrgPosition from it)
      const positions = preview.agents.map((a) => ({
        name:       a.name,
        role_title: a.role_title,
        division:   a.division,
        reports_to: a.reports_to,
        tier:       a.tier,
        provider:   null,
        model:      null,
        email:      null,
      }));

      try {
        const result = executeImport(_storeServices, preview, positions);
        return {
          success:           true,
          agents_created:    result.agents_created,
          divisions_created: result.divisions_created,
          duration_ms:       result.duration_ms,
        };
      } catch (_e) {
        return { error: `IMPORT-009: Import failed — ${_e instanceof Error ? _e.message : String(_e)}` };
      }
    }

    return { error: `IMPORT-010: Unknown mode "${String(mode)}" — use 'preview' or 'confirm'` };
  },
};
