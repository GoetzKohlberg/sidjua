// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Mock Agent Factory
 *
 * Creates mock agents with configurable behavior for benchmark load testing.
 * Uses timer-based simulation — no real LLM or MCP calls.
 */

import type {
  ProviderAdapter,
  LLMRequest,
  LLMResponse,
  ToolLLMResponse,
  ToolDefinition,
  ModelDefinition,
} from "../providers/types.js";
import type { AgentDefinition } from "../core/agents/definition-loader.js";
import type { McpTool, McpToolResult } from "../core/mcp/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MockAgentConfig {
  id: string;
  tier: "T1" | "T2" | "T3";
  division: string;
  /** Simulated LLM response time in ms. */
  responseDelayMs: number;
  /** 0.0–1.0 probability that a task throws an error. */
  failureRate: number;
  /** Average number of tool calls included in each chat response. */
  toolCallsPerTask: number;
  /** Simulated MCP tool call latency in ms. */
  toolCallDelayMs: number;
  /** For T1/T2 agents: IDs of agents to which tasks may be delegated. */
  delegatesTo?: string[];
}

export interface MockAgentSetup {
  config: MockAgentConfig;
  definition: AgentDefinition;
  provider: MockLlmProvider;
  registry: MockMcpRegistry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tierNum(tier: "T1" | "T2" | "T3"): 1 | 2 | 3 {
  return tier === "T1" ? 1 : tier === "T2" ? 2 : 3;
}

// ---------------------------------------------------------------------------
// MockLlmProvider
// ---------------------------------------------------------------------------

/** Implements ProviderAdapter using configurable timer-based simulation. */
export class MockLlmProvider implements ProviderAdapter {
  readonly providerName = "mock";
  readonly defaultModel: string;

  private _crashed = false;
  private _budgetExhausted = false;

  constructor(private readonly _config: MockAgentConfig) {
    this.defaultModel = `mock-model-${_config.id}`;
  }

  /** Failure injection: simulate process crash. */
  setCrashed(crashed: boolean): void {
    this._crashed = crashed;
  }

  /** Failure injection: simulate budget exhaustion. */
  setBudgetExhausted(exhausted: boolean): void {
    this._budgetExhausted = exhausted;
  }

  async chat(_request: LLMRequest): Promise<LLMResponse> {
    await sleep(this._config.responseDelayMs);

    if (this._crashed) {
      throw new Error(`Agent ${this._config.id} is not responding (simulated crash)`);
    }
    if (this._budgetExhausted) {
      throw new Error(`Budget exhausted for agent ${this._config.id}`);
    }
    if (this._config.failureRate > 0 && Math.random() < this._config.failureRate) {
      throw new Error(`Agent ${this._config.id} task failed (simulated random failure)`);
    }

    return {
      content: `Mock response from ${this._config.id}`,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      finishReason: "stop",
      latencyMs: this._config.responseDelayMs,
      model: this.defaultModel,
      provider: this.providerName,
    };
  }

  async chatWithTools(request: LLMRequest, tools: ToolDefinition[]): Promise<ToolLLMResponse> {
    const base = await this.chat(request);
    const count = Math.min(this._config.toolCallsPerTask, tools.length);
    const toolCalls = tools.slice(0, count).map((t, i) => ({
      id: `mock-tc-${i}`,
      name: t.name,
      input: { mock: true } as Record<string, unknown>,
    }));
    return { ...base, toolCalls, textContent: base.content };
  }

  estimateTokens(_messages: LLMRequest["messages"]): number {
    return 200;
  }

  getModels(): ModelDefinition[] {
    return [
      {
        id: this.defaultModel,
        displayName: `Mock Model (${this._config.id})`,
        contextWindow: 100_000,
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// MockMcpRegistry
// ---------------------------------------------------------------------------

/** Duck-typed mock registry — same interface as McpRegistry, no inheritance. */
export class MockMcpRegistry {
  private _timedOut = false;

  constructor(private readonly _toolCallDelayMs: number) {}

  /** Failure injection: make all tool calls fail immediately. */
  setTimedOut(timedOut: boolean): void {
    this._timedOut = timedOut;
  }

  async getToolsForAgent(
    _agentId: string,
    _division: string,
    _tier: string,
  ): Promise<McpTool[]> {
    return [
      { name: "mock_read",  description: "Read mock data",  inputSchema: { type: "object", properties: {} } },
      { name: "mock_write", description: "Write mock data", inputSchema: { type: "object", properties: {} } },
      { name: "mock_query", description: "Query mock data", inputSchema: { type: "object", properties: {} } },
    ];
  }

  async callTool(
    _toolName: string,
    _args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    if (this._timedOut) {
      throw new Error("MCP tool call timeout (simulated)");
    }
    await sleep(this._toolCallDelayMs);
    return {
      content: [{ type: "text", text: "mock result" }],
      isError: false,
    };
  }
}

// ---------------------------------------------------------------------------
// MockAgentFactory
// ---------------------------------------------------------------------------

export class MockAgentFactory {
  /** Create a mock LLM provider with the given config. */
  static createMockProvider(config: MockAgentConfig): MockLlmProvider {
    return new MockLlmProvider(config);
  }

  /** Create a mock MCP registry with a fixed tool call latency. */
  static createMockMcpRegistry(toolCallDelayMs: number): MockMcpRegistry {
    return new MockMcpRegistry(toolCallDelayMs);
  }

  /** Create a complete mock agent: definition + provider + registry. */
  static createAgent(config: MockAgentConfig): MockAgentSetup {
    const provider = new MockLlmProvider(config);
    const registry = new MockMcpRegistry(config.toolCallDelayMs);

    const baseDefinition = {
      id: config.id,
      name: `Mock Agent ${config.id}`,
      tier: tierNum(config.tier),
      division: config.division,
      model: `mock-model-${config.id}`,
      capabilities: ["mock"],
      budget: { daily_usd: 100, per_task_usd: 1.0 },
    } satisfies Omit<AgentDefinition, "can_delegate_to">;

    const definition: AgentDefinition =
      config.delegatesTo !== undefined
        ? { ...baseDefinition, can_delegate_to: config.delegatesTo }
        : baseDefinition;

    return { config, definition, provider, registry };
  }

  /** Create a fleet of agents keyed by agent ID. */
  static createFleet(configs: MockAgentConfig[]): Map<string, MockAgentSetup> {
    const fleet = new Map<string, MockAgentSetup>();
    for (const config of configs) {
      fleet.set(config.id, MockAgentFactory.createAgent(config));
    }
    return fleet;
  }
}

// ---------------------------------------------------------------------------
// Pre-built fleet configurations
// ---------------------------------------------------------------------------

export const FLEET_SMALL: MockAgentConfig[] = [
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

export const FLEET_MEDIUM: MockAgentConfig[] = [
  { id: "exec-1", tier: "T1", division: "mgmt",    responseDelayMs: 200, failureRate: 0,    toolCallsPerTask: 2, toolCallDelayMs: 50 },
  { id: "mgr-1",  tier: "T2", division: "hr",      responseDelayMs: 150, failureRate: 0.02, toolCallsPerTask: 1, toolCallDelayMs: 50 },
  { id: "mgr-2",  tier: "T2", division: "ops",     responseDelayMs: 155, failureRate: 0.02, toolCallsPerTask: 1, toolCallDelayMs: 50 },
  { id: "mgr-3",  tier: "T2", division: "finance", responseDelayMs: 160, failureRate: 0.03, toolCallsPerTask: 2, toolCallDelayMs: 50 },
  { id: "w-1",    tier: "T3", division: "ops",     responseDelayMs: 80,  failureRate: 0.05, toolCallsPerTask: 3, toolCallDelayMs: 25 },
  { id: "w-2",    tier: "T3", division: "ops",     responseDelayMs: 90,  failureRate: 0.05, toolCallsPerTask: 2, toolCallDelayMs: 25 },
  { id: "w-3",    tier: "T3", division: "hr",      responseDelayMs: 100, failureRate: 0.04, toolCallsPerTask: 2, toolCallDelayMs: 30 },
  { id: "w-4",    tier: "T3", division: "hr",      responseDelayMs: 110, failureRate: 0.06, toolCallsPerTask: 1, toolCallDelayMs: 30 },
  { id: "w-5",    tier: "T3", division: "finance", responseDelayMs: 120, failureRate: 0.03, toolCallsPerTask: 3, toolCallDelayMs: 35 },
  { id: "w-6",    tier: "T3", division: "finance", responseDelayMs: 95,  failureRate: 0.05, toolCallsPerTask: 2, toolCallDelayMs: 30 },
  { id: "w-7",    tier: "T3", division: "ops",     responseDelayMs: 85,  failureRate: 0.07, toolCallsPerTask: 1, toolCallDelayMs: 20 },
  { id: "w-8",    tier: "T3", division: "ops",     responseDelayMs: 105, failureRate: 0.04, toolCallsPerTask: 2, toolCallDelayMs: 25 },
];

// 2 T1, 5 T2, 25 T3 = 32 agents
const DIVISIONS = ["ops", "hr", "finance", "it", "legal"] as const;

export const FLEET_LARGE: MockAgentConfig[] = [
  { id: "exec-a", tier: "T1", division: "mgmt", responseDelayMs: 200, failureRate: 0,    toolCallsPerTask: 2, toolCallDelayMs: 50 },
  { id: "exec-b", tier: "T1", division: "mgmt", responseDelayMs: 220, failureRate: 0,    toolCallsPerTask: 1, toolCallDelayMs: 50 },
  ...Array.from({ length: 5 }, (_, i): MockAgentConfig => ({
    id: `lmgr-${i + 1}`,
    tier: "T2",
    division: DIVISIONS[i] ?? "ops",
    responseDelayMs: 150 + i * 10,
    failureRate: 0.02 + i * 0.005,
    toolCallsPerTask: 1 + (i % 2),
    toolCallDelayMs: 50,
  })),
  ...Array.from({ length: 25 }, (_, i): MockAgentConfig => ({
    id: `lworker-${i + 1}`,
    tier: "T3",
    division: DIVISIONS[i % 5] ?? "ops",
    responseDelayMs: 80 + (i % 5) * 15,
    failureRate: 0.03 + (i % 3) * 0.02,
    toolCallsPerTask: 1 + (i % 3),
    toolCallDelayMs: 20 + (i % 4) * 10,
  })),
];
