// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * Module-level CSRF token store (P434c).
 *
 * Accessible to SidjuaApiClient (api/client.ts) without React context.
 * Set by AuthProvider after login/setup; cleared on logout or session expiry.
 */

let _csrfToken: string | null = null;

/** Update the in-memory CSRF token. Called by AuthProvider on auth state change. */
export function setCsrfToken(token: string | null): void {
  _csrfToken = token;
}

/**
 * Read the current CSRF token without React context.
 * Used by SidjuaApiClient to attach X-CSRF-Token to mutating requests.
 * Returns null when no session is active.
 */
export function getCsrfToken(): string | null {
  return _csrfToken;
}
