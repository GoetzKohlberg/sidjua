// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Agent System Lifecycle Controller
 *
 * Manages cooperative freeze/resume for the blue/green update mechanism.
 * Agents poll getSystemState() and checkpoint before transitioning to FROZEN.
 */

import { createLogger } from "../logger.js";

const logger = createLogger("agent-lifecycle");

export type SystemState = "RUNNING" | "FREEZING" | "FROZEN";

let systemState: SystemState = "RUNNING";
const stateListeners: Array<(state: SystemState) => void> = [];

// Injected dependencies — set via wireAgentLifecycle()
let _getActiveAgentCount: () => number     = () => 0;
let _resumeAllAgents:     () => Promise<number> = async () => 0;

/**
 * Wire in the agent runtime functions.
 * Must be called before freeze/resume are used.
 */
export function wireAgentLifecycle(
  getCount: () => number,
  resumeAll: () => Promise<number>,
): void {
  _getActiveAgentCount = getCount;
  _resumeAllAgents     = resumeAll;
}

/** Returns the current system state. */
export function getSystemState(): SystemState {
  return systemState;
}

/** Returns the count of currently active (non-idle, non-frozen) agents. */
export function getActiveAgentCount(): number {
  return _getActiveAgentCount();
}

/** Subscribe to system state changes. */
export function onStateChange(listener: (state: SystemState) => void): void {
  stateListeners.push(listener);
}

/** Remove a state change listener. */
export function offStateChange(listener: (state: SystemState) => void): void {
  const idx = stateListeners.indexOf(listener);
  if (idx !== -1) stateListeners.splice(idx, 1);
}

function notifyListeners(): void {
  for (const listener of stateListeners) {
    try {
      listener(systemState);
    } catch (err: unknown) {
      logger.warn("agent-lifecycle", "State listener threw", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

/**
 * Request a cooperative freeze of all agents.
 * Idempotent — returns current state if already FREEZING or FROZEN.
 */
export async function handleFreeze(): Promise<{ state: SystemState; activeAgents: number }> {
  if (systemState === "FREEZING" || systemState === "FROZEN") {
    return { state: systemState, activeAgents: _getActiveAgentCount() };
  }
  systemState = "FREEZING";
  notifyListeners();
  logger.info("agent-lifecycle", "System freeze requested", {
    metadata: { activeAgents: _getActiveAgentCount() },
  });
  return { state: systemState, activeAgents: _getActiveAgentCount() };
}

/**
 * Mark the system as fully frozen (called when all agents have checkpointed).
 */
export function markFrozen(): void {
  if (systemState === "FREEZING") {
    systemState = "FROZEN";
    notifyListeners();
    logger.info("agent-lifecycle", "System is now FROZEN");
  }
}

/**
 * Resume all agents after a freeze.
 * Idempotent — returns current state if already RUNNING.
 */
export async function handleResume(): Promise<{ state: SystemState; resumedAgents: number }> {
  if (systemState === "RUNNING") {
    return { state: systemState, resumedAgents: 0 };
  }
  systemState = "RUNNING";
  notifyListeners();
  logger.info("agent-lifecycle", "System resume requested");
  const resumed = await _resumeAllAgents();
  return { state: systemState, resumedAgents: resumed };
}

/** Reset lifecycle state — for tests only. */
export function _resetLifecycleState(): void {
  systemState = "RUNNING";
  stateListeners.length = 0;
  _getActiveAgentCount = () => 0;
  _resumeAllAgents     = async () => 0;
}
