// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useEffect, useCallback } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';

import { ThemeProvider }    from './lib/theme';
import { AppConfigProvider, useAppConfig } from './lib/config';
import { ToastProvider }    from './components/shared/Toast';
import { ErrorBoundary }    from './components/shared/ErrorBoundary';
import { Shell }            from './components/layout/Shell';
import { FirstRunOverlay }  from './components/overlay/FirstRunOverlay';
import { SidjuaApiClient }  from './api/client';

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


type FirstRunState = 'loading' | 'completed' | 'pending' | 'error';

function AppWithFirstRunGate() {
  const { config, isBootstrapSession } = useAppConfig();

  const [firstRunState, setFirstRunState] = useState<FirstRunState>('loading');

  const checkFirstRun = useCallback(async () => {
    // If no credentials yet, or key came from auto-bootstrap (not user-saved),
    // skip overlay — show it only after the user has explicitly configured their key.
    if (!config.serverUrl || !config.apiKey || isBootstrapSession) {
      setFirstRunState('completed');
      return;
    }

    setFirstRunState('loading');
    try {
      const client = new SidjuaApiClient(config.serverUrl, config.apiKey);
      const res    = await client.getWorkspaceConfig();
      setFirstRunState(res.firstRunCompleted ? 'completed' : 'pending');
    } catch {
      // Network error — show error state with retry button; do NOT auto-complete
      setFirstRunState('error');
    }
  }, [config.serverUrl, config.apiKey, isBootstrapSession]);

  useEffect(() => {
    void checkFirstRun();
  }, [checkFirstRun]);

  const handleDismiss = useCallback(async () => {
    setFirstRunState('completed');  // optimistic update — hide overlay immediately

    if (!config.serverUrl || !config.apiKey) return;
    try {
      const client = new SidjuaApiClient(config.serverUrl, config.apiKey);
      await client.completeFirstRun();
    } catch {
      // Non-fatal — overlay is already hidden; next load may show it again
    }
  }, [config.serverUrl, config.apiKey]);

  return (
    <HashRouter>
      <AppRoutes firstRunState={firstRunState} onDismiss={handleDismiss} onRetry={checkFirstRun} />
    </HashRouter>
  );
}


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
      {/* Show overlay when first run is pending or errored */}
      {(firstRunState === 'pending' || firstRunState === 'error') && (
        <FirstRunOverlay
          onDismiss={onDismiss}
          onGoToSettings={handleGoToSettings}
          networkError={firstRunState === 'error'}
          onRetry={onRetry}
        />
      )}

      {/* Main app — always rendered but visually covered by overlay when shown */}
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
          {/* Catch-all → dashboard */}
          <Route path="*"           element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}


export default function App() {
  return (
    <ThemeProvider>
      <AppConfigProvider>
        <ToastProvider>
        <ErrorBoundary>
          <AppWithFirstRunGate />
        </ErrorBoundary>
        </ToastProvider>
      </AppConfigProvider>
    </ThemeProvider>
  );
}
