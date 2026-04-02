// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — Update notification banners (P368)
 *
 * UpdateBanner       — shows when a new version is available
 * MaintenanceBanner  — shows while an update is in progress
 * AgentsPausedBadge  — inline indicator when agents are FROZEN
 * UpdateProgressDialog — SSE-driven progress dialog during updates
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useAppConfig }   from '../../lib/config';

// ---------------------------------------------------------------------------
// UpdateBanner
// ---------------------------------------------------------------------------

interface VersionInfo {
  current:   string;
  latest:    string;
  hasUpdate: boolean;
}

export function UpdateBanner() {
  const { t }           = useTranslation();
  const { config }      = useAppConfig();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [showDialog, setShowDialog] = useState(false);

  useEffect(() => {
    if (!config.apiKey) return;
    fetch('/api/v1/update/check', {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    })
      .then((r) => r.ok ? r.json() as Promise<VersionInfo> : null)
      .then((v) => { if (v?.hasUpdate) setInfo(v); })
      .catch(() => { /* best-effort */ });
  }, [config.apiKey]);

  if (!info || dismissed) return null;

  return (
    <>
      <div style={{
        background:   'var(--color-info-bg, #e8f4fd)',
        border:       '1px solid var(--color-info, #2196f3)',
        borderRadius: 'var(--radius-md, 6px)',
        padding:      '10px 16px',
        marginBottom: '12px',
        fontSize:     '13px',
        color:        'var(--color-info, #1565c0)',
        display:      'flex',
        alignItems:   'center',
        gap:          '10px',
      }}>
        <span style={{ flex: 1 }}>
          {t('update.available', { version: info.latest })}
        </span>
        <button
          onClick={() => setShowDialog(true)}
          style={{
            background:   'var(--color-info, #2196f3)',
            border:       'none',
            borderRadius: 'var(--radius-sm, 4px)',
            color:        '#fff',
            cursor:       'pointer',
            padding:      '4px 12px',
            fontSize:     '12px',
            fontWeight:   600,
          }}
        >
          {t('update.now')}
        </button>
        <button
          onClick={() => setDismissed(true)}
          style={{
            background:   'none',
            border:       '1px solid var(--color-info, #2196f3)',
            borderRadius: 'var(--radius-sm, 4px)',
            color:        'var(--color-info, #1565c0)',
            cursor:       'pointer',
            padding:      '4px 10px',
            fontSize:     '12px',
          }}
        >
          {t('update.later')}
        </button>
      </div>
      {showDialog && (
        <UpdateProgressDialog
          targetVersion={info.latest}
          onClose={() => setShowDialog(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// MaintenanceBanner
// ---------------------------------------------------------------------------

export function MaintenanceBanner() {
  const { t }           = useTranslation();
  const { config }      = useAppConfig();
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!config.apiKey) return;
    let cancelled = false;

    const poll = () => {
      fetch('/api/v1/system/state', {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      })
        .then((r) => r.ok ? r.json() as Promise<{ state: string }> : null)
        .then((s) => {
          if (!cancelled) setActive(s?.state === 'FREEZING' || s?.state === 'FROZEN');
        })
        .catch(() => { /* best-effort */ });
    };

    poll();
    const interval = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [config.apiKey]);

  if (!active) return null;

  return (
    <div style={{
      background:   'var(--color-warning-bg, #fff8e1)',
      border:       '1px solid var(--color-warning, #ff8f00)',
      borderRadius: 'var(--radius-md, 6px)',
      padding:      '10px 16px',
      marginBottom: '12px',
      fontSize:     '13px',
      color:        'var(--color-warning, #e65100)',
      display:      'flex',
      alignItems:   'center',
      gap:          '8px',
    }}>
      <span>⏸</span>
      <span>{t('update.maintenance')}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentsPausedBadge
// ---------------------------------------------------------------------------

export function AgentsPausedBadge() {
  const { t }           = useTranslation();
  const { config }      = useAppConfig();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!config.apiKey) return;
    let cancelled = false;

    const poll = () => {
      fetch('/api/v1/system/state', {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      })
        .then((r) => r.ok ? r.json() as Promise<{ state: string }> : null)
        .then((s) => {
          if (!cancelled) setPaused(s?.state === 'FROZEN');
        })
        .catch(() => { /* best-effort */ });
    };

    poll();
    const interval = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [config.apiKey]);

  if (!paused) return null;

  return (
    <span style={{
      display:      'inline-flex',
      alignItems:   'center',
      gap:          '4px',
      background:   'var(--color-warning-bg, #fff8e1)',
      border:       '1px solid var(--color-warning, #ff8f00)',
      borderRadius: '12px',
      padding:      '2px 8px',
      fontSize:     '11px',
      color:        'var(--color-warning, #e65100)',
      fontWeight:   600,
    }}>
      ⏸ {t('update.agents_paused')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// UpdateProgressDialog
// ---------------------------------------------------------------------------

interface UpdateProgressDialogProps {
  targetVersion: string;
  onClose: () => void;
}

interface ProgressEvent {
  step:    string;
  done?:   boolean;
  error?:  string;
}

export function UpdateProgressDialog({ targetVersion, onClose }: UpdateProgressDialogProps) {
  const { t }       = useTranslation();
  const { config }  = useAppConfig();
  const [steps, setSteps]   = useState<string[]>([]);
  const [done, setDone]     = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const startUpdate = useCallback(() => {
    if (esRef.current) esRef.current.close();

    const url = `/api/v1/update/start?targetVersion=${encodeURIComponent(targetVersion)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as ProgressEvent;
        if (evt.error) {
          setError(evt.error);
          es.close();
        } else if (evt.done) {
          setDone(true);
          es.close();
        } else {
          setSteps((prev) => [...prev, evt.step]);
        }
      } catch (_err) { /* ignore parse errors */ }
    };
    es.onerror = () => {
      setError('Connection lost');
      es.close();
    };
  }, [targetVersion]);

  const startRollback = useCallback(() => {
    setRolling(true);
    setSteps([]);
    setDone(false);
    setError(null);

    if (esRef.current) esRef.current.close();
    const es = new EventSource('/api/v1/update/rollback');
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as ProgressEvent;
        if (evt.error) {
          setError(evt.error);
          es.close();
        } else if (evt.done) {
          setDone(true);
          es.close();
        } else {
          setSteps((prev) => [...prev, evt.step]);
        }
      } catch (_err) { /* ignore parse errors */ }
    };
    es.onerror = () => {
      setError('Connection lost');
      es.close();
    };
  }, []);

  useEffect(() => {
    startUpdate();
    return () => { esRef.current?.close(); };
  }, [startUpdate]);

  return (
    <div style={{
      position:       'fixed',
      inset:          0,
      background:     'rgba(0,0,0,0.5)',
      zIndex:         1000,
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
    }}>
      <div style={{
        background:   'var(--color-card-bg, #fff)',
        border:       '1px solid var(--color-border, #e0e0e0)',
        borderRadius: 'var(--radius-lg, 8px)',
        padding:      '24px',
        minWidth:     '360px',
        maxWidth:     '480px',
        boxShadow:    '0 8px 32px rgba(0,0,0,0.2)',
      }}>
        <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>
          {t('update.progress.title')}
        </h3>

        <div style={{
          maxHeight:  '200px',
          overflowY:  'auto',
          fontSize:   '12px',
          fontFamily: 'monospace',
          background: 'var(--color-code-bg, #f5f5f5)',
          borderRadius: '4px',
          padding:    '8px',
          marginBottom: '16px',
        }}>
          {steps.map((s, i) => (
            <div key={i}>{t('update.progress.step', { step: s })}</div>
          ))}
          {done  && <div style={{ color: 'green', fontWeight: 600 }}>{t('update.progress.done')}</div>}
          {error && <div style={{ color: 'red',   fontWeight: 600 }}>{t('update.progress.error', { message: error })}</div>}
        </div>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          {error && !rolling && (
            <button
              onClick={startRollback}
              style={{
                background:   'var(--color-danger, #d32f2f)',
                border:       'none',
                borderRadius: 'var(--radius-sm, 4px)',
                color:        '#fff',
                cursor:       'pointer',
                padding:      '6px 14px',
                fontSize:     '13px',
              }}
            >
              {t('update.rollback')}
            </button>
          )}
          {(done || error) && (
            <button
              onClick={onClose}
              style={{
                background:   'var(--color-primary, #1976d2)',
                border:       'none',
                borderRadius: 'var(--radius-sm, 4px)',
                color:        '#fff',
                cursor:       'pointer',
                padding:      '6px 14px',
                fontSize:     '13px',
              }}
            >
              {t('gui.common.close')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
