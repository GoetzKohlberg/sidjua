// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

/**
 * scripts/sync-locales.ts
 *
 * Detect and fill missing keys across all locale files in src/locales/.
 *
 * For each non-English locale file, keys present in en.json but absent in the
 * locale file are added with a `[XX]` placeholder prefix so translators can
 * easily find untranslated strings.
 *
 * Usage:
 *   npx tsx scripts/sync-locales.ts          # fill missing keys
 *   npx tsx scripts/sync-locales.ts --dry    # report only, no writes
 *
 * After running:
 *   cp src/locales/*.json locales/           # copy to build-output directory
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname }                             from "node:path";
import { fileURLToPath }                             from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");
const LOCALES   = join(ROOT, "src", "locales");

// ---------------------------------------------------------------------------
// Locale tag mapping: locale code → [XX] prefix tag
// ---------------------------------------------------------------------------

const LOCALE_TAGS: Record<string, string> = {
  ar:      "AR",
  bn:      "BN",
  bg:      "BG",
  cs:      "CS",
  da:      "DA",
  de:      "DE",
  el:      "EL",
  es:      "ES",
  et:      "ET",
  fi:      "FI",
  fil:     "FIL",
  fr:      "FR",
  ga:      "GA",
  ha:      "HA",
  hi:      "HI",
  hr:      "HR",
  hu:      "HU",
  id:      "ID",
  it:      "IT",
  ja:      "JA",
  ko:      "KO",
  mr:      "MR",
  ms:      "MS",
  nl:      "NL",
  no:      "NO",
  pcm:     "PCM",
  pl:      "PL",
  "pt-BR": "PT-BR",
  ro:      "RO",
  ru:      "RU",
  sk:      "SK",
  sl:      "SL",
  sv:      "SV",
  sw:      "SW",
  ta:      "TA",
  te:      "TE",
  th:      "TH",
  tr:      "TR",
  uk:      "UK",
  ur:      "UR",
  vi:      "VI",
  "zh-CN": "ZH-CN",
  "zh-TW": "ZH-TW",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LocaleData = Record<string, string>;

function loadJson(path: string): LocaleData {
  try {
    const raw    = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LocaleData;
    }
  } catch (_e) {
    // fall through
  }
  return {};
}

function writeJson(path: string, data: LocaleData): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function nonMetaKeys(data: LocaleData): string[] {
  return Object.keys(data).filter((k) => !k.startsWith("_meta"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const isDry = process.argv.includes("--dry");

  const enPath = join(LOCALES, "en.json");
  const en     = loadJson(enPath);
  const enKeys = nonMetaKeys(en);

  const files = readdirSync(LOCALES);
  const localeFiles = files
    .filter((f) => f.endsWith(".json") && f !== "en.json" && f !== "_template.json")
    .sort();

  let totalAdded = 0;
  let totalFiles = 0;

  for (const file of localeFiles) {
    const locale     = file.replace(".json", "");
    const localePath = join(LOCALES, file);
    const data       = loadJson(localePath);
    const tag        = LOCALE_TAGS[locale] ?? locale.toUpperCase();

    const missing = enKeys.filter((k) => !(k in data));
    if (missing.length === 0) {
      process.stdout.write(`${locale}: OK (no missing keys)\n`);
      continue;
    }

    process.stdout.write(`${locale}: ${missing.length} missing key(s)${isDry ? " (dry-run, not written)" : ""}\n`);
    if (isDry) {
      missing.slice(0, 5).forEach((k) => process.stdout.write(`  + ${k}: [${tag}] ${en[k]}\n`));
      if (missing.length > 5) process.stdout.write(`  ... and ${missing.length - 5} more\n`);
      continue;
    }

    for (const k of missing) {
      data[k] = `[${tag}] ${en[k]}`;
    }
    writeJson(localePath, data);
    totalAdded += missing.length;
    totalFiles++;
  }

  if (!isDry) {
    process.stdout.write(`\nDone: added ${totalAdded} key(s) across ${totalFiles} file(s)\n`);
    process.stdout.write(`Run: npm run i18n:sync   (or: mkdir -p dist/locales && cp src/locales/*.json dist/locales/)\n`);
  }
}

main();
