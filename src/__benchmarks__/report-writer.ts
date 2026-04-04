// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Benchmark Report Writer
 *
 * Serialises BenchmarkResult objects to JSON and prints summary tables.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BenchmarkResult } from "./benchmark-runner.js";

// ---------------------------------------------------------------------------
// writeBenchmarkReport
// ---------------------------------------------------------------------------

/**
 * Write benchmark results to a timestamped JSON file in `outputDir`.
 * Returns the absolute path of the written file.
 */
export function writeBenchmarkReport(
  results: BenchmarkResult[],
  outputDir: string,
): string {
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(outputDir, `benchmark-${timestamp}.json`);

  const report = {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform:    process.platform,
      arch:        process.arch,
    },
    results,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  return reportPath;
}

// ---------------------------------------------------------------------------
// printSummary
// ---------------------------------------------------------------------------

/** Print a human-readable summary table for each result. */
export function printSummary(results: BenchmarkResult[]): void {
  if (results.length === 0) {
    console.log("No benchmark results to display.");
    return;
  }

  for (const r of results) {
    console.log(`\n=== ${r.scenario} ===`);
    console.log(`Duration:     ${r.durationMs}ms`);
    console.log(
      `Tasks:        ${r.summary.totalTasks} total, ` +
        `${r.summary.completedTasks} completed, ` +
        `${r.summary.failedTasks} failed, ` +
        `${r.summary.rejectedTasks} rejected`,
    );
    console.log(`Success rate: ${r.summary.successRate}%`);
    console.log(`Throughput:   ${r.summary.throughput.toFixed(1)} tasks/sec`);
    console.log(
      `Latency:      p50=${r.latency.p50}ms  p90=${r.latency.p90}ms  ` +
        `p95=${r.latency.p95}ms  p99=${r.latency.p99}ms  max=${r.latency.max}ms`,
    );
    console.log(
      `Backpressure: max queue=${r.backpressure.maxQueueLength}, ` +
        `rejects=${r.backpressure.totalRejects}, ` +
        `activations=${r.backpressure.activationCount}`,
    );
    console.log(`Recovery:     ${r.deadWorkerRecoveries} dead workers recovered`);

    if (r.delegations.total > 0) {
      console.log(
        `Delegations:  ${r.delegations.total} total, ` +
          `${r.delegations.successful} ok, ` +
          `${r.delegations.failed} failed, ` +
          `avg=${r.delegations.avgDurationMs}ms`,
      );
    }

    if (r.failureInjection.injected.length > 0) {
      console.log(`Injected:     ${r.failureInjection.injected.join(", ")}`);
      console.log(`Recovered:    ${r.failureInjection.recovered.join(", ") || "none"}`);
      if (r.failureInjection.notRecovered.length > 0) {
        console.log(`Not recovered: ${r.failureInjection.notRecovered.join(", ")}`);
      }
    }
  }
}
