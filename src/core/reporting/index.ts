// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

export { ReportDataAggregator }                    from "./report-data-aggregator.js";
export { renderReportHtml, escapeHtml }            from "./report-template.js";
export { renderReport }                            from "./pdf-renderer.js";
export { buildMonthlyReport, buildComplianceReport } from "./report-builder.js";
export type * from "./types.js";
