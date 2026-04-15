// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — Auth Context (P434c)
 *
 * Provides session-based authentication state and an AuthProvider component.
 *
 * On mount, AuthProvider:
 *   1. Calls GET /api/v1/health  → reads setup_required and recovery_mode
 *   2. Calls GET /api/v1/auth/verify  → determines if a session is active
 *   3. If authenticated, calls GET /api/v1/auth/csrf  → fetches the CSRF token
 *
 * Routing contract (enforced by AuthGuard in App.tsx):
 *   - status === 'unauthenticated' && isFirstRun   → /setup
 *   - status === 'unauthenticated' && !isFirstRun  → /login
 *   - status === 'authenticated'                   → render children
 *
 * The CSRF token is stored both in React state (for context consumers) and in
 * the module-level csrf.ts store (for SidjuaApiClient, which cannot access React
 * context). Both are kept in sync by AuthProvider.
 */

import {
  createContext, useContext, useState, useEffect, useCallback, createElement,
  type ReactNode,
} from 'react';
import { API_PATHS } from '../api/paths';
import { setCsrfToken, getCsrfToken } from './csrf';
import { runLocaleReconciliationIfPending } from '../hooks/useTranslation';


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthState {
  status:             'loading' | 'authenticated' | 'unauthenticated';
  isFirstRun:         boolean;
  isRecoveryMode:     boolean;
  /** P440: workspace first-run overlay completed — derived from GET /api/v1/health (public). */
  firstRunCompleted:  boolean;
}

export interface AuthContextValue {
  authState:      AuthState;
  /** Current session CSRF token — null when unauthenticated. */
  csrfToken:      string | null;
  /** Call after a successful login or first-run setup. */
  onLoginSuccess: (csrfToken: string) => void;
  logout:         () => Promise<void>;
}


// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const DEFAULT_VALUE: AuthContextValue = {
  authState:      { status: 'loading', isFirstRun: false, isRecoveryMode: false, firstRunCompleted: false },
  csrfToken:      null,
  onLoginSuccess: () => undefined,
  logout:         async () => undefined,
};

export const AuthContext = createContext<AuthContextValue>(DEFAULT_VALUE);

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}


// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState,       setAuthState]       = useState<AuthState>(DEFAULT_VALUE.authState);
  const [csrfTokenState,  setCsrfTokenState]  = useState<string | null>(null);

  /** Update both module-level store (for SidjuaApiClient) and React state. */
  const applyToken = useCallback((token: string | null) => {
    setCsrfToken(token);
    setCsrfTokenState(token);
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      // 1. Health → setup_required, recovery_mode
      const healthRes = await fetch(API_PATHS.health());
      const health    = healthRes.ok
        ? (await healthRes.json() as Record<string, unknown>)
        : {};
      const isFirstRun      = Boolean(health['setup_required']);
      const isRecoveryMode  = Boolean(health['recovery_mode']);
      const firstRunCompleted = Boolean(health['first_run_completed']);

      // 2. Auth verify → is there an active session?
      const verifyRes = await fetch(API_PATHS.authVerify());
      if (!verifyRes.ok) {
        applyToken(null);
        setAuthState({ status: 'unauthenticated', isFirstRun, isRecoveryMode, firstRunCompleted });
        return;
      }

      // 3. Fetch CSRF token for the active session
      const csrfRes  = await fetch(API_PATHS.authCsrf());
      const csrfData = csrfRes.ok
        ? (await csrfRes.json() as { csrfToken?: string })
        : {};
      applyToken(csrfData.csrfToken ?? null);
      setAuthState({ status: 'authenticated', isFirstRun, isRecoveryMode, firstRunCompleted });
      void runLocaleReconciliationIfPending();
    } catch {
      applyToken(null);
      setAuthState({ status: 'unauthenticated', isFirstRun: false, isRecoveryMode: false, firstRunCompleted: false });
    }
  }, [applyToken]);

  // Initial auth check on mount
  useEffect(() => { void checkAuth(); }, [checkAuth]);

  // Idle-timeout: poll /auth/verify every 60 s.
  // On 401, clear session state so AuthGuard redirects to /login.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch(API_PATHS.authVerify());
        if (!res.ok && res.status === 401) {
          applyToken(null);
          setAuthState((prev) => ({ ...prev, status: 'unauthenticated' }));
        }
      } catch {
        // Network blip — don't evict session; next poll will catch a real expiry.
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [applyToken]);

  const onLoginSuccess = useCallback((token: string) => {
    applyToken(token);
    setAuthState((prev) => ({ ...prev, status: 'authenticated' }));
    void runLocaleReconciliationIfPending();
  }, [applyToken]);

  const logout = useCallback(async () => {
    try {
      await fetch(API_PATHS.authLogout(), {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-SIDJUA-Request': '1',
          'X-CSRF-Token':     getCsrfToken() ?? '',
        },
      });
    } catch { /* ignore — session is cleared client-side regardless */ }

    // Re-check health so isFirstRun/firstRunCompleted stay accurate after logout
    let isFirstRun      = false;
    let isRecoveryMode  = false;
    let firstRunCompleted = false;
    try {
      const healthRes = await fetch(API_PATHS.health());
      if (healthRes.ok) {
        const health    = await healthRes.json() as Record<string, unknown>;
        isFirstRun      = Boolean(health['setup_required']);
        isRecoveryMode  = Boolean(health['recovery_mode']);
        firstRunCompleted = Boolean(health['first_run_completed']);
      }
    } catch { /* ignore */ }

    applyToken(null);
    setAuthState({ status: 'unauthenticated', isFirstRun, isRecoveryMode, firstRunCompleted });
  }, [applyToken]);

  const value: AuthContextValue = {
    authState,
    csrfToken: csrfTokenState,
    onLoginSuccess,
    logout,
  };
  return createElement(AuthContext.Provider, { value }, children);
}
