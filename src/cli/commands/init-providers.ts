// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — init provider configuration and interactive setup
 *
 * Extracted from init.ts: interactive config collection, provider key
 * storage, and init summary output.
 */

import { writeFile, readFile }         from "node:fs/promises";
import { existsSync }                 from "node:fs";
import { join, basename }             from "node:path";
import { openDatabase }               from "../../utils/db.js";
import { runMigrations105 }           from "../../agent-lifecycle/migration.js";
import { SqliteSecretsProvider }      from "../../apply/secrets.js";
import { askText, askChoice, askSecret } from "../utils/interactive-prompt.js";
import { setLocale, getAvailableLocales, getLocaleInfo } from "../../i18n/index.js";
// Use import type to avoid circular import at runtime
import type { InitCommandOptions }    from "./init.js";


export interface InitConfig {
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


export interface ProviderMeta {
  name:   string;
  model:  string;
  envVar: string;
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
  groq:      { name: "Groq",          model: "llama-3.3-70b-versatile",              envVar: "GROQ_API_KEY" },
  google:    { name: "Google",        model: "gemini-2.0-flash",                      envVar: "GOOGLE_API_KEY" },
  openai:    { name: "OpenAI",        model: "gpt-4.1-mini",                          envVar: "OPENAI_API_KEY" },
  anthropic: { name: "Anthropic",     model: "claude-sonnet-4-6",                    envVar: "ANTHROPIC_API_KEY" },
};


export async function collectInitConfig(
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


export async function writeInitConfig(cfg: InitConfig, workDir: string): Promise<void> {
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


export function printInitSummary(cfg: InitConfig): void {
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
