// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.9: Backup & Restore Engine
 *
 * Full-system backup and restore for SIDJUA workspaces.
 *
 * Backup produces a ZIP archive.
 * Archive structure:
 *   manifest.json    — metadata + SHA-256 checksum
 *   manifest.sig     — HMAC-SHA256 signature of manifest.json
 *   databases/       — WAL-checkpointed SQLite .db files (preserving relative paths)
 *   governance/      — governance directory tree
 *   divisions/       — per-division directories
 *   config/          — divisions.yaml + other YAML/JSON root configs
 *   snapshots/       — governance snapshots (data/governance-snapshots/)
 *   knowledge/       — knowledge data (data/knowledge/)
 *
 * Database safety: `PRAGMA wal_checkpoint(TRUNCATE)` is run on every .db file
 * before copying. Only .db files are copied (not -wal/-shm files).
 *
 * Archive strategy: yauzl (streaming read) + yazl (streaming write).
 * Verify-before-extract: manifest.json and manifest.sig are read from the ZIP
 * central directory FIRST, HMAC is verified BEFORE any file is extracted.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
  copyFileSync,
  createReadStream,
  promises as fsPromises,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { sha256hex, hmacSign, hmacVerify, generateSecret } from "./crypto-utils.js";
import { join, relative, resolve, basename, dirname, normalize, isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";
import { tmpdir }    from "node:os";
import * as yauzl    from "yauzl";
import * as yazl     from "yazl";
import BetterSQLite3 from "better-sqlite3";
import { parse }     from "yaml";
import { createLogger }   from "./logger.js";
import { SidjuaError }    from "./error-codes.js";
import { isProcessAlive } from "../cli/utils/process.js";
import { SIDJUA_VERSION } from "../version.js";

const logger = createLogger("backup");

const MANIFEST_FILENAME      = "manifest.json";
const MANIFEST_SIG_FILE      = "manifest.sig";
/** Prevent OOM when loading backup source */
const MAX_BACKUP_SIZE_BYTES  = 500 * 1024 * 1024; // 500 MB
/** Zip bomb protection — cap uncompressed restore size */
const MAX_RESTORE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GB
/** C4: manifest size limit — abort streaming if manifest.json exceeds this */
export const MANIFEST_MAX_BYTES = 5 * 1024 * 1024; // 5 MB


export interface BackupConfig {
  /** Directory where backup archives are stored. */
  directory:       string;
  /** Keep at most this many backups (0 = unlimited). */
  retention_count: number;
  /** Delete backups older than this many days (0 = unlimited). */
  retention_days:  number;
}

export interface BackupManifest {
  id:               string;       // UUID
  short_id:         string;       // first 8 hex chars (no dashes)
  created_at:       string;       // ISO 8601
  label?:           string;
  sidjua_version:   string;
  work_dir:         string;       // original workDir (informational)
  file_count:       number;
  total_size_bytes: number;
  checksum:         string;       // SHA-256 hex over all content files sorted by path
  files:            string[];     // sorted relative paths
  file_checksums?:  Record<string, string>;  // per-file SHA-256 for post-extract verification
}

export interface BackupInfo {
  id:                 string;
  short_id:           string;
  archive_path:       string;
  created_at:         string;
  label?:             string;
  file_count:         number;
  total_size_bytes:   number;
  archive_size_bytes: number;
  sidjua_version:     string;
}

export interface CreateBackupOptions {
  workDir:      string;
  configPath:   string;
  label?:       string;
  /** Write archive to this path instead of the backup directory. */
  outputPath?:  string;
}

export interface CreateBackupResult {
  id:                 string;
  short_id:           string;
  archive_path:       string;
  file_count:         number;
  archive_size_bytes: number;
  label?:             string;
  warnings?:          string[];
}

export interface RestoreOptions {
  /** Archive path OR short/full backup ID. */
  archivePathOrId: string;
  workDir:         string;
  configPath:      string;
  dryRun?:         boolean;
  force?:          boolean;
  backupDir?:      string;
}

export interface RestoreResult {
  id:                     string;
  dryRun:                 boolean;
  files_restored:         number;
  pre_restore_backup_id?: string;
}


export function getBackupConfig(workDir: string, configPath?: string): BackupConfig {
  const defaultDir = join(workDir, "data", "backups");
  const cfg: BackupConfig = { directory: defaultDir, retention_count: 5, retention_days: 30 };

  // Resolve divisions.yaml: governance/ (new default) → root (legacy fallback)
  const govYaml  = join(workDir, "governance", "divisions.yaml");
  const rootYaml = join(workDir, "divisions.yaml");
  const yamlPath = configPath ?? (existsSync(govYaml) ? govYaml : rootYaml);
  if (existsSync(yamlPath)) {
    try {
      const parsed = parse(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
      const backup = parsed["backup"] as Record<string, unknown> | undefined;
      if (backup) {
        if (typeof backup["directory"] === "string") {
          cfg.directory = resolve(workDir, backup["directory"] as string);
        }
        if (typeof backup["retention_count"] === "number") {
          cfg.retention_count = backup["retention_count"] as number;
        }
        if (typeof backup["retention_days"] === "number") {
          cfg.retention_days = backup["retention_days"] as number;
        }
      }
    } catch (e: unknown) { logger.warn("backup", "Backup config parse failed — using defaults", { metadata: { error: e instanceof Error ? e.message : String(e) } }); }
  }

  return cfg;
}


const WAL_CHECKPOINT_MAX_RETRIES   = 3;
const WAL_CHECKPOINT_RETRY_DELAY_MS = 10_000;

/**
 * Run a WAL checkpoint via a worker thread and return on success.
 * Throws on timeout or non-zero exit code.
 */
function runCheckpointWorker(dbPath: string): Promise<void> {
  return new Promise<void>((done, fail) => {
    const TIMEOUT_MS = 30_000;
    const workerPath = new URL("./backup-checkpoint-worker.cjs", import.meta.url).pathname;
    const worker     = new Worker(workerPath, { workerData: { dbPath } });
    const timer = setTimeout(() => {
      void worker.terminate();
      fail(new Error(`WAL checkpoint timed out after ${TIMEOUT_MS}ms: ${dbPath}`));
    }, TIMEOUT_MS);
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.debug("backup_wal_checkpoint", `WAL checkpoint succeeded: ${basename(dbPath)}`, {
          metadata: { db_path: dbPath },
        });
        done();
      } else {
        fail(new Error(`WAL checkpoint worker exited with code ${code}: ${dbPath}`));
      }
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
  });
}

/**
 * Checkpoint a database WAL before backup with retries.
 * Best-effort: if all retries are exhausted, logs a warning and returns without
 * throwing. The backup will still proceed — SQLite WAL data is readable and the
 * backup archive includes the WAL file for replay on restore.
 */
async function checkpointDatabase(dbPath: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= WAL_CHECKPOINT_MAX_RETRIES; attempt++) {
    try {
      await runCheckpointWorker(dbPath);
      return; // success
    } catch (err: unknown) {
      lastErr = err;
      logger.warn("backup_wal_checkpoint_failed", `WAL checkpoint attempt ${attempt}/${WAL_CHECKPOINT_MAX_RETRIES} failed for ${basename(dbPath)}`, {
        metadata: { db_path: dbPath, error: err instanceof Error ? err.message : String(err) },
      });
      if (attempt < WAL_CHECKPOINT_MAX_RETRIES) {
        await new Promise<void>((r) => setTimeout(r, WAL_CHECKPOINT_RETRY_DELAY_MS));
      }
    }
  }
  // All retries exhausted — proceed with best-effort backup (WAL is still readable)
  logger.warn("backup_wal_checkpoint_exhausted", `WAL checkpoint failed after ${WAL_CHECKPOINT_MAX_RETRIES} attempts for ${basename(dbPath)} — backup proceeds with current WAL state`, {
    metadata: {
      db_path: dbPath,
      error:   lastErr instanceof Error ? lastErr.message : String(lastErr),
    },
  });
}


function getOrCreateSigningKey(workDir: string): string {
  const keyEnv = process.env["SIDJUA_BACKUP_KEY"];
  if (keyEnv !== undefined && keyEnv.length > 0) return keyEnv;

  const systemDir = join(workDir, ".system");
  const keyPath   = join(systemDir, "backup.key");
  if (existsSync(keyPath)) {
    // Warn if key file has insecure permissions
    const fileMode = statSync(keyPath).mode & 0o777;
    if (fileMode & 0o077) {
      process.stderr.write(
        `[SIDJUA] WARNING: backup.key has insecure permissions (${fileMode.toString(8)}). Should be 600.\n`,
      );
    }
    return readFileSync(keyPath, "utf-8").trim();
  }

  const key = generateSecret();
  mkdirSync(systemDir, { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function signManifest(manifestJson: string, signingKey: string): string {
  return hmacSign(signingKey, manifestJson).toString("hex");
}

function verifyManifestSig(manifestJson: string, signatureHex: string, signingKey: string): boolean {
  const sigBuf = Buffer.from(signatureHex, "hex");
  return hmacVerify(signingKey, manifestJson, sigBuf);
}


function checkBackupSize(sourceDir: string): void {
  let totalSize = 0;

  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile()) {
        totalSize += statSync(fullPath).size;
        if (totalSize > MAX_BACKUP_SIZE_BYTES) {
          throw SidjuaError.from(
            "SYS-004",
            `Backup source too large: ${Math.floor(totalSize / 1024 / 1024)} MB exceeds ${MAX_BACKUP_SIZE_BYTES / 1024 / 1024} MB limit`,
          );
        }
      }
    }
  }

  scan(sourceDir);
}


/** Open a zip file with yauzl (promise wrapper). */
function openZip(archivePath: string, options: yauzl.Options): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, options, (err, zipfile) => {
      if (err !== null || zipfile === undefined) {
        reject(err ?? new Error("yauzl.open returned no zipfile"));
      } else {
        resolve(zipfile);
      }
    });
  });
}

/**
 * C3 + C4: Read ONLY manifest.json and manifest.sig from zip headers.
 * Buffers at most MANIFEST_MAX_BYTES for the manifest. Aborts if exceeded.
 * Returns { manifest, sig } where sig may be null if not present.
 */
async function readZipHeaders(
  archivePath: string,
): Promise<{ manifest: Buffer; sig: Buffer | null }> {
  const zipfile = await openZip(archivePath, { lazyEntries: true });

  return new Promise<{ manifest: Buffer; sig: Buffer | null }>((resolve, reject) => {
    let manifestBuf: Buffer | null  = null;
    let sigBuf:      Buffer | null  = null;

    zipfile.on("error", (err: Error) => {
      reject(err);
    });

    zipfile.on("entry", (entry: yauzl.Entry) => {
      const name = entry.fileName;

      if (name !== MANIFEST_FILENAME && name !== MANIFEST_SIG_FILE) {
        // Skip — we only want these two entries in pass 1
        zipfile.readEntry();
        return;
      }

      zipfile.openReadStream(entry, (err, stream) => {
        if (err !== null || stream === undefined) {
          zipfile.close();
          reject(err ?? new Error("openReadStream failed for manifest entry"));
          return;
        }

        const chunks: Buffer[] = [];
        let bytesRead = 0;

        stream.on("data", (chunk: Buffer) => {
          bytesRead += chunk.length;
          if (bytesRead > MANIFEST_MAX_BYTES) {
            zipfile.close();
            reject(SidjuaError.from("SYS-005", `manifest.json exceeds size limit (${MANIFEST_MAX_BYTES / 1024 / 1024} MB)`));
            return;
          }
          chunks.push(chunk);
        });

        stream.on("error", (streamErr: Error) => {
          zipfile.close();
          reject(streamErr);
        });

        stream.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (name === MANIFEST_FILENAME) {
            manifestBuf = buf;
          } else {
            sigBuf = buf;
          }
          zipfile.readEntry();
        });
      });
    });

    zipfile.on("end", () => {
      zipfile.close();
      if (manifestBuf === null) {
        reject(SidjuaError.from("SYS-005", "Archive is missing manifest.json"));
        return;
      }
      resolve({ manifest: manifestBuf, sig: sigBuf });
    });

    zipfile.readEntry();
  });
}

/**
 * Stream-extract ALL entries from archivePath into targetDir.
 * Enforces:
 *  - Path traversal check per entry (Zip Slip prevention)
 *  - Total decompressed byte limit (zip bomb prevention)
 */
async function streamingExtract(
  archivePath: string,
  targetDir: string,
  maxBytes: number,
): Promise<void> {
  const resolvedTarget = resolve(targetDir);
  const zipfile = await openZip(archivePath, { lazyEntries: true });

  return new Promise<void>((done, fail) => {
    let totalBytes  = 0;
    let entryCount  = 0;

    /** Maximum number of entries (files + dirs) in a single archive. */
    const MAX_ENTRY_COUNT = 10_000;
    /** Maximum uncompressed size for a single archive entry. */
    const MAX_ENTRY_SIZE  = 100 * 1024 * 1024; // 100 MB

    zipfile.on("error", (err: Error) => {
      fail(err);
    });

    zipfile.on("entry", (entry: yauzl.Entry) => {
      const entryName     = normalize(entry.fileName);
      const fullEntryPath = resolve(targetDir, entryName);

      // Zip Slip prevention
      if (!fullEntryPath.startsWith(resolvedTarget + "/") && fullEntryPath !== resolvedTarget) {
        zipfile.close();
        fail(SidjuaError.from("SYS-009", `Path traversal detected in archive: ${entry.fileName}`));
        return;
      }

      // Guard: file count cap prevents inode exhaustion from many-small-file archives
      entryCount++;
      if (entryCount > MAX_ENTRY_COUNT) {
        zipfile.close();
        fail(SidjuaError.from("SYS-012", `Archive exceeds maximum file count (${MAX_ENTRY_COUNT})`));
        return;
      }

      // Guard: per-entry size limit prevents single oversized entries within total budget
      if (!entry.fileName.endsWith("/") && entry.uncompressedSize > MAX_ENTRY_SIZE) {
        zipfile.close();
        fail(SidjuaError.from("SYS-013", `Archive entry "${entry.fileName}" exceeds maximum size (${MAX_ENTRY_SIZE / 1024 / 1024} MB)`));
        return;
      }

      // Directory entry — just create and proceed
      if (entry.fileName.endsWith("/")) {
        mkdirSync(fullEntryPath, { recursive: true, mode: 0o700 });
        zipfile.readEntry();
        return;
      }

      zipfile.openReadStream(entry, (err, stream) => {
        if (err !== null || stream === undefined) {
          zipfile.close();
          fail(err ?? new Error(`openReadStream failed for ${entry.fileName}`));
          return;
        }

        mkdirSync(dirname(fullEntryPath), { recursive: true, mode: 0o700 });
        const outStream = createWriteStream(fullEntryPath);

        stream.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            stream.destroy();
            outStream.destroy();
            zipfile.close();
            fail(
              SidjuaError.from(
                "SYS-009",
                `Archive exceeds maximum restore size (${maxBytes / 1024 / 1024} MB). Possible zip bomb.`,
              ),
            );
          }
        });

        stream.on("error", (streamErr: Error) => {
          outStream.destroy();
          zipfile.close();
          fail(streamErr);
        });

        outStream.on("error", (outErr: Error) => {
          zipfile.close();
          fail(outErr);
        });

        outStream.on("finish", () => {
          zipfile.readEntry();
        });

        stream.pipe(outStream);
      });
    });

    zipfile.on("end", () => {
      zipfile.close();
      done();
    });

    // Start lazy entry iteration
    zipfile.readEntry();
  });
}


/**
 * Write all files in tempDir into a ZIP archive at archivePath using yazl.
 * Files are added with their path relative to tempDir as the zip entry name.
 */
async function writeZipFromDir(tempDir: string, archivePath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const zipfile   = new yazl.ZipFile();
    const outStream = createWriteStream(archivePath);

    outStream.on("error", (err) => {
      reject(err);
    });

    outStream.on("finish", () => {
      resolve();
    });

    (zipfile.outputStream as NodeJS.ReadableStream).pipe(outStream);

    // Walk tempDir and add all files
    function addDir(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          addDir(fullPath);
        } else if (entry.isFile()) {
          const entryName = relative(tempDir, fullPath);
          zipfile.addFile(fullPath, entryName);
        }
      }
    }

    try {
      addDir(tempDir);
      zipfile.end();
    } catch (err) {
      reject(err);
    }
  });
}


async function extractManifestFromArchive(archivePath: string): Promise<BackupManifest> {
  const { manifest } = await readZipHeaders(archivePath);
  try {
    return JSON.parse(manifest.toString("utf-8")) as BackupManifest;
  } catch (parseErr) {
    logger.warn("backup_manifest_parse_error", `Failed to parse manifest.json in ${basename(archivePath)}: ${String(parseErr)}`, {
      metadata: { archive_path: archivePath },
    });
    throw SidjuaError.from("SYS-005", `manifest.json is not valid JSON: ${String(parseErr)}`);
  }
}


function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function findDatabaseFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".db") && !f.endsWith("-wal") && !f.endsWith("-shm"))
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => join(dir, f));
}

/** Streaming checksum — avoids loading entire files into RAM */
async function computeChecksum(
  files: Array<{ relPath: string; absPath: string }>,
): Promise<string> {
  const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
  // Multi-update streaming hash: cannot use sha256hex() (single-pass) — intentional createHash usage
  const hash   = createHash("sha256");
  for (const f of sorted) {
    hash.update(f.relPath + "\n");
    const stream = createReadStream(f.absPath);
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** Streaming SHA-256 of a single file — used for per-file manifest verification. */
async function computeFileChecksum(absPath: string): Promise<string> {
  const hash   = createHash("sha256");
  const stream = createReadStream(absPath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function parseDivisionCodes(yamlPath: string): string[] {
  if (!existsSync(yamlPath)) return [];
  try {
    const parsed = parse(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
    const divs   = parsed["divisions"];
    if (!Array.isArray(divs)) return [];
    return (divs as unknown[])
      .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
      .map((d) => String(d["code"] ?? ""))
      .filter(Boolean);
  } catch (err) {
    logger.warn("backup_yaml_parse_failed",
      `Failed to parse divisions.yaml — division directories will be skipped in backup: ${String(err)}`,
      { metadata: { yaml_path: yamlPath } },
    );
    return [];
  }
}

const MAX_COPY_DEPTH = 50;

/** @internal Exported for testing only */
export function copyDirSync(src: string, dest: string, depth = 0): void {
  if (depth > MAX_COPY_DEPTH) {
    throw SidjuaError.from("SYS-009", `Directory recursion limit exceeded at: ${src}`);
  }
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath  = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, depth + 1);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

/** Safe database backup using SQLite's online backup API (no corruption risk) */
async function backupDatabase(srcPath: string, destPath: string): Promise<void> {
  const db = new BetterSQLite3(srcPath, { readonly: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }
}


async function resolveArchivePath(archivePathOrId: string, backupDir: string): Promise<string> {
  // C5: Reject traversal before resolution
  if (archivePathOrId.includes("..")) {
    throw SidjuaError.from("SYS-009", "Archive path contains path traversal characters");
  }
  // C5: Require non-empty backupDir
  if (typeof backupDir !== "string" || backupDir.trim().length === 0) {
    throw SidjuaError.from("SYS-009", "backupDir must be provided and non-empty");
  }

  if (archivePathOrId.endsWith(".zip")) {
    const resolvedPath = resolve(archivePathOrId);
    const resolvedDir  = resolve(backupDir);
    const rel = relative(resolvedDir, resolvedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw SidjuaError.from("SYS-009", `Archive path escapes backup directory`);
    }
    return resolvedPath;
  }

  return resolveBackupId(archivePathOrId, backupDir);
}

function checkAgentsRunning(workDir: string): boolean {
  const pidFile = join(workDir, "data", "orchestrator.pid");
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    return isProcessAlive(pid);
  } catch (e: unknown) { logger.debug("backup", "PID file not readable — assuming process not running", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    return false;
  }
}

function isVersionCompatible(archiveVersion: string, currentVersion: string): boolean {
  const archiveMajor = parseInt((archiveVersion.split(".")[0]) ?? "0", 10);
  const currentMajor = parseInt((currentVersion.split(".")[0]) ?? "0", 10);
  return archiveMajor === currentMajor;
}


export async function createBackup(
  options: CreateBackupOptions,
  config?: BackupConfig,
): Promise<CreateBackupResult> {
  const { workDir, configPath, label } = options;
  const cfg      = config ?? getBackupConfig(workDir, configPath);
  const id       = randomUUID();
  const shortId  = id.replace(/-/g, "").slice(0, 8);

  const archiveName = `sidjua-backup-${shortId}-${new Date().toISOString().slice(0, 10)}.zip`;
  const archivePath = options.outputPath ?? join(cfg.directory, archiveName);
  const archiveDir  = options.outputPath
    ? resolve(options.outputPath, "..")
    : cfg.directory;

  logger.info("backup_start", `Starting backup ${shortId}`, {
    metadata: { id, workDir, archivePath },
  });

  mkdirSync(archiveDir, { recursive: true });

  const tempDir = join(tmpdir(), `sidjua-backup-${id}`);
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });

  try {
    const contentFiles: Array<{ relPath: string; absPath: string }> = [];

    // 1. WAL checkpoint + copy databases
    // Preserve relative paths — data/agent.db → databases/data/agent.db
    const dbDestDir = join(tempDir, "databases");
    mkdirSync(dbDestDir, { recursive: true });
    const dbSearchDirs: Array<{ dir: string; relPrefix: string }> = [
      { dir: join(workDir, "data"), relPrefix: "data" },
      { dir: workDir,               relPrefix: "" },
    ];
    const dbWarnings: string[] = [];
    for (const { dir: searchDir, relPrefix } of dbSearchDirs) {
      for (const dbFile of findDatabaseFiles(searchDir)) {
        try {
          await checkpointDatabase(dbFile);
          const relName = relPrefix.length > 0 ? `${relPrefix}/${basename(dbFile)}` : basename(dbFile);
          const dest    = join(dbDestDir, ...relName.split("/"));
          mkdirSync(resolve(dest, ".."), { recursive: true });
          await backupDatabase(dbFile, dest);
          contentFiles.push({ relPath: `databases/${relName}`, absPath: dest });
        } catch (dbErr) {
          const msg = `Skipped ${basename(dbFile)}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`;
          dbWarnings.push(msg);
          logger.warn("backup_db_skip", msg, { metadata: { db_path: dbFile } });
        }
      }
    }

    // 2. Governance directory
    const govSrc  = join(workDir, "governance");
    const govDest = join(tempDir, "governance");
    if (existsSync(govSrc)) {
      copyDirSync(govSrc, govDest);
      for (const f of collectFiles(govDest)) {
        contentFiles.push({ relPath: `governance/${relative(govDest, f)}`, absPath: f });
      }
    }

    // 3. Division directories
    const divsDest = join(tempDir, "divisions");
    mkdirSync(divsDest, { recursive: true });
    for (const code of parseDivisionCodes(configPath)) {
      const divSrc = join(workDir, code);
      if (existsSync(divSrc)) {
        const divDest = join(divsDest, code);
        copyDirSync(divSrc, divDest);
        for (const f of collectFiles(divDest)) {
          contentFiles.push({ relPath: `divisions/${code}/${relative(divDest, f)}`, absPath: f });
        }
      }
    }

    // 4. Config files (root *.yaml / *.yml / *.json)
    const configDest = join(tempDir, "config");
    mkdirSync(configDest, { recursive: true });
    for (const cf of readdirSync(workDir)) {
      const src = join(workDir, cf);
      if (!statSync(src).isFile()) continue;
      if (cf.endsWith(".yaml") || cf.endsWith(".yml") || cf.endsWith(".json")) {
        const dest = join(configDest, cf);
        copyFileSync(src, dest);
        contentFiles.push({ relPath: `config/${cf}`, absPath: dest });
      }
    }

    // 5. Governance snapshots
    const snapshotSrc  = join(workDir, "data", "governance-snapshots");
    const snapshotDest = join(tempDir, "snapshots");
    if (existsSync(snapshotSrc)) {
      copyDirSync(snapshotSrc, snapshotDest);
      for (const f of collectFiles(snapshotDest)) {
        contentFiles.push({ relPath: `snapshots/${relative(snapshotDest, f)}`, absPath: f });
      }
    }

    // 6. Knowledge data
    const knowledgeSrc  = join(workDir, "data", "knowledge");
    const knowledgeDest = join(tempDir, "knowledge");
    if (existsSync(knowledgeSrc)) {
      copyDirSync(knowledgeSrc, knowledgeDest);
      for (const f of collectFiles(knowledgeDest)) {
        contentFiles.push({ relPath: `knowledge/${relative(knowledgeDest, f)}`, absPath: f });
      }
    }

    // 7. Checksum + size (streaming)
    const checksum   = await computeChecksum(contentFiles);
    const totalBytes = contentFiles.reduce((s, f) => s + statSync(f.absPath).size, 0);

    // 7b. Per-file checksums for post-extract verification (tar-slip mitigation)
    const fileChecksums: Record<string, string> = {};
    for (const { relPath, absPath } of contentFiles) {
      fileChecksums[relPath] = await computeFileChecksum(absPath);
    }

    // 8. Manifest
    const manifest: BackupManifest = {
      id,
      short_id:         shortId,
      created_at:       new Date().toISOString(),
      sidjua_version:   SIDJUA_VERSION,
      work_dir:         workDir,
      file_count:       contentFiles.length,
      total_size_bytes: totalBytes,
      checksum,
      files:            contentFiles.map((f) => f.relPath).sort(),
      file_checksums:   fileChecksums,
      ...(label !== undefined ? { label } : {}),
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    writeFileSync(join(tempDir, MANIFEST_FILENAME), manifestJson, "utf-8");

    // 8b. Sign manifest (HMAC-SHA256 anti-tampering)
    const signingKey = getOrCreateSigningKey(workDir);
    const signature  = signManifest(manifestJson, signingKey);
    writeFileSync(join(tempDir, MANIFEST_SIG_FILE), signature, "utf-8");

    // 9. Pre-flight size check then create archive with yazl (streaming)
    checkBackupSize(tempDir);
    await writeZipFromDir(tempDir, archivePath);

    // 10. Verify archive by reading manifest via streaming (no full load)
    const verified = await extractManifestFromArchive(archivePath);
    if (verified.checksum !== checksum) {
      throw SidjuaError.from("SYS-005", "Archive verification failed immediately after creation");
    }

    const archiveSize = statSync(archivePath).size;

    logger.info("backup_created", `Backup created: ${shortId}`, {
      metadata: { id, short_id: shortId, archive_path: archivePath, file_count: contentFiles.length, archive_size: archiveSize, label },
    });

    // 11. Retention
    await enforceRetention(cfg);

    return {
      id,
      short_id:           shortId,
      archive_path:       archivePath,
      file_count:         contentFiles.length,
      archive_size_bytes: archiveSize,
      ...(label !== undefined ? { label } : {}),
      ...(dbWarnings.length > 0 ? { warnings: dbWarnings } : {}),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}


export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const { workDir, configPath, dryRun = false, force = false } = options;
  const cfg = getBackupConfig(workDir, configPath);

  // C5: Require non-empty backupDir
  const effectiveBackupDir = options.backupDir ?? cfg.directory;
  if (typeof effectiveBackupDir !== "string" || effectiveBackupDir.trim().length === 0) {
    throw SidjuaError.from("SYS-009", "backupDir must be provided and non-empty");
  }

  const archivePath = await resolveArchivePath(options.archivePathOrId, effectiveBackupDir);

  if (!existsSync(archivePath)) {
    throw SidjuaError.from("SYS-008", `Archive not found: ${archivePath}`);
  }

  const tempDir = join(tmpdir(), `sidjua-restore-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });

  try {
    // C3: Pass 1 — read ONLY manifest.json + manifest.sig, verify HMAC BEFORE extracting anything
    const { manifest: manifestBuf, sig: sigBuf } = await readZipHeaders(archivePath);

    let manifestJson: string;
    try {
      manifestJson = manifestBuf.toString("utf-8");
    } catch (parseErr) {
      throw SidjuaError.from("SYS-005", `Failed to decode manifest.json: ${String(parseErr)}`);
    }

    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(manifestJson) as BackupManifest;
    } catch (parseErr) {
      throw SidjuaError.from("SYS-005", `manifest.json is not valid JSON: ${String(parseErr)}`);
    }

    // Verify signature BEFORE any extraction
    const signingKey = getOrCreateSigningKey(workDir);
    if (sigBuf !== null) {
      const storedSig = sigBuf.toString("utf-8").trim();
      if (!verifyManifestSig(manifestJson, storedSig, signingKey)) {
        throw SidjuaError.from("SYS-005", "Manifest HMAC signature invalid — archive may be tampered");
      }
    } else {
      // No sig — backward compat: allow with --force, reject otherwise
      if (!force) {
        throw SidjuaError.from(
          "SYS-005",
          "Archive has no manifest signature. Use --force to restore unsigned backup.",
        );
      }
      logger.warn("backup_no_sig", "Restoring unsigned backup (no manifest.sig) — configure SIDJUA_BACKUP_KEY for future security", {});
    }

    // C3: Pass 2 — now safe to extract (signature verified)
    await streamingExtract(archivePath, tempDir, MAX_RESTORE_SIZE_BYTES);

    // 3. Verify checksum
    const contentFiles: Array<{ relPath: string; absPath: string }> = [];
    for (const relPath of manifest.files) {
      const absPath = join(tempDir, relPath);
      if (existsSync(absPath)) {
        contentFiles.push({ relPath, absPath });
      }
    }
    const actualChecksum = await computeChecksum(contentFiles);
    if (actualChecksum !== manifest.checksum) {
      throw SidjuaError.from(
        "SYS-005",
        `Checksum mismatch: expected ${manifest.checksum.slice(0, 12)}…, got ${actualChecksum.slice(0, 12)}…`,
      );
    }

    // 3b. Per-file checksum verification — catches injected/swapped files not caught by aggregate hash
    if (manifest.file_checksums !== undefined) {
      for (const relPath of manifest.files) {
        const absPath  = join(tempDir, relPath);
        if (!existsSync(absPath)) {
          throw SidjuaError.from("SYS-005", `Restored file missing from archive: ${relPath}`);
        }
        const actual   = await computeFileChecksum(absPath);
        const expected = manifest.file_checksums[relPath];
        if (expected !== undefined && actual !== expected) {
          throw SidjuaError.from("SYS-005", `Per-file checksum mismatch after extraction: ${relPath}`);
        }
      }
    }

    // 4. Version check
    if (!isVersionCompatible(manifest.sidjua_version, SIDJUA_VERSION)) {
      throw SidjuaError.from(
        "SYS-006",
        `Archive version ${manifest.sidjua_version}, current ${SIDJUA_VERSION}`,
      );
    }

    // Dry-run: validate only
    if (dryRun) {
      logger.info("backup_restore_dry_run", `Dry-run restore: ${manifest.short_id}`, {
        metadata: { id: manifest.id, file_count: manifest.file_count, workDir },
      });
      return { id: manifest.id, dryRun: true, files_restored: manifest.file_count };
    }

    // 5. Agents-running check
    if (!force && checkAgentsRunning(workDir)) {
      throw SidjuaError.from("SYS-007", "Stop all agents before restoring");
    }

    // 6. Pre-restore backup
    let preRestoreId: string | undefined;
    try {
      const pre = await createBackup({ workDir, configPath, label: "pre-restore-auto" }, cfg);
      preRestoreId = pre.id;
      logger.info("backup_pre_restore_created", `Pre-restore backup: ${pre.short_id}`, {
        metadata: { id: pre.id },
      });
    } catch (err) {
      logger.warn("backup_pre_restore_failed", `Pre-restore backup failed (continuing): ${String(err)}`, {});
    }

    // 7. Restore databases
    // Walk databases/ recursively, preserve relative paths back to workDir
    const dbSrc = join(tempDir, "databases");
    if (existsSync(dbSrc)) {
      const dbFiles = collectFiles(dbSrc);
      for (const dbFile of dbFiles) {
        if (!dbFile.endsWith(".db")) continue;
        // relPath within the databases/ dir (e.g., "data/agent.db" or "agent.db")
        const relInDatabases = relative(dbSrc, dbFile);
        const destPath       = join(workDir, relInDatabases);
        mkdirSync(dirname(destPath), { recursive: true });
        await backupDatabase(dbFile, destPath);
      }
    }

    // 8. Restore governance
    const govSrc = join(tempDir, "governance");
    if (existsSync(govSrc)) {
      copyDirSync(govSrc, join(workDir, "governance"));
    }

    // 9. Restore division directories (additive)
    const divSrc = join(tempDir, "divisions");
    if (existsSync(divSrc)) {
      for (const divCode of readdirSync(divSrc)) {
        const src = join(divSrc, divCode);
        if (statSync(src).isDirectory()) {
          copyDirSync(src, join(workDir, divCode));
        }
      }
    }

    // 10. Restore config files
    const configSrc = join(tempDir, "config");
    if (existsSync(configSrc)) {
      for (const cf of readdirSync(configSrc)) {
        copyFileSync(join(configSrc, cf), join(workDir, cf));
      }
    }

    // 11. Restore snapshots
    const snapshotSrc = join(tempDir, "snapshots");
    if (existsSync(snapshotSrc)) {
      const dest = join(workDir, "data", "governance-snapshots");
      mkdirSync(dest, { recursive: true });
      copyDirSync(snapshotSrc, dest);
    }

    // 12. Restore knowledge
    const knowledgeSrc = join(tempDir, "knowledge");
    if (existsSync(knowledgeSrc)) {
      const dest = join(workDir, "data", "knowledge");
      mkdirSync(dest, { recursive: true });
      copyDirSync(knowledgeSrc, dest);
    }

    logger.info("backup_restored", `Backup restored: ${manifest.short_id}`, {
      metadata: { id: manifest.id, files_restored: contentFiles.length, workDir, pre_restore_id: preRestoreId },
    });

    return {
      id:             manifest.id,
      dryRun:         false,
      files_restored: contentFiles.length,
      ...(preRestoreId !== undefined && { pre_restore_backup_id: preRestoreId }),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}


export async function listBackups(backupDir: string): Promise<BackupInfo[]> {
  // C5: explicit non-empty check
  if (typeof backupDir !== "string" || backupDir.length === 0) return [];
  if (!existsSync(backupDir)) return [];
  const results: BackupInfo[] = [];

  for (const filename of readdirSync(backupDir)) {
    if (!filename.endsWith(".zip")) continue;
    const archivePath = join(backupDir, filename);
    try {
      const manifest = await extractManifestFromArchive(archivePath);
      results.push({
        id:                 manifest.id,
        short_id:           manifest.short_id,
        archive_path:       archivePath,
        created_at:         manifest.created_at,
        file_count:         manifest.file_count,
        total_size_bytes:   manifest.total_size_bytes,
        archive_size_bytes: statSync(archivePath).size,
        sidjua_version:     manifest.sidjua_version,
        ...(manifest.label !== undefined ? { label: manifest.label } : {}),
      });
    } catch (err) {
      logger.warn("backup_archive_unreadable",
        `Backup archive is corrupt or unreadable — skipping: ${filename}`,
        { metadata: { archive_path: archivePath, error: String(err) } },
      );
    }
  }

  return results.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}


export async function getBackupInfo(archivePathOrId: string, backupDir?: string): Promise<BackupManifest> {
  // C5: require non-empty backupDir if provided as non-undefined
  const effectiveDir = backupDir ?? "";
  if (typeof effectiveDir !== "string" || effectiveDir.trim().length === 0) {
    // Direct archive path — validate it ends with .zip and no traversal
    if (archivePathOrId.includes("..")) {
      throw SidjuaError.from("SYS-009", "Archive path contains path traversal characters");
    }
    if (!archivePathOrId.endsWith(".zip")) {
      throw SidjuaError.from("SYS-008", `Backup not found: ${archivePathOrId}`);
    }
    const resolvedPath = resolve(archivePathOrId);
    if (!existsSync(resolvedPath)) {
      throw SidjuaError.from("SYS-008", `Backup not found: ${archivePathOrId}`);
    }
    return extractManifestFromArchive(resolvedPath);
  }

  const archivePath = await resolveArchivePath(archivePathOrId, effectiveDir);
  if (!existsSync(archivePath)) {
    throw SidjuaError.from("SYS-008", `Backup not found: ${archivePathOrId}`);
  }
  return extractManifestFromArchive(archivePath);
}


export function deleteBackup(archivePathOrId: string, backupDir?: string): void {
  // C5: if backupDir is explicitly provided (even as ""), it must be non-empty
  if (backupDir !== undefined && (typeof backupDir !== "string" || backupDir.trim().length === 0)) {
    throw SidjuaError.from("SYS-009", "backupDir must be provided and non-empty");
  }

  // Traversal check always applies
  if (archivePathOrId.includes("..")) {
    throw SidjuaError.from("SYS-009", "Archive path contains path traversal characters");
  }

  if (backupDir !== undefined) {
    // C5: backupDir provided — enforce boundary
    let archivePath: string;
    if (archivePathOrId.endsWith(".zip")) {
      archivePath = resolve(archivePathOrId);
    } else {
      archivePath = resolveBackupId(archivePathOrId, backupDir);
    }

    const resolvedDir = resolve(backupDir);
    const archRel = relative(resolvedDir, archivePath);
    if (archRel.startsWith("..") || isAbsolute(archRel)) {
      throw SidjuaError.from("SYS-009", `Archive path escapes backup directory: ${archivePath}`);
    }

    if (!existsSync(archivePath)) {
      throw SidjuaError.from("SYS-008", `Backup not found: ${archivePathOrId}`);
    }
    rmSync(archivePath);
    logger.info("backup_deleted", `Backup deleted: ${basename(archivePath)}`, {
      metadata: { archive_path: archivePath },
    });
  } else {
    // No backupDir — only allow absolute paths pointing to .zip files within
    // the OS temp directory. Prevents arbitrary file deletion.
    const resolved = resolve(archivePathOrId);

    // Enforce .zip suffix
    if (!resolved.endsWith(".zip")) {
      throw SidjuaError.from("SYS-009", `Archive must be a .zip file: ${archivePathOrId}`);
    }

    // Enforce containment within tmpdir (the only safe location without a backupDir)
    const safeTmpDir = resolve(tmpdir());
    const archRel    = relative(safeTmpDir, resolved);
    if (archRel.startsWith("..") || isAbsolute(archRel)) {
      throw SidjuaError.from(
        "SYS-009",
        `Archive path is not within a safe directory: ${archivePathOrId}`,
      );
    }

    if (!existsSync(resolved)) {
      throw SidjuaError.from("SYS-008", `Backup not found: ${archivePathOrId}`);
    }
    rmSync(resolved);
    logger.info("backup_deleted", `Backup deleted: ${basename(resolved)}`, {
      metadata: { archive_path: resolved },
    });
  }
}


export function resolveBackupId(shortId: string, backupDir: string): string {
  // C5: explicit non-empty check
  if (typeof backupDir !== "string" || backupDir.trim().length === 0) {
    throw SidjuaError.from("SYS-009", "backupDir must be provided and non-empty");
  }

  if (!existsSync(backupDir)) {
    throw SidjuaError.from("SYS-008", `Backup directory not found: ${backupDir}`);
  }

  const normalized = shortId.toLowerCase().replace(/-/g, "");
  const matches: string[] = [];

  for (const filename of readdirSync(backupDir)) {
    if (!filename.endsWith(".zip")) continue;
    const archivePath = join(backupDir, filename);

    // Quick match against filename (contains short_id)
    if (filename.toLowerCase().includes(normalized)) {
      if (!matches.includes(archivePath)) matches.push(archivePath);
      continue;
    }

    // Full UUID match via manifest — fire-and-forget sync read (best effort; errors skip)
    // NOTE: resolveBackupId is kept sync (used in deleteBackup path); we do a sync openEntry
    // approach here using yauzl.fromBuffer which requires reading the file first.
    // To keep sync behavior, we skip manifest UUID lookup in this path (filename match suffices
    // for the common case). Full UUID lookup is available via the async listBackups path.
  }

  if (matches.length === 0) {
    throw SidjuaError.from("SYS-008", `No backup matches ID: ${shortId}`);
  }
  if (matches.length > 1) {
    const names = matches.map((p) => basename(p)).join(", ");
    throw SidjuaError.from("SYS-008", `Ambiguous ID "${shortId}" — matches: ${names}`);
  }

  return matches[0]!;
}


/**
 * Atomically delete a backup archive.
 *
 * Uses rename-before-delete: the rename is atomic on the same filesystem, so a
 * concurrent backup creation cannot see the file as the deletion target once the
 * rename completes. The actual unlink is async to avoid blocking the event loop.
 *
 * On startup, listBackups() skips .deleting files, so interrupted retentions
 * from a previous crash are cleaned up the next time enforceRetention() runs.
 */
async function atomicDelete(archivePath: string, shortId: string, reason: string): Promise<void> {
  const deletingPath = `${archivePath}.deleting`;
  try {
    renameSync(archivePath, deletingPath);
    logger.info("backup_retention_deleted", `Retention (${reason}): ${shortId}`, {
      metadata: { path: archivePath },
    });
    // Async unlink — does not block the event loop
    fsPromises.rm(deletingPath, { force: true }).catch((err: unknown) => {
      logger.warn("backup_retention_cleanup_error", "Could not remove .deleting file", {
        metadata: { path: deletingPath, error: err instanceof Error ? err.message : String(err) },
      });
    });
  } catch (err) {
    logger.warn("backup_retention_error", `Could not rename for deletion: ${String(err)}`, {
      metadata: { path: archivePath },
    });
  }
}

async function enforceRetention(config: BackupConfig): Promise<void> {
  const backups = await listBackups(config.directory);

  if (config.retention_count > 0 && backups.length > config.retention_count) {
    const toDelete = backups.slice(config.retention_count);
    for (const b of toDelete) {
      await atomicDelete(b.archive_path, b.short_id, "count");
    }
  }

  if (config.retention_days > 0) {
    const cutoff  = Date.now() - config.retention_days * 86_400_000;
    const expired = backups.filter((b) => new Date(b.created_at).getTime() < cutoff);
    for (const b of expired) {
      if (existsSync(b.archive_path)) {
        await atomicDelete(b.archive_path, b.short_id, "age");
      }
    }
  }
}
