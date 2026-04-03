// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Orchestrator bootstrap
 *
 * Shared factory for starting OrchestratorProcess from an orchestrator.yaml config.
 * Used by both `sidjua start` (foreground) and `sidjua server start` (Docker/API-only).
 *
 * GOVERNANCE GUARANTEE: Every API server path MUST call bootstrapOrchestrator before
 * accepting requests. Starting the HTTP server without a running orchestrator is a
 * governance violation — tasks would be accepted but never processed or audited.
 */

import { join }                        from "node:path";
import { OrchestratorProcess }         from "./orchestrator.js";
import { TaskEventBus }                from "../tasks/event-bus.js";
import { DEFAULT_DELEGATION_RULES }    from "./types.js";
import type { OrchestratorConfig, OrchestratorConfigRaw } from "./types.js";
import type { Database }               from "../utils/db.js";
import { readYamlFile }                from "../utils/yaml.js";
import { createLogger }                from "../core/logger.js";
import { OrchestratorConfigRawSchema, parseAndValidateYamlSafe } from "../core/schemas/index.js";
import { initTaskEventBridge }         from "../core/activity/bridges/task-event-bridge.js";
import { ToolRegistry }                from "../tool-integration/tool-registry.js";
import { ToolManager }                 from "../tool-integration/tool-manager.js";
import { InternalToolAdapter }         from "../tool-integration/adapters/internal-adapter.js";
import { ALL_INTERNAL_TOOLS }          from "../tool-integration/internal/index.js";
import { setAuditToolDb }              from "../tool-integration/internal/audit-trail.js";
import { setBudgetToolDb }             from "../tool-integration/internal/read-budget.js";
import { setSpendingToolDb }           from "../tool-integration/internal/read-spending.js";
import { setWriteBudgetToolDb }        from "../tool-integration/internal/write-budget.js";
import { setKnowledgeSearchDb }        from "../tool-integration/internal/search-knowledge-base.js";
import { setDocumentsToolDb }          from "../tool-integration/internal/list-documents.js";
import { loadMcpConfig }               from "../tool-integration/mcp-config.js";
import { McpLifecycleManager }         from "../tool-integration/mcp-lifecycle.js";
import { toolCallRouter }              from "../tool-integration/tool-call-router.js";

const logger = createLogger("orchestrator-bootstrap");

export interface OrchestratorBootstrapDeps {
  /** Open, writable database connection (must remain open for orchestrator lifetime). */
  db: Database;
  /** SIDJUA workspace root (parent of .system/, governance/, defaults/, etc.). */
  workDir: string;
  /** Absolute path to orchestrator.yaml. May not exist — defaults are used when absent. */
  configPath: string;
}

/**
 * Build and start an OrchestratorProcess from an orchestrator.yaml config.
 *
 * Falls back to safe production defaults when orchestrator.yaml is absent or
 * partially specified. Throws if OrchestratorProcess.start() fails — callers
 * MUST NOT start the HTTP server without a running orchestrator.
 *
 * @throws Error if orchestrator startup fails (sandbox init, etc.)
 */
export async function bootstrapOrchestrator(
  deps: OrchestratorBootstrapDeps,
): Promise<OrchestratorProcess> {
  const { db, workDir, configPath } = deps;
  const governanceRoot = join(workDir, "governance");

  let raw: OrchestratorConfigRaw = {};
  try {
    const parsed = readYamlFile(configPath) as unknown;
    const validated = parseAndValidateYamlSafe(OrchestratorConfigRawSchema, parsed);
    if (validated.success) {
      raw = validated.data as OrchestratorConfigRaw;
    } else {
      logger.warn("orchestrator-bootstrap", "orchestrator.yaml failed schema validation — using defaults", {});
    }
  } catch (_e) {
    // Non-fatal: orchestrator.yaml may not exist yet (first run before `sidjua apply`)
    logger.info("orchestrator-bootstrap", "orchestrator.yaml not found — using defaults", {});
  }

  // OrchestratorConfigRaw uses string keys for YAML compatibility;
  // OrchestratorConfig requires number keys.
  const maxPerTier: Record<number, number> = raw.max_agents_per_tier
    ? Object.fromEntries(
        Object.entries(raw.max_agents_per_tier).map(([k, v]) => [Number(k), v]),
      )
    : { 1: 2, 2: 6, 3: 16 };

  const config: OrchestratorConfig = {
    max_agents:             raw.max_agents ?? 20,
    max_agents_per_tier:    maxPerTier,
    event_poll_interval_ms: raw.event_poll_interval_ms ?? 500,
    delegation_timeout_ms:  raw.delegation_timeout_ms ?? 30_000,
    synthesis_timeout_ms:   raw.synthesis_timeout_ms ?? 60_000,
    max_tree_depth:         raw.max_tree_depth ?? 3,
    max_tree_breadth:       raw.max_tree_breadth ?? 8,
    default_division:       raw.default_division ?? "general",
    agent_definitions:      [],
    governance_root:        governanceRoot,
    delegation_rules:       raw.delegation_rules ?? DEFAULT_DELEGATION_RULES,
  };

  const eventBus    = new TaskEventBus(db);
  initTaskEventBridge(eventBus);
  const orchestrator = new OrchestratorProcess(db, eventBus, config);

  logger.info("orchestrator-bootstrap", "Starting orchestrator", {
    metadata: { governance_root: governanceRoot, max_agents: config.max_agents },
  });

  // This throws on failure (sandbox init error, DB error, etc.)
  // Callers must handle the error and NOT start the HTTP server.
  await orchestrator.start();

  logger.info("orchestrator-bootstrap", "Orchestrator running", {});

  // Register internal (native) tools — best-effort, non-fatal
  try {
    const registry    = new ToolRegistry(db);
    const toolManager = new ToolManager(db, registry);
    // Inject DB references for tools that query the database directly
    setAuditToolDb(db);
    setBudgetToolDb(db);
    setSpendingToolDb(db);
    setWriteBudgetToolDb(db);
    setDocumentsToolDb(db);    // list-documents
    setKnowledgeSearchDb(db);  // enable FTS fallback search in search-knowledge-base
    registerInternalTools(registry, toolManager);

    // Register and start MCP servers from config — best-effort, non-fatal
    const mcpConfig    = loadMcpConfig(join(workDir, "config", "mcp-servers.yaml"));
    const mcpLifecycle = new McpLifecycleManager(toolManager, mcpConfig.settings);
    registerMcpServers(registry, mcpConfig.servers);
    mcpLifecycle.registerServers(mcpConfig.servers);
    mcpLifecycle.startIdleWatcher();

    // Wire tool call router so agents can dispatch via toolCallRouter.createDispatcher()
    toolCallRouter.setDb(db);
    toolCallRouter.setToolManager(toolManager);
    toolCallRouter.setMcpLifecycle(mcpLifecycle);

    for (const entry of mcpConfig.servers.filter((s) => s.auto_start === true)) {
      mcpLifecycle.startServer(entry.id).catch((err: unknown) => {
        logger.warn("orchestrator-bootstrap", "MCP auto-start failed", {
          metadata: { id: entry.id, error: err instanceof Error ? err.message : String(err) },
        });
      });
    }
  } catch (_e) { /* non-fatal — orchestrator runs without tools if migrations haven't run */ }

  return orchestrator;
}

/**
 * Register MCP server entries into ToolRegistry so ToolManager.start() can find them.
 * Idempotent: skips servers already registered.
 */
export function registerMcpServers(
  registry: ToolRegistry,
  servers:  import("../tool-integration/mcp-config.js").McpServerEntry[],
): void {
  for (const entry of servers) {
    let exists = false;
    try { registry.getById(entry.id); exists = true; } catch (_e) { /* not found */ }
    if (!exists) {
      registry.create({
        id:   entry.id,
        name: entry.name,
        type: "mcp",
        config: {
          type:    "mcp",
          command: entry.command,
          ...(entry.args !== undefined ? { args: entry.args } : {}),
          ...(entry.env  !== undefined ? { env:  entry.env  } : {}),
        },
        capabilities: [],
      });
    }
  }
}

/**
 * Register all internal tool definitions into ToolRegistry + ToolManager.
 * Idempotent: skips tools that already exist in the registry.
 */
export function registerInternalTools(
  registry: ToolRegistry,
  toolManager: ToolManager,
): void {
  for (const def of ALL_INTERNAL_TOOLS) {
    // Check if already registered (getById throws if not found)
    let exists = false;
    try { registry.getById(def.id); exists = true; } catch (_e) { /* not found */ }

    if (!exists) {
      registry.create({
        id:   def.id,
        name: def.name,
        type: "composite",
        config: { type: "composite", sub_tools: [], strategy: "fallback" },
        capabilities: def.capabilities,
      });
    }

    const adapter = new InternalToolAdapter(def);
    toolManager.registerAdapter(def.id, adapter);
  }
}
