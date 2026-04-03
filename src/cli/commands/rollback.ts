// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua rollback` Command
 *
 * Restores a previous SIDJUA version from the version archive.
 *
 * Flow:
 *   1. Lock
 *   2. List available archived versions
 *   3. Validate target version exists (--to flag or interactive)
 *   4. Warn about governance downgrade
 *   5. Confirm
 *   6. Restore system/ from VersionArchive
 *   7. Reverse migrations if schema version differs
 *   8. Run selftest
 *   9. Unlock
 *   10. Report
 *
 * Important:
 *   - Audit logs are NEVER deleted during rollback
 *   - User data (data/divisions/, data/governance/) is NOT restored
 */

import type { Command }          from "commander";
import { resolvePaths }          from "../../core/paths.js";
import { validateWorkDir }       from "../../utils/path-utils.js";
import { getCanonicalDbPath }   from "../../core/db/paths.js";
import { SIDJUA_VERSION }        from "../../version.js";
import { FileLockManager }       from "../../core/update/lock-manager.js";
import { VersionArchiveManager } from "../../core/update/version-archive.js";
import { loadMigrationState, rollbackMigration, loadMigrationRegistry } from "../../core/update/migration-framework.js";
import { runSelftest }           from "./update.js";
import { join }                  from "node:path";
import * as readline             from "node:readline";
import { createLogger }          from "../../core/logger.js";
import { auditCliCommand }       from "../cli-audit.js";

const logger = createLogger("rollback-cmd");


export function registerRollbackCommands(program: Command): void {
  program
    .command("rollback")
    .description("Rollback SIDJUA to a previous version")
    .option("--to <version>",   "Target version to rollback to")
    .option("--yes",            "Auto-confirm without interactive prompt")
    .option("--force-unlock",   "Release stale lock before starting")
    .option("--list",           "List available versions for rollback")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (opts: {
      to?:          string;
      yes:          boolean;
      forceUnlock:  boolean;
      list:         boolean;
      workDir:      string;
    }) => {
      await runRollback(opts.to, opts.yes, opts.forceUnlock, opts.list, opts.workDir);
    });
}


async function runRollback(
  targetVersion: string | undefined,
  autoYes:       boolean,
  forceUnlock:   boolean,
  listOnly:      boolean,
  workDir:       string,
): Promise<void> {
  if (!listOnly) {
    auditCliCommand("rollback", undefined);
  }
  validateWorkDir(workDir);
  const paths   = resolvePaths(workDir);
  const archive = new VersionArchiveManager(join(paths.system.root, ".."), paths.system.root);
  const lock    = new FileLockManager(paths.data.root);

  if (forceUnlock) {
    await lock.forceRelease();
    process.stdout.write("Stale lock released.\n");
  }

  // Step 2: List available versions
  const versions = await archive.listVersions();

  if (listOnly || versions.length === 0) {
    if (versions.length === 0) {
      process.stdout.write("No versions available for rollback.\n");
      process.stdout.write("Run 'sidjua update' first to create a version archive.\n");
      process.exit(0);
    }

    process.stdout.write("Available versions for rollback:\n");
    for (const v of versions) {
      process.stdout.write(
        `  v${v.version.padEnd(12)} archived ${v.archivedAt.slice(0, 10)} ` +
        `(ruleset ${v.governanceRulesetVersion}, ${formatBytes(v.sizeBytes)})\n`,
      );
    }
    process.exit(0);
  }

  // Step 3: Determine target version
  let target: string;
  if (targetVersion !== undefined) {
    const found = versions.find((v) => v.version === targetVersion);
    if (found === undefined) {
      process.stderr.write(`Version ${targetVersion} not found in archive.\n`);
      process.stderr.write(`Available: ${versions.map((v) => v.version).join(", ")}\n`);
      process.exit(1);
    }
    target = targetVersion;
  } else if (versions.length === 1) {
    target = versions[0]!.version;
  } else {
    // Show options and ask
    process.stdout.write("Available versions:\n");
    versions.forEach((v, i) => {
      process.stdout.write(`  ${i + 1}. v${v.version} (${v.archivedAt.slice(0, 10)})\n`);
    });
    process.stdout.write("\nRollback to most recent (v" + versions[0]!.version + ")? Use --to <version> to specify.\n");
    target = versions[0]!.version;
  }

  // Step 4: Warn about governance downgrade
  const targetEntry = versions.find((v) => v.version === target)!;
  process.stdout.write(`\nRollback: current v${SIDJUA_VERSION} → v${target}\n`);
  process.stdout.write(`Governance ruleset: current → v${targetEntry.governanceRulesetVersion}\n`);
  process.stdout.write("⚠  Security rules will be downgraded to the archived version.\n");
  process.stdout.write("⚠  Audit logs will NOT be modified.\n");
  process.stdout.write("⚠  User data (divisions/, governance/) will NOT be changed.\n");

  // Step 5: Confirm
  if (!autoYes) {
    const confirmed = await promptConfirm(`\nProceed with rollback to v${target}? [y/N] `);
    if (!confirmed) {
      process.stdout.write("Cancelled.\n");
      process.exit(0);
    }
  }

  // Step 6: Acquire lock
  let acquired: boolean;
  try {
    acquired = await lock.acquire("rollback");
  } catch (lockErr: unknown) {
    process.stderr.write(`Cannot acquire rollback lock: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}\n`);
    process.exit(1);
  }
  if (!acquired) {
    process.stderr.write("Another operation is in progress. Use --force-unlock if the lock is stale.\n");
    process.exit(1);
  }

  try {
    // Step 6: Restore system/
    process.stdout.write(`\nRestoring system/ from v${target} archive...\n`);
    await archive.restoreSystem(target);

    // Step 7: Reverse migrations if needed
    const currentState  = loadMigrationState(paths.data.root);
    const targetState   = { schemaVersion: 0, appliedMigrations: [] }; // conservative: rollback all
    void targetState;

    if (currentState.appliedMigrations.length > 0) {
      process.stdout.write("Reversing schema migrations...\n");
      const registry = loadMigrationRegistry(paths.system.migrations);
      const registryIds = new Set(registry.map((r) => r.id));

      // Rollback in reverse order (only migrations not in the restored system)
      const { openDatabase } = await import("../../utils/db.js");
      const db = openDatabase(getCanonicalDbPath(workDir));
      try {
        const toReverse = [...currentState.appliedMigrations].reverse();
        for (const m of toReverse) {
          if (!registryIds.has(m.id)) {
            // Migration doesn't exist in rolled-back system → reverse it
            const result = await rollbackMigration(m.id, db, paths.system.migrations, paths.data.root);
            if (result.failed !== null) {
              process.stderr.write(`Warning: Could not reverse migration ${m.id}: ${result.error ?? ""}\n`);
            } else {
              process.stdout.write(`  Reversed migration: ${m.id}\n`);
            }
          }
        }
      } finally {
        db.close();
      }
    }

    // Step 8: Selftest
    process.stdout.write("\nRunning selftest...\n");
    const selftestPassed = runSelftest(paths);
    if (!selftestPassed) {
      process.stderr.write("⚠  Selftest failed after rollback. System may be in inconsistent state.\n");
    }

    // Step 10: Report
    process.stdout.write(`\nRollback to v${target} complete.\n`);
    logger.info("rollback-cmd", `Rollback to ${target} completed from ${SIDJUA_VERSION}`);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Rollback failed: ${msg}\n`);
    logger.error("rollback-cmd", `Rollback to ${target} failed`, {
      error: { code: "ROLLBACK_FAILED", message: msg },
    });
    process.exit(1);
  } finally {
    await lock.release();
  }

  process.exit(0);
}


async function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)         return `${bytes} B`;
  if (bytes < 1024 * 1024)  return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
