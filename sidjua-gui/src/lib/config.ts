// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — App Configuration Context
 *
 * Stores server URL and connection state.
 * The API key is held in React state ONLY — never persisted to localStorage.
 * Server URL (non-secret) is persisted to localStorage for convenience.
 *
 * Bootstrap key flow (P325):
 *   1. Server injects window.__SIDJUA_BOOTSTRAP__ = { api_key, server_url }
 *   2. On mount, check sessionStorage for a stored admin session token
 *   3. If stored token found, use it directly (skips exchange)
 *   4. If not found, call POST /api/v1/tokens to exchange bootstrap key → admin token
 *   5. Store the admin rawToken in sessionStorage['sidjua-session-token']
 *   6. On auth failure, clear the stored token and reset key (forces re-exchange on next load)
 *
 * The bootstrap key is NEVER persisted — only the exchanged admin token is stored.
 */

import { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo, type ReactNode, createElement } from 'react';
import { SidjuaApiClient } from '../api/client';
import { API_PATHS } from '../api/paths';
import type { TokenCreateResponse } from '../api/types';


export interface AppConfig {
  serverUrl: string;
  apiKey: string;
}

export type ConnectionStatus = 'unknown' | 'checking' | 'connected' | 'error';

export interface BuildInfo {
  version:     string;
  buildDate:   string | null;
  buildRef:    string | null;
  buildNumber: number | null;
}

export interface AppConfigContextValue {
  config: AppConfig;
  status: ConnectionStatus;
  /** @deprecated Always false — bootstrap fetch removed in favour of server-side injection. */
  bootstrapping: boolean;
  /** Build metadata from /api/v1/health — null until fetched. */
  buildInfo: BuildInfo | null;
  /** True when the active key came from auto-bootstrap, not a user-saved key. */
  isBootstrapSession: boolean;
  setConfig: (config: AppConfig) => void;
  testConnection: () => Promise<boolean>;
  client: SidjuaApiClient | null;
}


// P281: Type declaration for the server-injected bootstrap object.
interface SidjuaBootstrap {
  api_key:     string;
  server_url?: string;
}
interface WindowWithBootstrap extends Window {
  __SIDJUA_BOOTSTRAP__?: SidjuaBootstrap;
}

const STORAGE_KEY         = 'sidjua-config';
const SESSION_STORAGE_KEY = 'sidjua-session-token';

const DEFAULT_CONFIG: AppConfig = {
  serverUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4200',
  apiKey:    '',
};

// ---------------------------------------------------------------------------
// Runtime-only API key store
//
// The API key is kept in memory only — never written to localStorage.
// getRuntimeApiKey() is used by non-React code (e.g. useTranslation) that
// needs the key for authenticated requests but cannot access React context.
// ---------------------------------------------------------------------------

let _runtimeApiKey = '';

/** Update the in-memory API key. Called by AppConfigProvider on key change. */
export function setRuntimeApiKey(key: string): void {
  _runtimeApiKey = key;
}

/**
 * Read the in-memory API key without React context.
 * Used by useTranslation to attach an Authorization header to locale-persistence
 * requests. Returns '' when no key has been set yet.
 */
export function getRuntimeApiKey(): string {
  return _runtimeApiKey;
}

// ---------------------------------------------------------------------------
// Bootstrap session flag
//
// True when the current API key came from the automatic bootstrap exchange
// (server-injected key or stored session token on page reload) rather than
// from a user-initiated save in Settings.  Consumers use this to:
//   - Hide the exchanged admin token from the Settings key field
//   - Suppress the FirstRun overlay until the user has explicitly saved a key
// ---------------------------------------------------------------------------

let _isBootstrapSession = false;

/** True when the active key was set by auto-bootstrap, not by the user. */
export function getIsBootstrapSession(): boolean {
  return _isBootstrapSession;
}

/** Load server URL from localStorage. API key is intentionally excluded. */
function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return {
        serverUrl: parsed.serverUrl ?? DEFAULT_CONFIG.serverUrl,
        apiKey:    '',  // never loaded from storage
      };
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_CONFIG;
}

/** Save server URL to localStorage. API key is intentionally excluded. */
function saveConfig(cfg: AppConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ serverUrl: cfg.serverUrl }));
  } catch {
    // ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Session token helpers (P325)
//
// The admin session token is stored in sessionStorage (not localStorage) so
// the token is scoped to the current browser tab and cleared automatically
// when the tab is closed.  The bootstrap key itself is NEVER written to
// storage.
// ---------------------------------------------------------------------------

function loadStoredSessionToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function saveSessionToken(token: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    // ignore storage errors
  }
}

function clearSessionToken(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

/**
 * Exchange a bootstrap key for an admin session token.
 * Calls POST /api/v1/tokens with the bootstrap key as Bearer auth.
 * Returns the rawToken on success, or null on failure.
 */
async function exchangeForAdminToken(serverUrl: string, bootstrapKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${serverUrl}${API_PATHS.tokens()}`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${bootstrapKey}`,
      },
      body: JSON.stringify({ label: 'gui-session', scope: 'admin' }),
    });
    if (!res.ok) return null;
    const data = await res.json() as TokenCreateResponse;
    return data.rawToken ?? null;
  } catch {
    return null;
  }
}


export const AppConfigContext = createContext<AppConfigContextValue>({
  config:              DEFAULT_CONFIG,
  status:              'unknown',
  bootstrapping:       false,
  buildInfo:           null,
  isBootstrapSession:  false,
  setConfig:           () => undefined,
  testConnection:      async () => false,
  client:              null,
});

export function useAppConfig(): AppConfigContextValue {
  return useContext(AppConfigContext);
}


export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState]               = useState<AppConfig>(loadConfig);
  const [status, setStatus]                    = useState<ConnectionStatus>('unknown');
  const [buildInfo, setBuildInfo]              = useState<BuildInfo | null>(null);
  const [isBootstrapSession, setIsBootstrap]   = useState(false);

  // Guard: max 1 auth-failure recovery cycle to prevent infinite loops
  const rebootstrapCount = useRef(0);

  // Stable ref so the useMemo dependency array stays clean
  const handleAuthFailureRef = useRef<() => void>(() => undefined);
  handleAuthFailureRef.current = () => {
    if (rebootstrapCount.current >= 1) return;
    rebootstrapCount.current += 1;
    clearSessionToken();
    setRuntimeApiKey('');
    setConfigState((prev) => ({ ...prev, apiKey: '' }));
  };

  const client = useMemo(
    () => config.apiKey
      ? new SidjuaApiClient(config.serverUrl, config.apiKey, () => handleAuthFailureRef.current())
      : null,
    [config.serverUrl, config.apiKey],
  );

  const setConfig = useCallback((next: AppConfig) => {
    // User-initiated save: clear the bootstrap session flag so the FirstRun
    // overlay and Settings key field reflect the actual user-chosen key.
    _isBootstrapSession = false;
    setIsBootstrap(false);

    // Attempt to exchange for an admin session token.  If exchange succeeds,
    // store the admin token and use it; otherwise use the provided key as-is
    // (e.g. the user may have entered an admin token directly).
    void (async () => {
      if (next.apiKey) {
        const adminToken = await exchangeForAdminToken(next.serverUrl, next.apiKey);
        if (adminToken) {
          saveSessionToken(adminToken);
          const upgraded = { ...next, apiKey: adminToken };
          setConfigState(upgraded);
          saveConfig(upgraded);
          setStatus('unknown');
          return;
        }
      }
      setConfigState(next);
      saveConfig(next);
      setStatus('unknown');
    })();
  }, []);

  // Keep runtime key in sync with React state
  useEffect(() => {
    setRuntimeApiKey(config.apiKey);
  }, [config.apiKey]);

  const testConnection = useCallback(async (): Promise<boolean> => {
    if (!client) {
      setStatus('error');
      return false;
    }
    setStatus('checking');
    try {
      await client.health();
      setStatus('connected');
      return true;
    } catch {
      setStatus('error');
      return false;
    }
  }, [client]);

  // Auto-check whenever we have credentials (runs on mount AND after bootstrap sets the key)
  useEffect(() => {
    if (config.apiKey) {
      void testConnection();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiKey]);

  // Fetch build info from public /health endpoint (no auth required)
  useEffect(() => {
    const serverUrl = config.serverUrl || window.location.origin;
    fetch(`${serverUrl}/api/v1/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (data && typeof data === 'object') {
          const h = data as Record<string, unknown>;
          const version     = typeof h['version']      === 'string' ? h['version']      : 'dev';
          const buildDate   = typeof h['build_date']   === 'string' ? h['build_date']   : null;
          const buildRef    = typeof h['build_ref']    === 'string' ? h['build_ref']    : null;
          const buildNumber = typeof h['build_number'] === 'number' ? h['build_number'] : null;
          setBuildInfo({ version, buildDate, buildRef, buildNumber });
        }
      })
      .catch(() => { /* server not reachable yet — buildInfo stays null */ });
  }, [config.serverUrl]);

  // GUI bootstrap: read the API key from the server-injected window object,
  // then exchange it for an admin session token (P325).
  //
  // Flow:
  //  1. If we already have a key in React state, nothing to do.
  //  2. If a session token is stored in sessionStorage, use it directly
  //     (page reload within the same tab — no new exchange needed).
  //  3. Otherwise read the bootstrap key from window.__SIDJUA_BOOTSTRAP__,
  //     exchange it for an admin token, store the admin token, and apply it.
  //     If exchange fails, fall back to using the bootstrap key directly
  //     (local-dev / non-production setups where bootstrap key has admin scope).
  useEffect(() => {
    if (config.apiKey) return;  // already have a key

    const storedToken = loadStoredSessionToken();
    if (storedToken) {
      // Reuse persisted admin token across page reloads — mark as bootstrap session
      const serverUrl = config.serverUrl || window.location.origin;
      _isBootstrapSession = true;
      setIsBootstrap(true);
      setConfigState((prev) => ({ ...prev, serverUrl, apiKey: storedToken }));
      return;
    }

    const injected = (window as WindowWithBootstrap).__SIDJUA_BOOTSTRAP__;
    if (typeof injected?.api_key === 'string' && injected.api_key) {
      const serverUrl = injected.server_url || config.serverUrl || window.location.origin;
      void (async () => {
        const adminToken = await exchangeForAdminToken(serverUrl, injected.api_key);
        // Either path (exchanged token or fallback key) is a bootstrap session
        _isBootstrapSession = true;
        setIsBootstrap(true);
        if (adminToken) {
          saveSessionToken(adminToken);
          setConfigState({ serverUrl, apiKey: adminToken });
        } else {
          // Exchange failed (e.g. local dev with admin bootstrap key) — use key as-is
          setConfigState({ serverUrl, apiKey: injected.api_key });
        }
        saveConfig({ serverUrl, apiKey: '' });
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: AppConfigContextValue = {
    config,
    status,
    bootstrapping:      false,  // no longer used — kept for interface stability
    buildInfo,
    isBootstrapSession,
    setConfig,
    testConnection,
    client,
  };

  return createElement(AppConfigContext.Provider, { value }, children);
}
