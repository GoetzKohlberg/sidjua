// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React from 'react';

interface Props {
  value:  number;  // 0–100
  label?: string;
  color?: string;
}

export function ProgressBar({ value, label, color }: Props) {
  const clamped = Math.min(100, Math.max(0, value));

  // Dynamic colour based on value unless overridden
  const barColor = color ?? (
    clamped >= 90 ? 'var(--color-danger)' :
    clamped >= 70 ? 'var(--color-warning)' :
    'var(--color-success)'
  );

  return (
    <div>
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'center',
        marginBottom:   '6px',
        fontSize:       '16px',
        color:          'var(--color-text-secondary)',
      }}>
        {label && <span>{label}</span>}
        <span style={{ fontWeight: 600, marginLeft: 'auto' }}>{clamped.toFixed(0)}%</span>
      </div>
      <div style={{
        width:        '100%',
        height:       '6px',
        background:   'var(--color-border)',
        borderRadius: '3px',
        overflow:     'hidden',
      }}>
        <div style={{
          width:        `${clamped}%`,
          height:       '100%',
          background:   barColor,
          borderRadius: '3px',
          transition:   'width 0.4s ease',
        }} />
      </div>
    </div>
  );
}
