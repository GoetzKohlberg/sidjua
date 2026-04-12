// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — Structured Error Catalog (P324)
 *
 * CEO directive: every error shown to the user must explain WHAT went wrong
 * and provide a concrete NEXT STEP. Technical codes are secondary information.
 *
 * Each entry has:
 *   message        — plain-language description of what went wrong
 *   suggestion     — concrete next step the user should take
 *   technicalDetail — raw technical code/detail (shown only in debug mode)
 *
 * Locale keys for i18n are registered in src/locales/en.json under
 * "gui.error.<code>.message" and "gui.error.<code>.suggestion".
 */

export interface GuiErrorEntry {
  readonly message:        string;
  readonly suggestion:     string;
  readonly technicalDetail: string;
}

export const GUI_ERRORS = {

  // ── Authentication ────────────────────────────────────────────────────────

  /** Session not established (fresh load, not yet logged in). */
  'GUI-AUTH-001': {
    message:         'Not logged in.',
    suggestion:      'Please log in at /login or complete first-run setup at /setup.',
    technicalDetail: 'HTTP 401/403 — no session',
  },

  /** Session expired or access denied. */
  'GUI-AUTH-002': {
    message:         'Session expired or access denied.',
    suggestion:      'Please log in again. Go to /login or reload the page.',
    technicalDetail: 'HTTP 401/403 — authentication failed',
  },

  // ── Connectivity ──────────────────────────────────────────────────────────

  /** Server unreachable — Docker not running, wrong URL, firewall, etc. */
  'GUI-CONN-001': {
    message:         'Cannot connect to the SIDJUA server.',
    suggestion:      'Make sure the SIDJUA container is running: docker start <container-name> (or docker compose up)',
    technicalDetail: 'Network error — connection refused or DNS failure',
  },

  /** Server returned a 5xx internal error. */
  'GUI-CONN-002': {
    message:         'The server encountered an internal error.',
    suggestion:      'Try again in a moment, or restart SIDJUA: docker restart <container-name>',
    technicalDetail: 'HTTP 5xx — server-side error',
  },

  /** 4xx client error that is not 401/403 (bad request, not found, etc.). */
  'GUI-CONN-003': {
    message:         'The request could not be completed.',
    suggestion:      'Check that the data you entered is correct and try again.',
    technicalDetail: 'HTTP 4xx — client error',
  },

  /** Request timed out or was aborted. */
  'GUI-CONN-004': {
    message:         'The request timed out.',
    suggestion:      'Check your network connection and try again.',
    technicalDetail: 'AbortError / request cancelled',
  },

  /** Client not initialised — no server URL configured. */
  'GUI-CONN-005': {
    message:         'Not connected to any SIDJUA server.',
    suggestion:      'Open Settings and verify the server URL.',
    technicalDetail: 'No client configured',
  },

  // ── Health / Status ───────────────────────────────────────────────────────

  /** Health check failed — server may be starting or unreachable. */
  'GUI-HEALTH-001': {
    message:         'Could not reach the SIDJUA server.',
    suggestion:      'Check that Docker Desktop is running and the SIDJUA container is started.',
    technicalDetail: 'Health check request failed',
  },

  // ── LLM / Provider ────────────────────────────────────────────────────────

  /** No AI provider configured. */
  'GUI-LLM-001': {
    message:         'No AI provider is configured yet.',
    suggestion:      'Go to Settings > AI Provider and add your API key (e.g. Anthropic, OpenAI).',
    technicalDetail: 'CHAT-003 / PCFG-003 — provider not configured',
  },

  /** Provider connection test failed. */
  'GUI-PROVIDER-001': {
    message:         'Could not connect to the AI provider.',
    suggestion:      'Double-check your API key and try the connection test again.',
    technicalDetail: 'Provider test returned error',
  },

  /** Saving provider configuration failed. */
  'GUI-PROVIDER-002': {
    message:         'Failed to save the provider configuration.',
    suggestion:      'Check your network connection and try again. If the problem persists, restart SIDJUA.',
    technicalDetail: 'Provider config save failed',
  },

  /** Loading provider catalog or config failed. */
  'GUI-PROVIDER-003': {
    message:         'Failed to load provider data.',
    suggestion:      'Refresh the page or restart SIDJUA.',
    technicalDetail: 'Provider catalog/config load failed',
  },

  /** Resetting provider configuration failed. */
  'GUI-PROVIDER-004': {
    message:         'Failed to reset the provider configuration.',
    suggestion:      'Try again or restart SIDJUA.',
    technicalDetail: 'Provider config delete failed',
  },

  // ── Agent ────────────────────────────────────────────────────────────────

  /** Updating agent properties failed. */
  'GUI-AGENT-001': {
    message:         'Failed to update the agent.',
    suggestion:      'Check your connection and try again.',
    technicalDetail: 'PATCH /agents/:id failed',
  },

  /** Starting or stopping an agent failed. */
  'GUI-AGENT-002': {
    message:         'The agent action could not be completed.',
    suggestion:      'Check the agent status and try again. If it is stuck, restart SIDJUA.',
    technicalDetail: 'Agent start/stop failed',
  },

  // ── Chat ─────────────────────────────────────────────────────────────────

  /** Chat message request failed at the HTTP level. */
  'GUI-CHAT-001': {
    message:         'The message could not be sent.',
    suggestion:      'Check that an AI provider is configured in Settings > AI Provider, then try again.',
    technicalDetail: 'POST /chat/:agentId failed',
  },

  /** Server returned no response body for a chat request. */
  'GUI-CHAT-002': {
    message:         'The AI agent did not respond.',
    suggestion:      'Make sure an AI provider is configured. Go to Settings > AI Provider.',
    technicalDetail: 'Empty response body from chat endpoint',
  },

  // ── Settings ─────────────────────────────────────────────────────────────

  /** Saving application settings failed. */
  'GUI-SETTINGS-001': {
    message:         'Failed to save settings.',
    suggestion:      'Check your connection and try again.',
    technicalDetail: 'Settings save failed',
  },

  /** Connection test from Settings page failed. */
  'GUI-SETTINGS-002': {
    message:         'Connection test failed.',
    suggestion:      'Check that the server URL is correct and the SIDJUA container is running.',
    technicalDetail: 'Health check failed during settings test',
  },

  /** Error-logging toggle update failed. */
  'GUI-SETTINGS-003': {
    message:         'Failed to update the error-logging setting.',
    suggestion:      'Try again or restart SIDJUA.',
    technicalDetail: 'PATCH /logging failed',
  },

  // ── Workspace / Start-Over ───────────────────────────────────────────────

  /** Workspace backup failed. */
  'GUI-WORKSPACE-001': {
    message:         'Failed to create a workspace backup.',
    suggestion:      'Check disk space and try again.',
    technicalDetail: 'POST /workspace/backup failed',
  },

  /** Workspace wipe failed. */
  'GUI-WORKSPACE-002': {
    message:         'Failed to wipe the workspace.',
    suggestion:      'Try again or manually run: docker restart <container-name>',
    technicalDetail: 'POST /workspace/wipe failed',
  },

  // ── Audit Log ────────────────────────────────────────────────────────────

  /** Loading audit log entries failed. */
  'GUI-AUDIT-001': {
    message:         'Failed to load the audit log.',
    suggestion:      'Check your connection and try again.',
    technicalDetail: 'GET /audit failed',
  },

  // ── Generic ──────────────────────────────────────────────────────────────

  /** Catch-all for unexpected errors. */
  'GUI-GENERIC-001': {
    message:         'Something went wrong.',
    suggestion:      'Try reloading the page. If the problem persists, restart SIDJUA: docker restart <container-name>',
    technicalDetail: 'Unknown error',
  },

} as const satisfies Record<string, GuiErrorEntry>;

export type GuiErrorCode = keyof typeof GUI_ERRORS;

/**
 * Format an error for display to the end user.
 *
 * Returns "${message} ${suggestion}" so callers can show a single
 * actionable sentence without needing to understand the error structure.
 *
 * When `apiKey` is provided and the error is an auth failure, chooses
 * between GUI-AUTH-001 (no key) and GUI-AUTH-002 (key set but rejected).
 */
export function formatGuiError(err: unknown, hasApiKey?: boolean): string {
  if (err instanceof Error) {
    const guiCode = (err as Error & { guiCode?: string }).guiCode;
    if (guiCode && guiCode in GUI_ERRORS) {
      const entry = GUI_ERRORS[guiCode as GuiErrorCode];
      // Distinguish "no key" vs "wrong key" for auth errors
      if (guiCode === 'GUI-AUTH-002' && hasApiKey === false) {
        const noKey = GUI_ERRORS['GUI-AUTH-001'];
        return `${noKey.message} ${noKey.suggestion}`;
      }
      return `${entry.message} ${entry.suggestion}`;
    }
    // ApiError with no guiCode — the message may already be user-friendly
    if (err.message) return err.message;
  }
  return `${GUI_ERRORS['GUI-GENERIC-001'].message} ${GUI_ERRORS['GUI-GENERIC-001'].suggestion}`;
}

/**
 * Look up a GUI error entry by code.
 * Returns undefined if the code is not in the catalog.
 */
export function getGuiErrorInfo(code: string): GuiErrorEntry | undefined {
  return code in GUI_ERRORS ? GUI_ERRORS[code as GuiErrorCode] : undefined;
}
