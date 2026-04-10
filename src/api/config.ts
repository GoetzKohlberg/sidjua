// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P434b: GUI Auth Config Manager
 *
 * Manages .system/config.json (schemaVersion 2):
 *   - Atomic write: tmp-<pid>-<rand> → fsync → rename onto config.json
 *   - Backup rotation: keep 5 most-recent .bak-<ISO8601> copies
 *   - Corrupt-file recovery: rename to .corrupt-<ISO8601>, set recoveryMode=true
 *   - First-run detection: no config.json OR passwordHash null/absent
 *   - Write serialization: Promise-based mutex (no external dep)
 */

import { join }                          from "node:path";
import { existsSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { open, rename, unlink, readdir, copyFile }         from "node:fs/promises";
import { randomBytes }                   from "node:crypto";
import { createLogger }                  from "../core/logger.js";

const logger = createLogger("config-manager");

/** Supported schema version written to every config file. */
const SCHEMA_VERSION = 2;

/** Maximum number of .bak-* files to retain. */
const MAX_BACKUPS = 5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AppConfig {
  schemaVersion: number;
  /** argon2id hash of the admin password, or null on first run. */
  passwordHash:  string | null;
  /** Base64-encoded 32-byte HMAC key for session-cookie signing. */
  sessionSecret: string | null;
  /** ISO-8601 timestamp when this config was first created. */
  createdAt:     string;
  /** Reserved for future multi-user expansion (currently unused). */
  users:         string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeDefaultConfig(): AppConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    passwordHash:  null,
    sessionSecret: null,
    createdAt:     new Date().toISOString(),
    users:         [],
  };
}

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

export class ConfigManager {
  private readonly configPath: string;
  private readonly systemDir:  string;
  private _config:       AppConfig | null = null;
  private _recoveryMode: boolean          = false;

  /**
   * Serialize all writes through a promise chain.
   * Each save() call appends to the tail of the chain and resolves when done.
   */
  private _writeTail: Promise<void> = Promise.resolve();

  constructor(workDir: string) {
    this.systemDir  = join(workDir, ".system");
    this.configPath = join(this.systemDir, "config.json");
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  /** True when the loaded config was corrupt (renamed to .corrupt-*). */
  get recoveryMode(): boolean { return this._recoveryMode; }

  /** True before first-time setup: no config file, or passwordHash absent/null. */
  isFirstRun(): boolean {
    if (this._config === null) return true;
    return this._config.passwordHash === null || this._config.passwordHash === "";
  }

  /**
   * Return a shallow copy of the current in-memory config.
   * Throws if load() has not been called.
   */
  getConfig(): AppConfig {
    if (this._config === null) {
      throw new Error("ConfigManager.load() must be called before getConfig()");
    }
    return { ...this._config };
  }

  // ── load() — synchronous ──────────────────────────────────────────────────

  /**
   * Load config.json from disk.  Must be called once at startup.
   *
   * Returns:
   *   true  — valid config with passwordHash set (server configured)
   *   false — first run (no file, no passwordHash) or corrupt (recoveryMode=true)
   */
  load(): boolean {
    mkdirSync(this.systemDir, { recursive: true });

    if (!existsSync(this.configPath)) {
      this._config = makeDefaultConfig();
      logger.info("config_first_run", "No config.json found — first run detected", {});
      return false;
    }

    let raw: string;
    try {
      raw = readFileSync(this.configPath, "utf-8");
    } catch (e: unknown) {
      logger.error("config_read_error", "Failed to read config.json", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
      this._config       = makeDefaultConfig();
      this._recoveryMode = true;
      return false;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("config.json root is not an object");
      }
      // Merge with defaults so missing optional fields never cause runtime errors
      this._config = { ...makeDefaultConfig(), ...(parsed as Partial<AppConfig>) };
      return this._config.passwordHash !== null && this._config.passwordHash !== "";
    } catch (e: unknown) {
      this._corruptRecovery(e);
      return false;
    }
  }

  // ── save() — async, serialized ────────────────────────────────────────────

  /**
   * Persist updates to config.json atomically.
   * Calls are serialized — concurrent callers wait for the previous write.
   *
   * @param updates  Fields to merge into the current config.
   *                 schemaVersion and createdAt are immutable and ignored.
   */
  async save(updates: Partial<Omit<AppConfig, "schemaVersion" | "createdAt">>): Promise<void> {
    // Append this write to the tail of the serialization chain.
    // Each tail resolves after the actual write; concurrent callers queue up.
    const next = this._writeTail.then(() => this._doSave(updates));
    // Expose the new tail so the next save() waits for this one.
    this._writeTail = next.catch(() => undefined);
    return next;
  }

  // ── Private implementation ────────────────────────────────────────────────

  private _corruptRecovery(cause: unknown): void {
    const stamp      = new Date().toISOString().replace(/:/g, "-");
    const corruptPath = `${this.configPath}.corrupt-${stamp}`;
    try {
      renameSync(this.configPath, corruptPath);
    } catch (re: unknown) {
      logger.warn("config_corrupt_rename_failed", "Could not rename corrupt config file", {
        metadata: { corruptPath, error: re instanceof Error ? re.message : String(re) },
      });
    }
    logger.error("config_corrupt", "config.json is corrupt — moved to backup, entering recovery mode", {
      metadata: { corruptPath, error: cause instanceof Error ? cause.message : String(cause) },
    });
    this._config       = makeDefaultConfig();
    this._recoveryMode = true;
  }

  private async _doSave(
    updates: Partial<Omit<AppConfig, "schemaVersion" | "createdAt">>,
  ): Promise<void> {
    if (this._config === null) {
      throw new Error("ConfigManager.load() must be called before save()");
    }

    const next: AppConfig = {
      ...this._config,
      ...updates,
      // Immutable fields: always preserve originals
      schemaVersion: SCHEMA_VERSION,
      createdAt:     this._config.createdAt,
    };

    mkdirSync(this.systemDir, { recursive: true });

    // ── 1. Write new content to tmp file (safe — config.json untouched) ───
    const rand    = randomBytes(4).toString("hex");
    const tmpPath = `${this.configPath}.tmp-${process.pid}-${rand}`;
    const payload = JSON.stringify(next, null, 2);

    const fh = await open(tmpPath, "w", 0o600);
    try {
      await fh.writeFile(payload, "utf-8");
      await fh.datasync(); // flush data pages before rename
    } catch (writeErr: unknown) {
      await fh.close();
      try { await unlink(tmpPath); } catch (_) { /* best effort */ }
      throw writeErr;
    }
    await fh.close();

    // ── 2. Back up current config.json before replacing ────────────────
    if (existsSync(this.configPath)) {
      const stamp   = new Date().toISOString().replace(/:/g, "-");
      const bakPath = `${this.configPath}.bak-${stamp}`;
      try {
        await copyFile(this.configPath, bakPath);
      } catch (bakErr: unknown) {
        // Non-fatal — proceed with write even if backup fails
        logger.warn("config_backup_failed", "Could not create config backup — continuing", {
          metadata: {
            bakPath,
            error: bakErr instanceof Error ? bakErr.message : String(bakErr),
          },
        });
      }
      // Prune excess backups (fire-and-forget, non-fatal)
      this._pruneBackups().catch((_e: unknown) => undefined);
    }

    // ── 3. Atomic rename: tmp replaces config.json ──────────────────────
    await rename(tmpPath, this.configPath);

    this._config = next;

    logger.info("config_saved", "config.json written", {
      metadata: { fields: Object.keys(updates).join(",") },
    });
  }

  /**
   * Remove oldest .bak-* files, keeping at most MAX_BACKUPS.
   * ISO-8601 timestamps sort lexicographically, so the last N entries are newest.
   */
  private async _pruneBackups(): Promise<void> {
    try {
      const entries = await readdir(this.systemDir);
      const PREFIX  = "config.json.bak-";
      const baks    = entries.filter((e) => e.startsWith(PREFIX)).sort();
      const excess  = baks.slice(0, Math.max(0, baks.length - MAX_BACKUPS));
      for (const name of excess) {
        try {
          await unlink(join(this.systemDir, name));
        } catch (_e) { /* best effort */ }
      }
    } catch (_e) { /* best effort */ }
  }
}
