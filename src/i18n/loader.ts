// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — i18n: Locale Loader
 *
 * Loads locale JSON files from src/locales/, caches them in memory,
 * and provides a fallback chain: requested locale → "en".
 *
 * No external dependencies — pure Node.js.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath }             from "node:url";
import { join }                      from "node:path";
import type { Locale }               from "./types.js";


export interface LocaleInfo {
  /** BCP-47 locale code, e.g. "en", "zh-CN". */
  code:        string;
  /** English name of the language, e.g. "Chinese (Simplified)". */
  name:        string;
  /** Language name in that language, e.g. "简体中文". */
  nativeName:  string;
  /** True for AI-generated translations; false for human-maintained (en, de). */
  aiGenerated: boolean;
}

/** Static catalog — source of truth for display names and AI flag. */
const LOCALE_CATALOG: Record<string, Omit<LocaleInfo, "code">> = {
  en:    { name: "English",               nativeName: "English",             aiGenerated: false },
  de:    { name: "German",                nativeName: "Deutsch",             aiGenerated: false },
  ar:    { name: "Arabic",                nativeName: "العربية",             aiGenerated: true  },
  bn:    { name: "Bengali",               nativeName: "বাংলা",               aiGenerated: true  },
  cs:    { name: "Czech",                 nativeName: "Čeština",             aiGenerated: true  },
  es:    { name: "Spanish",               nativeName: "Español",             aiGenerated: true  },
  fil:   { name: "Filipino",              nativeName: "Filipino",            aiGenerated: true  },
  fr:    { name: "French",                nativeName: "Français",            aiGenerated: true  },
  hi:    { name: "Hindi",                 nativeName: "हिन्दी",               aiGenerated: true  },
  id:    { name: "Indonesian",            nativeName: "Bahasa Indonesia",    aiGenerated: true  },
  it:    { name: "Italian",               nativeName: "Italiano",            aiGenerated: true  },
  ja:    { name: "Japanese",              nativeName: "日本語",               aiGenerated: true  },
  ko:    { name: "Korean",                nativeName: "한국어",               aiGenerated: true  },
  ms:    { name: "Malay",                 nativeName: "Bahasa Melayu",       aiGenerated: true  },
  nl:    { name: "Dutch",                 nativeName: "Nederlands",          aiGenerated: true  },
  pl:    { name: "Polish",                nativeName: "Polski",              aiGenerated: true  },
  "pt-BR": { name: "Portuguese (Brazil)", nativeName: "Português (Brasil)",  aiGenerated: true  },
  ro:    { name: "Romanian",              nativeName: "Română",              aiGenerated: true  },
  ru:    { name: "Russian",               nativeName: "Русский",             aiGenerated: true  },
  sv:    { name: "Swedish",               nativeName: "Svenska",             aiGenerated: true  },
  th:    { name: "Thai",                  nativeName: "ไทย",                 aiGenerated: true  },
  tr:    { name: "Turkish",               nativeName: "Türkçe",              aiGenerated: true  },
  uk:    { name: "Ukrainian",             nativeName: "Українська",          aiGenerated: true  },
  vi:    { name: "Vietnamese",            nativeName: "Tiếng Việt",          aiGenerated: true  },
  "zh-CN": { name: "Chinese (Simplified)",   nativeName: "简体中文",          aiGenerated: true  },
  "zh-TW": { name: "Chinese (Traditional)", nativeName: "繁體中文",          aiGenerated: true  },
  // World languages (P363)
  ur:    { name: "Urdu",                  nativeName: "اردو",                aiGenerated: true  },
  pcm:   { name: "Nigerian Pidgin",       nativeName: "Naijá",               aiGenerated: true  },
  mr:    { name: "Marathi",               nativeName: "मराठी",               aiGenerated: true  },
  te:    { name: "Telugu",                nativeName: "తెలుగు",              aiGenerated: true  },
  ta:    { name: "Tamil",                 nativeName: "தமிழ்",               aiGenerated: true  },
  ha:    { name: "Hausa",                 nativeName: "Hausa",               aiGenerated: true  },
  sw:    { name: "Swahili",               nativeName: "Kiswahili",           aiGenerated: true  },
  // European languages (ESCO, P363)
  bg:    { name: "Bulgarian",             nativeName: "Български",           aiGenerated: true  },
  da:    { name: "Danish",                nativeName: "Dansk",               aiGenerated: true  },
  el:    { name: "Greek",                 nativeName: "Ελληνικά",            aiGenerated: true  },
  et:    { name: "Estonian",              nativeName: "Eesti",               aiGenerated: true  },
  fi:    { name: "Finnish",               nativeName: "Suomi",               aiGenerated: true  },
  ga:    { name: "Irish",                 nativeName: "Gaeilge",             aiGenerated: true  },
  hr:    { name: "Croatian",              nativeName: "Hrvatski",            aiGenerated: true  },
  hu:    { name: "Hungarian",             nativeName: "Magyar",              aiGenerated: true  },
  no:    { name: "Norwegian",             nativeName: "Norsk",               aiGenerated: true  },
  sk:    { name: "Slovak",                nativeName: "Slovenčina",          aiGenerated: true  },
  sl:    { name: "Slovenian",             nativeName: "Slovenščina",         aiGenerated: true  },
};


/**
 * Absolute path to the locales directory.
 * When compiled to dist/i18n/loader.js, `../locales/` resolves to dist/locales/.
 * The build pipeline copies src/locales/*.json to dist/locales/.
 */
const LOCALES_DIR = fileURLToPath(new URL("../locales/", import.meta.url));


let _currentLocale: Locale = "en";

/** In-process cache: locale → flat key→value record. */
const _cache = new Map<Locale, Record<string, string>>();


/** Return the currently active locale. */
export function getLocale(): Locale {
  return _currentLocale;
}

/**
 * Set the active locale. The change is in-process only (not persisted here).
 * Call `initLocaleFromDb()` to load the persisted locale from SQLite on startup.
 */
export function setLocale(locale: Locale): void {
  _currentLocale = locale;
}

/**
 * Return all available locales by scanning the locales directory.
 * Files starting with `_` (e.g. `_template.json`) are excluded.
 */
export function getAvailableLocales(): string[] {
  try {
    return readdirSync(LOCALES_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
      .map((f)    => f.replace(".json", ""))
      .sort();
  } catch (_e) {
    return ["en"];
  }
}

/**
 * Load and return the flat key→value record for the given locale.
 * Uses the in-process cache; the first call reads from disk.
 *
 * Fallback chain: locale → "en" (merged so locale values override en values).
 * This means a partial translation file is always safe — missing keys fall
 * back to English automatically.
 */
export function loadLocaleData(locale: Locale): Record<string, string> {
  const cached = _cache.get(locale);
  if (cached !== undefined) return cached;

  // Load the "en" baseline first (always the ultimate fallback)
  let data: Record<string, string>;
  if (locale === "en") {
    data = readJsonLocale("en");
  } else {
    const enData      = loadLocaleData("en"); // recursive, cached on second call
    const localeData  = readJsonLocale(locale);
    data = { ...enData, ...localeData };      // locale values override en
  }

  _cache.set(locale, data);
  return data;
}

/** Return the locale data for the currently active locale. */
export function getCurrentLocaleData(): Record<string, string> {
  return loadLocaleData(_currentLocale);
}

/**
 * Clear the in-process locale cache.
 * Useful in tests where locale files may change between test runs.
 */
export function clearLocaleCache(): void {
  _cache.clear();
}

/**
 * Initialize the active locale from the `workspace_config` SQLite table.
 * Non-fatal: silently falls back to "en" if the table or key doesn't exist.
 *
 * Accepts any object with a `prepare()` method to avoid importing the DB type.
 */
export function initLocaleFromDb(db: {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
}): void {
  try {
    const row = db.prepare(
      "SELECT value FROM workspace_config WHERE key = 'locale'",
    ).get() as { value: string } | undefined;
    if (typeof row?.value === "string" && row.value.trim()) {
      _currentLocale = row.value.trim();
    }
  } catch (_e) {
    // workspace_config table may not exist yet — stay on current locale
  }
}

/**
 * Return display metadata for a given locale code.
 * Falls back gracefully for any code not in the catalog.
 */
export function getLocaleInfo(code: string): LocaleInfo {
  const meta = LOCALE_CATALOG[code];
  if (meta) return { code, ...meta };
  return { code, name: code, nativeName: code, aiGenerated: true };
}

/**
 * Return metadata for all available locales (auto-detected from disk).
 * Order matches `getAvailableLocales()` (alphabetical by code).
 */
export function getAllLocaleInfo(): LocaleInfo[] {
  return getAvailableLocales().map(getLocaleInfo);
}


function readJsonLocale(locale: Locale): Record<string, string> {
  try {
    const filePath = join(LOCALES_DIR, `${locale}.json`);
    const raw      = readFileSync(filePath, "utf-8");
    const parsed   = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch (_e) {
    // File not found or invalid JSON — caller handles fallback
  }
  return {};
}
