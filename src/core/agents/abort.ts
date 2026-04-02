// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Agent AbortController Registry
 *
 * Provides per-agent AbortControllers to gracefully cancel pending
 * external calls (fetch, tool calls) when the system is freezing.
 *
 * Agent loops MUST pass controller.signal to all fetch calls:
 *   await fetch(url, { signal: getAgentAbortController(agentId).signal });
 *
 * On freeze: call abortAgent(agentId) to cancel pending operations.
 * On resume: call resetAgentAbort(agentId) so the agent gets a fresh controller.
 */

const agentControllers = new Map<string, AbortController>();

/**
 * Get (or create) the AbortController for the given agent.
 * Creating a new controller is idempotent per-agent — same controller
 * is returned until explicitly reset via resetAgentAbort().
 */
export function getAgentAbortController(agentId: string): AbortController {
  let controller = agentControllers.get(agentId);
  if (controller === undefined) {
    controller = new AbortController();
    agentControllers.set(agentId, controller);
  }
  return controller;
}

/**
 * Abort the agent's current AbortController, cancelling any pending signals.
 * The controller is removed from the registry — a fresh one will be created
 * on the next call to getAgentAbortController().
 */
export function abortAgent(agentId: string): void {
  const controller = agentControllers.get(agentId);
  if (controller !== undefined) {
    controller.abort();
    agentControllers.delete(agentId);
  }
}

/**
 * Remove the agent's AbortController without aborting it.
 * Call this on resume so the agent gets a fresh controller for new operations.
 */
export function resetAgentAbort(agentId: string): void {
  agentControllers.delete(agentId);
}

/**
 * Returns a Promise that resolves when the abort signal fires, or rejects after timeout.
 * Useful for waiting until an operation should be cancelled.
 */
export function waitUntilAborted(agentId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const controller = getAgentAbortController(agentId);
    if (controller.signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`Abort wait timed out after ${timeoutMs}ms for agent ${agentId}`));
    }, timeoutMs);
    controller.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Clear all controllers — for tests only. */
export function _resetAllAgentAborts(): void {
  agentControllers.clear();
}
