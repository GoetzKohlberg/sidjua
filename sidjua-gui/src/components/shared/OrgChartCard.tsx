// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React from 'react';
import type { OrgNode } from '../../api/types';
import { AgentIcon } from './AgentIcon';

interface OrgChartCardProps {
  node:        OrgNode;
  isSelected:  boolean;
  onClick:     (node: OrgNode) => void;
  /** True if this division node has child divisions (shows expand indicator). */
  hasChildren: boolean;
}

export function OrgChartCard({ node, isSelected, onClick, hasChildren }: OrgChartCardProps) {
  const div     = node.division;
  const active  = div.active;
  const ledColor = active ? 'var(--color-success, #22c55e)' : 'var(--color-text-muted, #6b7280)';

  return (
    <button
      onClick={() => onClick(node)}
      aria-selected={isSelected}
      aria-expanded={hasChildren ? isSelected : undefined}
      style={{
        display:       'flex',
        flexDirection: 'column',
        gap:           '4px',
        padding:       '12px 16px',
        minWidth:      '180px',
        maxWidth:      '240px',
        background:    isSelected ? 'var(--color-accent-muted)' : 'var(--color-surface)',
        border:        `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius:  'var(--radius-md)',
        cursor:        'pointer',
        transition:    'all var(--transition-base)',
        textAlign:     'left',
        color:         'var(--color-text)',
        fontFamily:    'inherit',
        fontSize:      '13px',
        position:      'relative',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.borderColor = 'var(--color-accent-muted)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.borderColor = 'var(--color-border)';
      }}
    >
      {/* Status LED */}
      <span
        style={{
          position:        'absolute',
          top:             '8px',
          right:           '8px',
          width:           '8px',
          height:          '8px',
          borderRadius:    '50%',
          backgroundColor: ledColor,
          animation:       active ? 'sidjua-pulse 1.5s infinite' : 'none',
        }}
        title={active ? 'active' : 'inactive'}
      />

      {/* Header: Icon + Division name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <AgentIcon name={div.name_en} size={24} />
        <div style={{ overflow: 'hidden' }}>
          <div style={{
            fontWeight:    600,
            fontSize:      '13px',
            whiteSpace:    'nowrap',
            overflow:      'hidden',
            textOverflow:  'ellipsis',
            paddingRight:  '16px',
          }}>
            {div.name_en}
          </div>
          {div.head_role && (
            <div style={{
              fontSize:     '11px',
              color:        'var(--color-text-secondary)',
              whiteSpace:   'nowrap',
              overflow:     'hidden',
              textOverflow: 'ellipsis',
            }}>
              {div.head_role}
            </div>
          )}
        </div>
      </div>

      {/* Agent count */}
      {node.agents.length > 0 && (
        <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
          {node.agents.length} agent{node.agents.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Expand indicator */}
      {hasChildren && (
        <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
          ▾ {node.children.length} sub-division{node.children.length !== 1 ? 's' : ''}
        </div>
      )}
    </button>
  );
}
