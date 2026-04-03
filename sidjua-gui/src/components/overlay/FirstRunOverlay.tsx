// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA GUI — First-Run Expectations Overlay
 *
 * Displays a full-screen overlay on first run to set user expectations.
 * The dismiss button is hidden for FIRST_RUN_READ_DELAY_MS, then fades in.
 * Blocks all interaction with the GUI underneath until dismissed.
 */

import React, { useState, useEffect, useRef } from 'react';
import { FIRST_RUN_READ_DELAY_MS } from '../../constants/firstRun';
import { useTranslation } from '../../hooks/useTranslation';



export interface FirstRunOverlayProps {
  onDismiss: () => void;
  onGoToSettings?: () => void;
  /** True when the server check failed with a network error — shows retry UI. */
  networkError?: boolean;
  onRetry?: () => void;
}


export function FirstRunOverlay({ onDismiss, onGoToSettings, networkError = false, onRetry }: FirstRunOverlayProps) {
  const totalSeconds = Math.round(FIRST_RUN_READ_DELAY_MS / 1000);
  const [countdown,  setCountdown]  = useState(totalSeconds);
  const [canProceed, setCanProceed] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { t } = useTranslation();

  const heading           = t('gui.overlay.heading');
  const emphasis          = t('gui.overlay.emphasis');
  const closing           = t('gui.overlay.closing');
  const fullText          = t('gui.overlay.text');
  const dismissLabel      = t('gui.overlay.dismiss');
  // Countdown tick: button is always visible; becomes active at 0
  useEffect(() => {
    if (totalSeconds <= 0) { setCanProceed(true); return; }
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setCanProceed(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [totalSeconds]);

  // Focus button once it becomes active (accessibility)
  useEffect(() => {
    if (canProceed && buttonRef.current) {
      buttonRef.current.focus();
    }
  }, [canProceed]);

  // Allow Enter key to dismiss once button is active
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (canProceed && e.key === 'Enter') {
        onDismiss();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canProceed, onDismiss]);

  // Build paragraph blocks (split on double newline, skip the emphasis and closing lines)
  const paragraphs = fullText
    .split('\n\n')
    .filter((p) => p.trim() !== emphasis && p.trim() !== closing);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-heading"
      style={{
        position:       'fixed',
        inset:          0,
        zIndex:         9999,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        background:     'var(--color-overlay-bg)',
        // Block all pointer interaction with content behind
        pointerEvents:  'all',
      }}
    >
      {/* Content card */}
      <div
        style={{
          background:   'var(--color-surface)',
          border:       '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow:    'var(--shadow-lg)',
          maxWidth:     '600px',
          width:        'calc(100vw - 48px)',
          maxHeight:    'calc(100vh - 80px)',
          overflowY:    'auto',
          padding:      '40px 48px',
        }}
      >
        {/* Heading */}
        <h1
          id="first-run-heading"
          style={{
            fontSize:     '24px',
            fontWeight:   700,
            color:        'var(--color-text)',
            margin:       '0 0 24px 0',
            lineHeight:   1.3,
          }}
        >
          {heading}
        </h1>

        {/* Body paragraphs */}
        {paragraphs.map((para, i) => (
          <p
            key={i}
            style={{
              color:      'var(--color-text)',
              fontSize:   '15px',
              lineHeight: 1.7,
              margin:     '0 0 16px 0',
            }}
          >
            {para.trim()}
          </p>
        ))}

        {/* Emphasis line */}
        <p
          style={{
            color:      'var(--color-text)',
            fontSize:   '17px',
            fontWeight: 700,
            lineHeight: 1.5,
            margin:     '0 0 16px 0',
          }}
        >
          {emphasis}
        </p>

        {/* Closing line */}
        <p
          style={{
            color:        'var(--color-accent)',
            fontSize:     '16px',
            fontWeight:   600,
            lineHeight:   1.5,
            margin:       '0 0 32px 0',
          }}
        >
          {closing}
        </p>

        {/* Network error banner */}
        {networkError && (
          <div
            role="alert"
            style={{
              background:   'var(--color-danger-subtle, rgba(239,68,68,0.08))',
              border:       '1px solid var(--color-danger)',
              borderRadius: 'var(--radius-md)',
              padding:      '12px 16px',
              marginBottom: '24px',
              display:      'flex',
              alignItems:   'center',
              justifyContent: 'space-between',
              gap:          '12px',
            }}
          >
            <p style={{ margin: 0, fontSize: '14px', color: 'var(--color-danger)' }}>
              {t('gui.first_run.connection_error')}{' '}<code>docker start sidjua</code>
            </p>
            {onRetry && (
              <button
                onClick={onRetry}
                style={{
                  background:   'var(--color-danger)',
                  color:        '#fff',
                  border:       'none',
                  borderRadius: 'var(--radius-sm)',
                  padding:      '6px 14px',
                  fontSize:     '13px',
                  fontWeight:   600,
                  cursor:       'pointer',
                  flexShrink:   0,
                }}
              >
                {t('gui.first_run.retry')}
              </button>
            )}
          </div>
        )}

        {/* Dismiss area */}
        <div
          style={{
            display:        'flex',
            flexDirection:  'column',
            alignItems:     'center',
            gap:            '12px',
          }}
        >
          {/* Dismiss button — always visible; disabled with countdown until ready */}
          <button
            ref={buttonRef}
            onClick={onDismiss}
            disabled={!canProceed}
            aria-label={canProceed ? dismissLabel : `${dismissLabel} (${countdown})`}
            style={{
              background:    canProceed ? 'var(--color-accent)' : 'var(--color-border)',
              color:         canProceed ? 'var(--color-text-inverse)' : 'var(--color-text-muted)',
              border:        'none',
              borderRadius:  'var(--radius-md)',
              padding:       '12px 28px',
              fontSize:      '15px',
              fontWeight:    600,
              cursor:        canProceed ? 'pointer' : 'not-allowed',
              transition:    'background 300ms ease, color 300ms ease',
            }}
          >
            {canProceed ? dismissLabel : `${dismissLabel} (${countdown})`}
          </button>
        </div>
      </div>
    </div>
  );
}
