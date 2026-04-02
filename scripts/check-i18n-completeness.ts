// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * i18n completeness verification script.
 *
 * Checks:
 *   1. All keys in en.json exist in every locale file (no missing keys)
 *   2. No empty string values in any locale file
 *   3. All interpolation placeholders {name} from en.json preserved in every locale
 *   4. _template.json has same keys as en.json (ignoring _meta keys)
 *   5. All README.{locale}.md files exist for every locale in src/locales/
 *   6. All docs/i18n/{locale}/INSTALLATION.md files exist
 *   7. No orphan keys (keys in locale but not in en.json)
 *   8. Warn on [XX] placeholder values (untranslated stubs from sync-locales)
 *
 * Exit code: 0 = all green, 1 = warnings only, 2 = failures
 *
 * Release workflow: run with STRICT=1 to treat [XX] placeholders as failures.
 *   STRICT=1 npx tsx scripts/check-i18n-completeness.ts
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname }                          from "node:path";
import { fileURLToPath }                          from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");
const LOCALES   = join(ROOT, "src", "locales");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LocaleData = Record<string, string>;

interface LocaleResult {
  locale:         string;
  totalEn:        number;
  missing:        string[];
  empty:          string[];
  placeholderErr: { key: string; expected: string[]; got: string[] }[];
  orphan:         string[];
  stubs:          number;
  readmeExists:   boolean;
  installExists:  boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPlaceholders(value: string): string[] {
  const matches = value.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g);
  return matches ? [...new Set(matches)].sort() : [];
}

function loadJson(path: string): LocaleData {
  return JSON.parse(readFileSync(path, "utf-8")) as LocaleData;
}

function nonMetaKeys(data: LocaleData): string[] {
  return Object.keys(data).filter((k) => !k.startsWith("_meta"));
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const isStrict = process.env["STRICT"] === "1";
  const enPath = join(LOCALES, "en.json");
  if (!existsSync(enPath)) {
    process.stderr.write("FATAL: src/locales/en.json not found\n");
    process.exit(2);
  }
  const en      = loadJson(enPath);
  const enKeys  = nonMetaKeys(en);
  const totalEn = enKeys.length;

  // Check _template.json
  const templatePath = join(LOCALES, "_template.json");
  const templateWarnings: string[] = [];
  if (existsSync(templatePath)) {
    const template      = loadJson(templatePath);
    const templateKeys  = nonMetaKeys(template);
    const missingInTmpl = enKeys.filter((k) => !templateKeys.includes(k));
    const orphanInTmpl  = templateKeys.filter((k) => !enKeys.includes(k));
    if (missingInTmpl.length > 0) {
      templateWarnings.push(
        `_template.json missing ${missingInTmpl.length} key(s): ${missingInTmpl.slice(0, 5).join(", ")}${missingInTmpl.length > 5 ? "..." : ""}`
      );
    }
    if (orphanInTmpl.length > 0) {
      templateWarnings.push(`_template.json has ${orphanInTmpl.length} orphan key(s)`);
    }
  }

  // Discover locale files
  const files = readdirSync(LOCALES);
  const localeFiles = files.filter(
    (f) => f.endsWith(".json") && f !== "en.json" && f !== "_template.json"
  );

  const results: LocaleResult[] = [];
  let hasFailures = false;
  let hasWarnings = templateWarnings.length > 0;

  for (const file of localeFiles.sort()) {
    const locale      = file.replace(".json", "");
    const localePath  = join(LOCALES, file);

    let data: LocaleData;
    try {
      data = loadJson(localePath);
    } catch (e) {
      process.stderr.write(`FATAL: ${file} is not valid JSON: ${String(e)}\n`);
      hasFailures = true;
      continue;
    }

    const localeKeys = nonMetaKeys(data);

    const missing = enKeys.filter((k) => !localeKeys.includes(k));
    const empty   = localeKeys.filter(
      (k) => typeof data[k] === "string" && (data[k] as string).trim() === ""
    );

    const placeholderErr: LocaleResult["placeholderErr"] = [];
    for (const key of localeKeys) {
      if (!Object.prototype.hasOwnProperty.call(en, key)) continue;
      const expectedPh = extractPlaceholders(en[key] as string);
      const gotPh      = extractPlaceholders(data[key] as string);
      if (JSON.stringify(expectedPh) !== JSON.stringify(gotPh)) {
        placeholderErr.push({ key, expected: expectedPh, got: gotPh });
      }
    }

    const orphan        = localeKeys.filter((k) => !enKeys.includes(k));
    const stubs         = localeKeys.filter(
      (k) => typeof data[k] === "string" && /^\[[A-Z0-9-]+\] /.test(data[k] as string)
    ).length;
    const readmeExists  = existsSync(join(ROOT, `README.${locale}.md`));
    const installExists = existsSync(join(ROOT, "docs", "i18n", locale, "INSTALLATION.md"));

    results.push({ locale, totalEn, missing, empty, placeholderErr, orphan, stubs, readmeExists, installExists });

    if (missing.length > 0 || empty.length > 0 || placeholderErr.length > 0) hasFailures = true;
    if (stubs > 0 || orphan.length > 0 || !readmeExists || !installExists) hasWarnings = true;
  }

  // Print table
  const cols    = [10, 8, 8, 6, 7, 7, 8, 7, 8, 9];
  const headers = ["Locale", "En Keys", "Missing", "Empty", "Ph.Err", "Orphan", "Stubs", "README", "Install", "Complete%"];
  const sep     = "-".repeat(cols.reduce((a, b) => a + b + 3, 0));

  process.stdout.write("\n" + sep + "\n");
  process.stdout.write(headers.map((h, i) => pad(h, cols[i]!)).join(" | ") + "\n");
  process.stdout.write(sep + "\n");

  for (const r of results) {
    const pct = Math.round(((r.totalEn - r.missing.length) / r.totalEn) * 100);
    const row = [
      r.locale,
      String(r.totalEn),
      String(r.missing.length),
      String(r.empty.length),
      String(r.placeholderErr.length),
      String(r.orphan.length),
      String(r.stubs),
      r.readmeExists ? "yes" : "NO",
      r.installExists ? "yes" : "NO",
      `${pct}%`,
    ].map((v, i) => pad(v, cols[i]!)).join(" | ");
    process.stdout.write(row + "\n");
  }
  process.stdout.write(sep + "\n");

  // Print template warnings
  if (templateWarnings.length > 0) {
    templateWarnings.forEach((w) => process.stderr.write(`\nWARN: ${w}\n`));
  }

  // Print failure details
  for (const r of results) {
    if (r.missing.length > 0) {
      process.stderr.write(`\n[${r.locale}] Missing ${r.missing.length} key(s):\n`);
      r.missing.slice(0, 10).forEach((k) => process.stderr.write(`  - ${k}\n`));
      if (r.missing.length > 10) process.stderr.write(`  ... and ${r.missing.length - 10} more\n`);
    }
    if (r.empty.length > 0) {
      process.stdout.write(`\n[${r.locale}] ${r.empty.length} empty value(s):\n`);
      r.empty.slice(0, 5).forEach((k) => process.stdout.write(`  - ${k}\n`));
    }
    if (r.placeholderErr.length > 0) {
      process.stderr.write(`\n[${r.locale}] ${r.placeholderErr.length} placeholder mismatch(es):\n`);
      r.placeholderErr.forEach(({ key, expected, got }) => {
        process.stderr.write(`  - ${key}: expected [${expected.join(",")}], got [${got.join(",")}]\n`);
      });
    }
  }

  // Check 8: warn (or fail in strict mode) on [XX] placeholder stubs
  const stubLocales = results.filter((r) => r.stubs > 0);
  if (stubLocales.length > 0) {
    const msg = `${stubLocales.length} locale(s) contain [XX] placeholder stubs (untranslated). Run scripts/sync-locales.ts to see details.`;
    if (isStrict) {
      process.stderr.write(`\nFAIL: ${msg}\n`);
      hasFailures = true;
    } else {
      process.stdout.write(`\nWARN: ${msg}\n`);
    }
  }

  if (hasFailures) {
    process.stderr.write("\ni18n check FAILED\n");
    process.exit(2);
  }
  if (hasWarnings) {
    process.stdout.write("\ni18n check PASSED with warnings\n");
    process.exit(1);
  }
  process.stdout.write("\ni18n check PASSED -- all locales complete\n");
  process.exit(0);
}

main();
