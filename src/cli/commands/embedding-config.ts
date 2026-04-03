// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V0.9.5: `sidjua config embedding <provider>` command
 *
 * Activates semantic search by:
 *   1. Validating the requested embedding provider + credentials
 *   2. Running the initial bulk import of all existing task outputs
 *   3. Blocking until complete (agents need the full knowledge base)
 *
 * Provider options:
 *   cloudflare-bge   @cf/baai/bge-base-en-v1.5, FREE — needs SIDJUA_CF_ACCOUNT_ID + SIDJUA_CF_TOKEN
 *   ollama-nomic     nomic-embed-text via Ollama, FREE local — needs Ollama running
 *   google-embedding text-embedding-004, free tier — needs GOOGLE_API_KEY
 *   openai-large     text-embedding-3-large, paid — needs OPENAI_API_KEY
 *
 * Provider selection is persisted to .system/config.json after a successful
 * bulk import so agents automatically use the chosen provider on next start.
 */

import { join, resolve }       from "node:path";
import { existsSync }          from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { stdout, stderr }      from "node:process";
import type { Command }        from "commander";
import { openDatabase }        from "../../utils/db.js";
import {
  getLocale,
  setLocale,
  getAvailableLocales,
} from "../../i18n/index.js";
import { runWorkspaceConfigMigration } from "../../api/workspace-config-migration.js";
import { TaskOutputEmbedder }  from "../../tasks/output-embedder.js";
import { InitialEmbeddingImporter } from "../../tasks/initial-embedding-importer.js";
import { CloudflareEmbedder }  from "../../knowledge-pipeline/embedding/cloudflare-embedder.js";
import { OllamaEmbedder }      from "../../knowledge-pipeline/embedding/ollama-embedder.js";
import { GoogleEmbedder }      from "../../knowledge-pipeline/embedding/google-embedder.js";
import { OpenAIEmbedder }      from "../../knowledge-pipeline/embedding/openai-embedder.js";
import type { Embedder }       from "../../knowledge-pipeline/types.js";
import { createLogger }        from "../../core/logger.js";
import { auditCliCommand }     from "../cli-audit.js";

const logger = createLogger("embedding-config");


const SUPPORTED_PROVIDERS = ["cloudflare-bge", "ollama-nomic", "google-embedding", "openai-large"] as const;
type EmbeddingProvider = typeof SUPPORTED_PROVIDERS[number];

const PROVIDER_DESCRIPTIONS: Record<EmbeddingProvider, string> = {
  "cloudflare-bge":   "@cf/baai/bge-base-en-v1.5 (768 dims, FREE — uses SIDJUA_CF_ACCOUNT_ID + SIDJUA_CF_TOKEN)",
  "ollama-nomic":     "nomic-embed-text via Ollama (768 dims, FREE local — requires Ollama running)",
  "google-embedding": "text-embedding-004 (768 dims, free tier — requires GOOGLE_API_KEY)",
  "openai-large":     "text-embedding-3-large (3072 dims, paid — requires OPENAI_API_KEY)",
};


export interface EmbeddingConfigOptions {
  workDir:    string;
  batchSize:  number;
  baseUrl?:   string;  // Ollama: override base URL
  dryRun:     boolean;
}


export function registerEmbeddingConfigCommands(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Manage SIDJUA configuration");

  // ── config locale subcommands ────────────────────────────────────────────
  // These mirror `sidjua locale` but live under `sidjua config` for
  // discoverability and scriptability in automation workflows.

  const localeCmd = configCmd
    .command("locale")
    .description("Display or change the workspace display language")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: { workDir: string }) => {
      const current = getLocale();
      stdout.write(`Current locale: ${current}\n`);
      void opts;
    });

  localeCmd
    .command("set <code>")
    .description("Set the display locale (e.g. de, en, fr)")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(async (code: string, opts: { workDir: string }) => {
      const workDir   = resolve(opts.workDir);
      const available = getAvailableLocales();

      if (!available.includes(code)) {
        stderr.write(`Unknown locale: ${code}\nAvailable: ${available.join(", ")}\n`);
        process.exitCode = 1;
        return;
      }

      const dbPath = join(workDir, ".system", "sidjua.db");
      if (existsSync(dbPath)) {
        try {
          const db = openDatabase(dbPath);
          runWorkspaceConfigMigration(db);
          db.prepare(
            "INSERT OR REPLACE INTO workspace_config (key, value, updated_at) VALUES ('locale', ?, datetime('now'))",
          ).run(code);
          db.close();
        } catch (_e) {
          // Non-fatal — locale still set in memory
        }
      }

      setLocale(code);
      stdout.write(`Locale set to: ${code}\n`);
    });

  localeCmd
    .command("list")
    .description("List available locales")
    .action(() => {
      const available = getAvailableLocales();
      stdout.write("Available locales:\n");
      for (const code of available) {
        stdout.write(`  ${code}\n`);
      }
    });

  // ── config embedding subcommand ──────────────────────────────────────────

  configCmd
    .command("embedding <provider>")
    .description(
      `Activate semantic search with the specified embedding provider.\n` +
      `Providers: ${SUPPORTED_PROVIDERS.join(" | ")}\n` +
      `Runs bulk import of all existing data before enabling real-time embedding.`,
    )
    .option("--work-dir <path>", "Working directory",  process.cwd())
    .option("--batch-size <n>", "Rows per embed batch", "50")
    .option("--base-url <url>", "Ollama base URL (default: http://localhost:11434)")
    .option("--dry-run",        "Count pending rows without embedding", false)
    .action(async (
      provider: string,
      opts:     { workDir: string; batchSize: string; baseUrl?: string; dryRun: boolean },
    ) => {
      const exitCode = await runEmbeddingConfigCommand(provider, {
        workDir:   resolve(opts.workDir),
        batchSize: parseInt(opts.batchSize, 10),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        dryRun:    opts.dryRun,
      });
      process.exit(exitCode);
    });
}


export async function runEmbeddingConfigCommand(
  provider: string,
  opts:     EmbeddingConfigOptions,
): Promise<number> {
  auditCliCommand("embedding-config", undefined);

  // ── Validate provider ──────────────────────────────────────────────────────
  if (!SUPPORTED_PROVIDERS.includes(provider as EmbeddingProvider)) {
    stderr.write(
      `✗ Unknown embedding provider: "${provider}"\n` +
      `  Supported: ${SUPPORTED_PROVIDERS.join(", ")}\n`,
    );
    return 1;
  }

  const providerKey = provider as EmbeddingProvider;

  // ── Resolve workspace DB ───────────────────────────────────────────────────
  const dbPath = join(opts.workDir, ".system", "sidjua.db");
  if (!existsSync(dbPath)) {
    stderr.write(
      `✗ Workspace not initialized at ${opts.workDir}\n` +
      `  Run \`sidjua init\` first.\n`,
    );
    return 1;
  }

  // ── Build embedder ─────────────────────────────────────────────────────────
  let embedder: Embedder;
  try {
    embedder = buildEmbedder(providerKey, opts);
  } catch (err) {
    stderr.write(`✗ ${String(err)}\n`);
    return 1;
  }

  stdout.write(`\nEmbedding provider: ${PROVIDER_DESCRIPTIONS[providerKey]}\n\n`);

  // ── Open DB + initialize vector table ─────────────────────────────────────
  const db = openDatabase(dbPath);
  const taskOutputEmbedder = new TaskOutputEmbedder(db, embedder);
  taskOutputEmbedder.initialize();

  const importer = new InitialEmbeddingImporter(db, taskOutputEmbedder);

  // ── Count pending rows ─────────────────────────────────────────────────────
  const pending = importer.countPending();
  const total   = importer.countTotal();

  stdout.write(`Task outputs in SQLite: ${total}\n`);
  stdout.write(`Already embedded:       ${total - pending}\n`);
  stdout.write(`Pending import:         ${pending}\n\n`);

  if (pending === 0) {
    stdout.write(`✓ All data is already embedded. Semantic search is ready.\n\n`);
    return 0;
  }

  if (opts.dryRun) {
    stdout.write(`[dry-run] Would embed ${pending} outputs. Run without --dry-run to proceed.\n\n`);
    return 0;
  }

  // ── Run initial bulk import (BLOCKING) ────────────────────────────────────
  stdout.write(`Starting bulk import — this must complete before agents use semantic search.\n`);
  stdout.write(`(Interrupt with Ctrl+C to pause; re-run this command to resume.)\n\n`);

  // Validate provider credentials with a single test embed before bulk run
  try {
    stdout.write("Validating credentials... ");
    await embedder.embed(["sidjua embedding test"]);
    stdout.write("✓\n\n");
  } catch (err) {
    stdout.write("✗\n\n");
    stderr.write(`✗ Embedding provider validation failed: ${String(err)}\n`);
    stderr.write(`  Check your credentials and retry.\n\n`);
    logger.warn("embedding_validation_failed", `Provider validation failed: ${String(err)}`, {});
    return 1;
  }

  const result = await importer.runImport({
    batchSize:  opts.batchSize,
    onProgress: (progress) => {
      const pct = Math.round((progress.completed / progress.total) * 100);
      const bar = makeBar(pct, 30);
      const elapsedSec = Math.round(progress.elapsed_ms / 1000);
      stdout.write(
        `\rEmbedding existing data: [${bar}] ${progress.completed}/${progress.total} (${pct}%) — ${elapsedSec}s`,
      );
    },
  });

  stdout.write("\n\n");

  // ── Report results ─────────────────────────────────────────────────────────
  const elapsedSec = (result.elapsed_ms / 1000).toFixed(1);

  if (result.failed === 0) {
    stdout.write(`✓ Initial import complete: ${result.embedded} outputs embedded in ${elapsedSec}s\n`);
    stdout.write(`  Semantic search is now active.\n\n`);
  } else {
    stdout.write(
      `⚠ Import complete with errors: ${result.embedded} embedded, ${result.failed} failed in ${elapsedSec}s\n`,
    );
    stdout.write(`  Failed rows will be retried on next re-run of this command.\n\n`);
  }

  // Persist selected provider to workspace config for automatic reload on startup.
  await persistEmbeddingProvider(opts.workDir, provider);

  stdout.write(
    `Next steps:\n` +
    `  • Start Qdrant:  docker compose --profile semantic-search up -d\n` +
    `  • Start SIDJUA:  sidjua start\n` +
    `  • Test search:   sidjua run "Find relevant past outputs about <topic>"\n\n`,
  );

  return result.failed > 0 ? 1 : 0;
}


function buildEmbedder(provider: EmbeddingProvider, opts: EmbeddingConfigOptions): Embedder {
  switch (provider) {
    case "cloudflare-bge": {
      const accountId = process.env["SIDJUA_CF_ACCOUNT_ID"] ?? "";
      const apiToken  = process.env["SIDJUA_CF_TOKEN"]       ?? "";
      if (!accountId || !apiToken) {
        throw new Error(
          "Cloudflare embedding requires SIDJUA_CF_ACCOUNT_ID and SIDJUA_CF_TOKEN environment variables.\n" +
          "  export SIDJUA_CF_ACCOUNT_ID=your-account-id\n" +
          "  export SIDJUA_CF_TOKEN=your-api-token",
        );
      }
      return new CloudflareEmbedder({ accountId, apiToken });
    }

    case "ollama-nomic": {
      const baseUrl = opts.baseUrl ?? process.env["OLLAMA_BASE_URL"];
      return new OllamaEmbedder({
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        model: process.env["OLLAMA_EMBED_MODEL"] ?? "nomic-embed-text",
      });
    }

    case "google-embedding": {
      const apiKey = process.env["GOOGLE_API_KEY"] ?? process.env["GOOGLE_AI_API_KEY"] ?? "";
      if (!apiKey) {
        throw new Error(
          "Google embedding requires GOOGLE_API_KEY environment variable.\n" +
          "  Get key at: https://aistudio.google.com\n" +
          "  export GOOGLE_API_KEY=AIza...",
        );
      }
      return new GoogleEmbedder({ apiKey });
    }

    case "openai-large": {
      const apiKey = process.env["OPENAI_API_KEY"] ?? "";
      if (!apiKey) {
        throw new Error(
          "OpenAI embedding requires OPENAI_API_KEY environment variable.\n" +
          "  export OPENAI_API_KEY=sk-...",
        );
      }
      return new OpenAIEmbedder(apiKey, "text-embedding-3-large");
    }
  }
}


function makeBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}


/**
 * Persist the selected embedding provider to the workspace config.json so it
 * is loaded automatically on orchestrator startup without requiring env vars.
 *
 * Reads the existing config.json (written by `sidjua init`), merges the
 * embedding section, and writes it back atomically.
 *
 * @param workDir  - Workspace root directory.
 * @param provider - Selected embedding provider key.
 */
async function persistEmbeddingProvider(workDir: string, provider: string): Promise<void> {
  const configPath = join(workDir, ".system", "config.json");
  try {
    const raw    = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    config["embedding"] = { provider, updated_at: new Date().toISOString() };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    logger.info(
      "embedding_provider_persisted",
      `Embedding provider '${provider}' saved to config.json`,
      { metadata: { provider, config_path: configPath } },
    );
  } catch (err) {
    // Non-fatal — workspace may not have been initialized with sidjua init
    logger.warn(
      "embedding_provider_persist_failed",
      `Could not persist embedding provider to ${configPath}: ${String(err)}`,
      { metadata: { provider, config_path: configPath } },
    );
  }
}
