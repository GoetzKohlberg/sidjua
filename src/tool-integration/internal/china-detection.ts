// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P344: China Bundle Detection
 *
 * Detects whether the China bundle of MCP seed servers should be included.
 * Checks (in priority order): explicit env var, locale, timezone.
 */

const CHINA_TIMEZONES = new Set([
  "Asia/Shanghai",
  "Asia/Chongqing",
  "Asia/Harbin",
  "Asia/Hong_Kong",
  "Asia/Macau",
  "Asia/Urumqi",
]);

export function detectChinaBundle(): boolean {
  // 1. Explicit override
  const explicit = process.env["SIDJUA_CHINA_BUNDLE"];
  if (explicit === "true")  return true;
  if (explicit === "false") return false;

  // 2. Locale (LANG / LC_ALL)
  const locale = process.env["LANG"] ?? process.env["LC_ALL"] ?? "";
  if (locale.startsWith("zh")) return true;

  // 3. Timezone
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (CHINA_TIMEZONES.has(tz)) return true;
  } catch {
    // Intl unavailable — skip
  }

  return false;
}
