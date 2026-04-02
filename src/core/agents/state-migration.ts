// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Agent State Migration
 *
 * Migrates agent checkpoints when the app version changes between blue and green slots.
 * Returns null if the checkpoint is incompatible with the current version.
 */

import type { AgentCheckpoint } from "./checkpoint.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agent-state-migration");

/**
 * Migrate an agent checkpoint to the current app version.
 *
 * @param checkpoint    The checkpoint to migrate
 * @param currentVersion  The currently running app version
 * @returns The migrated checkpoint, or null if migration is impossible
 */
export async function migrateAgentState(
  checkpoint:      AgentCheckpoint,
  currentVersion:  string,
): Promise<AgentCheckpoint | null> {
  if (checkpoint.version === currentVersion) {
    return checkpoint; // no migration needed
  }

  logger.info("agent-state-migration", "Migrating agent checkpoint", {
    metadata: {
      agentId:     checkpoint.id,
      fromVersion: checkpoint.version,
      toVersion:   currentVersion,
    },
  });

  // Version-specific migrations are added here as the platform evolves.
  // Default: update the version field and preserve all other state.
  // Return null only if the checkpoint format is truly incompatible.
  return { ...checkpoint, version: currentVersion };
}
