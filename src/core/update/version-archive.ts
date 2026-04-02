// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Version Archive Manager
 *
 * Archives and restores system/ snapshots keyed by version number.
 * Used by `sidjua rollback` to restore a previous SIDJUA version.
 *
 * Archive location: <install-dir>/versions/<version>/
 * Manifest:        <install-dir>/versions/manifest.json
 *
 * Default: keep last 3 versions.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join }         from "node:path";
import { execFile }     from "node:child_process";
import { promisify }    from "node:util";
import { createLogger }  from "../logger.js";
import { SidjuaError }   from "../error-codes.js";
import { loadVersionInfo } from "../governance/rule-loader.js";
import {
  assertWithinDirectoryReal,
  validateArchiveEntries,
  validateExtractedPaths,
} from "../../utils/path-utils.js";

const execFileAsync = promisify(execFile);
const logger        = createLogger("version-archive");


/**
 * Allowed characters in a version string passed to archiveCurrentSystem,
 * restoreSystem, and cleanupOldVersions.
 * Rejects path separators, leading dots, and other traversal vectors.
 */
const VERSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function assertValidVersion(version: string): void {
  if (!VERSION_RE.test(version)) {
    throw SidjuaError.from(
      "SEC-010",
      `Invalid version string: "${version}". ` +
      `Versions must match ${VERSION_RE.source} and cannot contain path separators.`,
    );
  }
}


export interface ArchivedVersion {
  version:                  string;
  archivedAt:               string;
  governanceRulesetVersion: string;
  sizeBytes:                number;
}

export interface VersionManifest {
  currentVersion: string;
  versions:       ArchivedVersion[];
}


export class VersionArchiveManager {
  private readonly versionsDir: string;
  private readonly systemDir:   string;
  private readonly manifestPath: string;

  constructor(installDir: string, systemDir: string) {
    this.versionsDir   = join(installDir, "versions");
    this.systemDir     = systemDir;
    this.manifestPath  = join(this.versionsDir, "manifest.json");
  }

  // --------------------------------------------------------------------------
  // archiveCurrentSystem
  // --------------------------------------------------------------------------

  /**
   * Snapshot the current system/ directory into versions/<version>/.
   * Uses streaming tar to avoid memory buffering.
   */
  async archiveCurrentSystem(version: string): Promise<void> {
    assertValidVersion(version);
    mkdirSync(this.versionsDir, { recursive: true });

    const versionDir  = join(this.versionsDir, version);
    mkdirSync(versionDir, { recursive: true });

    const archivePath = join(versionDir, "system.tar.gz");

    logger.info("version-archive", `Archiving system/ as version ${version}`);
    await execFileAsync("tar", ["-czf", archivePath, "-C", this.systemDir, "."]);

    // Read governance version from archived system (before it changes)
    const govInfo     = loadVersionInfo(join(this.systemDir, "governance"));
    const govVer      = govInfo?.ruleset_version ?? "unknown";
    const sizeBytes   = fileSizeBytes(archivePath);

    const entry: ArchivedVersion = {
      version,
      archivedAt:               new Date().toISOString(),
      governanceRulesetVersion: govVer,
      sizeBytes,
    };

    const manifest = this._loadManifest();
    // Replace entry if version already exists
    manifest.versions = manifest.versions.filter((v) => v.version !== version);
    manifest.versions.unshift(entry);
    manifest.currentVersion = version;
    this._saveManifest(manifest);

    logger.info("version-archive", `Archived version ${version} (${sizeBytes} bytes)`);
  }

  // --------------------------------------------------------------------------
  // restoreSystem
  // --------------------------------------------------------------------------

  /**
   * Restore system/ from the given version archive.
   *
   * Security safeguards:
   *   1. Version parameter validated to stay within versionsDir (prevents directory
   *      traversal via a crafted version string like "../../etc").
   *   2. Pre-extraction validation rejects archives with "../" or absolute-path entries.
   *   3. Extraction uses --strip-components=1 (consistent with backup-manager) to
   *      strip the archive root prefix ("./" created by -C <dir> .) explicitly.
   *   4. Post-extraction validation removes and throws on any symlink that escapes
   *      the target directory.
   */
  async restoreSystem(version: string): Promise<void> {
    // Guard 0 — validate version string format before any path operations.
    assertValidVersion(version);

    // Guard 1 — validate version string does not escape versionsDir.
    const versionDir  = join(this.versionsDir, version);
    assertWithinDirectoryReal(versionDir, this.versionsDir);

    const archivePath = join(versionDir, "system.tar.gz");

    if (!existsSync(archivePath)) {
      throw new Error(`No archive found for version ${version} at ${archivePath}`);
    }

    // Guard 2 — pre-extraction entry validation (no "../", no absolute paths).
    await validateArchiveEntries(archivePath);

    logger.info("version-archive", `Restoring system/ from version ${version}`);

    // Clear current system dir and re-create
    if (existsSync(this.systemDir)) {
      rmSync(this.systemDir, { recursive: true, force: true });
    }
    mkdirSync(this.systemDir, { recursive: true });

    // Guard 3 — add --strip-components=1 (consistent with backup-manager.ts).
    // Archives are created with `tar -czf archive -C systemDir .` so entries start with
    // "./"; --strip-components=1 strips that prefix explicitly rather than relying on
    // implicit "./" → "" normalization.
    await execFileAsync("tar", ["-xzf", archivePath, "-C", this.systemDir, "--strip-components=1"]);

    // Guard 4 — post-extraction symlink validation (defense-in-depth).
    await validateExtractedPaths(this.systemDir);

    logger.info("version-archive", `System restored to version ${version}`);
  }

  // --------------------------------------------------------------------------
  // listVersions
  // --------------------------------------------------------------------------

  async listVersions(): Promise<ArchivedVersion[]> {
    return this._loadManifest().versions;
  }

  // --------------------------------------------------------------------------
  // getManifest
  // --------------------------------------------------------------------------

  async getManifest(): Promise<VersionManifest> {
    return this._loadManifest();
  }

  // --------------------------------------------------------------------------
  // cleanupOldVersions
  // --------------------------------------------------------------------------

  async cleanupOldVersions(keep = 3): Promise<void> {
    const manifest = this._loadManifest();
    if (manifest.versions.length <= keep) return;

    const toRemove = manifest.versions.slice(keep);
    for (const entry of toRemove) {
      const versionDir = join(this.versionsDir, entry.version);
      try {
        rmSync(versionDir, { recursive: true, force: true });
        logger.info("version-archive", `Removed old version archive: ${entry.version}`);
      } catch (e: unknown) {
        logger.warn("version-archive", `Failed to remove version archive ${entry.version}`, {
          error: { code: "REMOVE_ERROR", message: e instanceof Error ? e.message : String(e) },
        });
      }
    }

    manifest.versions = manifest.versions.slice(0, keep);
    this._saveManifest(manifest);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private _loadManifest(): VersionManifest {
    if (!existsSync(this.manifestPath)) {
      return { currentVersion: "unknown", versions: [] };
    }
    try {
      const sizeBytes = statSync(this.manifestPath).size;
      if (sizeBytes > 128 * 1024) {
        logger.warn("version-archive", `Version manifest exceeds 128 KB (${sizeBytes} bytes) — starting fresh`, {
          metadata: { path: this.manifestPath, sizeBytes },
        });
        return { currentVersion: "unknown", versions: [] };
      }
      const raw = readFileSync(this.manifestPath, "utf-8");
      return JSON.parse(raw) as VersionManifest;
    } catch (e: unknown) {
      logger.warn("version-archive", "Failed to parse version manifest — starting fresh", {
        error: { code: "PARSE_ERROR", message: e instanceof Error ? e.message : String(e) },
      });
      return { currentVersion: "unknown", versions: [] };
    }
  }

  private _saveManifest(manifest: VersionManifest): void {
    mkdirSync(this.versionsDir, { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  }
}


function fileSizeBytes(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (e: unknown) {
    logger.debug("version-archive", "Could not stat file for size — returning 0", { metadata: { error: e instanceof Error ? e.message : String(e), filePath } });
    return 0;
  }
}
