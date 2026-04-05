// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua init` Command
 *
 * Creates a minimal workspace with the Guide agent pre-installed.
 * After `sidjua init`, running `sidjua chat guide` works immediately
 * with zero additional configuration.
 *
 * Sub-modules:
 *   init-agents.ts    — agent definitions, skill MDs, YAML templates
 *   init-workspace.ts — directory creation, config files, DB init, docs bundling
 *   init-providers.ts — interactive config collection, provider key storage, summary
 *   init-health.ts    — post-init welcome banner
 */

import { existsSync }    from "node:fs";
import { join, resolve } from "node:path";
import type { Command }  from "commander";
import { createLogger }  from "../../core/logger.js";
import { apply }         from "../../apply/index.js";
import { openDatabase }  from "../../utils/db.js";

import { createWorkspace }                        from "./init-workspace.js";
import { collectInitConfig, writeInitConfig, printInitSummary } from "./init-providers.js";

// Re-export skill MDs needed by chat.ts
export { CEO_ASSISTANT_SKILL_MD, GUIDE_SKILL_MD } from "./init-agents.js";

const logger = createLogger("init");


export interface InitCommandOptions {
  workDir:     string;
  force:       boolean;
  quiet:       boolean;
  yes:         boolean;          // non-interactive: skip dialog, use defaults
  provider?:   string;           // non-interactive: provider name (groq/google/openai/anthropic)
  providerKey?: string;          // non-interactive: provider API key
  memory?:     string;           // non-interactive: memory mode (openai/cloudflare/bm25/skip)
}


export function registerInitCommands(program: Command): void {
  program
    .command("init")
    .description("Initialize a new SIDJUA workspace with Guide agent pre-installed")
    .option("--work-dir <path>",     "Target directory for the workspace", process.cwd())
    .option("--force",               "Re-initialize even if workspace already exists", false)
    .option("--quiet",               "Suppress the welcome banner", false)
    .option("--yes",                 "Non-interactive: skip dialog, use defaults", false)
    .option("--provider <name>",     "Pre-select provider (groq|google|openai|anthropic)")
    .option("--provider-key <key>",  "Provider API key (use with --provider)")
    .option("--memory <mode>",       "Memory mode (openai|cloudflare|bm25|skip)", "skip")
    .action(async (opts: {
      workDir: string; force: boolean; quiet: boolean;
      yes: boolean; provider?: string; providerKey?: string; memory?: string;
    }) => {
      const exitCode = await runInitCommand({
        workDir: opts.workDir,
        force:   opts.force,
        quiet:   opts.quiet,
        yes:     opts.yes,
        ...(opts.provider    !== undefined && { provider:    opts.provider    }),
        ...(opts.providerKey !== undefined && { providerKey: opts.providerKey }),
        ...(opts.memory      !== undefined && { memory:      opts.memory      }),
      });
      if (exitCode === 0 && !opts.quiet) {
        const { runChatCommand } = await import("./chat.js");
        await runChatCommand({
          workDir:   resolve(opts.workDir),
          agent:     "ceo-assistant",
          verbose:   false,
          showIntro: true,
        });
      }
      process.exit(exitCode);
    });
}


export async function runInitCommand(opts: InitCommandOptions): Promise<number> {
  const workDir = resolve(opts.workDir);

  // Check if already initialized
  const dbPath = join(workDir, ".system", "sidjua.db");
  if (!opts.force && existsSync(dbPath)) {
    process.stdout.write(
      `Workspace already initialized at ${workDir}\n` +
      `Run \`sidjua chat\` to get started, or use --force to reinitialize.\n`,
    );
    return 0;
  }

  // ── Interactive dialog (skip if --yes or non-TTY) ─────────────────────────
  const interactive = !opts.yes && process.stdin.isTTY;
  let cfg: Awaited<ReturnType<typeof collectInitConfig>>;
  try {
    cfg = await collectInitConfig(opts, workDir, interactive);
  } catch (err) {
    process.stderr.write(`✗ Init cancelled: ${String(err)}\n`);
    return 1;
  }

  if (!opts.quiet) {
    process.stdout.write(`\n  Creating workspace...\n`);
  }

  try {
    await createWorkspace(workDir, opts.quiet);

    // Write provider key and embedder config after scaffold (dirs now exist)
    await writeInitConfig(cfg, workDir);

    // Persist selected locale to workspace_config (non-fatal)
    if (cfg.locale && cfg.locale !== "en") {
      try {
        const { runWorkspaceConfigMigration } = await import("../../api/workspace-config-migration.js");
        const localeDbPath = join(workDir, ".system", "sidjua.db");
        if (existsSync(localeDbPath)) {
          const db = openDatabase(localeDbPath);
          runWorkspaceConfigMigration(db);
          db.prepare(
            "INSERT OR REPLACE INTO workspace_config (key, value, updated_at) VALUES ('locale', ?, datetime('now'))",
          ).run(cfg.locale);
          db.close();
        }
      } catch (_e) { /* non-fatal — locale stays as default "en" */ }
    }

    // Auto-provision divisions into DB (non-fatal on failure)
    try {
      await apply({
        configPath: join(workDir, "governance", "divisions"),
        dryRun:     false,
        verbose:    false,
        force:      true,
        workDir,
      });
    } catch (e: unknown) {
      logger.warn("init", "Division sync skipped — run sidjua apply manually", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      if (!opts.quiet) {
        process.stdout.write("  ⚠ Division sync skipped — run `sidjua apply` manually\n");
      }
    }

    if (!opts.quiet) {
      printInitSummary(cfg);
    }

    return 0;
  } catch (err) {
    process.stderr.write(`✗ Init failed: ${String(err)}\n`);
    logger.error("init_failed", "Workspace initialization failed", {
      error: { code: "INIT-001", message: String(err) },
    });
    return 1;
  }
}
