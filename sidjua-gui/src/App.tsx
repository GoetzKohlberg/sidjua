// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useEffect, useCallback } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';

import { ThemeProvider }    from './lib/theme';
import { AppConfigProvider, useAppConfig } from './lib/config';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider }    from './components/shared/Toast';
import { ErrorBoundary }    from './components/shared/ErrorBoundary';
import { Shell }            from './components/layout/Shell';
import { FirstRunOverlay }  from './components/overlay/FirstRunOverlay';
import { LoadingSpinner }   from './components/shared/LoadingSpinner';

import { Setup }        from './pages/Setup';
import { Login }        from './pages/Login';
import { Dashboard }    from './pages/Dashboard';
import { Agents }       from './pages/Agents';
import { OrgChart }     from './pages/OrgChart';
import { Chat }         from './pages/Chat';
import { Divisions }    from './pages/Divisions';
import { Governance }   from './pages/Governance';
import { AuditLog }     from './pages/AuditLog';
import { CostTracking } from './pages/CostTracking';
import { Configuration } from './pages/Configuration';
import { Settings }     from './pages/Settings';


// ---------------------------------------------------------------------------
// Auth guard — redirects to /setup or /login when unauthenticated
// ---------------------------------------------------------------------------

function AuthGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { authState } = useAuth();

  useEffect(() => {
    if (authState.status === 'loading') return;
    if (authState.status === 'unauthenticated') {
      navigate(authState.isFirstRun ? '/setup' : '/login', { replace: true });
    }
  }, [authState, navigate]);

  if (authState.status === 'loading') {
    return (
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        height:         '100vh',
        background:     'var(--color-bg)',
      }}>
        <LoadingSpinner size="lg" label="Checking session…" />
      </div>
    );
  }
  if (authState.status !== 'authenticated') return null;
  return <>{children}</>;
}


// ---------------------------------------------------------------------------
// Workspace first-run gate (separate from auth first-run)
// ---------------------------------------------------------------------------

type FirstRunState = 'loading' | 'completed' | 'pending' | 'error';

function ProtectedApp() {
  const { client }    = useAppConfig();
  const { authState } = useAuth();
  // Local override: once dismissed, stay completed without waiting for authState refresh.
  const [dismissed, setDismissed] = useState(false);

  // P440: derive from public health endpoint (via AuthProvider) — no auth-gated fetch.
  const firstRunState: FirstRunState =
    dismissed || authState.firstRunCompleted ? 'completed' : 'pending';

  const handleDismiss = useCallback(async () => {
    setDismissed(true);
    try {
      await client!.completeFirstRun();
    } catch {
      // Non-fatal — overlay already hidden
    }
  }, [client]);

  return (
    <AppRoutes
      firstRunState={firstRunState}
      onDismiss={handleDismiss}
      onRetry={() => undefined}
    />
  );
}


// ---------------------------------------------------------------------------
// App routes
// ---------------------------------------------------------------------------

interface AppRoutesProps {
  firstRunState: FirstRunState;
  onDismiss: () => void;
  onRetry: () => void;
}

function AppRoutes({ firstRunState, onDismiss, onRetry }: AppRoutesProps) {
  const navigate = useNavigate();

  const handleGoToSettings = useCallback(() => {
    void onDismiss();
    navigate('/settings');
  }, [onDismiss, navigate]);

  return (
    <>
      {(firstRunState === 'pending' || firstRunState === 'error') && (
        <FirstRunOverlay
          onDismiss={onDismiss}
          onGoToSettings={handleGoToSettings}
          networkError={firstRunState === 'error'}
          onRetry={onRetry}
        />
      )}

      <Routes>
        <Route element={<Shell />}>
          <Route index              element={<Dashboard />}    />
          <Route path="chat"        element={<Navigate to="/chat/guide" replace />} />
          <Route path="chat/:agentId" element={<Chat />}       />
          <Route path="agents"      element={<OrgChart />}     />
          <Route path="divisions"   element={<Divisions />}    />
          <Route path="governance"  element={<Governance />}   />
          <Route path="audit"       element={<AuditLog />}     />
          <Route path="costs"       element={<CostTracking />} />
          <Route path="config"      element={<Configuration />}/>
          <Route path="settings"    element={<Settings />}     />
          <Route path="*"           element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}


// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <ThemeProvider>
      <AppConfigProvider>
        <ToastProvider>
          <ErrorBoundary>
            <HashRouter>
              <AuthProvider>
                <Routes>
                  <Route path="/setup" element={<Setup />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/*" element={
                    <AuthGuard>
                      <ProtectedApp />
                    </AuthGuard>
                  } />
                </Routes>
              </AuthProvider>
            </HashRouter>
          </ErrorBoundary>
        </ToastProvider>
      </AppConfigProvider>
    </ThemeProvider>
  );
}
