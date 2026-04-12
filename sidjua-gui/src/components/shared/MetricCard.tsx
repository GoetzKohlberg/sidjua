// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { type ReactNode } from 'react';

interface Props {
  title:     string;
  value:     ReactNode;
  subtitle?: string;
  icon?:     ReactNode;
  onClick?:  () => void;
}

export function MetricCard({ title, value, subtitle, icon, onClick }: Props) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
      style={{
        background:    'var(--color-surface)',
        border:        '1px solid var(--color-border)',
        borderRadius:  'var(--radius-lg)',
        padding:       '20px',
        boxShadow:     'var(--shadow-sm)',
        cursor:        onClick ? 'pointer' : 'default',
        transition:    'box-shadow var(--transition-fast), border-color var(--transition-fast)',
        display:       'flex',
        alignItems:    'flex-start',
        justifyContent:'space-between',
        gap:           '12px',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-md)';
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-accent)';
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-sm)';
        (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-border)';
      }}
    >
      <div>
        <p style={{
          fontSize:     '16px',
          fontWeight:   500,
          color:        'var(--color-text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '8px',
        }}>
          {title}
        </p>
        <p style={{
          fontSize:   '28px',
          fontWeight: 700,
          color:      'var(--color-text)',
          lineHeight: 1,
          marginBottom: subtitle ? '6px' : 0,
        }}>
          {value}
        </p>
        {subtitle && (
          <p style={{ fontSize: '16px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
            {subtitle}
          </p>
        )}
      </div>

      {icon && (
        <div style={{
          color:      'var(--color-text-muted)',
          flexShrink: 0,
          marginTop:  '2px',
        }}>
          {icon}
        </div>
      )}
    </div>
  );
}
