// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Agent Spawn Guard
 *
 * Prevents new agent tasks from being spawned while the system is FREEZING or FROZEN.
 * Agent runtime loops MUST call guardAgentSpawn() before starting a new task.
 *
 * Usage:
 *   if (!canSpawnAgent()) return; // silently skip
 *   guardAgentSpawn();            // throws SidjuaError if freeze in progress
 */

import { getSystemState } from "./lifecycle.js";
import { SidjuaError }    from "../error-codes.js";

/**
 * Returns true if the system is RUNNING and new agents may be spawned.
 * Returns false if the system is FREEZING or FROZEN.
 */
export function canSpawnAgent(): boolean {
  return getSystemState() === "RUNNING";
}

/**
 * Throws a SidjuaError (AGT-003) if the system is not RUNNING.
 * Call at the entry point of any agent task-start path.
 */
export function guardAgentSpawn(): void {
  const state = getSystemState();
  if (state !== "RUNNING") {
    throw SidjuaError.from(
      "AGT-002",
      `Agent spawn rejected — system is ${state}`,
    );
  }
}
