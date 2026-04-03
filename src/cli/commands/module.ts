// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua module` Commands
 *
 * Subcommands:
 *   sidjua module list              — List all available modules
 *   sidjua module status <id>       — Show install + config status for a module
 *   sidjua module install <id>      — Install a module
 *   sidjua module uninstall <id>    — Uninstall a module
 */

import { resolve }     from "node:path";
import type { Command } from "commander";
import { auditCliCommand } from "../cli-audit.js";
import {
  listAvailableModules,
  listInstalledModules,
  getModuleStatus,
  installModule,
  uninstallModule,
  interactiveInstall,
  createReadlineIO,
  validateModuleId,
} from "../../modules/module-loader.js";


export function registerModuleCommands(program: Command): void {
  const moduleCmd = program
    .command("module")
    .description("Manage installable agent modules (Discord, SAP, ERP, ...)");

  moduleCmd
    .command("list")
    .description("List all available and installed modules")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (opts: { workDir: string }) => {
      const exitCode = await runModuleList({ workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });

  moduleCmd
    .command("status <id>")
    .description("Show install and configuration status for a module")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (id: string, opts: { workDir: string }) => {
      const exitCode = await runModuleStatus({ id, workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });

  moduleCmd
    .command("install <id>")
    .description(
      "Install a module into the workspace\n" +
      "WARNING: Modules execute with full host privileges. Only install from trusted sources.",
    )
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (id: string, opts: { workDir: string }) => {
      const exitCode = await runModuleInstall({ id, workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });

  moduleCmd
    .command("uninstall <id>")
    .description("Uninstall a module from the workspace")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (id: string, opts: { workDir: string }) => {
      const exitCode = await runModuleUninstall({ id, workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });
}


export async function runModuleList(opts: { workDir: string }): Promise<number> {
  try {
    const available  = listAvailableModules();
    const installed  = await listInstalledModules(opts.workDir);
    const installedIds = new Set(installed.map((m) => m.id));

    process.stdout.write("Available Modules\n");
    process.stdout.write("─────────────────────────────────────────\n");

    for (const { id, manifest } of available) {
      const status    = installedIds.has(id) ? "installed" : "available";
      const configured = installed.find((m) => m.id === id)?.configured;
      const suffix    = status === "installed"
        ? (configured ? " [installed, configured]" : " [installed, needs config]")
        : "";
      process.stdout.write(`  ${id.padEnd(16)} ${manifest.name.padEnd(20)} ${manifest.description.slice(0, 40)}${suffix}\n`);
    }

    if (available.length === 0) {
      process.stdout.write("  No modules available.\n");
    }

    process.stdout.write("\n");
    process.stdout.write(`Installed: ${installed.length} / ${available.length}\n`);

    return 0;
  } catch (err) {
    process.stderr.write(`Error listing modules: ${String(err)}\n`);
    return 1;
  }
}


export async function runModuleStatus(opts: { id: string; workDir: string }): Promise<number> {
  try {
    validateModuleId(opts.id);
    const status = await getModuleStatus(opts.workDir, opts.id);

    if (!status.manifest) {
      process.stderr.write(`Unknown module: ${opts.id}\n`);
      process.stdout.write(`Available modules: discord\n`);
      return 1;
    }

    const m = status.manifest;
    process.stdout.write(`Module: ${m.name} (${m.id})\n`);
    process.stdout.write(`Version: ${m.version}\n`);
    process.stdout.write(`Description: ${m.description}\n`);
    process.stdout.write(`Category: ${m.category}\n`);
    process.stdout.write("\n");
    process.stdout.write(`Status\n`);
    process.stdout.write(`  Installed:  ${status.installed ? "yes" : "no"}\n`);
    process.stdout.write(`  Configured: ${status.configured ? "yes" : "no"}\n`);
    process.stdout.write(`  Secrets:    ${status.secretsSet ? "all set" : `missing: ${status.missingSecrets.join(", ")}`}\n`);

    if (status.installPath) {
      process.stdout.write(`  Path:       ${status.installPath}\n`);
    }

    if (!status.installed) {
      process.stdout.write("\n");
      process.stdout.write(`Install with: sidjua module install ${opts.id}\n`);
    } else if (!status.configured) {
      process.stdout.write("\n");
      process.stdout.write("Missing secrets:\n");
      for (const key of status.missingSecrets) {
        const secret = m.secrets?.find((s) => s.key === key);
        process.stdout.write(`  ${key} — ${secret?.description ?? ""}\n`);
      }
      process.stdout.write(`\nAdd secrets to: ${status.installPath}/.env\n`);
    }

    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    return 1;
  }
}


export async function runModuleInstall(
  opts: { id: string; workDir: string; nonInteractive?: boolean },
): Promise<number> {
  auditCliCommand("module", "install");
  try {
    validateModuleId(opts.id);
    const manifest = (await import("../../modules/module-loader.js"))
      .listAvailableModules()
      .find((m) => m.id === opts.id);

    if (!manifest) {
      process.stderr.write(`Unknown module: ${opts.id}\n`);
      return 1;
    }

    // Show module header
    process.stdout.write(`\nInstalling module: ${manifest.manifest.name} v${manifest.manifest.version}\n`);
    process.stdout.write(`${manifest.manifest.description}\n\n`);

    if (opts.nonInteractive || !process.stdin.isTTY) {
      // Non-interactive: copy templates + inject env secrets
      process.stdout.write("Non-interactive mode — reading secrets from environment.\n");
      await installModule(opts.workDir, opts.id);
    } else {
      // Interactive: prompt for secrets + config
      process.stdout.write("Setup required:\n");
      const io = await createReadlineIO();
      await interactiveInstall(opts.workDir, opts.id, io);
    }

    const status = await getModuleStatus(opts.workDir, opts.id);
    process.stdout.write(`\n✓ Module ${opts.id} installed at ${status.installPath}\n`);

    if (!status.secretsSet && status.missingSecrets.length > 0) {
      process.stdout.write("\nMissing secrets — add them to finish setup:\n");
      for (const key of status.missingSecrets) {
        const secret = status.manifest?.secrets?.find((s) => s.key === key);
        process.stdout.write(`  ${key} — ${secret?.description ?? ""}\n`);
      }
      process.stdout.write(`\n  File: ${status.installPath}/.env\n`);
    }

    process.stdout.write(`\nYour ${manifest.manifest.name} agent is ready. Try:\n`);
    process.stdout.write(`  sidjua ${opts.id} status       — Check configuration\n`);

    return 0;
  } catch (err) {
    process.stderr.write(`✗ Install failed: ${String(err)}\n`);
    return 1;
  }
}


export async function runModuleUninstall(opts: { id: string; workDir: string }): Promise<number> {
  auditCliCommand("module", "uninstall");
  try {
    validateModuleId(opts.id);
    process.stdout.write(`Uninstalling module: ${opts.id} ...\n`);
    await uninstallModule(opts.workDir, opts.id);
    process.stdout.write(`✓ Module ${opts.id} uninstalled.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`✗ Uninstall failed: ${String(err)}\n`);
    return 1;
  }
}
