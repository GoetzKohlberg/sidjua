// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Benchmark Scenarios
 *
 * Pre-built load scenarios for the benchmark runner.
 */

import {
  type MockAgentConfig,
  FLEET_SMALL,
  FLEET_MEDIUM,
} from "./mock-agent-factory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskGenerator {
  /** Target agent ID in the fleet. */
  agentId: string;
  priority: "low" | "normal" | "high";
  /** Task content sent to the mock provider. */
  content: string;
  /** Relative frequency weight (1–10). Higher = more tasks to this agent. */
  weight: number;
}

export interface BenchmarkScenario {
  name: string;
  description: string;
  fleet: MockAgentConfig[];
  taskGenerators: TaskGenerator[];
  /** Total benchmark duration in ms. */
  durationMs: number;
  /** Ramp-up period: scale from 0 to full rate linearly over this many ms. */
  rampUpMs: number;
  /** Target task submission rate at full load (tasks/second). */
  targetTasksPerSecond: number;
  /**
   * Optional freeze window — simulates the P368 agent-freeze lifecycle.
   * Task generation pauses during [freezeAtMs, resumeAtMs).
   */
  freezeAtMs?: number;
  resumeAtMs?: number;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Short Burst (CI-safe smoke test)
// ---------------------------------------------------------------------------

export const SCENARIO_SHORT_BURST: BenchmarkScenario = {
  name: "short-burst",
  description: "Quick sanity check — 4 agents, 10s, 5 tasks/sec",
  fleet: FLEET_SMALL,
  durationMs: 10_000,
  rampUpMs: 0,
  targetTasksPerSecond: 5,
  taskGenerators: [
    { agentId: "worker-1", priority: "normal", content: "Benchmark task", weight: 4 },
    { agentId: "worker-2", priority: "normal", content: "Benchmark task", weight: 4 },
    { agentId: "hr",       priority: "normal", content: "HR query",       weight: 1 },
    { agentId: "ceo",      priority: "high",   content: "Executive task", weight: 1 },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 2 — Sustained Load (backpressure activation)
// ---------------------------------------------------------------------------

export const SCENARIO_SUSTAINED_LOAD: BenchmarkScenario = {
  name: "sustained-load",
  description: "12 agents, 60s, 10 tasks/sec — exercises backpressure queue behavior",
  fleet: FLEET_MEDIUM,
  durationMs: 60_000,
  rampUpMs: 5_000,
  targetTasksPerSecond: 10,
  taskGenerators: [
    { agentId: "w-1", priority: "normal", content: "Ops task 1",     weight: 3 },
    { agentId: "w-2", priority: "normal", content: "Ops task 2",     weight: 3 },
    { agentId: "w-3", priority: "normal", content: "HR task",        weight: 2 },
    { agentId: "w-4", priority: "low",    content: "HR batch task",  weight: 2 },
    { agentId: "w-5", priority: "normal", content: "Finance task",   weight: 2 },
    { agentId: "w-6", priority: "normal", content: "Finance audit",  weight: 2 },
    { agentId: "w-7", priority: "high",   content: "Urgent ops",     weight: 1 },
    { agentId: "w-8", priority: "normal", content: "Ops review",     weight: 1 },
    { agentId: "mgr-1", priority: "normal", content: "Manager task", weight: 1 },
    { agentId: "mgr-2", priority: "normal", content: "Manager task", weight: 1 },
    { agentId: "mgr-3", priority: "high",   content: "Finance mgr",  weight: 1 },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 3 — Spike Load (queue overflow + 503 responses)
// ---------------------------------------------------------------------------

export const SCENARIO_SPIKE_LOAD: BenchmarkScenario = {
  name: "spike-load",
  description: "4 agents, 30s, 0→20 tasks/sec spike in 5s — tests queue overflow",
  fleet: FLEET_SMALL,
  durationMs: 30_000,
  rampUpMs: 5_000,
  targetTasksPerSecond: 20,
  taskGenerators: [
    { agentId: "worker-1", priority: "normal", content: "Spike task", weight: 5 },
    { agentId: "worker-2", priority: "normal", content: "Spike task", weight: 5 },
    { agentId: "hr",       priority: "low",    content: "HR task",    weight: 2 },
    { agentId: "ceo",      priority: "high",   content: "CEO task",   weight: 1 },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 4 — Delegation Chain
// ---------------------------------------------------------------------------

const DELEGATION_FLEET: MockAgentConfig[] = [
  {
    id: "ceo",
    tier: "T1",
    division: "mgmt",
    responseDelayMs: 200,
    failureRate: 0,
    toolCallsPerTask: 2,
    toolCallDelayMs: 50,
    delegatesTo: ["hr", "worker-1", "worker-2"],
  },
  {
    id: "hr",
    tier: "T2",
    division: "hr",
    responseDelayMs: 150,
    failureRate: 0.02,
    toolCallsPerTask: 1,
    toolCallDelayMs: 50,
    delegatesTo: ["worker-1", "worker-2"],
  },
  {
    id: "worker-1",
    tier: "T3",
    division: "ops",
    responseDelayMs: 100,
    failureRate: 0.05,
    toolCallsPerTask: 3,
    toolCallDelayMs: 30,
  },
  {
    id: "worker-2",
    tier: "T3",
    division: "ops",
    responseDelayMs: 100,
    failureRate: 0.05,
    toolCallsPerTask: 2,
    toolCallDelayMs: 30,
  },
];

export const SCENARIO_DELEGATION_CHAIN: BenchmarkScenario = {
  name: "delegation-chain",
  description: "T1→T2→T3 delegation under load — 3 tasks/sec, budget tracking",
  fleet: DELEGATION_FLEET,
  durationMs: 30_000,
  rampUpMs: 0,
  targetTasksPerSecond: 3,
  taskGenerators: [
    { agentId: "ceo", priority: "high", content: "Delegating task", weight: 10 },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 5 — Freeze During Load
// ---------------------------------------------------------------------------

export const SCENARIO_FREEZE_DURING_LOAD: BenchmarkScenario = {
  name: "freeze-during-load",
  description: "4 agents, 30s, freeze at t=15s, resume at t=20s — test graceful pause",
  fleet: FLEET_SMALL,
  durationMs: 30_000,
  rampUpMs: 0,
  targetTasksPerSecond: 5,
  freezeAtMs: 15_000,
  resumeAtMs: 20_000,
  taskGenerators: [
    { agentId: "worker-1", priority: "normal", content: "Load task", weight: 4 },
    { agentId: "worker-2", priority: "normal", content: "Load task", weight: 4 },
    { agentId: "hr",       priority: "low",    content: "HR task",   weight: 1 },
    { agentId: "ceo",      priority: "high",   content: "CEO task",  weight: 1 },
  ],
};

// ---------------------------------------------------------------------------
// Exported catalog
// ---------------------------------------------------------------------------

export const SCENARIOS: BenchmarkScenario[] = [
  SCENARIO_SHORT_BURST,
  SCENARIO_SUSTAINED_LOAD,
  SCENARIO_SPIKE_LOAD,
  SCENARIO_DELEGATION_CHAIN,
  SCENARIO_FREEZE_DURING_LOAD,
];
