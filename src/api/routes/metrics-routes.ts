// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P379: Prometheus Metrics Routes
 *
 *   GET /api/v1/metrics/prometheus  — Prometheus text exposition format (operator scope)
 *   GET /api/v1/metrics/json        — JSON snapshot of all metric values (operator scope)
 *
 * Both endpoints require the "operator" scope. Metrics contain no PII — only
 * agent names, divisions, tool names, model names, and numeric values.
 */

import type { Hono } from "hono";
import { requireScope } from "../middleware/require-scope.js";
import { getMetrics }   from "../../core/metrics/index.js";

export function registerMetricsRoutes(app: Hono): void {
  // ── GET /api/v1/metrics/prometheus ────────────────────────────────────────
  // Returns Prometheus text exposition format (version 0.0.4).
  app.get("/api/v1/metrics/prometheus", requireScope("operator"), (c) => {
    const body = getMetrics().serialize();
    return new Response(body, {
      status:  200,
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  });

  // ── GET /api/v1/metrics/json ───────────────────────────────────────────────
  // Returns a machine-readable JSON snapshot for dashboards and scripts.
  app.get("/api/v1/metrics/json", requireScope("operator"), (c) => {
    const raw    = getMetrics().serialize();
    const metrics: Record<string, Record<string, number>> = {};

    for (const line of raw.split("\n")) {
      if (line.startsWith("#") || line.trim() === "") continue;

      // Parse: metric_name{k="v",...} value  OR  metric_name value
      const braceIdx = line.indexOf("{");
      if (braceIdx !== -1) {
        const closeBrace = line.indexOf("}");
        const name   = line.slice(0, braceIdx);
        const labels = line.slice(braceIdx + 1, closeBrace);
        const value  = parseFloat(line.slice(closeBrace + 1).trim());
        if (!metrics[name]) metrics[name] = {};
        metrics[name]![labels || ""] = value;
      } else {
        const spaceIdx = line.lastIndexOf(" ");
        if (spaceIdx === -1) continue;
        const name  = line.slice(0, spaceIdx);
        const value = parseFloat(line.slice(spaceIdx + 1).trim());
        if (!metrics[name]) metrics[name] = {};
        metrics[name]![""] = value;
      }
    }

    return c.json({ metrics });
  });
}
