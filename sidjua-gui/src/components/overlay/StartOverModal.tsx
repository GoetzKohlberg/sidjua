// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA GUI — StartOverModal (P193)
 *
 * Modal that mirrors the `sidjua start-over` CLI flow:
 *   1. Workspace summary
 *   2. Backup message (encouraging, not alarming)
 *   3. Learning prompt
 *   4. Confirmation: "Back Up & Start Fresh" / "Keep Current Workspace"
 *
 * Color: amber/orange (not red — this is not a destructive action).
 * Tone: supportive mentor.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAppConfig } from '../../lib/config';
import { formatGuiError } from '../../i18n/gui-errors';
import { useTranslation } from '../../hooks/useTranslation';


interface WorkspaceSummaryData {
  agentCount:      number;
  divisionCount:   number;
  chatHistories:   number;
  totalSizeBytes:  number;
}

type Phase =
  | 'summary'       // Step 1: Workspace summary
  | 'backup'        // Step 2: Backing up…
  | 'learn'         // Step 3: Learning prompt
  | 'confirm'       // Step 4: Confirmation
  | 'wiping'        // Step 5: Wiping + init
  | 'done'          // Step 6: Complete
  | 'error';        // Error state


function formatBytes(bytes: number): string {
  if (bytes < 1024)               return `${bytes} B`;
  if (bytes < 1024 * 1024)        return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}


function LoadingDots() {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const id = setInterval(() => {
      setDots((d) => d.length >= 3 ? '' : d + '.');
    }, 400);
    return () => clearInterval(id);
  }, []);
  return <span aria-hidden="true">{dots}</span>;
}


export interface StartOverModalProps {
  onComplete: () => void;   // called when start-over finishes — redirect to dashboard
  onCancel:   () => void;   // called when user cancels
}

export function StartOverModal({ onComplete, onCancel }: StartOverModalProps) {
  const { client }   = useAppConfig();
  const dialogRef    = useRef<HTMLDivElement>(null);
  const confirmRef   = useRef<HTMLButtonElement>(null);

  const [phase,      setPhase]      = useState<Phase>('summary');
  const [summary,    setSummary]    = useState<WorkspaceSummaryData | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const { t } = useTranslation();

  // Fetch workspace summary on mount
  useEffect(() => {
    if (!client) return;
    void (async () => {
      try {
        const data = await client.get<WorkspaceSummaryData>('/api/v1/workspace/summary');
          setSummary(data);
      } catch {
        setSummary({ agentCount: 0, divisionCount: 0, chatHistories: 0, totalSizeBytes: 0 });
      }
    })();
  }, [client]);

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && (phase === 'summary' || phase === 'confirm')) {
        onCancel();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [phase, onCancel]);

  // Focus confirm button when we reach that phase
  useEffect(() => {
    if (phase === 'confirm' && confirmRef.current) {
      confirmRef.current.focus();
    }
  }, [phase]);

  // --- Step 2: Start the backup ---
  const handleStartBackup = useCallback(async () => {
    if (!client) return;
    setPhase('backup');
    try {
      const data = await client.post<{ backup_path: string }>('/api/v1/workspace/backup', undefined, 60_000);
      setBackupPath(data.backup_path);
      setPhase('learn');
    } catch (err: unknown) {
      setError(formatGuiError(err));
      setPhase('error');
    }
  }, [client]);

  // --- Step 5: Wipe + fresh init ---
  const handleConfirm = useCallback(async () => {
    if (!client) return;
    setPhase('wiping');
    try {
      await client.post<{ cleared: boolean }>('/api/v1/workspace/wipe', undefined, 60_000);
      setPhase('done');
    } catch (err: unknown) {
      setError(formatGuiError(err));
      setPhase('error');
    }
  }, [client]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="start-over-title"
      style={{
        position:         'fixed',
        inset:            0,
        zIndex:           9998,
        background:       'rgba(0, 0, 0, 0.55)',
        display:          'flex',
        alignItems:       'center',
        justifyContent:   'center',
        padding:          '16px',
      }}
      onClick={(e) => {
        // Close on backdrop click only in cancellable phases
        if (e.target === e.currentTarget && (phase === 'summary' || phase === 'confirm')) {
          onCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        style={{
          background:   'var(--color-surface)',
          border:       '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow:    'var(--shadow-md)',
          width:        '100%',
          maxWidth:     '520px',
          padding:      '32px',
          display:      'flex',
          flexDirection:'column',
          gap:          '20px',
        }}
      >
        {/* Phase: summary */}
        {phase === 'summary' && (
          <>
            <div>
              <h2
                id="start-over-title"
                style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-text)', marginBottom: '6px' }}
              >
                {t('gui.start_over.title')}
              </h2>
              <p style={{ fontSize: '15px', color: 'var(--color-text-secondary)' }}>
                {t('gui.start_over.subtitle')}
              </p>
            </div>

            {summary && (
              <div style={{
                background:   'var(--color-bg)',
                border:       '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                padding:      '16px',
                fontSize:     '15px',
                lineHeight:   '1.7',
                color:        'var(--color-text-secondary)',
              }}>
                <div style={{ fontWeight: 600, color: 'var(--color-text)', marginBottom: '8px' }}>
                  {t('gui.start_over.current_workspace')}
                </div>
                <div>{t('gui.start_over.label_agents')}: <strong style={{ color: 'var(--color-text)' }}>{summary.agentCount}</strong></div>
                <div>{t('gui.start_over.label_divisions')}: <strong style={{ color: 'var(--color-text)' }}>{summary.divisionCount}</strong></div>
                <div>{t('gui.start_over.label_chat_histories')}: <strong style={{ color: 'var(--color-text)' }}>{summary.chatHistories}</strong></div>
                <div>{t('gui.start_over.label_size')}: <strong style={{ color: 'var(--color-text)' }}>{formatBytes(summary.totalSizeBytes)}</strong></div>
              </div>
            )}

            <div style={{
              background:   '#fffbeb',
              border:       '1px solid #f59e0b',
              borderRadius: 'var(--radius-md)',
              padding:      '14px 16px',
              fontSize:     '15px',
              color:        '#92400e',
              lineHeight:   '1.6',
            }}>
              <strong>{t('gui.start_over.valuable_work')}</strong><br />
              {t('gui.start_over.backup_everything')}
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={onCancel}
                style={cancelButtonStyle}
              >
                {t('gui.start_over.keep_current')}
              </button>
              <button
                onClick={() => { void handleStartBackup(); }}
                disabled={summary === null}
                style={amberButtonStyle(summary === null)}
              >
                {t('gui.start_over.back_up_start_fresh')}
              </button>
            </div>
          </>
        )}

        {/* Phase: backup */}
        {phase === 'backup' && (
          <>
            <h2 id="start-over-title" style={headingStyle}>{t('gui.start_over.backing_up_title')}</h2>
            <p style={bodyStyle}>
              {t('gui.start_over.backing_up_body')}<LoadingDots />
            </p>
            <div style={progressBarContainerStyle}>
              <div style={progressBarIndeterminateStyle} />
            </div>
          </>
        )}

        {/* Phase: learn */}
        {phase === 'learn' && (
          <>
            <h2 id="start-over-title" style={headingStyle}>{t('gui.start_over.before_continue_title')}</h2>

            <div style={{ fontSize: '16px', color: 'var(--color-text)', lineHeight: '1.7' }}>
              <p style={{ marginBottom: '12px' }}>
                {t('gui.start_over.learn_body_1')}
              </p>
              <div style={{
                background:   'var(--color-bg)',
                border:       '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                padding:      '10px 14px',
                fontFamily:   'monospace',
                fontSize:     '16px',
                color:        'var(--color-text)',
                wordBreak:    'break-all',
              }}>
                sidjua analyze --workspace {backupPath}
              </div>
              <p style={{ marginTop: '12px', color: 'var(--color-text-secondary)' }}>
                {t('gui.start_over.learn_body_2')}
              </p>
            </div>

            <div style={{
              background:   'var(--color-bg)',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding:      '12px 14px',
              fontSize:     '16px',
              color:        'var(--color-text-secondary)',
            }}>
              {t('gui.start_over.backup_saved')}<br />
              <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{backupPath}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                ref={confirmRef}
                onClick={() => setPhase('confirm')}
                style={amberButtonStyle(false)}
              >
                {t('gui.start_over.continue_btn')}
              </button>
            </div>
          </>
        )}

        {/* Phase: confirm */}
        {phase === 'confirm' && (
          <>
            <h2 id="start-over-title" style={headingStyle}>{t('gui.start_over.ready_wipe_title')}</h2>
            <p style={bodyStyle}>
              {t('gui.start_over.wipe_warning')}{' '}{t('gui.start_over.backup_safe_at')}
            </p>
            <div style={{
              background:   'var(--color-bg)',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding:      '10px 14px',
              fontFamily:   'monospace',
              fontSize:     '16px',
              wordBreak:    'break-all',
            }}>
              {backupPath}
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button onClick={onCancel} style={cancelButtonStyle}>
                {t('gui.start_over.keep_current')}
              </button>
              <button
                ref={confirmRef}
                onClick={() => { void handleConfirm(); }}
                style={amberButtonStyle(false)}
              >
                {t('gui.start_over.wipe_btn')}
              </button>
            </div>
          </>
        )}

        {/* Phase: wiping */}
        {phase === 'wiping' && (
          <>
            <h2 id="start-over-title" style={headingStyle}>{t('gui.start_over.starting_fresh_title')}</h2>
            <p style={bodyStyle}>
              {t('gui.start_over.starting_fresh_body')}<LoadingDots />
            </p>
            <div style={progressBarContainerStyle}>
              <div style={progressBarIndeterminateStyle} />
            </div>
          </>
        )}

        {/* Phase: done */}
        {phase === 'done' && (
          <>
            <h2 id="start-over-title" style={headingStyle}>{t('gui.start_over.done_title')}</h2>
            <p style={bodyStyle}>
              {t('gui.start_over.done_body')}
            </p>
            <div style={{
              background:   'var(--color-bg)',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding:      '10px 14px',
              fontFamily:   'monospace',
              fontSize:     '16px',
              wordBreak:    'break-all',
            }}>
              {backupPath}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={onComplete}
                style={{
                  padding:      '10px 24px',
                  borderRadius: 'var(--radius-md)',
                  border:       'none',
                  background:   'var(--color-accent)',
                  color:        'var(--color-on-accent)',
                  fontWeight:   600,
                  fontSize:     '16px',
                  cursor:       'pointer',
                }}
              >
                {t('gui.start_over.go_dashboard')}
              </button>
            </div>
          </>
        )}

        {/* Phase: error */}
        {phase === 'error' && (
          <>
            <h2 id="start-over-title" style={headingStyle}>{t('gui.start_over.error_title')}</h2>
            <p style={{ fontSize: '15px', color: 'var(--color-danger)', lineHeight: '1.6' }}>
              {error}
            </p>
            <p style={bodyStyle}>
              {t('gui.start_over.error_body')}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onCancel} style={cancelButtonStyle}>
                {t('gui.start_over.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


const headingStyle: React.CSSProperties = {
  fontSize:   '18px',
  fontWeight: 700,
  color:      'var(--color-text)',
  margin:     0,
};

const bodyStyle: React.CSSProperties = {
  fontSize:   '16px',
  color:      'var(--color-text-secondary)',
  lineHeight: '1.6',
  margin:     0,
};

const cancelButtonStyle: React.CSSProperties = {
  padding:      '9px 18px',
  borderRadius: 'var(--radius-md)',
  border:       '1px solid var(--color-border)',
  background:   'var(--color-surface)',
  color:        'var(--color-text)',
  fontWeight:   500,
  fontSize:     '16px',
  cursor:       'pointer',
};

function amberButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding:      '9px 20px',
    borderRadius: 'var(--radius-md)',
    border:       'none',
    background:   disabled ? 'var(--color-border)' : '#f59e0b',
    color:        disabled ? 'var(--color-text-muted)' : '#1a1200',
    fontWeight:   600,
    fontSize:     '16px',
    cursor:       disabled ? 'not-allowed' : 'pointer',
    transition:   'background 0.15s ease',
  };
}

const progressBarContainerStyle: React.CSSProperties = {
  height:       '4px',
  background:   'var(--color-border)',
  borderRadius: '2px',
  overflow:     'hidden',
};

const progressBarIndeterminateStyle: React.CSSProperties = {
  height:         '100%',
  width:          '40%',
  background:     '#f59e0b',
  borderRadius:   '2px',
  animation:      'sidjua-indeterminate 1.4s ease-in-out infinite',
};
