// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA GUI — useTranslation hook (P191)
 *
 * Provides `t(key, params?)` translation function, current locale,
 * and `setLocale()` for in-app language switching.
 *
 * Strings are fetched once from GET /api/v1/locale/:locale and cached
 * in a module-level Map so all component instances share the same data.
 * Locale changes propagate to all mounted hooks via a subscriber set.
 *
 * Rules:
 *   - No external dependencies (no i18n library)
 *   - Graceful fallback: missing key returns the key itself
 *   - Locale files are served by the same origin (no CDN)
 *   - `setLocale()` persists via POST /api/v1/config/locale
 */

import { useState, useEffect, useCallback } from 'react';
import { API_PATHS } from '../api/paths';
import { getRuntimeApiKey } from '../lib/config';
import { getCsrfToken } from '../lib/csrf';
import type { LocaleStringsResponse } from '../api/types';


const _cache       = new Map<string, Record<string, string>>();
const _subscribers = new Set<() => void>();

const LS_KEY = 'sidjua_locale';

// Detect locale on module init (runs once when the module is first imported).
// Priority: localStorage saved preference → navigator.language → "en".
// Falls back to "en" in SSR/test environments where window is undefined.
function detectInitialLocale(): string {
  if (typeof window === 'undefined') return 'en';
  const saved = localStorage.getItem(LS_KEY);
  if (saved && saved.trim() !== '') return saved.trim();
  const lang = navigator.language ?? 'en';
  return lang.split('-')[0].toLowerCase() || 'en';
}

let _locale = detectInitialLocale();

// On startup, reconcile localStorage locale with server (best-effort, fire-and-forget).
// This ensures that a locale saved in localStorage from a previous session is reflected
// in the server's workspace_config, enabling consistent behaviour across GUI and CLI.
if (typeof window !== 'undefined') {
  const _savedLocale = localStorage.getItem(LS_KEY);
  if (_savedLocale && _savedLocale.trim() !== '') {
    // Defer to avoid blocking module init — run after the current microtask queue.
    Promise.resolve().then(async () => {
      try {
        // Import lazily to avoid circular dependency on getRuntimeApiKey at module init
        const { getRuntimeApiKey } = await import('../lib/config');
        const { getCsrfToken }     = await import('../lib/csrf');
        const key  = getRuntimeApiKey();
        const csrf = getCsrfToken();
        const headers: Record<string, string> = {
          'Content-Type':     'application/json',
          'X-SIDJUA-Request': '1',
        };
        if (key)  headers['Authorization'] = `Bearer ${key}`;
        if (csrf) headers['X-CSRF-Token']  = csrf;
        await fetch(API_PATHS.localeSet(), {
          method:  'POST',
          headers,
          body:    JSON.stringify({ locale: _savedLocale.trim() }),
        });
      } catch (_e) {
        // Non-fatal — server reconciliation is best-effort
      }
    });
  }
}

function _notify() {
  for (const fn of _subscribers) fn();
}

async function _loadLocale(locale: string): Promise<Record<string, string>> {
  if (_cache.has(locale)) return _cache.get(locale)!;
  try {
    const res = await fetch(API_PATHS.localeStrings(locale));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as LocaleStringsResponse;
    _cache.set(locale, data.strings);
    return data.strings;
  } catch (_e) {
    // API unavailable — return empty object; t() will return keys
    return {};
  }
}


function _translate(
  strings: Record<string, string>,
  key:     string,
  params?: Record<string, string | number>,
): string {
  let value = strings[key];
  if (value === undefined) return key; // graceful fallback
  if (params !== undefined) {
    value = value.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const v = params[name];
      return v !== undefined ? String(v) : `{${name}}`;
    });
  }
  return value;
}


export interface UseTranslationResult {
  /** Translate a key with optional interpolation params. */
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Currently active locale code (e.g. "en", "de"). */
  locale: string;
  /**
   * Switch to a new locale.
   * Persists via POST /api/v1/config/locale (best-effort).
   * All mounted useTranslation hooks update without page reload.
   * Returns { serverPersisted: true } if the server accepted the locale.
   */
  setLocale: (locale: string) => Promise<{ serverPersisted: boolean }>;
}

/**
 * React hook for i18n translation.
 *
 * @example
 * const { t, locale, setLocale } = useTranslation();
 * return <span>{t('gui.nav.dashboard')}</span>;
 */
export function useTranslation(): UseTranslationResult {
  const [strings,    setStrings]    = useState<Record<string, string>>(() => _cache.get(_locale) ?? {});
  const [localeCode, setLocaleCode] = useState(_locale);

  useEffect(() => {
    let mounted = true;

    // Load current locale if not cached
    if (!_cache.has(_locale)) {
      _loadLocale(_locale).then((data) => {
        if (mounted) setStrings(data);
      });
    }

    // Subscribe to locale changes from other components
    function onLocaleChange() {
      const currentLocale = _locale;
      setLocaleCode(currentLocale);
      const cached = _cache.get(currentLocale);
      if (cached) {
        setStrings(cached);
      } else {
        _loadLocale(currentLocale).then((data) => {
          if (mounted) setStrings(data);
        });
      }
    }

    _subscribers.add(onLocaleChange);
    return () => {
      mounted = false;
      _subscribers.delete(onLocaleChange);
    };
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      _translate(strings, key, params),
    [strings],
  );

  const setLocale = useCallback(async (newLocale: string): Promise<{ serverPersisted: boolean }> => {
    // Load locale data (no-op if already cached)
    await _loadLocale(newLocale);

    // Persist to localStorage immediately — survives page reload independently of server.
    try { localStorage.setItem(LS_KEY, newLocale); } catch (_e) { /* quota or privacy mode */ }

    // Update GUI locale UNCONDITIONALLY — independent of server persistence.
    // All mounted useTranslation hooks re-render with the new strings immediately.
    _locale = newLocale;
    _notify();

    // Best-effort persist to server (include auth headers so the endpoint accepts the request).
    let serverPersisted = false;
    try {
      const key  = getRuntimeApiKey();
      const csrf = getCsrfToken();
      const headers: Record<string, string> = {
        'Content-Type':     'application/json',
        'X-SIDJUA-Request': '1',
      };
      if (key)  headers['Authorization'] = `Bearer ${key}`;
      if (csrf) headers['X-CSRF-Token']  = csrf;
      const res = await fetch(API_PATHS.localeSet(), {
        method:  'POST',
        headers,
        body:    JSON.stringify({ locale: newLocale }),
      });
      serverPersisted = res.ok;
    } catch (_e) {
      // Non-fatal — locale already switched in-browser and persisted to localStorage
    }

    return { serverPersisted };
  }, []);

  return { t, locale: localeCode, setLocale };
}
