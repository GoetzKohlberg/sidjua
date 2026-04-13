// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * translate-locales — LLM-backed mass translation script.
 *
 * Propagates keys from en.json into every other production locale using an
 * OpenAI-compatible LLM provider (default: xAI grok-4-1-fast).
 *
 * Usage:
 *   tsx scripts/translate-locales.ts [options]
 *
 * Options:
 *   --dry-run            Report plan, call no APIs, write no files
 *   --locale <code>      Translate only this target locale
 *   --only-new           Translate only keys added in the last en.json commit
 *   --provider <id>      Override I18N_TRANSLATE_PROVIDER (xai | deepseek)
 *   --model <name>       Override the provider default model
 *   --yes                Skip interactive cost confirmation
 *   --ci                 Non-interactive, fail-closed; requires clean repo
 *
 * Environment (auto-loaded from $HOME/.sidjua-env if not in process env):
 *   I18N_TRANSLATE_PROVIDER   Default: xai
 *   XAI_API_KEY               Required for provider=xai
 *   DEEPSEEK_API_KEY          Required for provider=deepseek
 *
 * Exit codes:
 *   0 = full success
 *   1 = partial success (some locales skipped)
 *   2 = preflight / arg / auth failure
 *   3 = DE-JSON-SAFETY-CHECK failure
 *   4 = _meta integrity failure
 */

import {
  readFileSync, readdirSync, existsSync,
  openSync, writeSync, fsyncSync, closeSync, renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync }      from "node:child_process";
import * as readline     from "node:readline";

import {
  callProvider,
  PROVIDERS,
  PRICING,
  type ChatMessage,
  type ProviderCallConfig,
  type TranslationCallResult,
} from "./lib/translate-provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");
const LOCALES   = join(ROOT, "src", "locales");
const ENV_FILE  = join(process.env["HOME"] ?? "/root", ".sidjua-env");

// ---------------------------------------------------------------------------
// Language names for _meta correction of stub locales
// ---------------------------------------------------------------------------

const LANGUAGE_NAMES: Record<string, string> = {
  ar:      "Arabic",
  bg:      "Bulgarian",
  bn:      "Bengali",
  cs:      "Czech",
  da:      "Danish",
  de:      "Deutsch",
  el:      "Greek",
  es:      "Spanish",
  et:      "Estonian",
  fi:      "Finnish",
  fil:     "Filipino",
  fr:      "French",
  ga:      "Irish",
  ha:      "Hausa",
  hi:      "Hindi",
  hr:      "Croatian",
  hu:      "Hungarian",
  id:      "Indonesian",
  it:      "Italian",
  ja:      "Japanese",
  ko:      "Korean",
  mr:      "Marathi",
  ms:      "Malay",
  nl:      "Dutch",
  no:      "Norwegian",
  pcm:     "Nigerian Pidgin",
  pl:      "Polish",
  "pt-BR": "Portuguese (Brazil)",
  ro:      "Romanian",
  ru:      "Russian",
  sk:      "Slovak",
  sl:      "Slovenian",
  sv:      "Swedish",
  sw:      "Swahili",
  ta:      "Tamil",
  te:      "Telugu",
  th:      "Thai",
  tr:      "Turkish",
  uk:      "Ukrainian",
  ur:      "Urdu",
  vi:      "Vietnamese",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
};

// ---------------------------------------------------------------------------
// Types (exported for tests)
// ---------------------------------------------------------------------------

export type LocaleData = Record<string, string>;

interface RunOptions {
  dryRun:       boolean;
  localeFilter: string | null;
  onlyNew:      boolean;
  provider:     string;
  model:        string | null;
  yes:          boolean;
  ci:           boolean;
}

interface LocalePlan {
  code:       string;
  langName:   string;
  needsCount: number;
  keys:       string[];
}

interface TranslationPlan {
  locales:          LocalePlan[];
  inputTokens:      number;
  outputTokens:     number;
  estimatedCostUsd: number;
}

interface RunStats {
  inputTokens: number;
  outputTokens: number;
  cost:        number;
  translated:  string[];
  skipped:     { locale: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// $HOME/.sidjua-env inline parser (~15 LOC)
// ---------------------------------------------------------------------------

export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val   = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  const dashIdx = key.indexOf("-");
  const prefix  = dashIdx !== -1 ? key.slice(0, dashIdx + 1) : key.slice(0, 4);
  return `${prefix}****${key.slice(-4)}`;
}

function resolveApiKey(keyEnvVar: string, envFileVars: Record<string, string>): string | null {
  return process.env[keyEnvVar] ?? envFileVars[keyEnvVar] ?? null;
}

// ---------------------------------------------------------------------------
// JSON utilities
// ---------------------------------------------------------------------------

function loadJsonOrNull(path: string): LocaleData | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LocaleData;
  } catch (err) {
    process.stderr.write(`ERROR: ${path} is not valid JSON: ${String(err)}\n`);
    return null;
  }
}

function nonMetaKeys(data: LocaleData): string[] {
  return Object.keys(data).filter((k) => !k.startsWith("_meta"));
}

function extractPlaceholders(value: string): string[] {
  const m = value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g);
  return m ? [...new Set(m)].sort() : [];
}

export const STUB_RE = /^\[[A-Z0-9-]+\] /;

// ---------------------------------------------------------------------------
// Atomic write: temp file + fsync + rename
// ---------------------------------------------------------------------------

export function atomicWrite(destPath: string, content: string): void {
  const tmpPath = `${destPath}.tmp`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, destPath);
}

// ---------------------------------------------------------------------------
// Git utilities
// ---------------------------------------------------------------------------

function isLocaleDirty(): boolean {
  try {
    const out = execSync("git status --porcelain src/locales/", { cwd: ROOT, encoding: "utf-8" });
    return out.trim().length > 0;
  } catch (err) {
    process.stderr.write(`WARN: Could not check git status: ${String(err)}\n`);
    return false;
  }
}

function getNewEnKeys(): Set<string> | null {
  try {
    const diff = execSync("git diff HEAD~1 HEAD -- src/locales/en.json", {
      cwd: ROOT, encoding: "utf-8",
    });
    const added = new Set<string>();
    for (const line of diff.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const m = line.match(/^\+\s*"([^"]+)"\s*:/);
      if (m?.[1] && !m[1].startsWith("_meta")) added.add(m[1]);
    }
    return added;
  } catch (err) {
    process.stderr.write(`WARN: Could not determine new en.json keys from git: ${String(err)}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase A helpers
// ---------------------------------------------------------------------------

function deJsonSafetyCheck(): boolean {
  const dePath = join(LOCALES, "de.json");
  const data   = loadJsonOrNull(dePath);
  if (!data) return false;
  const lang = data["_meta.language"];
  if (typeof lang !== "string" || !lang.includes("Deutsch")) {
    process.stderr.write(
      `FATAL: de.json _meta.language="${String(lang)}" does not contain "Deutsch". ` +
      `File may have been corrupted or regenerated from stubs.\n`
    );
    return false;
  }
  return true;
}

function checkMetaIntegrity(localeFiles: string[]): boolean {
  let ok = true;
  for (const file of localeFiles) {
    const data = loadJsonOrNull(join(LOCALES, file));
    if (!data) { ok = false; continue; }
    const lang = data["_meta.language"];
    const loc  = data["_meta.locale"];
    if (typeof lang !== "string" || lang.trim() === "") {
      process.stderr.write(`FATAL: ${file} _meta.language is absent or empty.\n`);
      ok = false;
    }
    if (typeof loc !== "string" || loc.trim() === "") {
      process.stderr.write(`FATAL: ${file} _meta.locale is absent or empty.\n`);
      ok = false;
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Phase B — Compute keys needing translation
// ---------------------------------------------------------------------------

export function computeNeedsTranslation(
  enKeys:      string[],
  localeData:  LocaleData,
  onlyNewKeys: Set<string> | null,
): string[] {
  const needs: string[] = [];
  for (const key of enKeys) {
    const val      = localeData[key];
    const missing  = val === undefined;
    const empty    = typeof val === "string" && val.trim() === "";
    const isStub   = typeof val === "string" && STUB_RE.test(val);
    if (missing || empty || isStub) {
      if (onlyNewKeys === null || onlyNewKeys.has(key)) {
        needs.push(key);
      }
    }
  }
  return needs;
}

/** Fix _meta fields that are stubs in newly-seeded locales. Never calls LLM for meta. */
export function computeMetaFixes(locale: string, localeData: LocaleData): Record<string, string> {
  const fixes: Record<string, string> = {};
  const lang = localeData["_meta.language"];
  const loc  = localeData["_meta.locale"];
  const ver  = localeData["_meta.version"];
  if (typeof lang === "string" && STUB_RE.test(lang)) {
    const proper = LANGUAGE_NAMES[locale];
    if (proper) fixes["_meta.language"] = proper;
  }
  if (typeof loc === "string" && STUB_RE.test(loc)) {
    fixes["_meta.locale"] = locale;
  }
  if (typeof ver === "string" && STUB_RE.test(ver)) {
    fixes["_meta.version"] = "1.0";
  }
  return fixes;
}

// ---------------------------------------------------------------------------
// Phase C — Build plan + cost estimate
// ---------------------------------------------------------------------------

function buildPlan(
  localeFiles: string[],
  enData:      LocaleData,
  enKeys:      string[],
  opts:        RunOptions,
  onlyNewKeys: Set<string> | null,
): TranslationPlan {
  const pricing = PRICING[opts.provider] ?? PRICING["xai"]!;
  const plan: TranslationPlan = { locales: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

  for (const file of localeFiles) {
    const code = file.replace(".json", "");
    if (opts.localeFilter && code !== opts.localeFilter) continue;
    const data = loadJsonOrNull(join(LOCALES, file));
    if (!data) continue;
    const keys = computeNeedsTranslation(enKeys, data, onlyNewKeys);
    if (keys.length === 0) continue;
    const langName = LANGUAGE_NAMES[code] ?? (data["_meta.language"] as string) ?? code;
    // Token estimate: system prompt + JSON key/value pairs
    const inputChars  = 800 + keys.reduce((s, k) => s + (k.length) + (enData[k]?.length ?? 0) + 8, 0);
    const outputChars = keys.reduce((s, k) => s + k.length + (enData[k]?.length ?? 0) * 1.3 + 8, 0);
    const inputTok    = Math.ceil(inputChars / 4);
    const outputTok   = Math.ceil(outputChars / 4);
    plan.locales.push({ code, langName, needsCount: keys.length, keys });
    plan.inputTokens  += inputTok;
    plan.outputTokens += outputTok;
  }

  plan.estimatedCostUsd =
    (plan.inputTokens  / 1_000_000) * pricing.inputPerM +
    (plan.outputTokens / 1_000_000) * pricing.outputPerM;

  return plan;
}

function printPlan(plan: TranslationPlan, providerName: string, modelName: string): void {
  const totalKeys = plan.locales.reduce((s, l) => s + l.needsCount, 0);
  process.stdout.write(`\nTranslation plan:\n`);
  process.stdout.write(`  Provider:              ${providerName} (${modelName}, 2M context)\n`);
  process.stdout.write(`  Locales needing work:  ${plan.locales.length}\n`);
  process.stdout.write(`  Total keys to translate: ~${totalKeys}\n`);
  process.stdout.write(`  Estimated input tokens:  ~${plan.inputTokens.toLocaleString()}\n`);
  process.stdout.write(`  Estimated output tokens: ~${plan.outputTokens.toLocaleString()}\n`);
  process.stdout.write(`  Estimated cost:          $${plan.estimatedCostUsd.toFixed(3)} USD\n\n`);
}

// ---------------------------------------------------------------------------
// Phase D — Translation helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(langName: string, code: string): string {
  return (
    `You are translating UI strings for the SIDJUA agent governance platform ` +
    `from English into ${langName} (${code}).\n` +
    `Rules:\n` +
    `1. Return a JSON object mapping each input key to its translation. No commentary, no explanation, no markdown fences.\n` +
    `2. Preserve every placeholder token like {name}, {count}, {code} verbatim. Do not translate anything inside curly braces.\n` +
    `3. Preserve leading/trailing whitespace exactly as it appears in the source.\n` +
    `4. Use natural, native-level ${langName}. Not machine-translation register. The audience is a business user of an AI governance tool.\n` +
    `5. Do not add [XX] prefixes or any other markers. Return only the translation.\n` +
    `6. If a source string is already in ${langName} (e.g. a brand name, a technical code), return it unchanged.\n` +
    `7. Never return English unless the source is a proper noun that should stay in English (e.g. "OpenAI", "SIDJUA").`
  );
}

export function parseJsonResponse(content: string, locale: string): Record<string, string> | null {
  // Direct parse
  try {
    const parsed = JSON.parse(content);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch (_) { /* fall through */ }

  // Extract from possible markdown fences or surrounding text
  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch (err) {
      process.stderr.write(`  [${locale}] JSON extraction failed: ${String(err)}\n`);
    }
  }
  return null;
}

export interface ValidationResult {
  ok:         boolean;
  reason:     string;
  failedKeys: string[];
}

export function validateTranslations(
  keys:         string[],
  enData:       LocaleData,
  translations: Record<string, string>,
  locale:       string,
): ValidationResult {
  const failedKeys: string[] = [];
  const reasons:    string[] = [];

  for (const key of keys) {
    const translated = translations[key];
    if (translated === undefined || translated.trim() === "") {
      reasons.push(`${key}: empty or missing`);
      failedKeys.push(key);
      continue;
    }
    if (STUB_RE.test(translated)) {
      reasons.push(`${key}: stub value in response`);
      failedKeys.push(key);
      continue;
    }
    const expected = extractPlaceholders(enData[key] ?? "");
    const got      = extractPlaceholders(translated);
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      reasons.push(`${key}: placeholder mismatch expected=[${expected.join(",")}] got=[${got.join(",")}]`);
      failedKeys.push(key);
    }
  }

  if (failedKeys.length === 0) return { ok: true, reason: "", failedKeys: [] };
  return { ok: false, reason: reasons.slice(0, 3).join("; "), failedKeys };
}

// ---------------------------------------------------------------------------
// Phase D — Single-locale translation
// ---------------------------------------------------------------------------

async function translateLocale(
  locale:       string,
  langName:     string,
  keys:         string[],
  enData:       LocaleData,
  localeData:   LocaleData,
  metaFixes:    Record<string, string>,
  apiKey:       string,
  providerName: string,
  modelOverride: string | null,
  dryRun:       boolean,
): Promise<{ inputTokens: number; outputTokens: number } | null> {
  if (dryRun) {
    process.stdout.write(`  [dry-run] ${locale}: would translate ${keys.length} keys\n`);
    return { inputTokens: 0, outputTokens: 0 };
  }

  const providerConf = PROVIDERS[providerName];
  if (!providerConf) {
    process.stderr.write(`  [${locale}] ERROR: Unknown provider "${providerName}"\n`);
    return null;
  }
  const callConf: ProviderCallConfig = { ...providerConf, model: modelOverride ?? providerConf.model };

  const sourceObj: Record<string, string> = {};
  for (const k of keys) sourceObj[k] = enData[k] ?? "";

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(langName, locale) },
    { role: "user",   content: `Translate the following into ${langName}:\n${JSON.stringify(sourceObj, null, 2)}` },
  ];

  // Attempt 1: API call
  let raw: TranslationCallResult | null = null;
  try {
    raw = await callProvider(callConf, apiKey, messages);
  } catch (err) {
    process.stderr.write(`  [${locale}] API call attempt 1 failed: ${String(err)}\n`);
    // Attempt 2: retry with explicit JSON instruction
    messages.push({
      role:    "user",
      content: "Your previous request failed. Respond with ONLY valid JSON mapping keys to translated strings. No prose, no markdown.",
    });
    try {
      raw = await callProvider(callConf, apiKey, messages);
    } catch (err2) {
      process.stderr.write(`  [${locale}] API call attempt 2 failed: ${String(err2)}\n`);
      process.stderr.write(`  [${locale}] SKIP: Both API attempts failed.\n`);
      return null;
    }
  }

  // Parse JSON
  let translations = parseJsonResponse(raw.content, locale);
  if (!translations) {
    messages.push(
      { role: "assistant", content: raw.content },
      { role: "user", content: "Invalid JSON. Respond with ONLY a valid JSON object — no prose, no markdown fences, no commentary." },
    );
    try {
      const retry = await callProvider(callConf, apiKey, messages);
      raw.inputTokens  += retry.inputTokens;
      raw.outputTokens += retry.outputTokens;
      translations      = parseJsonResponse(retry.content, locale);
    } catch (err) {
      process.stderr.write(`  [${locale}] JSON-retry API call failed: ${String(err)}\n`);
    }
    if (!translations) {
      process.stderr.write(`  [${locale}] SKIP: Could not parse JSON response after retry.\n`);
      return null;
    }
  }

  // Validate
  let validation = validateTranslations(keys, enData, translations, locale);
  if (!validation.ok && validation.failedKeys.length > 0) {
    const retrySource: Record<string, string> = {};
    for (const k of validation.failedKeys) retrySource[k] = enData[k] ?? "";
    messages.push({
      role: "user",
      content:
        `These ${validation.failedKeys.length} keys had issues (missing placeholders, stubs, or empty values). ` +
        `Re-translate ONLY these keys, preserve all {placeholder} tokens exactly, return valid JSON:\n` +
        JSON.stringify(retrySource, null, 2),
    });
    try {
      const retry = await callProvider(callConf, apiKey, messages);
      raw.inputTokens  += retry.inputTokens;
      raw.outputTokens += retry.outputTokens;
      const retryResult = parseJsonResponse(retry.content, locale);
      if (retryResult) {
        for (const k of validation.failedKeys) {
          if (retryResult[k]) translations[k] = retryResult[k]!;
        }
        validation = validateTranslations(keys, enData, translations, locale);
      }
    } catch (err) {
      process.stderr.write(`  [${locale}] Validation-retry API call failed: ${String(err)}\n`);
    }
    if (!validation.ok) {
      process.stderr.write(`  [${locale}] SKIP: Validation failed after retry: ${validation.reason}\n`);
      return null;
    }
  }

  // English-leak check on a 10% sample
  const sampleSize = Math.max(1, Math.floor(keys.length * 0.1));
  const sample     = keys.slice(0, sampleSize);
  const identical  = sample.filter((k) => translations![k] === enData[k]).length;
  // pcm (Nigerian Pidgin) legitimately shares a large vocabulary with English;
  // high lexical overlap is expected and is not an indication of a failed translation.
  const englishLeakExempt = new Set(["pcm"]);
  if (identical / sampleSize > 0.20 && locale !== "en" && !englishLeakExempt.has(locale)) {
    process.stderr.write(
      `  [${locale}] SKIP: English-leak check — ${identical}/${sampleSize} sample translations identical to source.\n`
    );
    return null;
  }

  // DE-JSON-SAFETY-CHECK before writing de.json
  if (locale === "de" && !deJsonSafetyCheck()) {
    process.stderr.write(`  [${locale}] SKIP: DE-JSON-SAFETY-CHECK failed before write.\n`);
    return null;
  }

  // Merge validated translations + meta fixes into locale data
  const merged: LocaleData = { ...localeData };
  for (const [k, v] of Object.entries(metaFixes)) merged[k] = v;
  for (const k of keys) {
    const t = translations[k];
    if (t !== undefined && t !== "") merged[k] = t;
  }

  // Atomic write
  atomicWrite(join(LOCALES, `${locale}.json`), JSON.stringify(merged, null, 2) + "\n");

  process.stdout.write(
    `  [${locale}] OK — translated ${keys.length} keys ` +
    `(${raw.inputTokens.toLocaleString()}/${raw.outputTokens.toLocaleString()} tokens)\n`
  );
  return { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens };
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const opts: RunOptions = {
    dryRun:       args.includes("--dry-run"),
    localeFilter: args.includes("--locale") ? (args[args.indexOf("--locale") + 1] ?? null) : null,
    onlyNew:      args.includes("--only-new"),
    provider:     args.includes("--provider") ? (args[args.indexOf("--provider") + 1] ?? "xai") : "xai",
    model:        args.includes("--model") ? (args[args.indexOf("--model") + 1] ?? null) : null,
    yes:          args.includes("--yes"),
    ci:           args.includes("--ci"),
  };

  // Load .sidjua-env and apply provider override from env
  const envFileVars   = parseEnvFile(ENV_FILE);
  const providerEnv   = process.env["I18N_TRANSLATE_PROVIDER"] ?? envFileVars["I18N_TRANSLATE_PROVIDER"];
  if (providerEnv && !args.includes("--provider")) opts.provider = providerEnv;

  const providerConf = PROVIDERS[opts.provider];
  if (!providerConf) {
    process.stderr.write(`ERROR: Unknown provider "${opts.provider}". Available: ${Object.keys(PROVIDERS).join(", ")}\n`);
    process.exit(2);
  }

  const modelName = opts.model ?? providerConf.model;

  // Resolve API key (skip for dry-run)
  let apiKey = "dry-run-no-key";
  if (!opts.dryRun) {
    const key = resolveApiKey(providerConf.keyEnvVar, envFileVars);
    if (!key) {
      process.stderr.write(
        `ERROR: ${providerConf.keyEnvVar} is not set. ` +
        `Set it in process env or in ${ENV_FILE}\n`
      );
      process.exit(2);
    }
    apiKey = key;
    process.stdout.write(`Provider: ${opts.provider} (model: ${modelName}, key: ${maskKey(apiKey)})\n`);
  }

  // Phase A — DE-JSON-SAFETY-CHECK
  if (!opts.dryRun) {
    if (!deJsonSafetyCheck()) {
      process.stderr.write("FATAL: DE-JSON-SAFETY-CHECK failed.\n");
      process.exit(3);
    }
  }

  // Check dirty state
  if (!opts.dryRun && isLocaleDirty()) {
    if (opts.ci) {
      process.stderr.write("ERROR: src/locales/ has uncommitted changes. CI requires clean state.\n");
      process.exit(2);
    }
    process.stdout.write("WARN: src/locales/ has uncommitted changes — continuing (non-CI mode).\n");
  }

  // Load en.json
  const enData = loadJsonOrNull(join(LOCALES, "en.json"));
  if (!enData) { process.stderr.write("FATAL: Could not load src/locales/en.json\n"); process.exit(2); }
  const enKeys = nonMetaKeys(enData);

  // Enumerate locale files
  const localeFiles = readdirSync(LOCALES)
    .filter((f) => f.endsWith(".json") && !f.startsWith(".") && f !== "en.json" && f !== "_template.json")
    .sort();

  // Phase A — _meta integrity
  if (!checkMetaIntegrity(localeFiles)) {
    process.stderr.write("FATAL: _meta integrity check failed.\n");
    process.exit(4);
  }

  // --only-new
  let onlyNewKeys: Set<string> | null = null;
  if (opts.onlyNew) {
    onlyNewKeys = getNewEnKeys();
    if (onlyNewKeys !== null) {
      process.stdout.write(`--only-new: ${onlyNewKeys.size} new/modified keys in last en.json commit.\n`);
    }
  }

  // Phase B + C — Build plan
  const plan = buildPlan(localeFiles, enData, enKeys, opts, onlyNewKeys);

  if (plan.locales.length === 0) {
    process.stdout.write("Nothing to do — all locales are complete.\n");
    process.exit(0);
  }

  printPlan(plan, opts.provider, modelName);

  if (plan.estimatedCostUsd > 2.00) {
    process.stderr.write(
      `STOP: Estimated cost $${plan.estimatedCostUsd.toFixed(3)} exceeds $2.00 ceiling. CEO override required.\n`
    );
    process.exit(2);
  }

  if (!opts.yes && !opts.ci && !opts.dryRun) {
    const answer = await prompt("Continue? [y/N] ");
    if (answer.toLowerCase() !== "y") {
      process.stdout.write("Aborted.\n");
      process.exit(0);
    }
  }

  // Phase D — Translate each locale sequentially
  const stats: RunStats = { inputTokens: 0, outputTokens: 0, cost: 0, translated: [], skipped: [] };

  for (const entry of plan.locales) {
    const { code, langName, keys } = entry;
    process.stdout.write(`\n[${code}] ${langName} — ${keys.length} keys...\n`);

    const localeData = loadJsonOrNull(join(LOCALES, `${code}.json`));
    if (!localeData) {
      stats.skipped.push({ locale: code, reason: "Could not load locale file" });
      continue;
    }

    const metaFixes = computeMetaFixes(code, localeData);
    const result    = await translateLocale(
      code, langName, keys, enData, localeData, metaFixes,
      apiKey, opts.provider, opts.model, opts.dryRun,
    );

    if (result === null) {
      stats.skipped.push({ locale: code, reason: "Translation failed (see log)" });
    } else {
      stats.inputTokens  += result.inputTokens;
      stats.outputTokens += result.outputTokens;
      stats.translated.push(code);
    }
  }

  // Actual cost
  const pricing = PRICING[opts.provider] ?? PRICING["xai"]!;
  stats.cost =
    (stats.inputTokens  / 1_000_000) * pricing.inputPerM +
    (stats.outputTokens / 1_000_000) * pricing.outputPerM;

  // Phase E — Summary
  process.stdout.write(`\n${"=".repeat(64)}\n`);
  process.stdout.write(`Translated:  ${stats.translated.length} locale(s) — ${stats.translated.join(", ")}\n`);
  if (stats.skipped.length > 0) {
    process.stdout.write(`Skipped:     ${stats.skipped.length}\n`);
    for (const s of stats.skipped) process.stdout.write(`  - ${s.locale}: ${s.reason}\n`);
  }
  if (!opts.dryRun) {
    process.stdout.write(
      `Tokens used: ${stats.inputTokens.toLocaleString()} input / ${stats.outputTokens.toLocaleString()} output\n`
    );
    process.stdout.write(`Actual cost: $${stats.cost.toFixed(4)} USD\n`);
  }
  process.stdout.write("=".repeat(64) + "\n");

  process.exit(stats.skipped.length > 0 ? 1 : 0);
}

// Guard: only run main() when executed as the entry point, not when imported by tests.
const _moduleUrl = fileURLToPath(import.meta.url);
if (process.argv[1] && (_moduleUrl === process.argv[1] || _moduleUrl.endsWith(process.argv[1]))) {
  main().catch((err: unknown) => {
    process.stderr.write(`FATAL: ${String(err)}\n`);
    process.exit(2);
  });
}
