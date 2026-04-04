// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Report generation endpoints.
 *
 * POST /api/v1/reports/generate — generate a new report (operator scope)
 * GET  /api/v1/reports/:filename — serve a generated report file (operator scope)
 */

import { Hono }           from "hono";
import { join, basename } from "node:path";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import type Database      from "better-sqlite3";
import { requireScope }   from "../middleware/require-scope.js";
import { SidjuaError }    from "../../core/error-codes.js";
import { createLogger }   from "../../core/logger.js";
import { getMetrics }     from "../../core/metrics/index.js";
import { ReportDataAggregator } from "../../core/reporting/report-data-aggregator.js";
import { buildMonthlyReport, buildComplianceReport } from "../../core/reporting/report-builder.js";
import { renderReport }   from "../../core/reporting/pdf-renderer.js";
import type { PdfMcpRegistry } from "../../core/reporting/pdf-renderer.js";
import type { ReportGenerateRequest } from "../../core/reporting/types.js";

const logger = createLogger("report-routes");

export interface ReportRouteServices {
  db:         InstanceType<typeof Database>;
  workDir:    string;
  mcpRegistry?: PdfMcpRegistry | null;
}

export function registerReportRoutes(
  app: Hono,
  services: ReportRouteServices,
): void {
  const { db, workDir } = services;
  const mcpRegistry = services.mcpRegistry ?? null;
  const outputDir   = join(workDir, "reports");

  // ── POST /api/v1/reports/generate ─────────────────────────────────────────

  app.post("/api/v1/reports/generate", requireScope("operator"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (_err: unknown) {
      throw SidjuaError.from("API-001", "Invalid JSON body");
    }

    if (typeof body !== "object" || body === null) {
      throw SidjuaError.from("API-001", "Request body must be a JSON object");
    }

    const req = body as Partial<ReportGenerateRequest>;

    if (req.type !== "monthly" && req.type !== "compliance" && req.type !== "custom") {
      throw SidjuaError.from("API-001", "type must be 'monthly', 'compliance', or 'custom'");
    }

    if (typeof req.period !== "object" || req.period === null ||
        typeof req.period.from !== "string" || typeof req.period.to !== "string") {
      throw SidjuaError.from("API-001", "period.from and period.to are required ISO 8601 strings");
    }

    let from: Date;
    let to:   Date;
    try {
      from = new Date(req.period.from);
      to   = new Date(req.period.to);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new Error("invalid");
    } catch (_err: unknown) {
      throw SidjuaError.from("API-001", "period.from and period.to must be valid ISO 8601 dates");
    }

    if (from >= to) {
      throw SidjuaError.from("API-001", "period.from must be before period.to");
    }

    // Ensure output directory exists
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch (err: unknown) {
      logger.warn("report-routes", "Failed to create reports directory", {
        metadata: { error: err instanceof Error ? err.message : String(err), outputDir },
      });
    }

    const aggregator = new ReportDataAggregator(db, getMetrics());
    const period = { from, to };

    let reportData;
    if (req.type === "monthly") {
      reportData = await buildMonthlyReport(aggregator, period);
    } else {
      // compliance or custom both use compliance builder
      reportData = await buildComplianceReport(aggregator, period);
    }

    if (req.title !== undefined && req.title !== "") {
      reportData.title = req.title;
    }

    const result = await renderReport(reportData, mcpRegistry, outputDir);

    logger.info("report-routes", "Report generated", {
      metadata: { type: req.type, format: result.format, path: result.path },
    });

    return c.json({
      path:        basename(result.path),
      format:      result.format,
      generatedAt: reportData.generatedAt.toISOString(),
    }, 201);
  });

  // ── GET /api/v1/reports/:filename ──────────────────────────────────────────

  app.get("/api/v1/reports/:filename", requireScope("operator"), (c) => {
    const raw      = c.req.param("filename");
    // Reject any path traversal attempts
    const filename = basename(raw);
    if (filename !== raw || filename === "" || filename.startsWith(".")) {
      throw SidjuaError.from("API-001", "Invalid filename");
    }

    const filePath = join(outputDir, filename);
    if (!existsSync(filePath)) {
      throw SidjuaError.from("NOT-001", `Report file not found: ${filename}`);
    }

    const isPdf  = filename.endsWith(".pdf");
    const isHtml = filename.endsWith(".html");

    if (!isPdf && !isHtml) {
      throw SidjuaError.from("API-001", "Only .pdf and .html report files are served");
    }

    const contentType = isPdf ? "application/pdf" : "text/html; charset=utf-8";

    let fileData: Buffer;
    try {
      fileData = readFileSync(filePath);
    } catch (err: unknown) {
      logger.warn("report-routes", "Failed to read report file", {
        metadata: { error: err instanceof Error ? err.message : String(err), filePath },
      });
      throw SidjuaError.from("NOT-001", `Report file not readable: ${filename}`);
    }

    return new Response(fileData, {
      status:  200,
      headers: { "Content-Type": contentType },
    });
  });
}
