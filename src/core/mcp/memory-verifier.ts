// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP Memory Verifier
 *
 * Verify-before-act gate: inspects tool arguments for file path references
 * and confirms they exist within the workDir boundary before the tool is called.
 *
 * Only string values that look like absolute or relative file paths are checked.
 * Values that look like hashes, UUIDs, or plain strings are skipped.
 *
 * Returns `valid: false` + the list of invalid references if any check fails,
 * so the caller can block the tool call and surface a useful error message.
 */

import { access, realpath } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("memory-verifier");

/** Minimum path-like pattern: at least one slash or starts with ./ */
const PATH_LIKE_RE = /^\.?\.?[\\/]|^\/[^\s]/;

export interface VerifyResult {
  valid:       boolean;
  /** File paths from tool args that could not be verified. */
  invalidRefs: string[];
}

/**
 * Collect all string values from `args` that look like file paths.
 * Recurses one level into nested objects/arrays.
 */
function extractPathCandidates(args: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === "string" && PATH_LIKE_RE.test(value)) {
      candidates.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && PATH_LIKE_RE.test(item)) {
          candidates.push(item);
        }
      }
    } else if (value !== null && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      for (const v of Object.values(nested)) {
        if (typeof v === "string" && PATH_LIKE_RE.test(v)) {
          candidates.push(v);
        }
      }
    }
  }
  return candidates;
}

/**
 * Verify that path-like arguments in a tool call:
 *  1. Exist on the filesystem (fs.access).
 *  2. Resolve within `workDir` (symlink-safe via realpath).
 *
 * Returns `{ valid: true, invalidRefs: [] }` when no path-like args are found
 * or all paths are valid. When `workDir` is not provided, only file existence
 * is checked (no boundary enforcement).
 */
export async function verifyMemoryReferences(
  args:    Record<string, unknown>,
  workDir: string,
): Promise<VerifyResult> {
  const candidates = extractPathCandidates(args);
  if (candidates.length === 0) return { valid: true, invalidRefs: [] };

  const invalid: string[] = [];

  for (const candidate of candidates) {
    const abs = isAbsolute(candidate) ? candidate : resolve(workDir, candidate);

    // Existence check
    try {
      await access(abs);
    } catch (_e) {
      invalid.push(candidate);
      continue;
    }

    // Boundary check via realpath (resolves symlinks)
    try {
      const real    = await realpath(abs);
      const realDir = await realpath(workDir);
      if (!real.startsWith(realDir + "/") && real !== realDir) {
        logger.warn("memory_verifier_boundary", "Path escapes workDir", {
          metadata: { path: candidate, resolved: real, workDir },
        });
        invalid.push(candidate);
      }
    } catch (_e) {
      // realpath failed — treat as invalid
      invalid.push(candidate);
    }
  }

  return {
    valid:       invalid.length === 0,
    invalidRefs: invalid,
  };
}
