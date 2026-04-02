// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React from 'react';
import { useApi }       from '../hooks/useApi';
import { useAppConfig } from '../lib/config';
import { AgentIcon }    from '../components/shared/AgentIcon';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import type { StarterDivisionsResponse } from '../api/types';
import { GUI_ERRORS } from '../i18n/gui-errors';
import { useTranslation } from '../hooks/useTranslation';

const cardStyle: React.CSSProperties = {
  background:   'var(--color-surface)',
  border:       '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  padding:      '20px',
  boxShadow:    'var(--shadow-sm)',
};

const cardTitleStyle: React.CSSProperties = {
  fontSize:      '13px',
  fontWeight:    600,
  color:         'var(--color-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom:  '16px',
};

const AGENT_ICONS: Record<string, string> = {
  guide:     'compass',
  hr:        'users',
  it:        'server',
  auditor:   'shield-check',
  finance:   'bar-chart',
  librarian: 'book-open',
};

export function Divisions() {
  const { client } = useAppConfig();
  const divRes = useApi<StarterDivisionsResponse>((c) => c.listStarterDivisions());
  const { t } = useTranslation();
  const divisions = divRes.data?.divisions ?? [];

  if (!client) {
    return (
      <div style={{
        background:   'var(--color-warning-bg)',
        border:       '1px solid var(--color-warning)',
        borderRadius: 'var(--radius-lg)',
        padding:      '20px',
        color:        'var(--color-warning)',
        fontSize:     '13px',
      }}>
        <strong>{GUI_ERRORS['GUI-CONN-005'].message}</strong> {GUI_ERRORS['GUI-CONN-005'].suggestion}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
        {t('gui.divisions.page_title')}
      </h1>

      {divRes.loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
          <LoadingSpinner label="Loading divisions…" />
        </div>
      )}

      {!divRes.loading && divisions.map((div) => (
        <div key={div.id} style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
                  {div.name}
                </h2>
                {div.protected && (
                  <span style={{
                    background:   'var(--color-tier-1-bg)',
                    color:        'var(--color-tier-1-text)',
                    fontSize:     '10px',
                    fontWeight:   700,
                    padding:      '2px 6px',
                    borderRadius: '4px',
                  }}>
                    PROTECTED
                  </span>
                )}
              </div>
              <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
                {div.description}
              </p>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0, paddingLeft: '16px' }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--color-text)' }}>
                {div.agent_count}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{t('gui.divisions.agents_count')}</div>
            </div>
          </div>

          {/* Budget */}
          <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <div style={{
              background:   'var(--color-bg, #f9fafb)',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding:      '8px 12px',
            }}>
              <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>{t('gui.divisions.daily_limit')}</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--color-text)' }}>
                ${div.budget.daily_limit_usd.toFixed(2)}
              </div>
            </div>
            <div style={{
              background:   'var(--color-bg, #f9fafb)',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding:      '8px 12px',
            }}>
              <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>{t('gui.divisions.monthly_cap')}</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--color-text)' }}>
                ${div.budget.monthly_cap_usd.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Agent list */}
          <p style={cardTitleStyle}>{t('gui.divisions.agents_title')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {div.agents.map((agentId) => (
              <div
                key={agentId}
                style={{
                  display:      'inline-flex',
                  alignItems:   'center',
                  gap:          '6px',
                  background:   'var(--color-bg, #f9fafb)',
                  border:       '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  padding:      '5px 10px',
                  fontSize:     '12px',
                  color:        'var(--color-text-secondary)',
                }}
              >
                <AgentIcon name={AGENT_ICONS[agentId] ?? 'compass'} size={13} color="var(--color-accent)" />
                {agentId}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default Divisions;
