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
 * Workspace structure created:
 *   governance/divisions.yaml        ← governance config (was: root divisions.yaml pre-P184)
 *   governance/CHARTER.md
 *   governance/orchestrator.yaml
 *   governance/boundaries/defaults.yaml
 *   agents/agents.yaml
 *   agents/definitions/guide.yaml
 *   agents/skills/guide.md
 *   agents/templates/{worker,manager,researcher,developer}.yaml
 *   docs/{concepts,cli-reference,quick-start,troubleshooting,agent-templates,governance-examples}.md
 *   .system/providers/{cloudflare,groq,google}.yaml
 *
 * ---------------------------------------------------------------------------
 * DIRECTORY STRUCTURE ANALYSIS — for future consolidation (P185+)
 * ---------------------------------------------------------------------------
 *
 * After `sidjua init` and `sidjua apply`, the workspace root contains:
 *
 *   .system/       — Internal runtime state (DB, PIDs, keys, provider YAMLs)
 *   agents/        — Agent definitions, skills, templates
 *   ai-governance/ — Created by `sidjua apply` (Step 5 RBAC: rbac.yaml, routing-table.yaml)
 *                    OVERLAP with governance/: both hold governance-related files.
 *                    PROPOSAL: merge into governance/ and remove ai-governance/.
 *   archive/       — Created by apply (audit export archive dir)
 *   backups/       — Backup snapshots (sidjua backup create)
 *   config/        — Apply config: update.yaml, migration-state.json
 *                    PROPOSAL: move into .system/ since it's internal tooling state.
 *   data/          — Runtime data (default backup dir before backups/)
 *                    PROPOSAL: merge into .system/data/ or remove entirely.
 *   default/       — Division directory created by apply (the "default" division)
 *   docs/          — User-facing documentation (bundled from src/docs/)
 *   executive/     — Division directory created by apply (the "executive" division)
 *   governance/    — User-facing governance config: divisions.yaml, orchestrator.yaml,
 *                    CHARTER.md, boundaries/, audit/, security/
 *   workspace/     — Division directory created by apply (the "workspace" division)
 *
 * Questions for P185 consolidation:
 * - ai-governance/ vs governance/: the `apply` step creates ai-governance/ for RBAC output.
 *   Root cause: apply.ts hardcodes "ai-governance" as the rbac output dir. Should be merged
 *   into governance/rbac/ or governance/routing/. Requires changing apply/rbac.ts + apply/routing.ts.
 * - config/ vs .system/: config/ holds apply-generated state (update.yaml, .migration-state.json).
 *   These are internal and should live in .system/. Requires changing apply/finalize.ts.
 * - data/ vs backups/: data/ is created by apply as a default backup dir but backups/ is the
 *   actual backup location. The data/ dir is redundant. Remove from apply or redirect to backups/.
 * - default/, executive/, workspace/ at root: these are division directories named after the
 *   division codes in divisions.yaml. They pollute the root. Proposal: move under data/ or
 *   a dedicated divisions/ subdirectory (requires changing apply/filesystem.ts).
 * - archive/ at root: audit export archive — should be under .system/audit/ or governance/audit/.
 */

import { mkdir, writeFile, access, readFile, readdir, copyFile } from "node:fs/promises";
import { existsSync }                                    from "node:fs";
import { join, resolve, basename }                       from "node:path";
import { randomUUID }                                    from "node:crypto";
import type { Command }                                  from "commander";
import { saveTelemetryConfig }                           from "../../core/telemetry/telemetry-reporter.js";
import { DEFAULT_PRIMARY_ENDPOINT, DEFAULT_FALLBACK_ENDPOINT } from "../../core/telemetry/telemetry-types.js";
import { openDatabase }                                  from "../../utils/db.js";
import { runMigrations105 }                              from "../../agent-lifecycle/migration.js";
import { AgentRegistry }                                 from "../../agent-lifecycle/agent-registry.js";
import { createLogger }                                  from "../../core/logger.js";
import { SIDJUA_VERSION }                                from "../../version.js";
import { apply }                                         from "../../apply/index.js";
import { getDefaultDivisionsDir }                        from "../../defaults/loader.js";
import { askText, askChoice, askSecret }                 from "../utils/interactive-prompt.js";
import { setLocale, getAvailableLocales, getLocaleInfo }  from "../../i18n/index.js";
import { SqliteSecretsProvider }                         from "../../apply/secrets.js";

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


interface InitConfig {
  workspaceName: string;
  locale:        string;           // selected locale — default "en"
  memoryMode:    "openai" | "cloudflare" | "bm25" | "skip";
  // embedder credentials (only set if memoryMode requires them)
  openaiKey?:    string;
  cfAccountId?:  string;
  cfToken?:      string;
  // LLM provider
  providerName?: string;
  providerKey?:  string;
  providerModel?: string;
}


interface ProviderMeta {
  name:   string;
  model:  string;
  envVar: string;
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  groq:      { name: "Groq",          model: "llama-3.3-70b-versatile",              envVar: "GROQ_API_KEY" },
  google:    { name: "Google",        model: "gemini-2.0-flash",                      envVar: "GOOGLE_API_KEY" },
  openai:    { name: "OpenAI",        model: "gpt-4.1-mini",                          envVar: "OPENAI_API_KEY" },
  anthropic: { name: "Anthropic",     model: "claude-sonnet-4-6",                    envVar: "ANTHROPIC_API_KEY" },
};


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
  let cfg: InitConfig;
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
        const { openDatabase }              = await import("../../utils/db.js");
        const { runWorkspaceConfigMigration } = await import("../../api/workspace-config-migration.js");
        const dbPath = join(workDir, ".system", "sidjua.db");
        if (existsSync(dbPath)) {
          const db = openDatabase(dbPath);
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


async function collectInitConfig(
  opts:        InitCommandOptions,
  workDir:     string,
  interactive: boolean,
): Promise<InitConfig> {

  if (interactive) {
    process.stdout.write("\n  SIDJUA — Initializing workspace...\n\n");
  }

  // ── Language selection (FIRST — hardcoded multilingual, not using t()) ──
  let locale = "en";
  const availableLocales = getAvailableLocales();
  const hasMultipleLocales = availableLocales.length > 1;

  if (interactive && hasMultipleLocales) {
    // This prompt is intentionally hardcoded multilingual — it runs BEFORE
    // any locale is loaded, so t() cannot be used here.
    process.stdout.write("\n  Select your language / Sprache wählen / 语言选择:\n");
    availableLocales.forEach((code, i) => {
      const info = getLocaleInfo(code);
      process.stdout.write(`  ${String(i + 1).padStart(2)}. ${info.nativeName} (${info.name})\n`);
    });
    process.stdout.write("  Your choice [1]: ");
    const localeInput = await new Promise<string>((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes("\n")) {
          process.stdin.removeListener("data", onData);
          resolve(buf.trim());
        }
      };
      process.stdin.resume();
      process.stdin.on("data", onData);
    });
    const choiceNum = parseInt(localeInput, 10);
    if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= availableLocales.length) {
      locale = availableLocales[choiceNum - 1] ?? "en";
    }
    setLocale(locale);
  }

  // [1/3] Workspace name
  const dirName       = basename(workDir);
  const workspaceName = interactive
    ? await askText("[1/3] Workspace name", dirName)
    : dirName;

  // [2/3] Memory & Knowledge
  let memoryMode: InitConfig["memoryMode"] = "skip";
  let openaiKey: string | undefined;
  let cfAccountId: string | undefined;
  let cfToken: string | undefined;

  // Apply --memory flag if provided
  const memoryFlag = opts.memory?.toLowerCase();
  if (memoryFlag && ["openai", "cloudflare", "bm25", "skip"].includes(memoryFlag)) {
    memoryMode = memoryFlag as InitConfig["memoryMode"];
  }

  if (interactive) {
    process.stdout.write("\n  [2/3] Memory & Knowledge\n");
    process.stdout.write("        SIDJUA can remember agent conversations and search them later.\n");
    process.stdout.write("        This requires an embedding API key.\n");

    const memChoice = await askChoice("Choose embedding mode:", [
      { key: "a", label: "Activate with OpenAI embeddings (recommended — needs OPENAI_API_KEY)" },
      { key: "b", label: "Activate with Cloudflare embeddings (free — needs CF_ACCOUNT_ID + CF_TOKEN)" },
      { key: "c", label: "BM25 only (no API key needed — keyword search, no semantic search)" },
      { key: "d", label: "Skip memory for now (activate later: sidjua memory activate)" },
    ], "d");

    if (memChoice === "a") {
      memoryMode = "openai";
      openaiKey  = await askSecret("Enter your OpenAI API key");
    } else if (memChoice === "b") {
      memoryMode  = "cloudflare";
      cfAccountId = await askSecret("Enter your Cloudflare Account ID");
      cfToken     = await askSecret("Enter your Cloudflare API Token");
    } else if (memChoice === "c") {
      memoryMode = "bm25";
    } else {
      // "d" = skip — warn user about consequences
      process.stdout.write("\n  ⚠ Without memory, your agents will have NO long-term memory.\n");
      process.stdout.write("    Every conversation starts fresh — agents cannot recall previous interactions.\n");
      process.stdout.write("    You can activate memory later: sidjua memory activate\n");
    }
  }

  // [3/3] AI Provider
  let providerName: string | undefined;
  let providerKey: string | undefined;
  let providerModel: string | undefined;

  // Apply --provider / --provider-key flags if provided
  if (opts.provider) {
    const meta = PROVIDER_META[opts.provider.toLowerCase()];
    providerName  = opts.provider.toLowerCase();
    providerModel = meta?.model;
    providerKey   = opts.providerKey;
  }

  // Non-interactive: if OpenAI embedding key was collected and no explicit LLM provider,
  // reuse OPENAI_API_KEY for the LLM provider as well (silent — no user prompt)
  if (!interactive && !providerName && openaiKey) {
    providerName  = "openai";
    providerKey   = openaiKey;
    providerModel = PROVIDER_META["openai"]?.model;
  }

  if (interactive) {
    process.stdout.write("\n  [3/3] AI Provider\n");
    process.stdout.write("        SIDJUA needs an AI provider to power your agents.\n");
    process.stdout.write("        The built-in Guide agent works without any key (free Cloudflare model).\n");

    // If user already provided an OpenAI key for embedding, offer to reuse it
    if (openaiKey && !providerName) {
      process.stdout.write("\n");
      const reuse = await askChoice("Use the same OpenAI key for agent provider?", [
        { key: "y", label: "Yes — use same OpenAI key for agents (recommended)" },
        { key: "n", label: "No — choose a different provider or key" },
      ], "y");
      if (reuse === "y") {
        providerName  = "openai";
        providerKey   = openaiKey;
        providerModel = PROVIDER_META["openai"]?.model;
        process.stdout.write("  ✓ Using OpenAI key from embedding setup\n");
      }
      // "n" → fall through to full provider menu below
    }

    if (!providerName) {
      process.stdout.write("\n        To create your own agents, set up a provider:\n");

      const provChoice = await askChoice("Set up a provider:", [
        { key: "a", label: "Groq — free, fast, no credit card (console.groq.com → API Keys)" },
        { key: "b", label: "Google AI Studio — free, smart, no credit card (aistudio.google.com → API Keys)" },
        { key: "c", label: "OpenAI — paid, best quality" },
        { key: "d", label: "Anthropic — paid, best quality" },
        { key: "e", label: "Other — enter provider and key manually" },
        { key: "f", label: "Skip for now — only Guide agent available (add later: sidjua config provider)" },
      ], "f");

      const providerChoiceMap: Record<string, string> = { a: "groq", b: "google", c: "openai", d: "anthropic" };

      if (provChoice in providerChoiceMap) {
        const pid    = providerChoiceMap[provChoice]!;
        const meta   = PROVIDER_META[pid]!;
        providerName  = pid;
        providerModel = meta.model;
        providerKey   = await askSecret(`Enter your ${meta.name} API key`);
      } else if (provChoice === "e") {
        providerName = await askText("Provider name");
        providerKey  = await askSecret("API key");
      }
      // "f" = skip
    }
  }

  const cfg: InitConfig = { workspaceName, locale, memoryMode };
  if (openaiKey    !== undefined) cfg.openaiKey    = openaiKey;
  if (cfAccountId  !== undefined) cfg.cfAccountId  = cfAccountId;
  if (cfToken      !== undefined) cfg.cfToken       = cfToken;
  if (providerName !== undefined) cfg.providerName  = providerName;
  if (providerKey  !== undefined) cfg.providerKey   = providerKey;
  if (providerModel !== undefined) cfg.providerModel = providerModel;
  return cfg;
}


async function writeInitConfig(cfg: InitConfig, workDir: string): Promise<void> {
  const providersDir = join(workDir, ".system", "providers");
  const timestamp    = new Date().toISOString();

  // Open the secrets store for this workspace — created lazily on first use.
  const mainDbPath  = join(workDir, ".system", "sidjua.db");
  const secretsPath = join(workDir, ".system", "secrets.db");
  let secretsProvider: SqliteSecretsProvider | null = null;
  try {
    const mainDb = openDatabase(mainDbPath);
    runMigrations105(mainDb);
    secretsProvider = new SqliteSecretsProvider(mainDb);
    await secretsProvider.init({ db_path: secretsPath });
  } catch (_err) {
    // Secrets store not yet available (apply not run); fall back to env-var references.
    secretsProvider = null;
  }

  // Write LLM provider key via secrets store; YAML gets a reference, not the key itself.
  if (cfg.providerName && cfg.providerKey) {
    const secretRef = `provider.${cfg.providerName}.api_key`;
    if (secretsProvider !== null) {
      await secretsProvider.set("providers", `${cfg.providerName}.api_key`, cfg.providerKey);
    }
    const providerYaml = [
      `provider: ${cfg.providerName}`,
      `api_key: secret:${secretRef}`,
      `enabled: true`,
      `configured: ${timestamp}`,
      ...(cfg.providerModel ? [`default_model: ${cfg.providerModel}`] : []),
    ].join("\n") + "\n";
    await writeFile(join(providersDir, `${cfg.providerName}.yaml`), providerYaml, "utf-8");
  }

  // Collect env lines (non-secret metadata only — no plaintext key values).
  const envLines: string[] = [
    `# SIDJUA workspace environment — auto-generated by sidjua init`,
    `# DO NOT COMMIT — add .env to your .gitignore`,
    ``,
  ];

  if (cfg.memoryMode === "openai" && cfg.openaiKey) {
    const secretRef = "providers.openai.api_key";
    if (secretsProvider !== null) {
      await secretsProvider.set("providers", "openai.api_key", cfg.openaiKey);
    }
    // Write reference only — never the raw key
    envLines.push(`# OpenAI key stored in encrypted secrets — retrieve: sidjua secret get providers openai.api_key --reveal`);
    if (!cfg.providerName || cfg.providerName !== "openai") {
      const yamlContent = [
        `provider: openai`,
        `api_key: secret:${secretRef}`,
        `enabled: true`,
        `configured: ${timestamp}`,
      ].join("\n") + "\n";
      await writeFile(join(providersDir, "openai.yaml"), yamlContent, "utf-8");
    }
  } else if (cfg.memoryMode === "cloudflare" && cfg.cfAccountId && cfg.cfToken) {
    if (secretsProvider !== null) {
      await secretsProvider.set("providers", "cloudflare.account_id", cfg.cfAccountId);
      await secretsProvider.set("providers", "cloudflare.token",      cfg.cfToken);
    }
    envLines.push(`# Cloudflare credentials stored in encrypted secrets`);
    envLines.push(`SIDJUA_CF_ACCOUNT_ID=${cfg.cfAccountId}`);
  }

  // Write provider key reference to .env — never the raw key value.
  if (cfg.providerName && cfg.providerKey) {
    const meta   = PROVIDER_META[cfg.providerName];
    const envVar = meta?.envVar ?? cfg.providerName.toUpperCase() + "_API_KEY";
    const alreadyWritten = envLines.some((l) => l.startsWith(`${envVar}=`) || l.includes(`sidjua secret get providers ${cfg.providerName}`));
    if (!alreadyWritten) {
      envLines.push(`# ${envVar} stored in encrypted secrets — retrieve: sidjua secret get providers ${cfg.providerName}.api_key --reveal`);
    }
  }

  if (envLines.length > 3) {
    const envPath = join(workDir, ".env");
    const existing = existsSync(envPath)
      ? (await readFile(envPath, "utf-8"))
      : "";
    if (!existing.includes("SIDJUA workspace environment")) {
      await writeFile(envPath, envLines.join("\n") + "\n", "utf-8");
    }
  }

  if (secretsProvider !== null) secretsProvider.close();
}


function printInitSummary(cfg: InitConfig): void {
  const memoryLabel: Record<InitConfig["memoryMode"], string> = {
    openai:     "OpenAI semantic search (text-embedding-3-large)",
    cloudflare: "Cloudflare semantic search (@cf/baai/bge-base-en-v1.5, free)",
    bm25:       "BM25 keyword search (no API key needed)",
    skip:       "not configured (add later: sidjua memory activate)",
  };

  const providerLabel = cfg.providerName
    ? `${cfg.providerName}${cfg.providerModel ? ` (${cfg.providerModel})` : ""}`
    : "none — only Guide agent available";

  process.stdout.write(`\n`);
  process.stdout.write(`  ✓ Workspace created: ${cfg.workspaceName}\n`);
  process.stdout.write(`  ✓ Memory: ${memoryLabel[cfg.memoryMode]}\n`);
  process.stdout.write(`  ✓ Provider: ${providerLabel}\n`);
  process.stdout.write(`  ✓ CEO Assistant ready — try: sidjua chat\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  Next steps:\n`);
  process.stdout.write(`    sidjua chat           Talk to your CEO Assistant\n`);
  process.stdout.write(`    sidjua status         Check your workspace status\n`);
  process.stdout.write(`    sidjua help           See all commands\n`);
  process.stdout.write(`\n`);
}


async function createWorkspace(workDir: string, quiet: boolean): Promise<void> {
  const log = (msg: string): void => {
    if (!quiet) process.stdout.write(`  ${msg}\n`);
  };

  // ── Directories ────────────────────────────────────────────────────────────

  const dirs = [
    ".system/providers",
    "agents/definitions",
    "agents/skills",
    "agents/templates",
    "governance/boundaries",
    "docs",
  ];

  for (const d of dirs) {
    await mkdir(join(workDir, d), { recursive: true });
  }
  log("✓ Directories created");

  // ── governance/divisions/ — per-division YAML files copied from package defaults ──

  const govDivisionsDir    = join(workDir, "governance", "divisions");
  const pkgDivisionsDir    = getDefaultDivisionsDir();
  await mkdir(govDivisionsDir, { recursive: true });
  const divFiles = (await readdir(pkgDivisionsDir)).filter((f) => f.endsWith(".yaml"));
  for (const f of divFiles) {
    const content = await readFile(join(pkgDivisionsDir, f), "utf-8");
    await writeIfAbsent(join(govDivisionsDir, f), content, quiet);
  }
  log(`✓ governance/divisions/ (${divFiles.length} divisions)`);

  // ── governance/ ────────────────────────────────────────────────────────────

  await writeIfAbsent(join(workDir, "governance", "CHARTER.md"), CHARTER_MD, quiet);
  await writeIfAbsent(join(workDir, "governance", "boundaries", "defaults.yaml"), DEFAULTS_YAML, quiet);
  await writeIfAbsent(join(workDir, "governance", "orchestrator.yaml"), ORCHESTRATOR_YAML, quiet);
  log("✓ governance/");
  log("✓ governance/orchestrator.yaml");

  // ── agents/ ────────────────────────────────────────────────────────────────

  await writeIfAbsent(join(workDir, "agents", "agents.yaml"), AGENTS_YAML, quiet);
  // CEO Assistant (primary default agent — replaces Guide)
  await writeIfAbsent(join(workDir, "agents", "definitions", "ceo-assistant.yaml"), CEO_ASSISTANT_DEFINITION_YAML, quiet);
  await writeIfAbsent(join(workDir, "agents", "skills", "ceo-assistant.md"), CEO_ASSISTANT_SKILL_MD, quiet);
  // Guide (backward compat — still supported with `sidjua chat guide`)
  await writeIfAbsent(join(workDir, "agents", "definitions", "guide.yaml"), GUIDE_DEFINITION_YAML, quiet);
  await writeIfAbsent(join(workDir, "agents", "skills", "guide.md"), GUIDE_SKILL_MD, quiet);

  // Templates
  for (const [name, content] of Object.entries(AGENT_TEMPLATES)) {
    await writeIfAbsent(join(workDir, "agents", "templates", `${name}.yaml`), content, quiet);
  }
  log("✓ agents/ (Guide pre-installed)");

  // ── docs/ ─────────────────────────────────────────────────────────────────

  await bundleDocs(workDir, quiet);
  log("✓ docs/");

  // ── .system/providers/ ────────────────────────────────────────────────────

  await writeIfAbsent(join(workDir, ".system", "providers", "cloudflare.yaml"), CLOUDFLARE_PROVIDER_YAML, quiet);
  await writeIfAbsent(join(workDir, ".system", "providers", "groq.yaml"),       GROQ_PROVIDER_YAML, quiet);
  await writeIfAbsent(join(workDir, ".system", "providers", "google.yaml"),     GOOGLE_PROVIDER_YAML, quiet);
  log("✓ .system/providers/");

  // ── Database ───────────────────────────────────────────────────────────────

  const db = openDatabase(join(workDir, ".system", "sidjua.db"));
  db.pragma("foreign_keys = ON");
  runMigrations105(db);

  // Register CEO Assistant (primary) and Guide (backward compat)
  const registry = new AgentRegistry(db);
  try {
    const existing = registry.getById("ceo-assistant");
    if (!existing) {
      registry.create(CEO_ASSISTANT_AGENT_DEFINITION, "init");
    }
  } catch (e: unknown) {
    logger.warn("init", "CEO Assistant registration failed — will load from YAML on next start", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }
  // Also keep guide registered for backward compat (sidjua chat guide still works)
  try {
    const existingGuide = registry.getById("guide");
    if (!existingGuide) {
      registry.create(GUIDE_AGENT_DEFINITION, "init");
    }
  } catch (e: unknown) {
    logger.warn("init", "Guide agent registration failed — will load from YAML on next start", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }

  db.close();
  log("✓ Database initialized");

  // ── config.json ───────────────────────────────────────────────────────────

  const configJson = JSON.stringify(
    { workDir, version: SIDJUA_VERSION, initialized_at: new Date().toISOString() },
    null,
    2,
  );
  await writeFile(join(workDir, ".system", "config.json"), configJson, "utf-8");

  // Also write to SIDJUA_CONFIG_DIR if set (Docker / multi-volume deployments)
  const configDir = process.env["SIDJUA_CONFIG_DIR"];
  if (configDir) {
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), configJson, "utf-8");
  }

  log("✓ config.json written");

  // ── Telemetry — generate installation ID on first init ───────────────────

  try {
    const telPath = join(workDir, ".system", "telemetry.json");
    if (!existsSync(telPath)) {
      await saveTelemetryConfig(workDir, {
        mode:             "ask",
        primaryEndpoint:  DEFAULT_PRIMARY_ENDPOINT,
        fallbackEndpoint: DEFAULT_FALLBACK_ENDPOINT,
        installationId:   randomUUID(),
      });
      log("✓ telemetry.json written (mode: ask — run `sidjua telemetry enable` to opt in)");
    }
  } catch (e: unknown) {
    logger.warn("init", "Telemetry config write failed — non-fatal", { metadata: { error: e instanceof Error ? e.message : String(e) } });
  }

  // ── Lifecycle foundation files  ───────────────────────────────

  await provisionLifecycleFiles(workDir, quiet);
}


async function provisionLifecycleFiles(workDir: string, quiet: boolean): Promise<void> {
  const log = (s: string): void => { if (!quiet) process.stdout.write(s + "\n"); };

  // config/update.yaml — update provider settings
  await mkdir(join(workDir, "config"), { recursive: true });
  await writeIfAbsent(join(workDir, "config", "update.yaml"),
    "update:\n  provider: npm\n  check_interval_hours: 24\n  auto_check: true\n",
    quiet,
  );

  // backups/retention.json — backup retention policy
  await mkdir(join(workDir, "backups"), { recursive: true });
  await writeIfAbsent(
    join(workDir, "backups", "retention.json"),
    JSON.stringify({ max_backups: 5, max_age_days: 90, min_keep: 2, auto_cleanup: true }, null, 2) + "\n",
    quiet,
  );

  // .migration-state.json — tracks applied agent DB migrations
  await writeIfAbsent(
    join(workDir, ".migration-state.json"),
    JSON.stringify({ schemaVersion: 0, appliedMigrations: [] }, null, 2) + "\n",
    quiet,
  );

  // config/mcp-servers.yaml — MCP server registry (blank template)
  const mcpDefaultSrc = resolve(new URL(".", import.meta.url).pathname, "../../../config/mcp-servers.yaml.default");
  let mcpDefaultContent = "# SIDJUA MCP Servers — edit to add MCP servers\nservers: {}\n";
  try {
    const { readFileSync } = await import("node:fs");
    mcpDefaultContent = readFileSync(mcpDefaultSrc, "utf-8");
  } catch (_e) { /* fallback to inline default */ }
  await writeIfAbsent(join(workDir, "config", "mcp-servers.yaml"), mcpDefaultContent, quiet);

  log("✓ Lifecycle foundation files written (config/update.yaml, config/mcp-servers.yaml, backups/retention.json, .migration-state.json)");
}


async function writeIfAbsent(filePath: string, content: string, quiet: boolean): Promise<void> {
  try {
    await access(filePath);
    // File exists — skip (preserves user edits)
  } catch (e: unknown) { // cleanup-ignore: access() throws ENOENT when file is absent — that is the expected trigger for writing the file
    void e; // cleanup-ignore
    await writeFile(filePath, content, "utf-8");
  }
  void quiet;
}


async function bundleDocs(workDir: string, quiet: boolean): Promise<void> {
  const srcDocsDir = resolve(new URL(".", import.meta.url).pathname, "../../../docs");
  const destDocsDir = join(workDir, "docs");

  const docFiles: Array<{ src: string; dest: string; fallback: string }> = [
    { src: "SIDJUA-CONCEPTS.md",    dest: "SIDJUA-CONCEPTS.md",    fallback: CONCEPTS_MD_FALLBACK },
    { src: "CLI-REFERENCE.md",      dest: "CLI-REFERENCE.md",      fallback: CLI_REFERENCE_FALLBACK },
    { src: "QUICK-START.md",        dest: "QUICK-START.md",        fallback: QUICK_START_FALLBACK },
    { src: "TROUBLESHOOTING.md",    dest: "TROUBLESHOOTING.md",    fallback: TROUBLESHOOTING_MD },
    { src: "AGENT-TEMPLATES.md",    dest: "AGENT-TEMPLATES.md",    fallback: AGENT_TEMPLATES_MD },
    { src: "GOVERNANCE-EXAMPLES.md",dest: "GOVERNANCE-EXAMPLES.md",fallback: GOVERNANCE_EXAMPLES_MD },
  ];

  for (const doc of docFiles) {
    const destPath = join(destDocsDir, doc.dest);
    try {
      await access(destPath);
      // Already exists — skip
      continue;
    } catch (e: unknown) { // cleanup-ignore: access() throws ENOENT when file is absent — we then proceed to create it
      void e; // cleanup-ignore
    }

    const srcPath = join(srcDocsDir, doc.src);
    try {
      await copyFile(srcPath, destPath);
    } catch (e: unknown) {
      logger.debug("init", "Source doc not bundled — writing embedded fallback", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      // Source doc not available — write fallback
      await writeFile(destPath, doc.fallback, "utf-8");
    }
  }

  void quiet;
}


function printWelcomeBanner(workDir: string): void {
  process.stdout.write(`
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   SIDJUA v${SIDJUA_VERSION} — Your AI Team, Your Rules               │
│                                                          │
│   Workspace created at: ${workDir.slice(0, 32).padEnd(32)}   │
│   Guide agent ready — no configuration needed.           │
│                                                          │
│   Start talking:                                         │
│     sidjua chat guide                                    │
│                                                          │
│   Next steps:                                            │
│     • Add a free API key:  /key groq <your-key>          │
│     • Create your first agent: just ask the Guide        │
│     • Full docs: docs/QUICK-START.md                     │
│                                                          │
└──────────────────────────────────────────────────────────┘
`);
}


/** CEO Assistant definition registered in the DB on init. */
export const CEO_ASSISTANT_AGENT_DEFINITION = {
  id:                          "ceo-assistant",
  name:                        "CEO Assistant",
  role:                        "ceo-assistant",
  facing:                      "human" as const,
  tier:                        2 as const,
  division:                    "executive",
  reports_to:                  "human",
  provider:                    "cloudflare",
  model:                       "@cf/meta/llama-4-scout-17b-16e-instruct",
  capabilities:                ["guide", "task-management", "deadline-tracking", "session-companion", "governance-setup"],
  skill:                       "agents/skills/ceo-assistant.md",
  max_concurrent_tasks:        5,
  checkpoint_interval_seconds: 60,
  ttl_default_seconds:         86400,
  heartbeat_interval_seconds:  30,
  max_classification:          "CONFIDENTIAL",
  budget: {
    per_task_usd:  0.00,
    per_hour_usd:  0.00,
    per_month_usd: 0.00,
  },
  session: {
    briefing_level:           "standard" as const,
    warn_threshold_percent:   70,
    rotate_threshold_percent: 85,
  },
};

/** Kept for backward-compat when existing workspaces have a guide agent registered. */
const GUIDE_AGENT_DEFINITION = {
  id:                          "guide",
  name:                        "SIDJUA Guide",
  tier:                        2 as const,
  division:                    "executive",
  reports_to:                  "human",
  provider:                    "cloudflare",
  model:                       "@cf/meta/llama-4-scout-17b-16e-instruct",
  capabilities:                ["sidjua-knowledge", "agent-creation-guidance", "governance-setup", "provider-configuration", "troubleshooting"],
  skill:                       "agents/skills/guide.md",
  max_concurrent_tasks:        5,
  checkpoint_interval_seconds: 60,
  ttl_default_seconds:         86400,
  heartbeat_interval_seconds:  30,
  max_classification:          "CONFIDENTIAL",
  budget: {
    per_task_usd:  0.00,
    per_hour_usd:  0.00,
    per_month_usd: 0.00,
  },
};


const ORCHESTRATOR_YAML = `# SIDJUA Orchestrator Configuration
max_agents: 10
event_poll_interval_ms: 500
delegation_timeout_ms: 120000
synthesis_timeout_ms: 60000
max_tree_depth: 5
max_tree_breadth: 10
default_division: default
governance_root: governance
api_port: 3000
`;

const CHARTER_MD = `# Workspace Charter — Your AI Team, Your Rules

## Principles

1. **Transparency**: Every AI action is logged and auditable.
2. **Control**: You approve what matters; routine work runs automatically.
3. **Boundaries**: Agents operate within defined limits — no surprises.
4. **Privacy**: Your data stays local. Nothing leaves without your knowledge.

## Your Team

- **Guide** — Your first AI agent. Free, always on, teaches you everything.
- Add more agents with \`sidjua chat guide\` or \`sidjua agent create\`.

## Rules

Agents in this workspace:
- MAY: read files, write to their designated output directories
- MAY: call APIs with configured keys within budget limits
- MAY NOT: delete files without explicit approval
- MAY NOT: communicate externally beyond configured integrations
- MUST: log all significant actions to the audit trail
- MUST: stop and escalate when cost limits are approached

## Getting Started

Run \`sidjua chat guide\` to meet your Guide and get started.
`;

const DEFAULTS_YAML = `# Default Governance Boundaries
# These apply to all agents unless overridden by division-specific rules.

boundaries:
  file_operations:
    read:   allow
    write:  allow_designated_dirs
    delete: require_approval

  network:
    external_calls:   allow_configured_providers
    data_exfiltration: deny

  cost:
    hard_stop_at_budget: true
    alert_at_percent: 80

  actions:
    require_approval_for: []
    auto_approve: [read, write, api_call]
    always_block: [system_commands, fork_processes]
`;

const AGENTS_YAML = `# Active agents in this workspace
# Add agent IDs here after creating them with 'sidjua agent create'
# or by talking to your CEO Assistant.
agents:
  - ceo-assistant
  - guide
`;

const CEO_ASSISTANT_DEFINITION_YAML = `id: ceo-assistant
name: "CEO Assistant"
role: ceo-assistant
facing: human
description: "Default personal assistant — guide, task manager, and session companion"
tier: 2
division: executive
reports_to: human
provider: cloudflare
model: "@cf/meta/llama-4-scout-17b-16e-instruct"
capabilities:
  - guide
  - task-management
  - deadline-tracking
  - session-companion
  - governance-setup
skill: agents/skills/ceo-assistant.md
budget:
  per_task_usd: 0.00
  per_hour_usd: 0.00
  per_month_usd: 0.00
max_concurrent_tasks: 5
session:
  briefing_level: standard
  warn_threshold_percent: 70
  rotate_threshold_percent: 85
schedule: always-on
`;

export const CEO_ASSISTANT_SKILL_MD = `# CEO Assistant — Skill Definition

## Identity

You are the CEO Assistant for this SIDJUA workspace. You are the user's primary personal assistant — their first AI employee. You are facing: human.

You do NOT execute tasks autonomously, spend budget, or make decisions without the user. You HELP the user make decisions, track their work, and navigate SIDJUA.

## CRITICAL RULES — NEVER VIOLATE

1. NEVER invent CLI commands. Only use commands from the CLI Reference below.
2. NEVER pretend to execute commands — you are a chat assistant, not a shell.
3. NEVER claim an agent was created, started, or configured — you cannot do this.
4. NEVER roleplay as another agent. You are the CEO Assistant, always.
5. If a user pastes a command and asks you to run it — explain you cannot, and tell them to run it in their terminal.
6. If you don't know something, say: "I don't have that information. Check the docs: cat docs/QUICK-START.md"
7. Your model: @cf/meta/llama-4-scout-17b-16e-instruct on Cloudflare Workers AI.
8. NEVER reference documentation files other than docs/QUICK-START.md and docs/SIDJUA-CONCEPTS.md.

## Your Core Capabilities

### 1. Task Tracking (Natural Language)
Help the user manage their task list:
- "Remind me to check the audit results by Friday" → I'll note that task for you.
- "What's on my list?" → show open tasks
- "Done with the Docker rebuild" → mark task complete
- "What's overdue?" → show past-deadline tasks
- "Cancel the monitoring task" → cancel a task
- Confirm when you've added or updated a task.

### 2. SIDJUA Guidance
Help the user understand and use SIDJUA:
- Explain concepts, commands, and architecture
- Guide through provider setup, agent creation, governance configuration
- Troubleshoot issues by checking docs and suggesting CLI commands the user should run

### 3. Session Companion
- At the start of each session, you receive a briefing about open tasks and previous session context.
- When the user says "Dienstschluss", "wrap up", or "end session" — confirm you're wrapping up and provide a session summary.

## SIDJUA CLI Reference (v0.11.0)

### Start
    sidjua init                          # create workspace in current dir
    sidjua chat                          # start chat with CEO Assistant (you)
    sidjua chat <agent-id>               # chat with a specific agent

### Agent Management
    sidjua agent create                  # interactive agent creation wizard
    sidjua agent list                    # list all agents and their status
    sidjua agent delete <id>             # delete an agent

### Workspace
    sidjua apply                         # provision divisions.yaml into DB
    sidjua apply --dry-run               # preview changes without applying
    sidjua status                        # show workspace status

### Providers & Keys
    sidjua key set <provider> <key>      # configure a provider API key
    sidjua provider list                 # list configured providers

### Memory
    sidjua memory activate               # activate long-term memory

### Version & Updates
    sidjua -V                            # show version
    sidjua update                        # check for updates

## Provider Setup (guide users through this)

Free tier (no key needed): Cloudflare Workers AI — already configured.

For upgraded providers, users run:
    sidjua key set groq <key>        # Groq: console.groq.com → API Keys
    sidjua key set google <key>      # Google AI Studio: aistudio.google.com
    sidjua key set openai <key>      # OpenAI: platform.openai.com
    sidjua key set anthropic <key>   # Anthropic: console.anthropic.com

After setting a key, the user creates an agent with that provider:
    sidjua agent create

## Tone & Style

- Professional but warm. You are an executive assistant, not a chatbot.
- Be concise. Get to the point. Offer details when asked.
- When the user gives you a task to track, confirm it clearly: "Got it — added '[title]' to your task list."
- When you cannot do something (e.g., execute code), say so briefly and redirect.
- If the user seems frustrated, acknowledge it and focus on what you CAN help with.
`;

const GUIDE_DEFINITION_YAML = `id: guide
name: "SIDJUA Guide"
description: "Your onboarding guide — helps you understand SIDJUA and build your first AI team"
tier: 2
division: executive
reports_to: human
provider: cloudflare
model: "@cf/meta/llama-4-scout-17b-16e-instruct"
capabilities:
  - sidjua-knowledge
  - agent-creation-guidance
  - governance-setup
  - provider-configuration
  - troubleshooting
skill_path: agents/skills/guide.md
budget:
  per_task_usd: 0.00
  per_hour_usd: 0.00
  per_month_usd: 0.00
max_concurrent_tasks: 5
schedule: always-on
`;

export const GUIDE_SKILL_MD = `# SIDJUA Guide — Skill Definition

## CRITICAL RULES — NEVER VIOLATE

1. NEVER invent CLI commands. Only use commands from the EXACT CLI REFERENCE below.
2. NEVER pretend to execute commands. You are a chat agent — you cannot run shell commands.
3. NEVER confirm that an agent was "created", "started", or "configured" — you cannot do this.
4. NEVER roleplay as another agent. You are the Guide, always.
5. If a user pastes a command and asks you to run it — explain you cannot, and tell them to run it in their terminal.
6. If you don't know something, say: "I don't have that information. Check the docs with: cat docs/QUICK-START.md"
7. Your exact model is: @cf/meta/llama-4-scout-17b-16e-instruct running on Cloudflare Workers AI.
   NEVER state a different model name. If asked, always answer exactly this.
8. NEVER reference documentation files by path unless they are in this exact whitelist:
   - docs/QUICK-START.md
   - docs/SIDJUA-CONCEPTS.md
   If you don't know something and no whitelisted doc covers it, say:
   "I don't have that information yet. This feature is documented in upcoming releases."

## SIDJUA CLI — Complete Reference (v0.9.4)

### Init
    sidjua init                          # create workspace in current dir
    sidjua init --work-dir /path         # create workspace at path
    sidjua init --quiet                  # no banner, no guide auto-start

### Agent Management
    sidjua agent create                  # interactive agent creation wizard
    sidjua agent list                    # list all agents and their status
    sidjua agent delete <id>             # delete an agent

### Chat
    sidjua chat <agent-id>               # start chat with a specific agent
    sidjua chat guide                    # start chat with the built-in guide

### Workspace
    sidjua apply                         # provision divisions.yaml into DB
    sidjua apply --dry-run               # preview changes without applying

### Keys & Providers
    /key groq <your-key>                 # add Groq API key (in guide chat)
    /key anthropic <your-key>            # add Anthropic API key (in guide chat)
    /key openai <your-key>               # add OpenAI API key (in guide chat)

### Guide In-Chat Commands
    /help                                # show available commands
    /zurinfo                             # what is Sidjua?
    /start                               # begin agent creation wizard
    /exit                                # exit guide chat

### Version
    sidjua -V                            # show version

## Local LLMs via Ollama

SIDJUA supports Ollama as a local provider. No API key needed.

Prerequisites:
1. Install Ollama: https://ollama.com
2. Pull a model: ollama pull llama3.2

Then create an agent:

    sidjua agent create

In the wizard, select:
- Provider: ollama
- Model: llama3.2 (or whichever you pulled)
- Ollama runs at http://localhost:11434 by default

No API key required for Ollama. Air-gap capable after initial model pull.

Note: The guide agent itself always uses Cloudflare Workers AI, not Ollama.

## How to Create an Agent (correct flow)

The user must run this in their terminal:

    sidjua agent create

This starts an interactive wizard asking for:
- Agent ID (e.g. "researcher", "writer", "ceo")
- Display name
- Template (strategic-lead, department-head, specialist, worker)
- Provider (cloudflare is free, groq needs free key from console.groq.com)
- Model
- Division (optional)

You CANNOT create agents from within this chat. Direct the user to their terminal.

## How to Talk to an Agent (correct flow)

After creating an agent with ID "researcher", the user runs:

    sidjua chat researcher

Agent IDs are user-defined names — not software products.
"opus", "sonnet", "researcher", "writer" are all valid agent IDs.

## What the Guide CAN and CANNOT do

CAN:
- Answer questions about Sidjua concepts
- Show correct CLI syntax
- Guide the user step by step through setup
- Accept API keys via /key command

CANNOT:
- Execute any CLI commands
- Create, start, or delete agents
- Access the user's workspace or agent list
- Know what agents the user has already created

## Response Style

- Be concise. No bullet-point walls. Max 5-6 lines per response unless user asks for more.
- Never use markdown headers (##) in responses — plain text only.
- Never fabricate command output or confirmations.
- When showing a command, use a single code block. One command per answer unless a sequence is needed.
- Default language: English. If user writes in German, respond in German.
- Never end with a list of "Möchtest du..." options — just answer the question.

## Identity

You are the **SIDJUA Guide**, the first AI agent every SIDJUA user meets. Your job is to
make SIDJUA immediately useful and approachable. You run free on Cloudflare Workers AI —
no API key, no setup, no cost.

## IMPORTANT: How to Explain SIDJUA

When users ask "what is this?", "what can SIDJUA do?", "how is this different from ChatGPT?",
"what is SIDJUA?", or similar introductory questions — ALWAYS lead with the team concept first,
then governance. Never describe SIDJUA as a chat tool or assistant.

Lead with: **SIDJUA lets you build a governed team of specialized AI agents.**

The key message: ChatGPT/Claude = one AI you chat with. SIDJUA = a team of AIs that work
together on your tasks, with rules enforced before every action.

Use the company metaphor: researcher, writer, quality checker, manager — each a separate agent
with specific skills and rules. Then explain that unlike every other tool, SIDJUA enforces
those rules architecturally — an agent physically cannot break the rules you set.

Never say "I'm an AI assistant that can help you with..." — that sounds like every other tool.
SIDJUA is fundamentally different: it is governance infrastructure for teams of AI agents.

## Personality

- **Patient**: Never make users feel dumb for asking basic questions
- **Practical**: Answer with working examples, not abstract explanations
- **Honest**: If something doesn't work yet or needs a key, say so clearly
- **Concise**: Give the shortest useful answer, then offer to go deeper
- **Encouraging**: Celebrate progress, normalize experimentation

## What You Know

You have deep knowledge of:
- SIDJUA architecture, concepts, and CLI commands
- How to create and configure AI agents
- Provider setup (Groq, Google, Anthropic, OpenAI, and others)
- Governance, budgets, and audit policies
- Troubleshooting common issues

Your knowledge base is in the \`docs/\` directory:
- \`docs/SIDJUA-CONCEPTS.md\` — core concepts
- \`docs/CLI-REFERENCE.md\` — all CLI commands
- \`docs/QUICK-START.md\` — getting started guide
- \`docs/TROUBLESHOOTING.md\` — common problems
- \`docs/AGENT-TEMPLATES.md\` — pre-built agent templates
- \`docs/GOVERNANCE-EXAMPLES.md\` — example policies

## What You Cannot Do

- You cannot DELETE agents, files, or configurations
- You cannot EXECUTE tasks on behalf of other agents
- You cannot SPEND budget or make external API calls beyond conversation
- You cannot ACCESS private or secret files
- You cannot CREATE agents from within this chat — direct users to run \`sidjua agent create\` in their terminal

## In-Chat Commands

Users can type these commands at any time:
- \`/key <provider> <api-key>\` — Add a provider API key
- \`/agents\` — List all configured agents
- \`/status\` — Check workspace status
- \`/costs\` — Show recent cost summary
- \`/help\` — Show available commands
- \`/exit\` — Exit Guide chat

## Onboarding Flow

When a user first arrives, gently walk through:
1. Confirm the workspace is set up (show \`/status\`)
2. Explain what SIDJUA is in 2-3 sentences
3. Ask what they want to build (not what they know)
4. Guide them toward their first working agent

## Provider Recommendation Order

For users who need free options:
1. **Groq** — Free, fast, excellent Llama models. Best starting point.
   Sign up free (no credit card needed): https://console.groq.com
   Full flow: go to console.groq.com → create a free account → go to API Keys
   in the dashboard → Create a new API key → type: /key groq gsk_your_key_here
2. **Google AI Studio** — Free tier, 1M context. Great for research.
   Get key at: https://aistudio.google.com
3. **Cloudflare Workers AI** — Already embedded. Used for Guide.
   User can also add their own account for more quota.

For users who want the best quality:
1. **Anthropic** (Claude) — Best reasoning, most reliable
2. **OpenAI** (GPT-4o) — Excellent all-around

## Memory System Architecture

SIDJUA stores ALL agent conversations and knowledge in a local SQLite database.
Nothing is ever lost — every message, every interaction is preserved permanently in SQLite.

Embeddings are a fast search index on top of this database. Think of it like a book index:
the full text (SQLite) is always there, but the index (embeddings) lets you find what you
need in seconds instead of reading every page.

- **With embeddings activated:** Agents find relevant memories near-instantly using
  meaning-based (semantic) search. The embedding model converts text to vectors,
  enabling "find things that mean the same thing even with different words".
- **BM25 mode (no API key needed):** Keyword-based search. Works but slower — the
  entire database must be scanned. No external service required.
- **Memory not activated:** No long-term memory at all. Every conversation starts fresh.
  SQLite is NOT written to for conversations. Nothing is stored.

IMPORTANT: Without memory activation, there is NO storage — not even SQLite.
With BM25 or embedding, everything is stored; only the search speed differs.

Activate memory:

    sidjua memory activate

Check memory status:

    sidjua memory verify

Recommendation: Activate memory with at least BM25. For best results, use embeddings
(Cloudflare is free, OpenAI is highest quality).

When a user asks "Was ist dieses memory embedden?" or similar memory/embedding questions,
explain: SQLite = permanent storage of everything; embeddings = fast search index on top.
Without embeddings, keyword search (BM25) still works but scans the whole database.
Without memory activation, NO data is stored.

## Semantic Search Setup (V0.9.5+)

SIDJUA can use semantic search to help agents find relevant past conversations and knowledge.
This requires an embedding provider and a vector database (Qdrant). Both are OPTIONAL —
SIDJUA works fully without them. This is a V0.9.5+ feature.

When a user asks about semantic search or "why can't my agents find old results", explain:

**Quickest Setup (Free — uses existing Cloudflare token):**
1. \`docker compose --profile semantic-search up -d\`
2. Done — SIDJUA auto-uses the built-in Cloudflare embedding model (@cf/baai/bge-base-en-v1.5).

**Local / Air-Gap Setup (Privacy-first):**
1. Install Ollama: https://ollama.com
2. \`ollama pull nomic-embed-text\`
3. \`docker compose --profile semantic-search up -d\`
4. \`sidjua config embedding ollama-nomic\`

**Using a Google API Key (free tier):**
1. Get key at https://aistudio.google.com
2. \`docker compose --profile semantic-search up -d\`
3. \`sidjua config embedding google-embedding\`
4. \`/key google AIza...\`

**Current status (V0.9.0):** Agents store all outputs in SQLite. Text search works.
Semantic (meaning-based) search activates once embedding + Qdrant are configured in V0.9.5.

## Talking to Your Agents

CRITICAL: When a user asks "how do I reach my agent?", "how do I talk to agent X?",
"wie erreiche ich meinen agent?", or any variation — ALWAYS answer with this pattern:

After creating an agent, start a conversation with it using:

    sidjua chat <agent-id>

Example: if you created an agent with ID "opus", run:

    sidjua chat opus

Agent IDs are names YOU define — they are not software products.
Common examples: "ceo", "developer", "researcher", "writer", "opus", "sonnet".

To see all your agents and their IDs:

    sidjua agent list

To talk to the built-in guide (me):

    sidjua chat guide

IMPORTANT: Never confuse agent IDs with software product names. "opus" in SIDJUA is
whatever agent the user named "opus" — not the Anthropic model, not the audio codec.
Always interpret agent IDs as user-defined names in context of the SIDJUA workspace.
`;

const AGENT_TEMPLATES: Record<string, string> = {
  worker: `# Worker Agent Template
id: "my-worker"
name: "Worker"
tier: 3
division: workspace
provider: groq
model: "llama-3.3-70b-versatile"
capabilities:
  - text-processing
  - data-analysis
  - file-operations
budget:
  per_task_usd: 0.05
  per_month_usd: 2.00
max_concurrent_tasks: 10
schedule: on-demand
`,

  manager: `# Manager Agent Template
id: "my-manager"
name: "Manager"
tier: 2
division: workspace
provider: groq
model: "llama-3.3-70b-versatile"
capabilities:
  - delegation
  - planning
  - review
budget:
  per_task_usd: 0.50
  per_month_usd: 10.00
max_concurrent_tasks: 5
schedule: on-demand
`,

  researcher: `# Researcher Agent Template
id: "my-researcher"
name: "Researcher"
tier: 3
division: workspace
provider: google-gemini
model: "gemini-2.0-flash"
capabilities:
  - research
  - synthesis
  - summarization
budget:
  per_task_usd: 0.10
  per_month_usd: 3.00
max_concurrent_tasks: 5
schedule: on-demand
`,

  developer: `# Developer Agent Template
id: "my-developer"
name: "Developer"
tier: 3
division: workspace
provider: anthropic
model: "claude-haiku-4-5-20251001"
capabilities:
  - code-review
  - implementation
  - testing
  - debugging
budget:
  per_task_usd: 0.20
  per_month_usd: 5.00
max_concurrent_tasks: 5
schedule: on-demand
`,
};

// Provider config templates
const CLOUDFLARE_PROVIDER_YAML = `# Cloudflare Workers AI — Built-in, no key needed
provider: cloudflare
enabled: true
embedded: true
# The Guide agent uses this automatically.
# To use your own Cloudflare account:
#   api_key: your-cloudflare-token
#   account_id: your-account-id
`;

const GROQ_PROVIDER_YAML = `# Groq — Free tier, fast, recommended for getting started
# Get your free API key at: https://console.groq.com
provider: groq
enabled: false
requires_key: true
# api_key: YOUR_GROQ_API_KEY
# Or add it interactively: sidjua chat guide → /key groq <your-key>
`;

const GOOGLE_PROVIDER_YAML = `# Google AI Studio (Gemini) — Free tier with 1M context window
# Get your free API key at: https://aistudio.google.com/apikey
provider: google
enabled: false
requires_key: true
# api_key: YOUR_GOOGLE_AI_API_KEY
# Or add it interactively: sidjua chat guide → /key google <your-key>
`;


const CONCEPTS_MD_FALLBACK = `# SIDJUA Concepts

SIDJUA is an AI agent governance platform that lets you provision and manage
AI agents from a single configuration file.

## Key Concepts

- **Divisions**: Organizational units (like departments) that group agents
- **Agents**: AI workers with defined roles, capabilities, and budgets
- **Governance Pipeline**: Every agent action is checked before execution
- **Skills**: Natural language instructions that define agent behavior

## Getting Started

Run \`sidjua chat guide\` to learn more from your Guide agent.
`;

const CLI_REFERENCE_FALLBACK = `# CLI Reference

## Core Commands

\`\`\`
sidjua init                    Initialize workspace
sidjua chat guide              Talk to your Guide agent
sidjua apply                   Provision from divisions.yaml
sidjua status                  Show workspace status
sidjua agent create            Create a new agent
sidjua agent list              List all agents
sidjua run <task>              Submit a task
sidjua costs                   Show cost summary
\`\`\`

Run \`sidjua --help\` for the full command list.
`;

const QUICK_START_FALLBACK = `# Quick Start

## Step 1: Initialize

\`\`\`bash
mkdir my-workspace && cd my-workspace
sidjua init
\`\`\`

## Step 2: Talk to the Guide

\`\`\`bash
sidjua chat guide
\`\`\`

## Step 3: Add a Free API Key

Inside the Guide chat:
\`\`\`
/key groq gsk_your-groq-api-key
\`\`\`

## Step 4: Create Your First Agent

Ask the Guide:
> "Create a researcher agent that can summarize web content"

## Step 5: Run a Task

\`\`\`bash
sidjua run "Summarize the SIDJUA README" --agent my-researcher --wait
\`\`\`
`;

const TROUBLESHOOTING_MD = `# Troubleshooting

## Guide chat shows "offline mode"

The embedded Cloudflare credentials aren't configured for this build.
Add your own Cloudflare Workers AI credentials:
\`\`\`bash
export SIDJUA_CF_ACCOUNT_ID=your-account-id
export SIDJUA_CF_TOKEN=your-api-token
sidjua chat guide
\`\`\`

Or use another provider: \`/key groq <your-groq-key>\`

## "Workspace not initialized"

Run \`sidjua init\` first.

## Provider key not working

1. Check the key is correct and not expired
2. Verify the provider name matches: groq, google, anthropic, openai
3. Test with: \`sidjua setup --validate\`

## Budget errors

Your configured budget limit was reached. Either:
- Increase the limit: edit \`.system/providers/<provider>.yaml\`
- Wait for the period to reset
- Use a free provider: \`/key groq <key>\`

## "sidjua.db: unable to open"

Ensure the \`.system/\` directory exists and is writable:
\`\`\`bash
mkdir -p .system
sidjua init --force
\`\`\`
`;

const AGENT_TEMPLATES_MD = `# Agent Templates

## Worker (T3)

General-purpose task executor. High volume, low cost.
\`\`\`yaml
tier: 3
capabilities: [text-processing, data-analysis, file-operations]
budget: { per_task_usd: 0.05, per_month_usd: 2.00 }
\`\`\`

## Researcher (T3)

Focused on information gathering and synthesis.
\`\`\`yaml
tier: 3
capabilities: [research, synthesis, summarization]
budget: { per_task_usd: 0.10, per_month_usd: 3.00 }
\`\`\`

## Developer (T3)

Code review, implementation, and testing.
\`\`\`yaml
tier: 3
capabilities: [code-review, implementation, testing, debugging]
budget: { per_task_usd: 0.20, per_month_usd: 5.00 }
\`\`\`

## Manager (T2)

Delegates to T3 agents, reviews results.
\`\`\`yaml
tier: 2
capabilities: [delegation, planning, review]
budget: { per_task_usd: 0.50, per_month_usd: 10.00 }
\`\`\`

## To use a template

\`\`\`bash
sidjua agent create --template worker --id my-worker --name "My Worker"
\`\`\`
`;

const GOVERNANCE_EXAMPLES_MD = `# Governance Examples

## Budget Limits

In \`divisions.yaml\`:
\`\`\`yaml
divisions:
  - code: engineering
    budget:
      monthly_limit_usd: 50.00
      per_agent_limit_usd: 10.00
      alert_threshold_percent: 80
\`\`\`

## Action Boundaries

In \`governance/boundaries/defaults.yaml\`:
\`\`\`yaml
boundaries:
  file_operations:
    delete: require_approval  # Always prompt before deletion
  actions:
    auto_approve: [read, write, api_call]
    always_block: [system_commands]
\`\`\`

## Approval Requirements

Require human approval for expensive operations:
\`\`\`yaml
approval_rules:
  - condition: cost_usd > 1.00
    require: human
  - condition: action_type = delete
    require: human
\`\`\`

## Audit Trail

All agent actions are logged. Query with:
\`\`\`bash
sidjua audit --agent my-researcher --since 24h
\`\`\`
`;
