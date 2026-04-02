// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Bouncer Configuration Reader
 *
 * Reads bouncer settings from the workspace_config table.
 * Returns safe defaults when the DB is unavailable.
 */

import type { Database }        from "../../utils/db.js";
import type { SensitivityLevel } from "./bouncer-types.js";

export interface BouncerConfig {
  enabled:     boolean;
  sensitivity: SensitivityLevel;
}

const DEFAULT_CONFIG: BouncerConfig = {
  enabled:     true,
  sensitivity: "normal",
};

/**
 * Read bouncer configuration from the workspace_config table.
 *
 * Falls back to defaults if the DB is null or the rows are missing.
 */
export function getBouncerConfig(db: Database | null): BouncerConfig {
  if (db === null) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const rows = db.prepare(
      "SELECT key, value FROM workspace_config WHERE key IN ('bouncer_enabled', 'bouncer_sensitivity')",
    ).all() as Array<{ key: string; value: string }>;

    const map = new Map(rows.map((r) => [r.key, r.value]));

    const enabledRaw     = map.get("bouncer_enabled");
    const sensitivityRaw = map.get("bouncer_sensitivity");

    const enabled = enabledRaw !== undefined
      ? enabledRaw !== "false" && enabledRaw !== "0"
      : DEFAULT_CONFIG.enabled;

    const validLevels: SensitivityLevel[] = ["strict", "normal", "relaxed"];
    const sensitivity: SensitivityLevel = (
      sensitivityRaw !== undefined && validLevels.includes(sensitivityRaw as SensitivityLevel)
        ? sensitivityRaw as SensitivityLevel
        : DEFAULT_CONFIG.sensitivity
    );

    return { enabled, sensitivity };
  } catch (_err: unknown) {
    return { ...DEFAULT_CONFIG };
  }
}
