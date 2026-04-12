// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — ConfirmDialog
 *
 * Modal confirmation dialog. Supports a danger variant, an optional
 * requireInput field (user must type a string to unlock confirm),
 * and Escape-to-cancel. Focus lands on Cancel by default.
 */

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

export interface ConfirmDialogProps {
  open:          boolean;
  title:         string;
  message:       React.ReactNode;
  confirmLabel?: string;
  cancelLabel?:  string;
  /** Red confirm button + warning icon */
  danger?:       boolean;
  /** User must type this exact string before confirm is enabled */
  requireInput?: string;
  onConfirm:     () => void;
  onCancel:      () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
  danger       = false,
  requireInput,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

  // Reset input and set focus when dialog opens
  useEffect(() => {
    if (!open) {
      setInputValue('');
      return;
    }
    const t = setTimeout(() => {
      if (requireInput) inputRef.current?.focus();
      else              cancelRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [open, requireInput]);

  // Escape closes
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const canConfirm = !requireInput || inputValue === requireInput;
  const confirmBg  = canConfirm
    ? (danger ? 'var(--color-danger)' : 'var(--color-accent)')
    : 'var(--color-border)';

  return (
    /* Backdrop — click outside to cancel */
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position:       'fixed',
        inset:          0,
        background:     'var(--color-modal-overlay)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        zIndex:         10000,
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        style={{
          background:   'var(--color-surface)',
          border:       '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          padding:      '24px',
          width:        '440px',
          maxWidth:     'calc(100vw - 48px)',
          boxShadow:    'var(--shadow-lg)',
        }}
      >
        {/* Title row */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '12px' }}>
          {danger && (
            <AlertTriangle
              size={22}
              style={{ color: 'var(--color-danger)', flexShrink: 0, marginTop: '1px' }}
            />
          )}
          <h2
            id="confirm-dialog-title"
            style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}
          >
            {title}
          </h2>
        </div>

        {/* Message */}
        <div style={{
          fontSize:     '15px',
          color:        'var(--color-text-secondary)',
          marginBottom: '16px',
          lineHeight:   1.5,
        }}>
          {message}
        </div>

        {/* requireInput field */}
        {requireInput && (
          <div style={{ marginBottom: '16px' }}>
            <p style={{ fontSize: '16px', color: 'var(--color-text-muted)', marginBottom: '6px' }}>
              Type{' '}
              <strong style={{ fontFamily: 'monospace', color: 'var(--color-text)' }}>
                {requireInput}
              </strong>{' '}
              to confirm:
            </p>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm) onConfirm(); }}
              placeholder={requireInput}
              style={{
                width:        '100%',
                padding:      '8px 10px',
                borderRadius: 'var(--radius-md)',
                border:       '1px solid var(--color-border)',
                background:   'var(--color-bg)',
                color:        'var(--color-text)',
                fontSize:     '15px',
                fontFamily:   'monospace',
                boxSizing:    'border-box',
                outline:      'none',
              }}
            />
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            ref={cancelRef}
            onClick={onCancel}
            style={{
              padding:      '8px 18px',
              borderRadius: 'var(--radius-md)',
              border:       '1px solid var(--color-border)',
              background:   'var(--color-surface)',
              color:        'var(--color-text)',
              fontSize:     '15px',
              cursor:       'pointer',
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            style={{
              padding:      '8px 18px',
              borderRadius: 'var(--radius-md)',
              border:       'none',
              background:   confirmBg,
              color:        canConfirm ? 'var(--color-on-accent)' : 'var(--color-text-muted)',
              fontSize:     '15px',
              fontWeight:   600,
              cursor:       canConfirm ? 'pointer' : 'not-allowed',
              transition:   'background var(--transition-fast)',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
