// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * Maps backend error codes (from response body `error.code`) to
 * i18n translation keys for user-facing error messages.
 *
 * When the API returns `{ error: { code: "IMPORT-102", ... } }`, the
 * GUI translates the code to a user-friendly message via t(key).
 *
 * Keys are registered in src/locales/en.json under `gui.error.*`.
 */

export const ERROR_CODE_MAP: Readonly<Record<string, string>> = {
  // ── Agent errors ──────────────────────────────────────────────────────────
  'AGT-001':    'gui.error.agent_not_found',
  'AGT-002':    'gui.error.agent_error_state',

  // ── Org import errors ─────────────────────────────────────────────────────
  'IMPORT-102': 'gui.error.import_unsupported_type',
  'IMPORT-103': 'gui.error.import_parse_failed',
  'IMPORT-104': 'gui.error.import_no_rows',
  'IMPORT-105': 'gui.error.import_no_name_column',
  'IMPORT-106': 'gui.error.import_file_too_large',
  'IMPORT-202': 'gui.error.import_expired',

  // ── Memory errors ─────────────────────────────────────────────────────────
  'MEM-409':    'gui.error.memory_consolidation_busy',

  // ── Rate-limit errors ─────────────────────────────────────────────────────
  'RATE-001':   'gui.error.rate_limit_sse',
  'RATE-002':   'gui.error.rate_limit_request',
  'RATE-SSE-001': 'gui.error.rate_limit_sse',

  // ── Request / stream errors ───────────────────────────────────────────────
  'REQ-001':    'gui.error.stream_missing_message',
} as const;

/**
 * Resolve an ApiError to a translated message.
 *
 * Checks for an `i18nKey` property set by the API client (from
 * ERROR_CODE_MAP lookup). Falls back to the provided `fallback` string.
 *
 * Usage:
 *   const msg = resolveBackendError(err, t, t('gui.error.generic_fallback'));
 */
export function resolveBackendError(
  err:      unknown,
  t:        (key: string) => string,
  fallback: string,
): string {
  if (err instanceof Error) {
    const i18nKey = (err as Error & { i18nKey?: string }).i18nKey;
    if (i18nKey) return t(i18nKey);
  }
  return fallback;
}
