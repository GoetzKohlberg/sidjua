// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React from 'react';
import { AgentIcon } from './AgentIcon';

export interface StarterAgentData {
  id:           string;
  name:         string;
  description:  string;
  icon:         string;
  tier:         1 | 2 | 3;
  division:     string;
  domains:      string[];
  capabilities: string[];
  status:       'active' | 'inactive';
}

interface AgentCardProps {
  agent:         StarterAgentData;
  selected?:     boolean;
  onClick?:      () => void;
  llmStatus?:    'configured' | 'not_configured' | undefined;
  providerLabel?: string; // display name of assigned provider
}

const TIER_COLORS: Record<number, { bg: string; text: string; label: string }> = {
  1: { bg: 'var(--color-tier-1-bg)', text: 'var(--color-tier-1-text)', label: 'T1' },
  2: { bg: 'var(--color-tier-2-bg)', text: 'var(--color-tier-2-text)', label: 'T2' },
  3: { bg: 'var(--color-tier-3-bg)', text: 'var(--color-tier-3-text)', label: 'T3' },
};

export function AgentCard({ agent, selected = false, onClick, llmStatus, providerLabel }: AgentCardProps) {
  const tier   = TIER_COLORS[agent.tier] ?? TIER_COLORS[2]!;
  const active = agent.status === 'active';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
      style={{
        background:   selected ? 'var(--color-accent-muted)' : 'var(--color-surface)',
        border:       `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-lg)',
        padding:      '16px',
        cursor:       onClick ? 'pointer' : 'default',
        display:      'flex',
        flexDirection: 'column',
        gap:          '10px',
        boxShadow:    'var(--shadow-sm)',
        transition:   'border-color 0.15s ease, box-shadow 0.15s ease',
        userSelect:   'none',
      }}
      onMouseEnter={(e) => {
        if (onClick) (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.1))';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-sm)';
      }}
    >
      {/* Header: icon + name + badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width:        '38px',
          height:       '38px',
          borderRadius: '50%',
          background:   'var(--color-accent-muted, #eff6ff)',
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'center',
          flexShrink:   0,
          color:        'var(--color-accent)',
        }}>
          <AgentIcon name={agent.icon} size={18} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight:   700,
            fontSize:     '16px',
            color:        'var(--color-text)',
            whiteSpace:   'nowrap',
            overflow:     'hidden',
            textOverflow: 'ellipsis',
          }}>
            {agent.name}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px' }}>
            {/* Tier badge */}
            <span style={{
              background:   tier.bg,
              color:        tier.text,
              fontSize:     '14px',
              fontWeight:   700,
              padding:      '2px 6px',
              borderRadius: '4px',
              letterSpacing: '0.03em',
            }}>
              {tier.label}
            </span>

            {/* Status dot */}
            <span
              title={active ? 'Active' : 'Inactive'}
              style={{
                display:      'inline-flex',
                alignItems:   'center',
                gap:          '4px',
                fontSize:     '13px',
                color:        active ? 'var(--color-success)' : 'var(--color-text-muted)',
              }}
            >
              <span style={{
                width:        '6px',
                height:       '6px',
                borderRadius: '50%',
                background:   active ? 'var(--color-success)' : 'var(--color-text-muted)',
                flexShrink:   0,
              }} />
              {active ? 'active' : 'inactive'}
            </span>
          </div>
        </div>
      </div>

      {/* LLM status badge */}
      {llmStatus !== undefined && (
        <div style={{
          display:      'flex',
          alignItems:   'center',
          gap:          '5px',
          fontSize:     '13px',
          fontWeight:   600,
          color:        llmStatus === 'configured' ? 'var(--color-success)' : 'var(--color-llm-warn-text)',
          background:   llmStatus === 'configured' ? 'var(--color-llm-ready-bg)' : 'var(--color-llm-warn-bg)',
          border:       `1px solid ${llmStatus === 'configured' ? 'var(--color-llm-ready-border)' : 'var(--color-llm-warn-border)'}`,
          borderRadius: '4px',
          padding:      '2px 7px',
          alignSelf:    'flex-start',
        }}>
          {llmStatus === 'configured'
            ? `● ${providerLabel ?? 'LLM ready'}`
            : '⚠ No LLM configured'}
        </div>
      )}

      {/* Domains */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
        {agent.domains.map((domain) => (
          <span
            key={domain}
            style={{
              background:   'var(--color-bg, #f9fafb)',
              border:       '1px solid var(--color-border)',
              borderRadius: '999px',
              fontSize:     '13px',
              color:        'var(--color-text-secondary)',
              padding:      '2px 8px',
              whiteSpace:   'nowrap',
            }}
          >
            {domain}
          </span>
        ))}
      </div>
    </div>
  );
}
