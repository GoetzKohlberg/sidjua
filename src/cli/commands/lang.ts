// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua lang` Command
 *
 * Language management CLI — adds/removes installed languages for this workspace.
 * The `sidjua locale` command remains unchanged and continues to work.
 *
 * Subcommands:
 *   sidjua lang                  — Show active language + installed list
 *   sidjua lang list             — Show all available languages with install status
 *   sidjua lang add <code>       — Install a language
 *   sidjua lang remove <code>    — Remove an installed language
 *   sidjua lang set <code>       — Set the active language (delegates to locale set)
 */

import { existsSync }  from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  getLocale,
  setLocale,
  getAvailableLocales,
  getAllLocaleInfo,
  getLocaleInfo,
} from "../../i18n/index.js";
import {
  getInstalledLanguages,
  installLanguage,
  removeLanguage,
} from "../../i18n/lang-store.js";
import { openDatabase } from "../../utils/db.js";
import { validateWorkDir } from "../../utils/path-utils.js";
import { runWorkspaceConfigMigration } from "../../api/workspace-config-migration.js";


function openWorkspaceDb(workDir: string) {
  const resolved = resolve(workDir);
  validateWorkDir(resolved);
  const dbPath = join(resolved, ".system", "sidjua.db");
  if (!existsSync(dbPath)) {
    process.stderr.write("No workspace found. Run 'sidjua apply' first.\n");
    process.exit(1);
  }
  const db = openDatabase(dbPath);
  runWorkspaceConfigMigration(db);
  return db;
}


export function registerLangCommands(program: Command): void {
  const langCmd = program
    .command("lang")
    .description("Manage workspace languages")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: { workDir: string }) => {
      const db        = openWorkspaceDb(opts.workDir);
      const active    = getLocale();
      const installed = getInstalledLanguages(db);
      db.close();

      process.stdout.write(`Active language:     ${active}\n`);
      process.stdout.write(`Installed languages: ${installed.join(", ")}\n`);
    });

  // sidjua lang list
  langCmd
    .command("list")
    .description("List all available languages with install status")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: { workDir: string }) => {
      const db        = openWorkspaceDb(opts.workDir);
      const active    = getLocale();
      const installed = getInstalledLanguages(db);
      db.close();

      const allInfo = getAllLocaleInfo();
      process.stdout.write("  Available languages:\n");
      for (const info of allInfo) {
        const isInstalled = installed.includes(info.code);
        const isActive    = info.code === active;
        const check       = isInstalled ? "✓" : " ";
        const status      = isActive
          ? " (installed, active)"
          : isInstalled
          ? " (installed)"
          : " (not installed)";
        const namePad = info.nativeName.padEnd(26, " ");
        process.stdout.write(`  ${check} ${info.code.padEnd(6)} ${namePad}${status}\n`);
      }
    });

  // sidjua lang add <code>
  langCmd
    .command("add <code>")
    .description("Install a language for this workspace")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((code: string, opts: { workDir: string }) => {
      const available = getAvailableLocales();
      if (!available.includes(code)) {
        process.stderr.write(`Unknown language code: ${code}. Run 'sidjua lang list' for available languages.\n`);
        process.exit(1);
      }

      const db = openWorkspaceDb(opts.workDir);
      let added: boolean;
      try {
        added = installLanguage(db, code);
      } catch (err: unknown) {
        db.close();
        process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
        process.exit(1);
        return;
      }
      db.close();

      if (!added) {
        process.stdout.write(`Language ${code} is already installed.\n`);
      } else {
        const info = getLocaleInfo(code);
        process.stdout.write(`Language ${code} (${info.nativeName}) installed successfully.\n`);
      }
    });

  // sidjua lang remove <code>
  langCmd
    .command("remove <code>")
    .description("Remove an installed language from this workspace")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((code: string, opts: { workDir: string }) => {
      if (code === "en") {
        process.stderr.write("Cannot remove English — it is always required.\n");
        process.exit(1);
        return;
      }

      const db = openWorkspaceDb(opts.workDir);
      let removed: boolean;
      try {
        removed = removeLanguage(db, code);
      } catch (err: unknown) {
        db.close();
        process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
        process.exit(1);
        return;
      }
      db.close();

      if (!removed) {
        process.stdout.write(`Language ${code} is not installed.\n`);
      } else {
        process.stdout.write(`Language ${code} removed.\n`);
      }
    });

  // sidjua lang set <code>  — delegates to locale persistence
  langCmd
    .command("set <code>")
    .description("Set the active language (persisted to workspace)")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(async (code: string, opts: { workDir: string }) => {
      const available = getAvailableLocales();
      if (!available.includes(code)) {
        process.stderr.write(`Unknown language code: ${code}. Run 'sidjua lang list' for available languages.\n`);
        process.exit(1);
        return;
      }

      const db = openWorkspaceDb(opts.workDir);
      db.prepare<[string]>(
        "INSERT OR REPLACE INTO workspace_config (key, value, updated_at) VALUES ('locale', ?, datetime('now'))",
      ).run(code);
      db.close();

      setLocale(code);
      process.stdout.write(`Active language set to ${code}.\n`);
      await Promise.resolve(); // satisfy async signature
    });
}
