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
 * H17: Admin tokens must NOT be persisted to sessionStorage — XSS risk.
 */

import { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo, type ReactNode, createElement } from 'react';
import { SidjuaApiClient } from '../api/client';


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

/** Load config. In browser-native mode the server URL is always the page origin. */
function loadConfig(): AppConfig {
  return {
    serverUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4200',
    apiKey:    '',
  };
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
// Session token helpers (H17)
//
// Admin tokens are held in React state (memory) only.
// clearSessionToken() cleans up any token that may have been stored by
// earlier versions of the GUI.
// ---------------------------------------------------------------------------

function clearSessionToken(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore storage errors
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
    setStatus('error');
  };

  // In browser-native mode auth is via session cookie — create client even with empty apiKey.
  const client = useMemo(
    () => new SidjuaApiClient(config.serverUrl, config.apiKey, () => handleAuthFailureRef.current()),
    [config.serverUrl, config.apiKey],
  );

  const setConfig = useCallback((next: AppConfig) => {
    // User-initiated save: clear the bootstrap session flag so the FirstRun
    // overlay and Settings key field reflect the actual user-chosen key.
    _isBootstrapSession = false;
    setIsBootstrap(false);
    setConfigState(next);
    saveConfig(next);
    setStatus('unknown');
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
