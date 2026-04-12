// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React from 'react';
import type { OrgNode, AgentStatus } from '../../api/types';
import { AgentIcon } from './AgentIcon';
import { useTranslation } from '../../hooks/useTranslation';

interface OrgChartCardProps {
  node:         OrgNode;
  isSelected:   boolean;
  onClick:      (node: OrgNode) => void;
  /** True if this division node has child divisions (shows expand indicator). */
  hasChildren:  boolean;
  /** Agent status data keyed by agent_id — optional P359 overlay. */
  agentStatuses?: Record<string, AgentStatus>;
}

function statusDotColor(status: AgentStatus): string {
  if (status.health === 'unhealthy') return 'var(--color-error, #ef4444)';
  if (status.health === 'unknown')   return 'var(--color-text-muted, #6b7280)';
  return 'var(--color-success, #22c55e)';
}

function statusDotAnimation(status: AgentStatus): string {
  return (status.health === 'healthy' && status.is_busy) ? 'sidjua-pulse 1.5s infinite' : 'none';
}

function formatAgo(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60)  return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  const hrs  = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

interface AgentStatusDotProps {
  status: AgentStatus;
}

function AgentStatusDot({ status }: AgentStatusDotProps) {
  const { t } = useTranslation();

  let tooltip: string;
  if (status.health === 'unhealthy') {
    const ago = status.last_heartbeat ? formatAgo(status.last_heartbeat) : '?';
    tooltip = t('gui.org.status_unhealthy').replace('{time}', ago);
  } else if (status.health === 'unknown') {
    tooltip = t('gui.org.status_unknown');
  } else {
    tooltip = t('gui.org.status_healthy');
  }

  if (status.is_busy) {
    tooltip += ' · ' + t('gui.org.status_busy');
  }

  if (status.recent_task_count > 0) {
    tooltip += ' · ' + t('gui.org.tasks_recent').replace('{count}', String(status.recent_task_count));
  }

  return (
    <span
      title={tooltip}
      style={{
        display:         'inline-block',
        width:           '8px',
        height:          '8px',
        borderRadius:    '50%',
        backgroundColor: statusDotColor(status),
        animation:       statusDotAnimation(status),
        flexShrink:      0,
      }}
    />
  );
}

export function OrgChartCard({ node, isSelected, onClick, hasChildren, agentStatuses }: OrgChartCardProps) {
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
        fontSize:      '15px',
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
            fontSize:      '15px',
            whiteSpace:    'nowrap',
            overflow:      'hidden',
            textOverflow:  'ellipsis',
            paddingRight:  '16px',
          }}>
            {div.name_en}
          </div>
          {div.head_role && (
            <div style={{
              fontSize:     '13px',
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
        <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
          {node.agents.length} agent{node.agents.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Per-agent status dots (P359) */}
      {agentStatuses !== undefined && node.agents.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' }}>
          {node.agents.map((agent) => {
            const st = agentStatuses[agent.id];
            if (st === undefined) return null;
            return (
              <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <AgentStatusDot status={st} />
                {st.recent_task_count > 0 && (
                  <span style={{
                    fontSize:     '11px',
                    color:        'var(--color-text-muted)',
                    background:   'var(--color-surface-alt, rgba(0,0,0,0.08))',
                    borderRadius: '4px',
                    padding:      '0 3px',
                    lineHeight:   '14px',
                  }}>
                    {st.recent_task_count}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Expand indicator */}
      {hasChildren && (
        <div style={{ fontSize: '14px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
          ▾ {node.children.length} sub-division{node.children.length !== 1 ? 's' : ''}
        </div>
      )}
    </button>
  );
}
