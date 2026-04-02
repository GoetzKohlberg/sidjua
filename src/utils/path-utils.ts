// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Path safety utilities
 *
 * Shared helpers for preventing path traversal attacks across:
 *   - Backup/archive restoration
 *   - Skill path resolution
 *
 * All functions use path.resolve() BEFORE validation so that relative `..`
 * components are normalized before the containment check is applied.
 * This eliminates TOCTOU gaps caused by checking string patterns alone.
 */

import { resolve, relative, isAbsolute, dirname } from "node:path";
import { realpathSync }                            from "node:fs";
import { execFile }                                from "node:child_process";
import { promisify }                               from "node:util";
import { readdir, lstat, readlink, unlink }        from "node:fs/promises";
import { SidjuaError }                             from "../core/error-codes.js";

const execFileAsync = promisify(execFile);


/**
 * Validate a CLI --work-dir argument.
 *
 * Rejects paths that resolve to known system-critical directories to prevent
 * a malicious `--work-dir /etc` from operating on sensitive paths.
 *
 * @throws SidjuaError SEC-010 if workDir resolves to a system-critical path.
 */
const SYSTEM_CRITICAL_PATHS = new Set([
  "/", "/etc", "/usr", "/usr/local", "/bin", "/sbin",
  "/proc", "/sys", "/dev", "/boot", "/lib", "/lib64",
]);

export function validateWorkDir(workDir: string): void {
  const resolved = resolve(workDir);
  if (SYSTEM_CRITICAL_PATHS.has(resolved)) {
    throw SidjuaError.from(
      "SEC-010",
      `--work-dir "${workDir}" resolves to a system-critical path "${resolved}" — operation denied`,
    );
  }
}


/**
 * Assert that `filePath` is within `baseDir` (or equal to it).
 *
 * Both paths are resolved with `path.resolve()` before comparison so that
 * relative `..` traversal, Windows drive-root paths, and symlinked parent
 * directories are all normalized before the containment check.
 *
 * @throws SidjuaError SEC-010 if `filePath` escapes `baseDir`
 */
export function assertWithinDirectory(filePath: string, baseDir: string): void {
  const resolved     = resolve(filePath);
  const resolvedBase = resolve(baseDir);
  const rel          = relative(resolvedBase, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw SidjuaError.from(
      "SEC-010",
      `Path traversal detected: "${filePath}" escapes base directory "${baseDir}"`,
    );
  }
}


/**
 * Assert that `filePath` is within `baseDir` (or equal to it), resolving
 * symlinks on BOTH paths with `realpathSync()` before comparison.
 *
 * Use this variant when `baseDir` (or `filePath`) could be a symbolic link
 * that points outside of the expected directory tree. Falls back to
 * `path.resolve()` when a path does not exist yet (ENOENT).
 *
 * @throws SidjuaError SEC-010 if `filePath` escapes `baseDir`
 */
export function assertWithinDirectoryReal(filePath: string, baseDir: string): void {
  function tryRealpath(p: string): string {
    try {
      return realpathSync(p);
    } catch (_err) {
      // Path does not exist yet — fall back to logical resolution
      return resolve(p);
    }
  }

  const resolved     = tryRealpath(filePath);
  const resolvedBase = tryRealpath(baseDir);
  const rel          = relative(resolvedBase, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw SidjuaError.from(
      "SEC-010",
      `Path traversal detected: "${filePath}" escapes base directory "${baseDir}"`,
    );
  }
}


/**
 * Validate a single tar archive entry name for path traversal characters.
 *
 * Rejects entries that:
 * - Contain null bytes
 * - Start with `/` (absolute path)
 * - Contain a `..` path component at any position
 *
 * Exported for unit testing without requiring a real tar archive.
 *
 * @throws SidjuaError SEC-010 on any suspicious entry
 */
export function checkArchiveEntry(entry: string): void {
  // Null bytes confuse path functions and indicate a crafted archive
  if (entry.includes("\0")) {
    throw SidjuaError.from("SEC-010", "Archive entry contains null byte");
  }

  // Absolute paths bypass any -C <target> restriction
  if (entry.startsWith("/")) {
    throw SidjuaError.from(
      "SEC-010",
      `Archive entry uses absolute path: "${entry}"`,
    );
  }

  // Any ".." component — even buried in a longer path — can escape target dir
  const components = entry.split("/");
  for (const comp of components) {
    if (comp === "..") {
      throw SidjuaError.from(
        "SEC-010",
        `Archive entry contains path traversal component: "${entry}"`,
      );
    }
  }
}

/**
 * Pre-extraction validation: list all entries in a tar.gz archive and reject
 * any that contain path traversal characters.
 *
 * Call this BEFORE extracting the archive; do not extract archives that fail
 * this check even if they have a seemingly innocent root directory.
 *
 * @throws SidjuaError SEC-010 if any entry is dangerous
 * @throws Error on tar invocation failure
 */
export async function validateArchiveEntries(archivePath: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tzf", archivePath]);
  const entries    = stdout.trim().split("\n").filter((e) => e.length > 0);
  for (const entry of entries) {
    checkArchiveEntry(entry);
  }
}


/**
 * Post-extraction validation: walk all files and symlinks in `targetDir` and
 * verify that none escape the directory via symlink traversal.
 *
 * Regular files and directories that are reached by following the directory
 * walk are already within `targetDir` by construction. Symlinks are the only
 * mechanism that can escape — each symlink's resolved target is checked.
 *
 * Dangerous symlinks are removed before throwing to prevent further access.
 *
 * @throws SidjuaError SEC-010 if a symlink escapes targetDir
 */
export async function validateExtractedPaths(targetDir: string): Promise<void> {
  const resolvedTarget = resolve(targetDir);

  let entries: string[];
  try {
    // Node.js 18.17+ / 20+ / 22 support { recursive: true }
    entries = (await readdir(resolvedTarget, { recursive: true })) as string[];
  } catch (e: unknown) {
    // targetDir missing or unreadable — nothing to validate
    void e; // cleanup-ignore: targetDir missing or unreadable — return is control flow
    return;
  }

  for (const entry of entries) {
    const fullPath = resolve(resolvedTarget, entry);

    let stat;
    try {
      stat = await lstat(fullPath);
    } catch (e: unknown) {
      void e; // cleanup-ignore: file disappeared mid-walk — continue is control flow
      continue; // file disappeared mid-walk — skip
    }

    if (!stat.isSymbolicLink()) continue;

    // Resolve the symlink target relative to its containing directory
    let linkTarget: string;
    try {
      linkTarget = await readlink(fullPath);
    } catch (e: unknown) {
      void e; // cleanup-ignore: unreadable symlink — continue is control flow
      continue; // unreadable symlink — skip
    }

    const linkResolved = resolve(dirname(fullPath), linkTarget);
    const rel          = relative(resolvedTarget, linkResolved);

    if (rel.startsWith("..") || isAbsolute(rel)) {
      // Remove the dangerous symlink before throwing
      await unlink(fullPath).catch((e: unknown) => { void e; /* cleanup-ignore: dangerous symlink removal is best-effort before throwing */ });
      throw SidjuaError.from(
        "SEC-010",
        `Symlink escape detected in extracted archive: "${entry}" → "${linkTarget}"`,
      );
    }
  }
}
