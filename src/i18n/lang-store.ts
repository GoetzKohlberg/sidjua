// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Language Store
 *
 * Manages the list of "installed" languages for a workspace.
 * Persisted in workspace_config under the key `installed_languages` as a JSON array.
 *
 * Default: always includes 'en' plus the active locale from workspace_config.
 */

import type { Database } from "../utils/db.js";
import { getAvailableLocales } from "./loader.js";

const CONFIG_KEY = "installed_languages";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the persisted installed-languages list, or null if not yet set. */
function readInstalledRaw(db: Database): string[] | null {
  try {
    const row = db.prepare<[string], { value: string }>(
      "SELECT value FROM workspace_config WHERE key = ?",
    ).get(CONFIG_KEY) as { value: string } | undefined;

    if (row === undefined) return null;

    const parsed: unknown = JSON.parse(row.value);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed as string[];
    }
    return ["en"];
  } catch (_err) {
    return ["en"];
  }
}

function getActiveLocale(db: Database): string {
  try {
    const row = db.prepare<[], { value: string }>(
      "SELECT value FROM workspace_config WHERE key = 'locale'",
    ).get() as { value: string } | undefined;
    return row?.value ?? "en";
  } catch (_err) {
    return "en";
  }
}

function writeInstalled(db: Database, codes: string[]): void {
  // Ensure 'en' is always present
  const deduped = [...new Set(["en", ...codes])];
  db.prepare<[string, string]>(
    "INSERT OR REPLACE INTO workspace_config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  ).run(CONFIG_KEY, JSON.stringify(deduped));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get list of installed language codes for this workspace.
 * Always includes 'en'. Initializes from active locale if not yet persisted.
 */
export function getInstalledLanguages(db: Database): string[] {
  const raw = readInstalledRaw(db);

  if (raw === null) {
    // Key not present — initialize from active locale
    const active  = getActiveLocale(db);
    const initial = active !== "en" ? ["en", active] : ["en"];
    writeInstalled(db, initial);
    return initial;
  }

  return [...new Set(["en", ...raw])];
}

/**
 * Install a language (mark it as available in this workspace).
 * Returns true if newly added, false if already installed.
 * Throws if the code is not a known locale.
 */
export function installLanguage(db: Database, code: string): boolean {
  const available = getAvailableLocales();
  if (!available.includes(code)) {
    throw new Error(`Unknown language code: ${code}`);
  }

  const current = getInstalledLanguages(db);
  if (current.includes(code)) return false;

  writeInstalled(db, [...current, code]);
  return true;
}

/**
 * Remove a language from the workspace.
 * Returns true if removed, false if not installed.
 * Throws if attempting to remove 'en' or the active locale.
 */
export function removeLanguage(db: Database, code: string): boolean {
  if (code === "en") {
    throw new Error("Cannot remove English — it is always required");
  }

  const active = getActiveLocale(db);
  if (code === active) {
    throw new Error(`Cannot remove ${code} — it is the active language`);
  }

  const current = getInstalledLanguages(db);
  if (!current.includes(code)) return false;

  writeInstalled(db, current.filter((c) => c !== code));
  return true;
}
