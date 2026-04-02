// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * org-import — REST endpoints for org chart file upload and import.
 *
 *   POST /api/v1/org/import         — multipart file upload; returns preview
 *   POST /api/v1/org/import/confirm — confirm a preview; executes import
 *
 * P350: Org Chart Import Pipeline
 */

import type { Hono }   from "hono";
import type Database   from "better-sqlite3";
import { requireScope } from "../middleware/require-scope.js";
import { createLogger } from "../../core/logger.js";

import { parseCsv, parseJson, parseXlsx, detectFormat } from "../../org-chart/import-parser.js";
import { autoMapColumns, applyMapping }                  from "../../org-chart/import-mapper.js";
import { validateHierarchy }                             from "../../org-chart/import-validator.js";
import { buildPreview, consumePreview }                  from "../../org-chart/import-preview.js";
import { executeImport }                                 from "../../org-chart/import-executor.js";

const logger = createLogger("org-import");

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface OrgImportRouteServices {
  db: InstanceType<typeof Database>;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerOrgImportRoutes(
  app: Hono,
  { db }: OrgImportRouteServices,
): void {

  // ── POST /api/v1/org/import ───────────────────────────────────────────────
  app.post("/api/v1/org/import", requireScope("operator"), async (c) => {
    let body: FormData;
    try {
      body = await c.req.formData();
    } catch (_e) {
      return c.json(
        { error: { code: "IMPORT-100", message: "Expected multipart/form-data body" } },
        400,
      );
    }

    const file = body.get("file") as File | null;
    if (file === null) {
      return c.json(
        { error: { code: "IMPORT-101", message: "Missing 'file' field in multipart body" } },
        400,
      );
    }

    const filename = file.name ?? "upload";
    const mimeType = file.type ?? "";
    const format   = detectFormat(filename, mimeType);

    if (format === "unknown") {
      return c.json(
        { error: { code: "IMPORT-102", message: "Unsupported file type — use CSV, JSON, or XLSX" } },
        400,
      );
    }

    // Guard against OOM from extremely large uploads
    const MAX_IMPORT_SIZE = 2 * 1024 * 1024; // 2 MB
    if (file.size > MAX_IMPORT_SIZE) {
      return c.json(
        {
          error: {
            code:    "IMPORT-106",
            message: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum: ${MAX_IMPORT_SIZE / 1024 / 1024} MB`,
          },
        },
        413,
      );
    }

    // Read file bytes
    let rawRows;
    try {
      if (format === "xlsx") {
        const arrayBuf = await file.arrayBuffer();
        const buffer   = Buffer.from(arrayBuf);
        rawRows        = await parseXlsx(buffer);
      } else if (format === "json") {
        const text = await file.text();
        rawRows    = parseJson(text);
      } else {
        const text = await file.text();
        rawRows    = parseCsv(text);
      }
    } catch (_e) {
      logger.warn("parse_error", "Failed to parse uploaded file", {
        metadata: { filename, format, error: _e instanceof Error ? _e.message : String(_e) },
      });
      return c.json(
        {
          error: {
            code:    "IMPORT-103",
            message: `Failed to parse file: ${_e instanceof Error ? _e.message : String(_e)}`,
          },
        },
        422,
      );
    }

    if (rawRows.length === 0) {
      return c.json(
        { error: { code: "IMPORT-104", message: "No rows found in the uploaded file" } },
        422,
      );
    }

    // Auto-map columns
    const columns = Object.keys(rawRows[0] ?? {});
    const mapping = autoMapColumns(columns);

    if (mapping.fieldToColumn["name"] === undefined) {
      return c.json(
        {
          error: {
            code:    "IMPORT-105",
            message: "Could not find a name column — include a Name, Employee Name, or Agent Name column",
          },
          detected_columns: columns,
        },
        422,
      );
    }

    // Map + validate
    const positions  = applyMapping(rawRows, mapping);
    const validation = validateHierarchy(positions);

    if (!validation.valid) {
      return c.json(
        {
          error: {
            code:    "IMPORT-106",
            message: "Validation failed",
            errors:  validation.errors,
          },
          warnings: validation.warnings,
        },
        422,
      );
    }

    // Collect existing division codes
    const existingDivCodes = new Set<string>();
    try {
      const rows = db.prepare("SELECT code FROM divisions").all() as { code: string }[];
      for (const r of rows) {
        existingDivCodes.add(r.code);
      }
    } catch (_e) {
      // Non-fatal — divisions table may not exist yet
    }

    const preview = buildPreview(validation.positions, existingDivCodes);

    logger.info("preview_built", "Org chart import preview built", {
      metadata: { preview_id: preview.id, agents: preview.total_agents, divisions: preview.new_divisions },
    });

    return c.json({
      preview_id:    preview.id,
      expires_at:    preview.expires_at,
      total_agents:  preview.total_agents,
      new_divisions: preview.new_divisions,
      tree_text:     preview.tree_text,
      warnings:      validation.warnings,
      divisions:     preview.divisions,
      agents:        preview.agents,
    });
  });

  // ── POST /api/v1/org/import/confirm ──────────────────────────────────────
  app.post("/api/v1/org/import/confirm", requireScope("operator"), async (c) => {
    let body: { preview_id?: unknown };
    try {
      body = await c.req.json() as { preview_id?: unknown };
    } catch (_e) {
      return c.json(
        { error: { code: "IMPORT-200", message: "Expected JSON body with preview_id" } },
        400,
      );
    }

    const previewId = typeof body["preview_id"] === "string" ? body["preview_id"] : null;
    if (previewId === null || previewId.trim() === "") {
      return c.json(
        { error: { code: "IMPORT-201", message: "'preview_id' is required" } },
        400,
      );
    }

    const preview = consumePreview(previewId);
    if (preview === null) {
      return c.json(
        { error: { code: "IMPORT-202", message: "Preview not found or has expired — re-upload the file" } },
        404,
      );
    }

    // Reconstruct positions from preview agents
    const positions = preview.agents.map((a) => ({
      name:       a.name,
      role_title: a.role_title,
      division:   a.division,
      reports_to: a.reports_to,
      tier:       a.tier,
      provider:   null as string | null,
      model:      null as string | null,
      email:      null as string | null,
    }));

    try {
      const result = executeImport({ db }, preview, positions);

      logger.info("import_complete", "Org chart import executed", {
        metadata: {
          agents_created:    result.agents_created,
          divisions_created: result.divisions_created,
          duration_ms:       result.duration_ms,
        },
      });

      return c.json({
        success:           true,
        agents_created:    result.agents_created,
        divisions_created: result.divisions_created,
        duration_ms:       result.duration_ms,
      });
    } catch (_e) {
      logger.error("import_failed", "Org chart import execution failed", {
        metadata: { error: _e instanceof Error ? _e.message : String(_e) },
      });
      return c.json(
        {
          error: {
            code:    "IMPORT-203",
            message: `Import failed: ${_e instanceof Error ? _e.message : String(_e)}`,
          },
        },
        500,
      );
    }
  });
}
