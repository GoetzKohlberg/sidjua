// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — API key module-level state (shared singleton)
 *
 * Extracted from cli-server.ts so that api-key subcommands (generate, rotate,
 * disable-bootstrap, enable-bootstrap) and the server startup path all share
 * the same live apiKeyState object without registering duplicate Commander
 * commands.
 *
 * NOTE: Module-level state limits deployment to single-process mode.
 * Multi-worker/cluster support requires migrating key state to SQLite or shared store.
 * Per-client API tokens with RBAC scopes are planned for V1.0.
 * For multi-user deployments, place the API behind a reverse proxy with additional auth.
 */

import { generateSecret } from "../core/crypto-utils.js";

/**
 * Maximum allowed grace period for key rotation.
 * Prevents an operator from accidentally (or maliciously) setting an
 * unbounded grace period that keeps the old key valid indefinitely.
 */
export const MAX_GRACE_PERIOD_MS = 24 * 60 * 60 * 1_000; // 24 hours

export const apiKeyState = {
  currentApiKey: process.env["SIDJUA_API_KEY"] ?? "",
  pendingKey:    null as string | null,
  pendingTimer:  null as ReturnType<typeof setTimeout> | null,
};

/** Exposed for tests only — resets module state. */
export function _resetApiKeyState(): void {
  apiKeyState.currentApiKey = "";
  if (apiKeyState.pendingTimer !== null) clearTimeout(apiKeyState.pendingTimer);
  apiKeyState.pendingTimer = null;
  apiKeyState.pendingKey   = null;
}

/** Returns the API key currently valid for authentication. */
export function getActiveApiKey(): string {
  return apiKeyState.pendingKey !== null ? apiKeyState.pendingKey : apiKeyState.currentApiKey;
}

/** Generates a cryptographically-random 32-byte hex API key. */
export function generateApiKey(): string {
  return generateSecret();
}
