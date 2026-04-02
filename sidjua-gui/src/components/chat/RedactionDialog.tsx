// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — Bouncer Redaction Dialog
 *
 * Modal overlay shown before sending when the bouncer detects sensitive data.
 * Presents three options: Send anyway / Send redacted (default) / Cancel.
 */

import React, { useEffect, useRef } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import type { ScanResult } from '../../api/types';

export interface RedactionDialogProps {
  /** The scan result from the scan API */
  scanResult:      ScanResult;
  /** Original user message text */
  originalMessage: string;
  /** Called with the message to actually send (original or redacted) */
  onSend:          (message: string) => void;
  /** Called when user cancels */
  onCancel:        () => void;
}

/** Human-readable label for a pattern type */
function formatLabel(label: string): string {
  return label
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Render the original message with sensitive spans highlighted.
 * Matches are non-overlapping and sorted by start offset (guaranteed by backend).
 */
function HighlightedMessage({
  text,
  matches,
}: {
  text:    string;
  matches: ScanResult['matches'];
}): React.ReactElement {
  const parts: React.ReactNode[] = [];
  let pos = 0;

  for (const m of matches) {
    if (m.start > pos) {
      parts.push(<span key={`text-${pos}`}>{text.slice(pos, m.start)}</span>);
    }
    parts.push(
      <span
        key={`match-${m.start}`}
        title={formatLabel(m.label)}
        style={{
          background:   'var(--color-warning-muted, rgba(234, 179, 8, 0.2))',
          borderBottom: '2px solid var(--color-warning, #eab308)',
          borderRadius: '2px',
          padding:      '0 2px',
          cursor:       'default',
        }}
      >
        {text.slice(m.start, m.end)}
        <sub style={{
          fontSize:   '10px',
          color:      'var(--color-warning, #ca8a04)',
          fontWeight: 600,
          marginLeft: '2px',
        }}>
          {formatLabel(m.label)}
        </sub>
      </span>,
    );
    pos = m.end;
  }

  if (pos < text.length) {
    parts.push(<span key={`text-end`}>{text.slice(pos)}</span>);
  }

  return <>{parts}</>;
}

export function RedactionDialog({
  scanResult,
  originalMessage,
  onSend,
  onCancel,
}: RedactionDialogProps): React.ReactElement {
  const { t }         = useTranslation();
  const sendRedactRef = useRef<HTMLButtonElement>(null);

  // Auto-focus "Send redacted" button (the safe default)
  useEffect(() => {
    sendRedactRef.current?.focus();
  }, []);

  // Keyboard: Escape → cancel, Enter → send redacted (if focused)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const matchCount = scanResult.matches.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="redaction-dialog-title"
      style={{
        position:       'fixed',
        inset:          0,
        zIndex:         9999,
        background:     'rgba(0, 0, 0, 0.55)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        padding:        '16px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background:    'var(--color-surface)',
          border:        '1px solid var(--color-border)',
          borderRadius:  'var(--radius-lg)',
          boxShadow:     'var(--shadow-md)',
          width:         '100%',
          maxWidth:      '520px',
          padding:       '28px 32px',
          display:       'flex',
          flexDirection: 'column',
          gap:           '18px',
        }}
      >
        {/* Title */}
        <div>
          <h2
            id="redaction-dialog-title"
            style={{
              fontSize:    '17px',
              fontWeight:  700,
              color:       'var(--color-text)',
              margin:      0,
              marginBottom:'6px',
              display:     'flex',
              alignItems:  'center',
              gap:         '8px',
            }}
          >
            <span style={{ color: 'var(--color-warning, #ca8a04)', fontSize: '18px' }}>⚠</span>
            {t('gui.bouncer.dialog_title')}
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0 }}>
            {t('gui.bouncer.match_count').replace('{count}', String(matchCount))}
          </p>
        </div>

        {/* Original message with highlights */}
        <div>
          <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: '6px', marginTop: 0 }}>
            {t('gui.bouncer.dialog_body')}
          </p>
          <div style={{
            background:   'var(--color-bg)',
            border:       '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding:      '12px 14px',
            fontSize:     '13px',
            color:        'var(--color-text)',
            lineHeight:   '1.7',
            whiteSpace:   'pre-wrap',
            wordBreak:    'break-word',
            maxHeight:    '140px',
            overflowY:    'auto',
          }}>
            <HighlightedMessage text={originalMessage} matches={scanResult.matches} />
          </div>
        </div>

        {/* Redacted preview */}
        <div>
          <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: '6px', marginTop: 0 }}>
            {t('gui.bouncer.preview_label')}
          </p>
          <div style={{
            background:   'var(--color-bg)',
            border:       '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding:      '12px 14px',
            fontSize:     '13px',
            color:        'var(--color-text-secondary)',
            lineHeight:   '1.7',
            whiteSpace:   'pre-wrap',
            wordBreak:    'break-word',
            maxHeight:    '100px',
            overflowY:    'auto',
          }}>
            {scanResult.redacted}
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between', marginTop: '4px' }}>
          {/* Send anyway — left, ghost style */}
          <button
            onClick={() => onSend(originalMessage)}
            style={{
              padding:      '9px 16px',
              borderRadius: 'var(--radius-md)',
              border:       '1px solid var(--color-border)',
              background:   'var(--color-surface)',
              color:        'var(--color-text-secondary)',
              fontWeight:   500,
              fontSize:     '13px',
              cursor:       'pointer',
            }}
          >
            {t('gui.bouncer.send_anyway')}
          </button>

          <div style={{ display: 'flex', gap: '8px' }}>
            {/* Cancel */}
            <button
              onClick={onCancel}
              style={{
                padding:      '9px 16px',
                borderRadius: 'var(--radius-md)',
                border:       '1px solid var(--color-border)',
                background:   'var(--color-surface)',
                color:        'var(--color-text)',
                fontWeight:   500,
                fontSize:     '13px',
                cursor:       'pointer',
              }}
            >
              {t('gui.bouncer.cancel')}
            </button>

            {/* Send redacted — PRIMARY, auto-focused */}
            <button
              ref={sendRedactRef}
              onClick={() => onSend(scanResult.redacted)}
              style={{
                padding:      '9px 20px',
                borderRadius: 'var(--radius-md)',
                border:       'none',
                background:   'var(--color-accent)',
                color:        'var(--color-on-accent)',
                fontWeight:   600,
                fontSize:     '13px',
                cursor:       'pointer',
              }}
            >
              {t('gui.bouncer.send_redacted')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
