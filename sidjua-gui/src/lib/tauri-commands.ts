// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

/**
 * SIDJUA GUI — Tauri IPC stubs (P434a)
 *
 * Tauri IPC has been removed in P434a (browser-native scope).
 * This file is kept as a placeholder to preserve import compatibility.
 * TODO P434c: rewire to REST API where needed.
 */

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/**
 * Always returns false — Tauri has been removed.
 * Kept for call-site compatibility during P434a transition.
 */
export function isTauriEnvironment(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Stubs — replaced by REST API calls in P434c
// ---------------------------------------------------------------------------

/** @deprecated Tauri removed — will be rewired to REST API in P434c. */
export async function tauriRevealSecret(
  _name:      string,
  _serverUrl: string,
  _token:     string,
): Promise<string> {
  throw new Error('tauriRevealSecret: Tauri IPC removed. TODO P434c: rewire to REST API.');
}

/** @deprecated Tauri removed — will be rewired to REST API in P434c. */
export async function tauriCreateToken(
  _scope:     string,
  _label:     string,
  _serverUrl: string,
  _token:     string,
): Promise<string> {
  throw new Error('tauriCreateToken: Tauri IPC removed. TODO P434c: rewire to REST API.');
}

/** @deprecated Tauri removed — will be rewired to REST API in P434c. */
export async function tauriShutdownServer(
  _serverUrl: string,
  _token:     string,
): Promise<void> {
  throw new Error('tauriShutdownServer: Tauri IPC removed. TODO P434c: rewire to REST API.');
}
