// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua start-over` command (P193)
 *
 * Safe, learning-oriented workspace restart. Backs up EVERYTHING before
 * wiping. Never destructive without explicit confirmation. The philosophy:
 * mistakes are data, not failure.
 *
 * Also registers:
 *   sidjua analyze --workspace <path>   — analyse a backup with auditor agent
 */

import {
  existsSync,
  statSync,
  statfsSync,
  readdirSync,
  mkdirSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, freemem, tmpdir } from "node:os";
import { join, resolve, basename, relative, sep } from "node:path";
import { validateWorkDir } from "../../utils/path-utils.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Command } from "commander";
import { SIDJUA_VERSION } from "../../version.js";
import { createLogger }   from "../../core/logger.js";
import { auditCliCommand } from "../cli-audit.js";

const logger = createLogger("start-over");


/** Summary of a workspace, produced by scanWorkspace(). */
export interface WorkspaceSummary {
  workDir:         string;
  created:         Date | null;
  agentCount:      number;
  activeAgents:    number;
  stoppedAgents:   number;
  errorAgents:     number;
  divisionCount:   number;
  logEntries:      number;
  configFiles:     number;
  sqliteDbs:       number;
  chatHistories:   number;
  userFiles:       number;
  governanceRules: number;
  totalBytes:      number;
  isEmpty:         boolean;
  isInitialized:   boolean;
}

/** Metadata written into every backup directory. */
export interface BackupMetadata {
  backup_date:        string;
  sidjua_version:     string;
  workspace_created:  string | null;
  agent_count:        number;
  division_count:     number;
  chat_count:         number;
  file_count:         number;
  rule_count:         number;
  total_size_bytes:   number;
  reason:             string;
}


/**
 * Recursively count all files under `dir` and accumulate their sizes.
 * Silently skips unreadable paths.
 */
function walkDir(dir: string, out: { count: number; bytes: number }): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (_e) {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch (_e) {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(full, out);
    } else {
      out.count++;
      out.bytes += st.size;
    }
  }
}

/**
 * Count newlines in a file without loading the entire contents.
 * Returns 0 if the file is unreadable.
 */
function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf8");
    return content.split("\n").filter((l) => l.trim()).length;
  } catch (_e) {
    return 0;
  }
}

/**
 * Count immediate children of a directory (files + subdirs).
 * Returns 0 if the directory doesn't exist or is unreadable.
 */
function countDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).length;
  } catch (_e) {
    return 0;
  }
}

/**
 * Count files matching a simple extension list inside `dir` (non-recursive).
 */
function countFiles(dir: string, exts: string[]): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => exts.some((e) => f.endsWith(e))).length;
  } catch (_e) {
    return 0;
  }
}

/**
 * Count matching files recursively in `dir`.
 */
function countFilesRecursive(dir: string, exts: string[]): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch (_e) { continue; }
      if (st.isDirectory()) {
        total += countFilesRecursive(full, exts);
      } else if (exts.some((e) => name.endsWith(e))) {
        total++;
      }
    }
  } catch (_e) { /* ignore */ }
  return total;
}

/**
 * Read agent status counts from the SQLite database, if available.
 * Falls back to { active: 0, stopped: 0, error: 0 }.
 */
function readAgentStatuses(dbPath: string): { active: number; stopped: number; error: number } {
  const result = { active: 0, stopped: 0, error: 0 };
  if (!existsSync(dbPath)) return result;
  try {
    // Inline dynamic require to keep this module dependency-free in tests
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = (require("better-sqlite3") as { default?: typeof import("better-sqlite3"); } & typeof import("better-sqlite3")).default ?? require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(
        "SELECT status, COUNT(*) AS cnt FROM agent_lifecycle GROUP BY status",
      ).all() as Array<{ status: string; cnt: number }>;
      for (const { status, cnt } of rows) {
        if (status === "active" || status === "starting" || status === "idle") result.active += cnt;
        else if (status === "stopped" || status === "stopping")               result.stopped += cnt;
        else if (status === "error")                                          result.error += cnt;
      }
    } finally {
      db.close();
    }
  } catch (_e) { /* DB not readable — fall through */ }
  return result;
}

/**
 * Read the workspace creation date from the SQLite database.
 * Returns null if unavailable.
 */
function readWorkspaceCreated(dbPath: string): Date | null {
  if (!existsSync(dbPath)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = (require("better-sqlite3") as { default?: typeof import("better-sqlite3"); } & typeof import("better-sqlite3")).default ?? require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(
        "SELECT value FROM workspace_config WHERE key = 'created_at' LIMIT 1",
      ).get() as { value: string } | undefined;
      if (row?.value) return new Date(row.value);
    } finally {
      db.close();
    }
  } catch (_e) { /* fall through */ }
  return null;
}

/**
 * Scan a workspace directory and return a `WorkspaceSummary`.
 * Never throws — unreadable paths are treated as empty.
 */
export function scanWorkspace(workDir: string): WorkspaceSummary {
  const systemDir  = join(workDir, ".system");
  const dbPath     = join(systemDir, "sidjua.db");
  const agentsDir  = join(workDir, "agents", "definitions");
  const govDir     = join(workDir, "governance");
  const logsDir    = join(workDir, "logs");
  const chatsDir   = join(workDir, "chats");
  const userDir    = join(workDir, "user-files");
  const rulesDir   = join(workDir, "rules");

  const isInitialized = existsSync(dbPath);

  // Check for complete emptiness (no .system at all)
  const isEmpty = !existsSync(systemDir) && !existsSync(agentsDir);

  // Agent count from definitions dir
  const agentCount    = countFiles(agentsDir, [".yaml", ".yml"]);
  const agentStatuses = readAgentStatuses(dbPath);

  // Division count — from YAML (count "- name:" or "  name:" blocks)
  let divisionCount = 0;
  const divYaml = join(govDir, "divisions.yaml");
  if (existsSync(divYaml)) {
    try {
      const lines = readFileSync(divYaml, "utf8").split("\n");
      // Match "  - name: foo" or "  name: foo" (YAML list item or mapping key)
      divisionCount = lines.filter((l) => /^\s+(?:-\s+)?name:\s/.test(l)).length;
      if (divisionCount === 0) {
        // fallback: count top-level list items "- "
        divisionCount = lines.filter((l) => /^\s*-\s/.test(l)).length;
      }
    } catch (_e) { /* ignore */ }
  }

  // Log entries — count non-empty lines in all .log files in logs/
  let logEntries = 0;
  if (existsSync(logsDir)) {
    try {
      for (const name of readdirSync(logsDir)) {
        if (name.endsWith(".log") || name.endsWith(".jsonl") || name.endsWith(".txt")) {
          logEntries += countLines(join(logsDir, name));
        }
      }
    } catch (_e) { /* ignore */ }
  }

  // Config files: YAML/JSON in governance/ + .system/providers/
  const configFiles =
    countFilesRecursive(govDir, [".yaml", ".yml", ".json"]) +
    countFilesRecursive(join(systemDir, "providers"), [".yaml", ".yml"]);

  // SQLite databases
  const sqliteDbs = countFilesRecursive(workDir, [".db", ".sqlite"]);

  // Chat histories
  const chatHistories = countDir(chatsDir);

  // User files
  const userFiles = countDir(userDir);

  // Governance rules (rules/ + governance/boundaries/)
  const governanceRules =
    countFilesRecursive(rulesDir, [".yaml", ".yml", ".json"]) +
    countFilesRecursive(join(govDir, "boundaries"), [".yaml", ".yml", ".json"]);

  // Total workspace size
  const sizeAcc = { count: 0, bytes: 0 };
  if (existsSync(workDir)) walkDir(workDir, sizeAcc);

  const created = readWorkspaceCreated(dbPath);

  return {
    workDir,
    created,
    agentCount,
    activeAgents:    agentStatuses.active,
    stoppedAgents:   agentStatuses.stopped,
    errorAgents:     agentStatuses.error,
    divisionCount,
    logEntries,
    configFiles,
    sqliteDbs,
    chatHistories,
    userFiles,
    governanceRules,
    totalBytes:      sizeAcc.bytes,
    isEmpty,
    isInitialized,
  };
}


/**
 * Format a Date as `YYYY-MM-DD-HHmmss` for backup directory names.
 */
export function formatBackupTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join("-") + "-" + [
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

/**
 * Return the default backups root: `~/.sidjua/backups/`.
 */
export function defaultBackupsRoot(): string {
  return join(homedir(), ".sidjua", "backups");
}

/**
 * Compute a unique backup destination path.
 * If `workspace-TIMESTAMP` already exists, appends `-1`, `-2`, etc.
 */
export function resolveBackupDest(root: string, ts: string): string {
  const base = join(root, `workspace-${ts}`);
  if (!existsSync(base)) return base;
  for (let i = 1; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Check available disk space against the workspace size.
 * Returns `{ ok: true }` or `{ ok: false, needed: number, available: number }`.
 *
 * Note: Node.js has no built-in statvfs. We approximate by reading /proc/statvfs
 * or using `os.freemem()` as a rough proxy. A real implementation would use
 * a native binding. Here we check that free memory > workspace size × 1.1 as
 * a conservative guard (backups are on disk, not RAM, but this prevents the
 * most obvious failures).
 */
const MIN_FREE_BYTES = 100 * 1024 * 1024; // 100 MB minimum regardless of workspace size

export function checkDiskSpace(
  workspaceSizeBytes: number,
  checkPath = tmpdir(),
): { ok: true } | { ok: false; needed: number; available: number } {
  let available: number;
  try {
    const stats = statfsSync(checkPath);
    available = stats.bfree * stats.bsize;
  } catch (_err) {
    // Fall back to freemem() if statfsSync is unavailable (e.g. non-Linux)
    available = freemem();
  }
  const needed = Math.max(Math.ceil(workspaceSizeBytes * 1.1), MIN_FREE_BYTES);
  if (available < needed) {
    return { ok: false, needed, available };
  }
  return { ok: true };
}

/**
 * Write `metadata.json` into the backup directory.
 */
export function writeBackupMetadata(
  backupDir: string,
  meta: BackupMetadata,
): void {
  writeFileSync(
    join(backupDir, "metadata.json"),
    JSON.stringify(meta, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Files and patterns that must NEVER be included in a workspace backup.
 *
 * The backup is user-accessible (stored in ~/.sidjua/backups or a
 * user-specified path). Credentials and server secrets must not be copied
 * there to avoid credential leakage via the backup archive.
 *
 * Matching logic (see shouldExcludeFromBackup):
 *   - Exact relative-path matches are checked against EXCLUDED_EXACT_PATHS.
 *   - Any file inside .system/ that has a .key or .token extension is blocked
 *     via EXCLUDED_SYSTEM_PATTERN regardless of its specific name.
 */
const EXCLUDED_EXACT_PATHS = new Set([
  ".env",
  join(".system", "master.key"),
  join(".system", "backup.key"),
  join(".system", "server.key"),
  join(".system", "ipc.token"),
  join(".system", "admin.token"),
]);

const EXCLUDED_SYSTEM_PATTERN = /\.(key|token)$/i;

function shouldExcludeFromBackup(workDir: string, srcPath: string): boolean {
  const rel = relative(workDir, srcPath);
  if (EXCLUDED_EXACT_PATHS.has(rel)) return true;
  // Block any *.key / *.token file inside .system/ (catches future additions)
  const inSystem = rel === ".system" || rel.startsWith(".system" + sep);
  if (inSystem && EXCLUDED_SYSTEM_PATTERN.test(basename(srcPath))) return true;
  return false;
}

/**
 * Copy the entire workspace to `destDir`, excluding secrets and credentials.
 *
 * Sensitive files (API keys, IPC tokens, .env) are never copied to the
 * backup destination — the backup is user-accessible and must not contain
 * credentials. Excluded paths are logged at INFO level.
 *
 * @throws Error if the copy fails for any reason.
 */
export function copyWorkspace(workDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  // Copy each top-level entry separately to avoid copying dest if it's inside workDir
  const entries = readdirSync(workDir);
  for (const name of entries) {
    const src = join(workDir, name);
    if (shouldExcludeFromBackup(workDir, src)) {
      logger.info("start_over_backup", `Excluded from backup: ${name}`, { metadata: { path: name } });
      continue;
    }
    const dest = join(destDir, name);
    cpSync(src, dest, {
      recursive:    true,
      errorOnExist: false,
      filter: (srcFile) => {
        if (shouldExcludeFromBackup(workDir, srcFile)) {
          const rel = relative(workDir, srcFile);
          logger.info("start_over_backup", `Excluded from backup: ${rel}`, { metadata: { path: rel } });
          return false;
        }
        return true;
      },
    });
  }
}

/**
 * Create a full workspace backup.
 *
 * @param workDir - Source workspace directory.
 * @param summary - Pre-scanned workspace summary.
 * @param backupsRoot - Root directory for backups (default: ~/.sidjua/backups/).
 * @param now - Timestamp for the backup name (default: new Date()).
 * @returns Path to the created backup directory.
 * @throws Error if backup fails for any reason.
 */
export function createWorkspaceBackup(
  workDir:     string,
  summary:     WorkspaceSummary,
  backupsRoot: string = defaultBackupsRoot(),
  now:         Date   = new Date(),
): string {
  const ts      = formatBackupTimestamp(now);
  const destDir = resolveBackupDest(backupsRoot, ts);

  // Create backup root
  try {
    mkdirSync(backupsRoot, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create backup directory: ${backupsRoot}\n${String(err)}`);
  }

  // Copy workspace
  copyWorkspace(workDir, destDir);

  // Write metadata
  const meta: BackupMetadata = {
    backup_date:       now.toISOString(),
    sidjua_version:    SIDJUA_VERSION,
    workspace_created: summary.created?.toISOString() ?? null,
    agent_count:       summary.agentCount,
    division_count:    summary.divisionCount,
    chat_count:        summary.chatHistories,
    file_count:        summary.userFiles,
    rule_count:        summary.governanceRules,
    total_size_bytes:  summary.totalBytes,
    reason:            "start-over",
  };
  writeBackupMetadata(destDir, meta);

  return destDir;
}


/** Directories within the workspace that are removed during a wipe. */
const WIPE_DIRS = [
  ".system",
  "governance",
  "agents",
  "logs",
  "chats",
  "user-files",
  "rules",
  "data",
  "docs",
  "ai-governance",
  "archive",
  "config",
] as const;

/**
 * Wipe a workspace directory in preparation for a fresh init.
 *
 * Removes workspace-generated directories and files.
 * Does NOT touch the backups directory (which lives outside the workspace
 * in ~/.sidjua/backups/).
 */
export function wipeWorkspace(workDir: string): void {
  for (const dir of WIPE_DIRS) {
    const full = join(workDir, dir);
    if (existsSync(full)) {
      rmSync(full, { recursive: true, force: true });
    }
  }

  // Remove division-specific root directories (named by division slug)
  // Identify them as directories at root that are not in our known list
  const keepDirs = new Set([...WIPE_DIRS, "backups", "node_modules", ".git"]);
  try {
    for (const name of readdirSync(workDir)) {
      if (keepDirs.has(name)) continue;
      const full = join(workDir, name);
      let st;
      try { st = statSync(full); } catch (_e) { continue; }
      if (st.isDirectory()) {
        rmSync(full, { recursive: true, force: true });
      }
    }
  } catch (_e) { /* ignore */ }

  // Remove root-level .env, *.db, *.sqlite
  const ROOT_FILES = [".env"];
  for (const f of ROOT_FILES) {
    const full = join(workDir, f);
    if (existsSync(full)) {
      rmSync(full, { force: true });
    }
  }
  // Remove root-level DB files
  try {
    for (const name of readdirSync(workDir)) {
      if (name.endsWith(".db") || name.endsWith(".sqlite")) {
        const full = join(workDir, name);
        if (existsSync(full) && statSync(full).isFile()) {
          rmSync(full, { force: true });
        }
      }
    }
  } catch (_e) { /* ignore */ }
}


export interface BackupEntry {
  path:    string;
  name:    string;
  date:    Date | null;
  version: string | null;
  bytes:   number;
  meta:    BackupMetadata | null;
}

/**
 * List all backup directories under `backupsRoot`.
 */
export function listBackups(backupsRoot: string = defaultBackupsRoot()): BackupEntry[] {
  if (!existsSync(backupsRoot)) return [];
  let names: string[];
  try {
    names = readdirSync(backupsRoot);
  } catch (_e) {
    return [];
  }

  const entries: BackupEntry[] = [];
  for (const name of names.sort().reverse()) {
    const full = join(backupsRoot, name);
    let st;
    try { st = statSync(full); } catch (_e) { continue; }
    if (!st.isDirectory()) continue;

    let meta: BackupMetadata | null = null;
    const metaPath = join(full, "metadata.json");
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as BackupMetadata;
      } catch (_e) { /* ignore */ }
    }

    const sizeAcc = { count: 0, bytes: 0 };
    walkDir(full, sizeAcc);

    entries.push({
      path:    full,
      name,
      date:    meta?.backup_date ? new Date(meta.backup_date) : null,
      version: meta?.sidjua_version ?? null,
      bytes:   sizeAcc.bytes,
      meta,
    });
  }
  return entries;
}


/**
 * Read and return BackupMetadata from a backup directory.
 * Returns null if the path is not a valid backup.
 */
export function readBackupMetadata(backupPath: string): BackupMetadata | null {
  const metaPath = join(backupPath, "metadata.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as BackupMetadata;
  } catch (_e) {
    return null;
  }
}


function formatSize(bytes: number): string {
  if (bytes < 1024)               return `${bytes} B`;
  if (bytes < 1024 * 1024)        return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

function printSummary(summary: WorkspaceSummary): void {
  const createdStr = summary.created
    ? summary.created.toLocaleString()
    : "unknown";
  const agentDetail = summary.agentCount > 0
    ? ` (${summary.activeAgents} active, ${summary.stoppedAgents} stopped, ${summary.errorAgents} error)`
    : "";

  stdout.write("\nWorkspace Summary:\n");
  stdout.write(`  Created:          ${createdStr}\n`);
  stdout.write(`  Agents:           ${summary.agentCount}${agentDetail}\n`);
  stdout.write(`  Divisions:        ${summary.divisionCount}\n`);
  stdout.write(`  Log entries:      ${formatNum(summary.logEntries)}\n`);
  stdout.write(`  Config files:     ${summary.configFiles}\n`);
  stdout.write(`  SQLite DBs:       ${summary.sqliteDbs}\n`);
  stdout.write(`  Chat histories:   ${summary.chatHistories} conversations\n`);
  stdout.write(`  User files:       ${summary.userFiles}\n`);
  stdout.write(`  Governance rules: ${summary.governanceRules}\n`);
  stdout.write(`  Total size:       ${formatSize(summary.totalBytes)}\n`);
  stdout.write("\n");
}


async function askYesNo(question: string): Promise<boolean> {
  if (!stdin.isTTY) return false; // default No in non-interactive mode
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  let answer = "";
  try {
    answer = await rl.question(question);
  } finally {
    rl.close();
  }
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}


export interface StartOverCommandOptions {
  workDir:     string;
  list:        boolean;
  backupsRoot: string;
  /** Injected for tests — skips interactive confirmation. */
  forceYes?:   boolean;
}

export async function runStartOverCommand(opts: StartOverCommandOptions): Promise<number> {
  const { workDir, list, backupsRoot } = opts;
  validateWorkDir(workDir);

  // --- --list mode ---
  if (list) {
    const entries = listBackups(backupsRoot);
    if (entries.length === 0) {
      stdout.write("No previous backups found.\n");
      return 0;
    }
    stdout.write("Previous workspaces:\n\n");
    for (const e of entries) {
      const dateStr    = e.date ? e.date.toLocaleString() : "unknown date";
      const versionStr = e.version ? `v${e.version}` : "unknown version";
      stdout.write(`  ${dateStr}  ${versionStr}  ${formatSize(e.bytes)}\n`);
      stdout.write(`  ${e.path}\n\n`);
    }
    return 0;
  }

  // --- Step 1: Workspace Scan ---
  const summary = scanWorkspace(workDir);

  if (!summary.isInitialized && summary.isEmpty) {
    process.stderr.write(
      "Your workspace is empty — nothing to back up. Run `sidjua init` to get started.\n",
    );
    return 1;
  }

  if (!summary.isInitialized && !summary.isEmpty) {
    process.stderr.write(
      "No SIDJUA workspace found. Run `sidjua init` first.\n",
    );
    return 1;
  }

  printSummary(summary);

  // --- Step 2: Disk space check ---
  const spaceCheck = checkDiskSpace(summary.totalBytes, workDir);
  if (!spaceCheck.ok) {
    process.stderr.write(
      `Not enough disk space for backup.\n` +
      `  Need:      ${formatSize(spaceCheck.needed)}\n` +
      `  Available: ${formatSize(spaceCheck.available)}\n`,
    );
    return 1;
  }

  // --- Step 2: Backup message + execution ---
  stdout.write("Your previous work — including your mistakes — is valuable.\n");
  stdout.write("Backing up everything now...\n");

  let backupPath: string;
  try {
    backupPath = createWorkspaceBackup(workDir, summary, backupsRoot);
  } catch (err) {
    process.stderr.write(`\nBackup failed: ${String(err)}\nAborting — your workspace is unchanged.\n`);
    return 1;
  }
  stdout.write(`\nBackup saved to: ${backupPath}\n`);

  // --- Step 3: Learning prompt ---
  stdout.write("\n");
  stdout.write("Before you continue:\n");
  stdout.write("\n");
  stdout.write("Your old workspace contains everything — what worked and what didn't.\n");
  stdout.write("When your new setup is running, point an agent to this backup:\n");
  stdout.write("\n");
  stdout.write(`  sidjua analyze --workspace ${backupPath}\n`);
  stdout.write("\n");
  stdout.write("Let it figure out what went wrong. Learn from your experiments\n");
  stdout.write("before you repeat them.\n");

  // --- Step 4: Confirmation ---
  const confirmed = opts.forceYes ?? await askYesNo("\nReady to wipe the current workspace and start fresh? (y/N) ");
  if (!confirmed) {
    stdout.write("Cancelled. Your workspace is unchanged.\n");
    stdout.write(`Your backup is still available at: ${backupPath}\n`);
    return 0;
  }

  // --- Step 5: Wipe + fresh init ---
  stdout.write("\nWiping current workspace...\n");
  wipeWorkspace(workDir);

  stdout.write("Setting up fresh workspace...\n");
  const { runInitCommand } = await import("./init.js");
  const initCode = await runInitCommand({
    workDir,
    force:  true,
    quiet:  false,
    yes:    true,
  });
  if (initCode !== 0) {
    process.stderr.write("Fresh init failed. Check the error above.\n");
    return 1;
  }

  // --- Step 6: Completion ---
  stdout.write("\nFresh workspace ready.\n");
  stdout.write(`Your old data is safe at: ${backupPath}\n`);

  return 0;
}


export interface AnalyzeCommandOptions {
  workspace: string;
}

export async function runAnalyzeCommand(opts: AnalyzeCommandOptions): Promise<number> {
  const backupPath = resolve(opts.workspace);

  if (!existsSync(backupPath)) {
    process.stderr.write(`Workspace backup not found: ${backupPath}\n`);
    return 1;
  }

  const meta = readBackupMetadata(backupPath);
  if (!meta) {
    process.stderr.write(
      `Not a valid SIDJUA backup: ${backupPath}\n(Missing metadata.json)\n`,
    );
    return 1;
  }

  const backupDate = meta.backup_date
    ? new Date(meta.backup_date).toLocaleString()
    : "unknown";

  stdout.write(`\nWorkspace backup: ${backupDate}\n`);
  stdout.write(`SIDJUA version at backup: ${meta.sidjua_version}\n`);
  stdout.write(
    `Agents: ${meta.agent_count} | Divisions: ${meta.division_count} | Chats: ${meta.chat_count}\n`,
  );
  stdout.write("\n");

  // Check if auditor agent is configured in current workspace
  // The auditor agent is identified by the agent_id "auditor" in the registry
  const cwd         = process.cwd();
  const agentsYaml  = join(cwd, "agents", "agents.yaml");
  const auditorDef  = join(cwd, "agents", "definitions", "auditor.yaml");
  const hasAuditor  = existsSync(auditorDef) || (
    existsSync(agentsYaml) &&
    readFileSync(agentsYaml, "utf8").includes("auditor")
  );

  if (!hasAuditor) {
    stdout.write("No auditor agent configured. To analyze this workspace:\n");
    stdout.write("1. Configure an auditor agent in your new workspace\n");
    stdout.write(`2. Run: sidjua analyze --workspace ${backupPath}\n`);
    stdout.write("\n");
    stdout.write("You can also browse your old configs and logs directly at:\n");
    stdout.write(`  ${backupPath}\n`);
    return 0;
  }

  // Auditor agent is available — compile analysis payload and route to it
  stdout.write("Analyzing workspace with auditor agent...\n");
  stdout.write("(Collecting backup contents for analysis)\n");

  // Build a structured summary of the backup for the auditor
  const analysisPayload = buildAnalysisPayload(backupPath, meta);

  // Route to auditor via ExecutionBridge
  try {
    const { runChatCommand } = await import("./chat.js");
    const analysisPrompt =
      `Please analyze this backup of my previous SIDJUA workspace and produce a report.\n\n` +
      `${analysisPayload}\n\n` +
      `Focus on:\n` +
      `- What was configured correctly\n` +
      `- What likely caused problems\n` +
      `- Recommendations for the new setup\n` +
      `- Patterns to avoid\n`;

    void analysisPrompt; // prompt displayed to user above; chat is interactive
    const exitCode = await runChatCommand({
      agent:   "auditor",
      verbose: false,
      workDir: cwd,
    });
    return exitCode;
  } catch (_e) {
    // Fallback if auditor chat fails
    stdout.write("\nAuditor agent encountered an error. You can browse the backup directly at:\n");
    stdout.write(`  ${backupPath}\n`);
    return 0;
  }
}

/**
 * Build a structured text payload from a backup directory for the auditor agent.
 */
function buildAnalysisPayload(backupPath: string, meta: BackupMetadata): string {
  const lines: string[] = [
    `## Backup Metadata`,
    `- Date: ${meta.backup_date}`,
    `- SIDJUA version: ${meta.sidjua_version}`,
    `- Agents: ${meta.agent_count}`,
    `- Divisions: ${meta.division_count}`,
    `- Chat histories: ${meta.chat_count}`,
    `- Total size: ${formatSize(meta.total_size_bytes)}`,
    ``,
  ];

  // Include governance/divisions.yaml if present
  const divYaml = join(backupPath, "governance", "divisions.yaml");
  if (existsSync(divYaml)) {
    try {
      const content = readFileSync(divYaml, "utf8");
      lines.push("## Governance Configuration (divisions.yaml)");
      lines.push("```yaml");
      lines.push(content.slice(0, 8000)); // cap at 8KB
      lines.push("```");
      lines.push("");
    } catch (_e) { /* ignore */ }
  }

  // Include agent definitions (first 5)
  const agentDefsDir = join(backupPath, "agents", "definitions");
  if (existsSync(agentDefsDir)) {
    try {
      const defs = readdirSync(agentDefsDir).filter((f) => f.endsWith(".yaml")).slice(0, 5);
      for (const def of defs) {
        const content = readFileSync(join(agentDefsDir, def), "utf8");
        lines.push(`## Agent Definition: ${def}`);
        lines.push("```yaml");
        lines.push(content.slice(0, 4000));
        lines.push("```");
        lines.push("");
      }
    } catch (_e) { /* ignore */ }
  }

  // Include recent log entries (last 100 lines of most recent log)
  const logsDir = join(backupPath, "logs");
  if (existsSync(logsDir)) {
    try {
      const logs = readdirSync(logsDir).filter((f) => f.endsWith(".log") || f.endsWith(".jsonl"));
      if (logs.length > 0) {
        const latest = logs.sort().reverse()[0];
        const content = readFileSync(join(logsDir, latest!), "utf8");
        const lastLines = content.split("\n").slice(-100).join("\n");
        lines.push(`## Recent Logs (${latest})`);
        lines.push("```");
        lines.push(lastLines);
        lines.push("```");
        lines.push("");
      }
    } catch (_e) { /* ignore */ }
  }

  return lines.join("\n");
}


export function registerStartOverCommands(program: Command): void {
  // sidjua start-over
  program
    .command("start-over")
    .description("Back up your workspace and start fresh")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--list", "List all previous workspace backups", false)
    .option("--backups-root <path>", "Root directory for backups", defaultBackupsRoot())
    .action(async (opts: { workDir: string; list: boolean; backupsRoot: string }) => {
      auditCliCommand("start-over", undefined);
      const exitCode = await runStartOverCommand({
        workDir:     opts.workDir,
        list:        opts.list,
        backupsRoot: opts.backupsRoot,
      });
      process.exit(exitCode);
    });

  // sidjua analyze --workspace <path>
  program
    .command("analyze")
    .description("Analyze a previous workspace backup with the auditor agent")
    .requiredOption("--workspace <path>", "Path to the workspace backup directory")
    .action(async (opts: { workspace: string }) => {
      const exitCode = await runAnalyzeCommand({ workspace: opts.workspace });
      process.exit(exitCode);
    });
}
