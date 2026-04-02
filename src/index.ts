#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.
/**
 * SIDJUA — AI Governance Platform
 * CLI entry point
 *
 * Wires Commander.js subcommands to the typed command handlers in src/cli/.
 */

import { program } from "commander";
import { SIDJUA_VERSION } from "./version.js";
import { runApplyCommand } from "./cli/apply-command.js";
import { runStatusCommand } from "./cli/status-command.js";
import { registerPhase10Commands } from "./cli/cli.js";
import { registerAgentCommands } from "./agent-lifecycle/index.js";
import { registerKnowledgeCommands, registerPolicyCommands } from "./knowledge-pipeline/index.js";
import { registerToolCommands, registerEnvCommands } from "./tool-integration/index.js";
import { registerLoggingCommands } from "./cli/cli-logging.js";
import { registerGovernanceCommands } from "./governance/cli-governance.js";
import { registerServerCommands } from "./api/cli-server.js";
import { registerBackupCommands } from "./cli/cli-backup.js";
import { registerSetupCommands }  from "./cli/commands/setup.js";
import { registerProviderCommands as registerProviderCatalogCommands } from "./cli/commands/provider.js";
import { registerKeyCommands }    from "./cli/commands/key.js";
import { registerOutputCommands } from "./cli/commands/output.js";
import { registerInitCommands }    from "./cli/commands/init.js";
import { registerChatCommands }   from "./cli/commands/chat.js";
import { registerModuleCommands } from "./cli/commands/module.js";
import { registerDiscordCommands } from "./cli/commands/discord.js";
import { registerEmailCommands }   from "./cli/commands/email.js";
import { registerImportCommands }  from "./cli/commands/import.js";
import { registerSecretCommands }          from "./cli/commands/secret.js";
import { registerEmbeddingConfigCommands } from "./cli/commands/embedding-config.js";
import { registerMemoryCommands }          from "./cli/commands/memory.js";
import { registerSandboxCommands }         from "./cli/commands/sandbox.js";
import { registerRulesCommands }           from "./cli/commands/rules.js";
import { registerVersionCommands }         from "./cli/commands/version.js";
import { registerUpdateCommands, registerChangelogCommands } from "./cli/commands/update.js";
import { registerRollbackCommands }        from "./cli/commands/rollback.js";
import { registerSelftestCommands }        from "./cli/commands/selftest.js";
import { registerMigrateEmbeddingsCommands } from "./cli/commands/migrate-embeddings.js";
import { registerAuditCommands }            from "./cli/commands/audit.js";
import { registerTelemetryCommands }       from "./cli/commands/telemetry.js";
import { registerIntegrationCommands }    from "./cli/commands/integration.js";
import { registerTlsCommands }            from "./cli/commands/tls.js";
import { msg }                             from "./i18n/index.js";
import { registerLocaleCommands }          from "./cli/commands/locale.js";
import { registerLangCommands }            from "./cli/commands/lang.js";
import { registerStartOverCommands }       from "./cli/commands/start-over.js";
import { registerDaemonCommands }          from "./cli/commands/daemon.js";
import { registerMessagingCommands }       from "./cli/commands/messaging.js";
import { registerScheduleCommands }        from "./cli/commands/schedule.js";
import { registerTokenCommands }           from "./cli/commands/token.js";
import { registerDelegationCommands }      from "./cli/commands/delegation.js";
import { registerActivityCommands }        from "./cli/commands/activity.js";
import { performStartupCheck }             from "./core/update/update-check.js";
import { NpmUpdateProvider }               from "./core/update/npm-update-provider.js";
import { auditCliCommand }                 from "./cli/cli-audit.js";
import { resolvePaths }                    from "./core/paths.js";
import { loadVersionInfo }                 from "./core/governance/rule-loader.js";
import { configureLogger }                 from "./core/logger.js";


const BUILD_META = {
  version:  process.env["npm_package_version"] ?? "dev",
  build:    process.env["BUILD_DATE"]          ?? "local",
  ref:      process.env["VCS_REF"]             ?? "none",
  platform: "sidjua",
};

void BUILD_META; // exported via runtime headers; not a CLI flag

// ---------------------------------------------------------------------------
// CLI log suppression — structured JSON logs are for server/daemon mode only.
// In CLI mode, suppress info/debug logs so they don't pollute command output.
// Users can opt into verbose output via --log-level debug (handled per-command).
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const logLevelArg = rawArgs.find((_, i, a) => a[i - 1] === "--log-level") ?? null;
const isDebugMode = logLevelArg === "debug";

// Default CLI behaviour: suppress info/debug JSON logs; show nothing unless debug.
// Level "off" suppresses all output; debug shows text-format logs to stdout.
configureLogger({ level: isDebugMode ? "debug" : "off", format: "text" });


program
  .name("sidjua")
  .description("SIDJUA Free — AI agent orchestration platform (AGPL-3.0)")
  .version(SIDJUA_VERSION);


program
  .command("apply")
  .description("Provision the AI workspace from divisions.yaml")
  .option("--config <path>", "Path to divisions.yaml", "governance/divisions.yaml")
  .option("--dry-run", "Show plan without executing", false)
  .option("--verbose", "Detailed output per step", false)
  .option("--force", "Skip confirmation prompts", false)
  .option("--step <name>", "Run only a specific step (and prerequisites)")
  .option("--work-dir <path>", "Working directory", process.cwd())
  .action(async (opts: {
    config: string;
    dryRun: boolean;
    verbose: boolean;
    force: boolean;
    step?: string;
    workDir: string;
  }) => {
    auditCliCommand("apply", undefined);
    const cmdOpts: import("./cli/apply-command.js").ApplyCommandOptions = {
      config: opts.config,
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      force: opts.force,
      workDir: opts.workDir,
      ...(opts.step !== undefined ? { step: opts.step } : {}),
    };
    const exitCode = await runApplyCommand(cmdOpts);
    process.exit(exitCode);
  });


program
  .command("status")
  .description("Show the current workspace state")
  .option("--work-dir <path>", "Working directory", process.cwd())
  .action((opts: { workDir: string }) => {
    const exitCode = runStatusCommand({ workDir: opts.workDir });
    process.exit(exitCode);
  });


registerPhase10Commands(program);


registerAgentCommands(program);


registerKnowledgeCommands(program);
registerPolicyCommands(program);


registerToolCommands(program);
registerEnvCommands(program);


registerLoggingCommands(program);
registerGovernanceCommands(program);


registerServerCommands(program);
registerTlsCommands(program);


registerBackupCommands(program);


registerSetupCommands(program);
registerProviderCatalogCommands(program);
registerKeyCommands(program);
registerOutputCommands(program);


registerInitCommands(program);
registerChatCommands(program);


registerModuleCommands(program);
registerDiscordCommands(program);
registerEmailCommands(program);


registerImportCommands(program);


registerSecretCommands(program);


registerEmbeddingConfigCommands(program);


registerMemoryCommands(program);


registerSandboxCommands(program);


registerRulesCommands(program);


registerVersionCommands(program);
registerUpdateCommands(program);
registerRollbackCommands(program);
registerSelftestCommands(program);
registerChangelogCommands(program);
// Disabled: migrate-embeddings requires a real embedding provider (planned V1.1)
// registerMigrateEmbeddingsCommands(program);
registerAuditCommands(program);


registerTelemetryCommands(program);


registerIntegrationCommands(program);


registerLocaleCommands(program);

registerLangCommands(program);

registerStartOverCommands(program);


registerDaemonCommands(program);


registerMessagingCommands(program);


registerScheduleCommands(program);


registerDelegationCommands(program);


registerTokenCommands(program);


registerActivityCommands(program);


{
  const args = process.argv.slice(2);
  const isInfoFlag = args.length > 0 && (args[0] === "--help" || args[0] === "-h" || args[0] === "-V");
  if (isInfoFlag) {
    const hasOpenAI = Boolean(process.env["OPENAI_API_KEY"]);
    const hasCF     = Boolean(process.env["SIDJUA_CF_ACCOUNT_ID"]) && Boolean(process.env["SIDJUA_CF_TOKEN"]);
    if (hasOpenAI) {
      process.stderr.write(msg("startup.embedder_hint_openai", { model: "text-embedding-3-large", dimensions: "3072" }) + "\n");
    } else if (hasCF) {
      process.stderr.write(msg("startup.embedder_hint_cloudflare") + "\n");
    } else {
      process.stderr.write(msg("startup.embedder_hint_none") + "\n");
    }
  }
}


{
  try {
    const checkPaths   = resolvePaths();
    const govInfo      = loadVersionInfo(checkPaths.system.governance);
    const rulesetVer   = govInfo?.ruleset_version ?? "unknown";
    const provider     = new NpmUpdateProvider();
    performStartupCheck(checkPaths.data.root, provider, SIDJUA_VERSION, rulesetVer, process.argv);
  } catch (e: unknown) {
    void e; // cleanup-ignore: startup check must never crash CLI
  }
}


program.parse();
