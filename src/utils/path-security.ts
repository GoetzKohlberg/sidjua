// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Centralized path security utilities
 *
 * Provides safe path resolution and identifier validation to prevent
 * path traversal attacks across the codebase.
 *
 * resolveContainedPath — validates a relative path stays inside a base directory
 * validateSafeId       — rejects identifier strings unsafe for use as filenames
 */

import { isAbsolute, join, relative, resolve } from "node:path";
import { SidjuaError } from "../core/error-codes.js";


/**
 * Resolve and validate a relative path within a base directory.
 *
 * Rejects:
 *  - Absolute paths
 *  - Paths containing ".." components
 *  - Paths that resolve outside baseDir after normalization
 *
 * @returns The resolved absolute path (guaranteed within baseDir)
 * @throws SidjuaError SEC-010 if the path escapes baseDir
 */
export function resolveContainedPath(baseDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw SidjuaError.from(
      "SEC-010",
      `Path must be relative: "${relativePath}"`,
    );
  }

  // Normalize separators for the traversal component check
  const parts = relativePath.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "..")) {
    throw SidjuaError.from(
      "SEC-010",
      `Path traversal detected: "${relativePath}"`,
    );
  }

  const joined       = join(baseDir, relativePath);
  const resolvedPath = resolve(joined);
  const resolvedBase = resolve(baseDir);
  const rel          = relative(resolvedBase, resolvedPath);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw SidjuaError.from(
      "SEC-010",
      `Path traversal detected: "${relativePath}" escapes base directory "${baseDir}"`,
    );
  }

  return resolvedPath;
}


/**
 * Validate that an identifier is safe for use as a filename component.
 *
 * Accepts only: letters, digits, hyphens, underscores.
 * Must start with a letter or digit.
 *
 * @returns The id unchanged if valid
 * @throws SidjuaError SEC-010 if the id contains unsafe characters
 */
export function validateSafeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    throw SidjuaError.from(
      "SEC-010",
      `Unsafe identifier: "${id}" — only letters, digits, hyphens, and underscores are allowed`,
    );
  }
  return id;
}
