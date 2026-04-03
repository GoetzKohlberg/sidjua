// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua module` Commands
 *
 * Subcommands (legacy agent modules):
 *   sidjua module list              — List all available modules
 *   sidjua module status <id>       — Show install + config status for a module
 *   sidjua module install <id>      — Install a module
 *   sidjua module uninstall <id>    — Uninstall a module
 *
 * Subcommands (MCP module SDK):
 *   sidjua module init <name>       — Scaffold a new custom MCP module
 *   sidjua module add <package>     — Install an npm MCP package as a module
 *   sidjua module remove <name>     — Remove an installed MCP module
 *   sidjua module test <name>       — Test an installed MCP module (tools/list)
 */

import { resolve, join } from "node:path";
import { execSync }      from "node:child_process";
import type { Command }  from "commander";
import { auditCliCommand } from "../cli-audit.js";
import {
  listAvailableModules,
  listInstalledModules,
  getModuleStatus,
  installModule    as legacyInstallModule,
  uninstallModule,
  interactiveInstall,
  createReadlineIO,
  validateModuleId,
} from "../../modules/module-loader.js";
import {
  scanModules,
  scaffoldModule,
  installModule  as mcpInstallModule,
  removeModule   as mcpRemoveModule,
} from "../../core/modules/index.js";


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

  // ── MCP Module SDK commands ─────────────────────────────────────────────

  moduleCmd
    .command("init <name>")
    .description("Scaffold a new custom MCP module in modules/<name>/")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action((name: string, opts: { workDir: string }) => {
      const exitCode = runMcpModuleInit({ name, workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });

  moduleCmd
    .command("add <package>")
    .description("Install an npm MCP server package as a SIDJUA module")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action((pkg: string, opts: { workDir: string }) => {
      const exitCode = runMcpModuleAdd({ package: pkg, workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });

  moduleCmd
    .command("remove <name>")
    .description("Remove an installed MCP module")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action((name: string, opts: { workDir: string }) => {
      const exitCode = runMcpModuleRemove({ name, workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });

  moduleCmd
    .command("test <name>")
    .description("Test an installed MCP module by listing its tools")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action((name: string, opts: { workDir: string }) => {
      const exitCode = runMcpModuleTest({ name, workDir: resolve(opts.workDir) });
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

    // ── MCP Modules (modules/ directory) ─────────────────────────────────
    const mcpModules = scanModules(join(opts.workDir, "modules"));
    process.stdout.write("\n");
    process.stdout.write("MCP Modules (modules/)\n");
    process.stdout.write("─────────────────────────────────────────\n");

    if (mcpModules.length === 0) {
      process.stdout.write("  No MCP modules installed.\n");
      process.stdout.write("  Add one: sidjua module add <npm-package>\n");
      process.stdout.write("  Create one: sidjua module init <name>\n");
    } else {
      for (const mod of mcpModules) {
        const def = mod.definition;
        process.stdout.write(
          `  ${mod.name.padEnd(20)} ${def.version.padEnd(8)} ${def.description.slice(0, 40)} [${mod.source}]\n`,
        );
      }
      process.stdout.write(`\n  Total: ${mcpModules.length}\n`);
    }

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
      await legacyInstallModule(opts.workDir, opts.id);
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

// ---------------------------------------------------------------------------
// MCP Module SDK runners
// ---------------------------------------------------------------------------

export function runMcpModuleInit(opts: { name: string; workDir: string }): number {
  auditCliCommand("module", "init");
  const modulesDir = join(opts.workDir, "modules");
  const result = scaffoldModule(opts.name, modulesDir);
  if (!result.success) {
    process.stderr.write(`✗ ${result.error ?? "Failed to scaffold module."}\n`);
    return 1;
  }
  process.stdout.write(`✓ Module scaffolded at ${result.path}\n`);
  process.stdout.write(`  Edit ${result.path}/index.js to implement your tool logic.\n`);
  process.stdout.write(`  Then restart the server to load the new module.\n`);
  return 0;
}

export function runMcpModuleAdd(opts: { package: string; workDir: string }): number {
  auditCliCommand("module", "add");
  const modulesDir = join(opts.workDir, "modules");
  process.stdout.write(`Installing MCP module: ${opts.package} ...\n`);
  const result = mcpInstallModule(opts.package, modulesDir);
  if (!result.success) {
    process.stderr.write(`✗ ${result.error ?? "Installation failed."}\n`);
    return 1;
  }
  process.stdout.write(`✓ Module "${result.moduleName}" installed at ${result.path}\n`);
  process.stdout.write(`  Restart the server to load the new module.\n`);
  return 0;
}

export function runMcpModuleRemove(opts: { name: string; workDir: string }): number {
  auditCliCommand("module", "remove");
  const modulesDir = join(opts.workDir, "modules");
  const removed = mcpRemoveModule(opts.name, modulesDir);
  if (!removed) {
    process.stderr.write(`✗ Module "${opts.name}" not found or invalid name.\n`);
    return 1;
  }
  process.stdout.write(`✓ Module "${opts.name}" removed.\n`);
  return 0;
}

export function runMcpModuleTest(opts: { name: string; workDir: string }): number {
  auditCliCommand("module", "test");
  const modulesDir = join(opts.workDir, "modules");
  const modules = scanModules(modulesDir);
  const mod = modules.find((m) => m.name === opts.name);

  if (mod === undefined) {
    process.stderr.write(`✗ Module "${opts.name}" not found in ${modulesDir}.\n`);
    return 1;
  }

  const def = mod.definition;
  if (def.mcp.transport !== "stdio" || def.mcp.command === undefined) {
    process.stderr.write(`✗ Module "${opts.name}" uses SSE transport — test via URL directly.\n`);
    return 1;
  }

  // Send initialize + tools/list over STDIO, print result
  const initReq   = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
  const listReq   = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list",   params: {} });
  const notifReq  = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  try {
    const args    = def.mcp.args ?? [];
    const cmdLine = `echo '${initReq}\\n${notifReq}\\n${listReq}' | ${def.mcp.command} ${args.join(" ")}`;
    const output  = execSync(cmdLine, { cwd: mod.path, timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const lines   = output.trim().split("\n").filter(Boolean);

    process.stdout.write(`Module: ${mod.name} (${def.version})\n`);
    process.stdout.write(`Transport: ${def.mcp.transport}\n\n`);

    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string; description: string }> } };
        if (msg.id === 2 && msg.result?.tools !== undefined) {
          const tools = msg.result.tools;
          process.stdout.write(`Tools (${tools.length}):\n`);
          for (const tool of tools) {
            process.stdout.write(`  ${tool.name.padEnd(24)} ${tool.description ?? ""}\n`);
          }
        }
      } catch (_err) {
        // Non-JSON line — ignore
      }
    }
    return 0;
  } catch (err: unknown) {
    process.stderr.write(`✗ Test failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
