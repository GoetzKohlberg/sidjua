// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

/**
 * SIDJUA Desktop — Tauri IPC Command Wrappers
 *
 * Typed wrappers around the Rust Tauri commands defined in src-tauri/src/lib.rs.
 * Security-sensitive API operations (secret reveal, token creation, server shutdown)
 * route through Tauri IPC instead of direct fetch() calls so that:
 *
 *   1. The Rust backend enforces that the target server is a loopback address.
 *   2. Sensitive credentials do not flow through the renderer's fetch() path.
 *   3. The IPC surface is explicit and auditable.
 *
 * All functions check isTauriEnvironment() before calling invoke().
 * Call sites should fall back to the REST API when running in a browser.
 */

import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the page is running inside a Tauri WebView.
 * Use this to gate Tauri-specific code paths from browser fallbacks.
 */
export function isTauriEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window
  );
}

// ---------------------------------------------------------------------------
// Command: reveal_secret
// ---------------------------------------------------------------------------

/**
 * Reveal the plaintext value of a named secret via Tauri IPC.
 *
 * @param name       Secret name (path segment — no slashes)
 * @param serverUrl  Base URL of the SIDJUA server (must be loopback)
 * @param token      Bearer API token with sufficient scope
 * @returns          Plaintext secret value
 * @throws           String error message on HTTP failure or invalid URL
 */
export async function tauriRevealSecret(
  name:      string,
  serverUrl: string,
  token:     string,
): Promise<string> {
  return invoke<string>('reveal_secret', { name, serverUrl, token });
}

// ---------------------------------------------------------------------------
// Command: create_token
// ---------------------------------------------------------------------------

/**
 * Create a scoped API token via Tauri IPC.
 *
 * @param scope      Token scope ('readonly' | 'operator' | 'admin')
 * @param label      Human-readable label for the token
 * @param serverUrl  Base URL of the SIDJUA server (must be loopback)
 * @param token      Bearer API token with admin scope
 * @returns          Newly created raw token string
 * @throws           String error message on HTTP failure or invalid URL
 */
export async function tauriCreateToken(
  scope:     string,
  label:     string,
  serverUrl: string,
  token:     string,
): Promise<string> {
  return invoke<string>('create_token', { scope, label, serverUrl, token });
}

// ---------------------------------------------------------------------------
// Command: shutdown_server
// ---------------------------------------------------------------------------

/**
 * Request the SIDJUA server to shut down via Tauri IPC.
 *
 * @param serverUrl  Base URL of the SIDJUA server (must be loopback)
 * @param token      Bearer API token with admin scope
 * @throws           String error message on HTTP failure or invalid URL
 */
export async function tauriShutdownServer(
  serverUrl: string,
  token:     string,
): Promise<void> {
  return invoke<void>('shutdown_server', { serverUrl, token });
}
