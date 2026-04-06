// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — OpenClaw Credential Migrator
 *
 * Extracts API keys from an OpenClaw config and stores them in
 * {workDir}/.sidjua-imported.env (dotenv format) for SIDJUA's
 * ProviderKeyManager to discover.
 *
 * SECURITY: Credentials are NEVER logged or printed in plaintext.
 * CLI output masks values as  sk-ant-****, ghp-****, etc. // pipeline-ok
 */

import { writeFile, readFile } from "node:fs/promises";
import { existsSync }          from "node:fs";
import { join }                from "node:path";
import type { OpenClawConfig, ExtractedCredential } from "./openclaw-types.js";


/** Maps environment variable names (as seen in OpenClaw env) to SIDJUA provider IDs. */
export const ENV_TO_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY:      "anthropic",
  OPENAI_API_KEY:         "openai",
  GROQ_API_KEY:           "groq",
  OPENROUTER_API_KEY:     "openrouter",
  GOOGLE_API_KEY:         "google",
  GOOGLE_GENERATIVE_AI_API_KEY: "google",
  MISTRAL_API_KEY:        "mistral",
  DEEPSEEK_API_KEY:       "deepseek",
  XAI_API_KEY:            "xai",
  GROK_API_KEY:           "xai",
  COHERE_API_KEY:         "cohere",
  TOGETHER_API_KEY:       "together",
  FIREWORKS_API_KEY:      "fireworks",
  // Module-related secrets
  DISCORD_BOT_TOKEN:      "discord",
  SLACK_BOT_TOKEN:        "slack",
  GITHUB_TOKEN:           "github",
  TELEGRAM_BOT_TOKEN:     "telegram",
  NOTION_API_KEY:         "notion",
};


/**
 * Extract API keys from an OpenClaw config object.
 * Looks in:
 *   1. env.ANTHROPIC_API_KEY etc. (flat env vars)
 *   2. env.vars.ANTHROPIC_API_KEY (nested vars sub-object)
 *   3. auth.profiles → map by provider field
 *   4. skills.entries.*.env.* (skill-specific env vars)
 *   5. skills.entries.*.apiKey (skill-specific API key)
 *
 * Deduplicates by provider (first occurrence wins).
 */
export function extractCredentials(config: OpenClawConfig): ExtractedCredential[] {
  const seen = new Map<string, ExtractedCredential>(); // provider → credential

  function addIfNew(provider: string, value: string, source: string): void {
    if (!seen.has(provider) && value.trim()) {
      seen.set(provider, { provider, value: value.trim(), source });
    }
  }

  // 1. Flat env object  { ANTHROPIC_API_KEY: "sk-ant-..." } // pipeline-ok
  if (config.env) {
    for (const [key, val] of Object.entries(config.env)) {
      if (typeof val === "string") {
        const provider = ENV_TO_PROVIDER[key];
        if (provider) addIfNew(provider, val, `env.${key}`);
      }
      // Nested env.vars sub-object
      if (key === "vars" && typeof val === "object" && val !== null) {
        for (const [vKey, vVal] of Object.entries(val as Record<string, unknown>)) {
          if (typeof vVal === "string") {
            const provider = ENV_TO_PROVIDER[vKey];
            if (provider) addIfNew(provider, vVal, `env.vars.${vKey}`);
          }
        }
      }
    }
  }

  // 2. auth.profiles  { myProfile: { provider: "anthropic", apiKey: "..." } }
  //    Note: OpenClaw auth profiles may also embed token inside nested fields
  if (config.auth?.profiles) {
    for (const [profileName, profile] of Object.entries(config.auth.profiles)) {
      if (profile.provider) {
        // Check if there are apiKey fields in the raw profile
        const raw = profile as Record<string, unknown>;
        const key = raw["apiKey"] ?? raw["api_key"] ?? raw["token"];
        if (typeof key === "string") {
          addIfNew(profile.provider, key, `auth.profiles.${profileName}.apiKey`);
        }
      }
    }
  }

  // 3. skills.entries.*.env.*  and  skills.entries.*.apiKey
  if (config.skills?.entries) {
    for (const [skillName, entry] of Object.entries(config.skills.entries)) {
      // skill-level env vars
      if (entry.env) {
        for (const [envKey, envVal] of Object.entries(entry.env)) {
          const provider = ENV_TO_PROVIDER[envKey];
          if (provider) addIfNew(provider, envVal, `skills.entries.${skillName}.env.${envKey}`);
        }
      }
      // skill-level apiKey (associate with skill name as provider)
      if (entry.apiKey) {
        // Map skill name to provider (e.g. discord → discord)
        const provider = skillName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        addIfNew(provider, entry.apiKey, `skills.entries.${skillName}.apiKey`);
      }
    }
  }

  return [...seen.values()];
}


/**
 * Mask an API key value for safe display.
 * Shows first 4 chars and last 4 chars with **** in the middle.
 */
export function maskSecret(value: string): string {
  if (value.length <= 12) return "****";
  const prefix = value.slice(0, 4);
  const suffix = value.slice(-4);
  return `${prefix}****${suffix}`;
}


const IMPORTED_ENV_FILE = ".sidjua-imported.env";

/**
 * Write extracted credentials to {workDir}/.sidjua-imported.env.
 * Appends to existing content (avoids overwriting existing keys).
 * Returns the list of provider names successfully stored.
 */
export async function storeCredentials(
  credentials: ExtractedCredential[],
  workDir:     string,
): Promise<string[]> {
  const envPath = join(workDir, IMPORTED_ENV_FILE);

  // Read existing file
  const existing = new Map<string, string>(); // KEY → value
  if (existsSync(envPath)) {
    const content = await readFile(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        existing.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
    }
  }

  // Build provider → env var name (reverse of ENV_TO_PROVIDER)
  const providerToEnvKey = new Map<string, string>();
  for (const [envKey, provider] of Object.entries(ENV_TO_PROVIDER)) {
    if (!providerToEnvKey.has(provider)) {
      providerToEnvKey.set(provider, envKey);
    }
  }

  const stored: string[] = [];
  for (const cred of credentials) {
    const envKey = providerToEnvKey.get(cred.provider) ?? `${cred.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
    if (!existing.has(envKey)) {
      existing.set(envKey, cred.value);
      stored.push(cred.provider);
    }
  }

  // Write back
  const lines = [...existing.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  await writeFile(envPath, lines, "utf-8");
  return stored;
}


export interface MigrateResult {
  migrated: string[];
  skipped:  string[];
}

/**
 * Migrate credentials from an OpenClaw config to SIDJUA's key store.
 * If noSecrets is true, skip storage entirely and return all as skipped.
 */
export async function migrateCredentials(
  config:    OpenClawConfig,
  workDir:   string,
  noSecrets: boolean,
): Promise<MigrateResult> {
  const all = extractCredentials(config);

  if (noSecrets || all.length === 0) {
    return {
      migrated: [],
      skipped:  all.map((c) => c.provider),
    };
  }

  const migrated = await storeCredentials(all, workDir);
  const migratedSet = new Set(migrated);
  const skipped = all.filter((c) => !migratedSet.has(c.provider)).map((c) => c.provider);

  return { migrated, skipped };
}

/**
 * Return the path to the imported env file.
 */
export function importedEnvPath(workDir: string): string {
  return join(workDir, IMPORTED_ENV_FILE);
}
