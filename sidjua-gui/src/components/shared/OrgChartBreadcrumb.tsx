// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React from 'react';

export interface BreadcrumbItem {
  id:        string;
  name:      string;
  role?: string | null;
}

interface OrgChartBreadcrumbProps {
  path:       BreadcrumbItem[];
  onNavigate: (index: number) => void;
}

export function OrgChartBreadcrumb({ path, onNavigate }: OrgChartBreadcrumbProps) {
  return (
    <nav
      aria-label="Org chart navigation"
      style={{
        display:    'flex',
        alignItems: 'center',
        gap:        '4px',
        padding:    '8px 0',
        fontSize:   '15px',
        flexWrap:   'wrap',
      }}
    >
      {path.map((item, i) => (
        <React.Fragment key={item.id}>
          {i > 0 && (
            <span style={{ color: 'var(--color-text-muted)', margin: '0 2px' }}>›</span>
          )}
          {i < path.length - 1 ? (
            <button
              onClick={() => onNavigate(i)}
              style={{
                background:  'none',
                border:      'none',
                color:       'var(--color-accent)',
                cursor:      'pointer',
                padding:     '2px 4px',
                borderRadius: 'var(--radius-sm)',
                fontSize:    '15px',
                fontFamily:  'inherit',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
            >
              {item.name}
            </button>
          ) : (
            <span style={{ color: 'var(--color-text)', fontWeight: 600, padding: '2px 4px' }}>
              {item.name}
            </span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
