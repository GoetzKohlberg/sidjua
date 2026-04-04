// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Benchmark Runner
 *
 * Executes load scenarios against mock agents, collects latency and throughput
 * metrics, and returns a structured BenchmarkResult.
 */

import { BackpressureManager, BackpressureError } from "../core/runtime/backpressure.js";
import {
  MockAgentFactory,
  type MockAgentSetup,
} from "./mock-agent-factory.js";
import { FailureInjector, type FailureConfig } from "./failure-injector.js";
import { SCENARIOS, type BenchmarkScenario, type TaskGenerator } from "./scenarios.js";
import { _setMetricsInstance, MetricsCollector } from "../core/metrics/metrics-collector.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface LatencyStats {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
}

export interface BenchmarkResult {
  scenario: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  summary: {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    rejectedTasks: number;
    timedOutTasks: number;
    successRate: number;
    throughput: number;
  };
  latency: LatencyStats;
  backpressure: {
    maxQueueLength: number;
    totalRejects: number;
    activationCount: number;
  };
  deadWorkerRecoveries: number;
  delegations: {
    total: number;
    successful: number;
    failed: number;
    avgDurationMs: number;
  };
  failureInjection: {
    injected: string[];
    recovered: string[];
    notRecovered: string[];
  };
  perAgent: Record<
    string,
    {
      tasks: number;
      completed: number;
      failed: number;
      avgLatencyMs: number;
      budgetUsed: number;
    }
  >;
}

// ---------------------------------------------------------------------------
// Internal tracking
// ---------------------------------------------------------------------------

interface TaskRecord {
  agentId: string;
  tier: string;
  startedAt: number;
  completedAt: number;
  status: "completed" | "failed" | "rejected";
  isDelegation: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Weighted random pick from task generators. */
function weightedPick(generators: TaskGenerator[]): TaskGenerator {
  const totalWeight = generators.reduce((sum, g) => sum + g.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const g of generators) {
    roll -= g.weight;
    if (roll <= 0) return g;
  }
  return generators[generators.length - 1] ?? generators[0]!;
}

/** Calculate latency percentiles from sorted durations array. */
function calculatePercentiles(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const pct = (p: number): number => {
    const idx = Math.floor((p / 100) * sorted.length);
    return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50: pct(50),
    p90: pct(90),
    p95: pct(95),
    p99: pct(99),
    max: sorted[sorted.length - 1] ?? 0,
    avg: Math.round(sum / sorted.length),
  };
}

// ---------------------------------------------------------------------------
// BenchmarkRunner
// ---------------------------------------------------------------------------

export class BenchmarkRunner {
  /**
   * Run a single scenario with optional failure injections.
   * Uses an isolated in-memory MetricsCollector for the duration.
   */
  async run(
    scenario: BenchmarkScenario,
    failureInjections: FailureConfig[] = [],
  ): Promise<BenchmarkResult> {
    // Isolated metrics for this run
    const isolatedMetrics = new MetricsCollector();
    _setMetricsInstance(isolatedMetrics);

    try {
      return await this._runScenario(scenario, failureInjections);
    } finally {
      _setMetricsInstance(null);
    }
  }

  /** Run all pre-built scenarios sequentially. */
  async runAll(): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];
    for (const scenario of SCENARIOS) {
      const result = await this.run(scenario);
      results.push(result);
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Private: core runner
  // ---------------------------------------------------------------------------

  private async _runScenario(
    scenario: BenchmarkScenario,
    failureInjections: FailureConfig[],
  ): Promise<BenchmarkResult> {
    const fleet = MockAgentFactory.createFleet(scenario.fleet);

    // Backpressure config: map fleet tiers to concurrent limits
    const maxConcurrentByTier: Record<string, number> = {};
    for (const config of scenario.fleet) {
      if (config.tier === "T1") maxConcurrentByTier["T1"] = 2;
      else if (config.tier === "T2") maxConcurrentByTier["T2"] = 4;
      else maxConcurrentByTier["T3"] = 8;
    }
    const bp = new BackpressureManager({ maxConcurrentByTier, maxQueueLength: 200, queueTimeoutMs: 5_000 });

    const injector = new FailureInjector();
    for (const fi of failureInjections) {
      injector.scheduleFailure(fi);
    }

    const startTime = Date.now();
    const taskRecords: TaskRecord[] = [];
    const inFlight: Promise<void>[] = [];

    let maxQueueLength = 0;
    let totalRejects = 0;
    let activationCount = 0;
    let lastQueueLength = 0;
    let deadWorkerRecoveries = 0;

    const crashedAgents = new Set<string>();

    // Delegation tracking
    const delegationRecords: Array<{
      taskId: string;
      startedAt: number;
      completedAt?: number;
      success: boolean;
    }> = [];

    // ---------------------------------------------------------------------------
    // Task execution simulation
    // ---------------------------------------------------------------------------

    const submitTask = (
      agentId: string,
      tier: string,
      priority: "low" | "normal" | "high",
      isDelegation: boolean,
    ): Promise<void> => {
      const taskId = `bench-${agentId}-${Math.random().toString(36).slice(2, 8)}`;
      const setup = fleet.get(agentId);
      const taskStart = Date.now();

      if (setup === undefined) return Promise.resolve();

      const delegStartedAt = isDelegation ? Date.now() : -1;
      const delegIdx = isDelegation
        ? delegationRecords.push({ taskId, startedAt: delegStartedAt, success: false }) - 1
        : -1;

      const run = async (): Promise<void> => {
        let status: TaskRecord["status"] = "completed";

        try {
          await bp.acquire(taskId, tier, priority);

          // Track queue metrics
          const qs = bp.getStatus();
          if (qs.queueLength > maxQueueLength) maxQueueLength = qs.queueLength;
          if (qs.queueLength > 0 && lastQueueLength === 0) activationCount++;
          lastQueueLength = qs.queueLength;

          try {
            // Simulate LLM call
            await setup.provider.chat({
              messages: [{ role: "user", content: "benchmark task" }],
            });

            // Simulate tool calls
            for (let i = 0; i < setup.config.toolCallsPerTask; i++) {
              await setup.registry.callTool("mock_read", {});
            }

            // Simulate delegation for T1/T2 agents with delegatesTo
            if (
              !isDelegation &&
              setup.config.delegatesTo !== undefined &&
              setup.config.delegatesTo.length > 0
            ) {
              const delegIds = setup.config.delegatesTo;
              const delegId = delegIds[Math.floor(Math.random() * delegIds.length)];
              if (delegId !== undefined) {
                const delegSetup = fleet.get(delegId);
                if (delegSetup !== undefined) {
                  const delegTier = `T${delegSetup.definition.tier}`;
                  inFlight.push(submitTask(delegId, delegTier, "normal", true));
                }
              }
            }

            if (isDelegation && delegIdx >= 0) {
              const rec = delegationRecords[delegIdx];
              if (rec !== undefined) {
                rec.completedAt = Date.now();
                rec.success = true;
              }
            }
          } catch (execErr) {
            status = "failed";

            // Dead worker recovery tracking
            if (crashedAgents.has(agentId)) {
              deadWorkerRecoveries++;
              crashedAgents.delete(agentId);
            }

            if (isDelegation && delegIdx >= 0) {
              const rec = delegationRecords[delegIdx];
              if (rec !== undefined) rec.completedAt = Date.now();
            }
          } finally {
            bp.release(tier);
          }
        } catch (acquireErr) {
          if (acquireErr instanceof BackpressureError) {
            status = "rejected";
            totalRejects++;
          } else {
            status = "failed";
          }
        }

        taskRecords.push({
          agentId,
          tier,
          startedAt: taskStart,
          completedAt: Date.now(),
          status,
          isDelegation,
        });
      };

      return run();
    };

    // ---------------------------------------------------------------------------
    // Process failure events
    // ---------------------------------------------------------------------------

    const processFailureEvents = (elapsed: number): void => {
      const events = injector.tick(elapsed);
      for (const event of events) {
        if (event.type === "queue-flood") {
          // Flood T3 workers
          for (const [agentId, setup] of fleet.entries()) {
            if (setup.definition.tier === "T3") {
              for (let i = 0; i < 40; i++) {
                inFlight.push(submitTask(agentId, "T3", "low", false));
              }
            }
          }
          continue;
        }

        const targets =
          event.target === "all"
            ? Array.from(fleet.keys())
            : [event.target];

        for (const agentId of targets) {
          const setup = fleet.get(agentId);
          if (setup === undefined) continue;

          if (event.action === "start") {
            if (event.type === "agent-crash") {
              setup.provider.setCrashed(true);
              crashedAgents.add(agentId);
            } else if (event.type === "mcp-timeout") {
              setup.registry.setTimedOut(true);
            } else if (event.type === "budget-exhaust") {
              setup.provider.setBudgetExhausted(true);
            }
          } else {
            if (event.type === "agent-crash") {
              setup.provider.setCrashed(false);
              if (crashedAgents.has(agentId)) {
                deadWorkerRecoveries++;
                crashedAgents.delete(agentId);
              }
            } else if (event.type === "mcp-timeout") {
              setup.registry.setTimedOut(false);
            } else if (event.type === "budget-exhaust") {
              setup.provider.setBudgetExhausted(false);
            }
          }
        }
      }
    };

    // ---------------------------------------------------------------------------
    // Load generator loop
    // ---------------------------------------------------------------------------

    while (Date.now() - startTime < scenario.durationMs) {
      const elapsed = Date.now() - startTime;

      processFailureEvents(elapsed);

      // Freeze window
      if (
        scenario.freezeAtMs !== undefined &&
        scenario.resumeAtMs !== undefined &&
        elapsed >= scenario.freezeAtMs &&
        elapsed < scenario.resumeAtMs
      ) {
        await sleep(20);
        continue;
      }

      // Calculate current submission rate with ramp-up
      const rampFactor = scenario.rampUpMs <= 0 ? 1 : Math.min(1, elapsed / scenario.rampUpMs);
      const currentRate = scenario.targetTasksPerSecond * rampFactor;
      const intervalMs = currentRate > 0 ? 1000 / currentRate : 1000;

      const gen = weightedPick(scenario.taskGenerators);
      const setup = fleet.get(gen.agentId);
      if (setup !== undefined) {
        const tier = `T${setup.definition.tier}`;
        inFlight.push(submitTask(gen.agentId, tier, gen.priority, false));
      }

      await sleep(intervalMs);
    }

    // Drain in-flight tasks (with a generous cap so tests don't hang)
    await Promise.allSettled(inFlight);

    bp.stop();

    const endTime = Date.now();
    const actualDurationMs = endTime - startTime;

    // ---------------------------------------------------------------------------
    // Build result
    // ---------------------------------------------------------------------------

    const completed  = taskRecords.filter((r) => r.status === "completed" && !r.isDelegation);
    const failed     = taskRecords.filter((r) => r.status === "failed"    && !r.isDelegation);
    const rejected   = taskRecords.filter((r) => r.status === "rejected"  && !r.isDelegation);
    const allPrimary = taskRecords.filter((r) => !r.isDelegation);

    const completedLatencies = completed.map((r) => r.completedAt - r.startedAt);
    const latency = calculatePercentiles(completedLatencies);

    const totalPrimary = allPrimary.length;
    const successRate =
      totalPrimary > 0 ? Math.round((completed.length / totalPrimary) * 100 * 10) / 10 : 0;

    const throughput =
      actualDurationMs > 0
        ? Math.round((completed.length / (actualDurationMs / 1000)) * 10) / 10
        : 0;

    // Per-agent stats
    const perAgent: BenchmarkResult["perAgent"] = {};
    for (const config of scenario.fleet) {
      const agentRecords = taskRecords.filter((r) => r.agentId === config.id && !r.isDelegation);
      const agentCompleted = agentRecords.filter((r) => r.status === "completed");
      const avgLat =
        agentCompleted.length > 0
          ? Math.round(
              agentCompleted.reduce((s, r) => s + (r.completedAt - r.startedAt), 0) /
                agentCompleted.length,
            )
          : 0;

      perAgent[config.id] = {
        tasks:         agentRecords.length,
        completed:     agentCompleted.length,
        failed:        agentRecords.filter((r) => r.status === "failed").length,
        avgLatencyMs:  avgLat,
        budgetUsed:    agentCompleted.length * 0.001, // mock: 0.001 USD per completed task
      };
    }

    // Delegation stats
    const delegCompleted = delegationRecords.filter((d) => d.success);
    const delegFailed    = delegationRecords.filter((d) => !d.success && d.completedAt !== undefined);
    const delegDurations = delegCompleted.map((d) =>
      (d.completedAt ?? 0) - d.startedAt,
    );
    const avgDelegDuration =
      delegDurations.length > 0
        ? Math.round(delegDurations.reduce((s, v) => s + v, 0) / delegDurations.length)
        : 0;

    return {
      scenario: scenario.name,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date(endTime).toISOString(),
      durationMs: actualDurationMs,
      summary: {
        totalTasks:     totalPrimary,
        completedTasks: completed.length,
        failedTasks:    failed.length,
        rejectedTasks:  rejected.length,
        timedOutTasks:  0,
        successRate,
        throughput,
      },
      latency,
      backpressure: {
        maxQueueLength,
        totalRejects,
        activationCount,
      },
      deadWorkerRecoveries,
      delegations: {
        total:          delegationRecords.length,
        successful:     delegCompleted.length,
        failed:         delegFailed.length,
        avgDurationMs:  avgDelegDuration,
      },
      failureInjection: {
        injected:     injector.getFiredNames(),
        recovered:    injector.getRecoveredNames(),
        notRecovered: injector.getUnrecoveredNames(),
      },
      perAgent,
    };
  }
}
