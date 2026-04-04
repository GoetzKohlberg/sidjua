// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import { writeFileSync } from "node:fs";
import { join }          from "node:path";
import { createLogger }  from "../logger.js";
import { renderReportHtml } from "./report-template.js";
import type { ReportData } from "./types.js";

const logger = createLogger("pdf-renderer");

// ─── McpRegistry duck-type (avoids circular dep with mcp-registry.ts) ────────

export interface PdfMcpRegistry {
  getStatus(): Array<{ name: string; health: string }>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<{ content: unknown[] }>;
}

// ─── Puppeteer strategy ───────────────────────────────────────────────────────

async function renderViaPuppeteer(
  html: string,
  mcpRegistry: PdfMcpRegistry,
  outputPath: string,
): Promise<void> {
  // Navigate to an inline data URI with the HTML content
  const base64Html = Buffer.from(html, "utf-8").toString("base64");
  const dataUri    = `data:text/html;base64,${base64Html}`;

  await mcpRegistry.callTool("puppeteer_navigate", { url: dataUri });
  const result = await mcpRegistry.callTool("puppeteer_screenshot", {
    name: "report",
    type: "pdf",
    path: outputPath,
  });

  // Validate that something was written
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("Puppeteer MCP returned empty content for PDF render");
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a report to PDF (via Puppeteer MCP) or HTML (fallback).
 *
 * If `mcpRegistry` is provided and the "puppeteer" server is healthy, the
 * report is rendered to PDF. Otherwise, the HTML is written to disk and a
 * warning is logged.
 */
export async function renderReport(
  data: ReportData,
  mcpRegistry: PdfMcpRegistry | null,
  outputDir: string,
): Promise<{ path: string; format: "pdf" | "html" }> {
  const html = renderReportHtml(data);

  const puppeteerAvailable =
    mcpRegistry !== null &&
    mcpRegistry.getStatus().some((s) => s.name === "puppeteer" && s.health === "healthy");

  if (puppeteerAvailable && mcpRegistry !== null) {
    const pdfPath = join(outputDir, `report-${Date.now()}.pdf`);
    try {
      await renderViaPuppeteer(html, mcpRegistry, pdfPath);
      logger.info("pdf-renderer", "PDF report rendered via Puppeteer MCP", {
        metadata: { path: pdfPath },
      });
      return { path: pdfPath, format: "pdf" };
    } catch (err: unknown) {
      logger.warn("pdf-renderer", "Puppeteer MCP render failed — falling back to HTML", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Fallback: write as HTML
  const htmlPath = join(outputDir, `report-${Date.now()}.html`);
  writeFileSync(htmlPath, html, "utf-8");
  logger.warn("pdf-renderer", "pdf-fallback-html", {
    metadata: { reason: "puppeteer-mcp-not-available", path: htmlPath },
  });
  return { path: htmlPath, format: "html" };
}
