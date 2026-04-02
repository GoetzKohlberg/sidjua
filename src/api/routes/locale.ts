// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Locale REST Routes (P191)
 *
 * GET  /api/v1/locale               — current locale + available locales + completeness
 * GET  /api/v1/locale/:locale       — full locale JSON (merged with en fallback)
 * POST /api/v1/config/locale        — set locale (persisted to workspace_config)
 */

import type { Hono } from "hono";
import type { Database } from "../../utils/db.js";
import { requireScope } from "../middleware/require-scope.js";
import {
  getLocale,
  setLocale,
  getAvailableLocales,
  loadLocaleData,
} from "../../i18n/index.js";
import {
  getInstalledLanguages,
  installLanguage,
  removeLanguage,
} from "../../i18n/lang-store.js";
import { runWorkspaceConfigMigration } from "../workspace-config-migration.js";

// ---------------------------------------------------------------------------
// Server-supported locales
//
// The server uses locale strings in CLI output and API error messages.
// Only locales with human-maintained translations are "server-supported".
// GUI clients may use any locale client-side — they download strings directly
// via GET /api/v1/locale/:locale and render everything in the browser.
// ---------------------------------------------------------------------------

/** Locales with full, human-maintained server-side translation support. */
const SERVER_SUPPORTED_LOCALES: string[] = ["en", "de"];


/**
 * Calculate translation completeness for a locale.
 * Returns a number 0.0–1.0.
 * "en" is always 1.0.
 */
function calcCompleteness(locale: string): number {
  if (locale === "en") return 1.0;
  const enData     = loadLocaleData("en");
  const locData    = loadLocaleData(locale);
  const enKeys     = Object.keys(enData).filter((k) => !k.startsWith("_"));
  if (enKeys.length === 0) return 1.0;
  const translated = enKeys.filter((k) => {
    const v = locData[k];
    return v !== undefined && v !== "";
  }).length;
  return Math.round((translated / enKeys.length) * 100) / 100;
}


export interface LocaleRouteServices {
  db?: Database | null;
}

/**
 * Register locale routes on the Hono app.
 */
export function registerLocaleRoutes(
  app:      Hono,
  services: LocaleRouteServices = {},
): void {
  const { db } = services;

  // GET /api/v1/locale — metadata: current, available, completeness per locale
  app.get("/api/v1/locale", (c) => {
    const available    = getAvailableLocales();
    const current      = db !== null && db !== undefined
      ? getCurrentLocaleFromDb(db) ?? getLocale()
      : getLocale();
    const completeness: Record<string, number> = {};
    for (const loc of available) {
      completeness[loc] = calcCompleteness(loc);
    }
    return c.json({ current, available, completeness });
  });

  // GET /api/v1/locale/installed — list installed languages + active
  // NOTE: must be registered BEFORE /api/v1/locale/:locale to avoid param capture
  app.get("/api/v1/locale/installed", requireScope("operator"), (c) => {
    if (db == null) {
      return c.json({ languages: ["en"], active: getLocale() });
    }
    const active    = getCurrentLocaleFromDb(db) ?? getLocale();
    const languages = getInstalledLanguages(db);
    return c.json({ languages, active });
  });

  // POST /api/v1/locale/install — add a language
  app.post("/api/v1/locale/install", requireScope("operator"), async (c) => {
    if (db == null) {
      return c.json({ error: { code: "LOCALE-010", message: "No database available" } }, 503);
    }
    let body: { code?: unknown };
    try {
      body = await c.req.json() as { code?: unknown };
    } catch (_e) {
      return c.json({ error: { code: "LOCALE-002", message: "Invalid JSON body" } }, 400);
    }
    const code = body.code;
    if (typeof code !== "string" || code.trim() === "") {
      return c.json({ error: { code: "LOCALE-003", message: "code must be a non-empty string" } }, 400);
    }
    try {
      const added = installLanguage(db, code);
      const languages = getInstalledLanguages(db);
      return c.json({ added, languages });
    } catch (err: unknown) {
      return c.json({ error: { code: "LOCALE-003", message: err instanceof Error ? err.message : String(err) } }, 400);
    }
  });

  // POST /api/v1/locale/uninstall — remove a language
  app.post("/api/v1/locale/uninstall", requireScope("operator"), async (c) => {
    if (db == null) {
      return c.json({ error: { code: "LOCALE-010", message: "No database available" } }, 503);
    }
    let body: { code?: unknown };
    try {
      body = await c.req.json() as { code?: unknown };
    } catch (_e) {
      return c.json({ error: { code: "LOCALE-002", message: "Invalid JSON body" } }, 400);
    }
    const code = body.code;
    if (typeof code !== "string" || code.trim() === "") {
      return c.json({ error: { code: "LOCALE-003", message: "code must be a non-empty string" } }, 400);
    }
    try {
      const removed   = removeLanguage(db, code);
      const languages = getInstalledLanguages(db);
      return c.json({ removed, languages });
    } catch (err: unknown) {
      return c.json({ error: { code: "LOCALE-003", message: err instanceof Error ? err.message : String(err) } }, 400);
    }
  });

  // GET /api/v1/locale/:locale — full locale strings for GUI
  // NOTE: registered AFTER static paths to avoid capturing "installed", "install", "uninstall"
  app.get("/api/v1/locale/:locale", (c) => {
    const locale     = c.req.param("locale");
    const available  = getAvailableLocales();

    // Unknown locale → 404
    if (!available.includes(locale)) {
      return c.json({ error: { code: "LOCALE-001", message: `Locale '${locale}' not found` } }, 404);
    }

    const strings      = loadLocaleData(locale);
    const completeness = calcCompleteness(locale);
    return c.json({ locale, strings, completeness });
  });

  // POST /api/v1/config/locale — set workspace locale
  app.post("/api/v1/config/locale", requireScope("operator"), async (c) => {
    let body: { locale?: string };
    try {
      body = await c.req.json() as { locale?: string };
    } catch (_e) {
      return c.json({ error: { code: "LOCALE-002", message: "Invalid JSON body" } }, 400);
    }

    const locale    = body.locale;
    const available = getAvailableLocales();

    if (typeof locale !== "string" || !available.includes(locale)) {
      return c.json({ error: { code: "LOCALE-003", message: `Unknown locale: ${locale ?? ""}` } }, 400);
    }

    // Restrict server-side persistence to fully-supported locales.
    // GUI clients work with all 26 languages client-side; the server only
    // uses the locale for CLI output and API error messages.
    if (!SERVER_SUPPORTED_LOCALES.includes(locale)) {
      return c.json({
        error: {
          code:        "LOCALE-001",
          message:     `Locale '${locale}' is not fully supported on the server. Supported: ${SERVER_SUPPORTED_LOCALES.join(", ")}`,
          recoverable: true,
          suggestion:  "Use a supported locale or contribute translations",
        },
      }, 400);
    }

    // Persist to DB if available
    if (db !== null && db !== undefined) {
      try {
        runWorkspaceConfigMigration(db);
        db.prepare(
          "INSERT OR REPLACE INTO workspace_config (key, value, updated_at) VALUES ('locale', ?, datetime('now'))",
        ).run(locale);
      } catch (_e) {
        // Non-fatal — locale still set in memory
      }
    }

    // Update in-process locale
    setLocale(locale);

    return c.json({ success: true, locale });
  });
}


function getCurrentLocaleFromDb(db: Database): string | null {
  try {
    const row = db.prepare<[], { value: string }>(
      "SELECT value FROM workspace_config WHERE key = 'locale'",
    ).get();
    return row?.value ?? null;
  } catch (_e) {
    return null;
  }
}
