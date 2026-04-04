#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Benchmark CLI Entry Point
 *
 *   npm run benchmark                        # run short-burst
 *   npm run benchmark:quick                  # same
 *   npm run benchmark:full                   # all scenarios
 *   npx tsx src/__benchmarks__/run.ts <name> # named scenario
 */

import { BenchmarkRunner } from "./benchmark-runner.js";
import { writeBenchmarkReport, printSummary } from "./report-writer.js";
import { SCENARIOS } from "./scenarios.js";

const args = process.argv.slice(2);
const runner = new BenchmarkRunner();

async function main(): Promise<void> {
  let results;

  if (args.includes("--all")) {
    console.log(`Running all ${SCENARIOS.length} scenarios…`);
    results = await runner.runAll();
  } else {
    const scenarioName =
      args.find((a) => !a.startsWith("--")) ?? "short-burst";
    const scenario = SCENARIOS.find((s) => s.name === scenarioName);

    if (scenario === undefined) {
      console.error(`Unknown scenario: ${scenarioName}`);
      console.error(`Available: ${SCENARIOS.map((s) => s.name).join(", ")}`);
      process.exit(1);
    }

    console.log(`Running scenario: ${scenario.name}`);
    console.log(`  ${scenario.description}`);
    console.log(`  Fleet: ${scenario.fleet.length} agents`);
    console.log(`  Duration: ${scenario.durationMs / 1000}s at ${scenario.targetTasksPerSecond} tasks/sec`);
    console.log("");

    results = [await runner.run(scenario)];
  }

  printSummary(results);

  const reportPath = writeBenchmarkReport(results, "benchmarks/");
  console.log(`\nFull report written: ${reportPath}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Benchmark failed:", msg);
  process.exit(1);
});
