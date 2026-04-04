// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — OpenClaw path validator.
 *
 * Checks that a given directory looks like an OpenClaw installation
 * before parsing or importing. Never writes — read-only analysis.
 */

import { createLogger } from "../logger.js";
import * as fs   from "node:fs";
import * as path from "node:path";

const logger = createLogger("openclaw-validators");

export interface ValidationResult {
  valid: boolean;
  path: string;
  found: {
    agents:    boolean;
    soul:      boolean;
    memory:    boolean;
    heartbeat: boolean;
    config:    boolean;
    clawhub:   boolean;
  };
  errors: string[];
}

/**
 * Validate that the given path is a readable OpenClaw installation directory.
 *
 * Resolves `~` against HOME. Does not write anything.
 */
export function validateOpenClawPath(installPath: string): ValidationResult {
  const resolved = installPath.startsWith("~")
    ? path.join(process.env["HOME"] ?? "/home/user", installPath.slice(1))
    : path.resolve(installPath);

  const result: ValidationResult = {
    valid: false,
    path:  resolved,
    found: {
      agents:    false,
      soul:      false,
      memory:    false,
      heartbeat: false,
      config:    false,
      clawhub:   false,
    },
    errors: [],
  };

  if (!fs.existsSync(resolved)) {
    result.errors.push(`Path does not exist: ${resolved}`);
    return result;
  }

  try {
    if (!fs.statSync(resolved).isDirectory()) {
      result.errors.push(`Path is not a directory: ${resolved}`);
      return result;
    }
  } catch (err) {
    result.errors.push(`Cannot stat path: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  result.found.agents    = fs.existsSync(path.join(resolved, "AGENTS.md"));
  result.found.soul      = fs.existsSync(path.join(resolved, "SOUL.md"));
  result.found.memory    = fs.existsSync(path.join(resolved, "MEMORY.md"));
  result.found.heartbeat = fs.existsSync(path.join(resolved, "HEARTBEAT.md"));
  result.found.config    = fs.existsSync(path.join(resolved, "config.yaml"))
                        || fs.existsSync(path.join(resolved, ".env"));
  result.found.clawhub   = fs.existsSync(path.join(resolved, ".clawhub"));

  if (!result.found.agents) {
    result.errors.push("AGENTS.md not found — this may not be an OpenClaw installation");
    logger.debug("openclaw-validators", "AGENTS.md missing at path", { metadata: { resolved } });
  }

  result.valid = result.found.agents;
  return result;
}
