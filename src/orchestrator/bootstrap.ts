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
import { initTaskEventBridge }         from "../core/activity/bridges/task-event-bridge.js";

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
    raw = readYamlFile(configPath) as OrchestratorConfigRaw;
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
  return orchestrator;
}
