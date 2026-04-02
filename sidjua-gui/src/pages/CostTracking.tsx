// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState } from 'react';
import { DollarSign, Hash, TrendingUp } from 'lucide-react';

import { useApi }           from '../hooks/useApi';
import { useDivisions }     from '../hooks/useDivisions';
import { useTranslation }   from '../hooks/useTranslation';
import { MetricCard }    from '../components/shared/MetricCard';
import { ProgressBar }   from '../components/shared/ProgressBar';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import { formatCurrency } from '../lib/format';
import type { CostsResponse, CostBreakdownEntry } from '../api/types';


type Period = '24h' | '7d' | '30d';



function DivisionBars({ breakdown, total }: { breakdown: CostBreakdownEntry[]; total: number }) {
  const { t } = useTranslation();
  const byDiv = new Map<string, number>();
  for (const entry of breakdown) {
    byDiv.set(entry.division_code, (byDiv.get(entry.division_code) ?? 0) + entry.cost_usd);
  }

  const rows = [...byDiv.entries()]
    .map(([div, usd]) => ({ div, usd }))
    .sort((a, b) => b.usd - a.usd);

  if (rows.length === 0) {
    return <p style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{t('gui.cost.no_data')}</p>;
  }

  const maxUsd = rows[0]?.usd ?? 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {rows.map(({ div, usd }) => {
        const pct = total > 0 ? (usd / total) * 100 : 0;
        const barPct = maxUsd > 0 ? (usd / maxUsd) * 100 : 0;
        return (
          <div key={div}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '12px' }}>
              <span style={{ color: 'var(--color-text)', fontWeight: 500 }}>{div}</span>
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {formatCurrency(usd)} <span style={{ color: 'var(--color-text-muted)' }}>({pct.toFixed(1)}%)</span>
              </span>
            </div>
            <div style={{
              width:        '100%',
              height:       '8px',
              background:   'var(--color-border)',
              borderRadius: '4px',
              overflow:     'hidden',
            }}>
              <div style={{
                width:        `${barPct}%`,
                height:       '100%',
                background:   'var(--color-accent)',
                borderRadius: '4px',
                transition:   'width 0.4s ease',
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}


type SortKey = 'agent_id' | 'division_code' | 'cost_usd' | 'entries';

function AgentTable({ breakdown }: { breakdown: CostBreakdownEntry[] }) {
  const { t } = useTranslation();
  const [sortKey, setSortKey]   = useState<SortKey>('cost_usd');
  const [sortAsc, setSortAsc]   = useState(false);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  const sorted = [...breakdown].sort((a, b) => {
    const va = a[sortKey];
    const vb = b[sortKey];
    const cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb));
    return sortAsc ? cmp : -cmp;
  });

  if (sorted.length === 0) {
    return <p style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{t('gui.cost.no_agent_data')}</p>;
  }

  const maxCost = sorted.reduce((m, e) => Math.max(m, e.cost_usd), 0);

  const columns: { key: SortKey; label: string }[] = [
    { key: 'agent_id',     label: t('gui.cost.col_agent') },
    { key: 'division_code',label: t('gui.cost.col_division') },
    { key: 'cost_usd',     label: t('gui.cost.col_cost_usd') },
    { key: 'entries',      label: t('gui.cost.col_calls') },
  ];

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--color-surface-alt)', borderBottom: '2px solid var(--color-border)' }}>
            {columns.map((col) => (
              <th
                key={col.key}
                onClick={() => toggleSort(col.key)}
                style={{
                  textAlign:     'left',
                  padding:       '9px 12px',
                  fontSize:      '11px',
                  color:         sortKey === col.key ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  fontWeight:    600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  cursor:        'pointer',
                  whiteSpace:    'nowrap',
                  userSelect:    'none',
                }}
              >
                {col.label} {sortKey === col.key ? (sortAsc ? '↑' : '↓') : ''}
              </th>
            ))}
            <th style={{ padding: '9px 12px', width: '120px' }} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => (
            <tr
              key={`${e.agent_id}-${e.division_code}`}
              style={{ borderBottom: '1px solid var(--color-border)' }}
              onMouseEnter={(ev) => { (ev.currentTarget as HTMLTableRowElement).style.background = 'var(--color-bg-hover)'; }}
              onMouseLeave={(ev) => { (ev.currentTarget as HTMLTableRowElement).style.background = ''; }}
            >
              <td style={{ padding: '9px 12px', fontSize: '13px', color: 'var(--color-text)', fontWeight: 500 }}>
                {e.agent_id}
              </td>
              <td style={{ padding: '9px 12px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                {e.division_code}
              </td>
              <td style={{ padding: '9px 12px', fontSize: '13px', color: 'var(--color-text)', fontWeight: 600 }}>
                {formatCurrency(e.cost_usd)}
              </td>
              <td style={{ padding: '9px 12px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                {e.entries}
              </td>
              <td style={{ padding: '9px 12px' }}>
                <div style={{
                  height:     '4px',
                  background: 'var(--color-border)',
                  borderRadius: '2px',
                  overflow:   'hidden',
                }}>
                  <div style={{
                    width:      `${maxCost > 0 ? (e.cost_usd / maxCost) * 100 : 0}%`,
                    height:     '100%',
                    background: 'var(--color-accent)',
                    borderRadius: '2px',
                  }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


const cardStyle: React.CSSProperties = {
  background:   'var(--color-surface)',
  border:       '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  padding:      '20px',
  boxShadow:    'var(--shadow-sm)',
};

const cardTitleStyle: React.CSSProperties = {
  fontSize:      '12px',
  fontWeight:    600,
  color:         'var(--color-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom:  '16px',
};

export function CostTracking() {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>('7d');

  const PERIOD_LABELS: Record<Period, string> = {
    '24h': t('gui.cost.period_today'),
    '7d':  t('gui.cost.period_7d'),
    '30d': t('gui.cost.period_30d'),
  };

  const costsRes = useApi<CostsResponse>(
    (c) => c.listCosts({ period }),
    [period],
  );
  const divRes   = useDivisions();

  const costs    = costsRes.data;
  const total    = costs?.total;
  const breakdown = costs?.breakdown ?? [];

  // Budget utilisation per division (rough: compare actual spend vs division count as proxy)
  // The API doesn't return budget limits, so we just show spend with no limit bar.

  const providerMap = new Map<string, number>();
  for (const entry of breakdown) {
    const key = `${entry.agent_id.split('-')[0] ?? 'unknown'}`;
    providerMap.set(key, (providerMap.get(key) ?? 0) + entry.cost_usd);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Period selector */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>{t('gui.cost.period')}</span>
        {(['24h', '7d', '30d'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding:      '5px 14px',
              borderRadius: 'var(--radius-md)',
              border:       '1px solid',
              borderColor:  period === p ? 'var(--color-accent)' : 'var(--color-border)',
              background:   period === p ? 'var(--color-accent-muted)' : 'var(--color-surface)',
              color:        period === p ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              cursor:       'pointer',
              fontSize:     '13px',
              fontWeight:   period === p ? 600 : 400,
              transition:   'all var(--transition-fast)',
            }}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
        {costsRes.loading && <LoadingSpinner size="sm" />}
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
        <MetricCard
          title={t('gui.cost.total_cost')}
          value={costsRes.loading ? <LoadingSpinner size="sm" /> : formatCurrency(total?.total_usd ?? 0)}
          subtitle={PERIOD_LABELS[period]}
          icon={<DollarSign size={22} />}
        />
        <MetricCard
          title={t('gui.cost.input_tokens')}
          value={costsRes.loading ? <LoadingSpinner size="sm" /> : (total?.total_input_tokens ?? 0).toLocaleString()}
          subtitle={t('gui.cost.prompt_tokens_sub')}
          icon={<Hash size={22} />}
        />
        <MetricCard
          title={t('gui.cost.output_tokens')}
          value={costsRes.loading ? <LoadingSpinner size="sm" /> : (total?.total_output_tokens ?? 0).toLocaleString()}
          subtitle={t('gui.cost.completion_tokens_sub')}
          icon={<TrendingUp size={22} />}
        />
      </div>

      {/* Error */}
      {costsRes.error && (
        <div style={{ color: 'var(--color-danger)', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span>{costsRes.error}</span>
          <button onClick={costsRes.refetch} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', textDecoration: 'underline' }}>
            {t('gui.common.retry')}
          </button>
        </div>
      )}

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <div style={cardStyle}>
          <p style={cardTitleStyle}>{t('gui.cost.by_division')}</p>
          {costsRes.loading ? <LoadingSpinner /> : (
            <DivisionBars breakdown={breakdown} total={total?.total_usd ?? 1} />
          )}
        </div>

        <div style={cardStyle}>
          <p style={cardTitleStyle}>{t('gui.cost.period_summary')}</p>
          {costs && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t('gui.cost.from')}</span>
                  <span style={{ color: 'var(--color-text)' }}>{new Date(costs.period.from).toLocaleString()}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t('gui.cost.to')}</span>
                  <span style={{ color: 'var(--color-text)' }}>{new Date(costs.period.to).toLocaleString()}</span>
                </div>
              </div>
              <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={{ color: 'var(--color-text-secondary)' }}>{t('gui.cost.total_api_calls')}</span>
                <span style={{ color: 'var(--color-text)', fontWeight: 600 }}>{total?.entries ?? 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={{ color: 'var(--color-text-secondary)' }}>{t('gui.cost.unique_agents')}</span>
                <span style={{ color: 'var(--color-text)', fontWeight: 600 }}>
                  {new Set(breakdown.map((e) => e.agent_id)).size}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={{ color: 'var(--color-text-secondary)' }}>{t('gui.cost.unique_divisions')}</span>
                <span style={{ color: 'var(--color-text)', fontWeight: 600 }}>
                  {new Set(breakdown.map((e) => e.division_code)).size}
                </span>
              </div>
            </div>
          )}
          {!costs && !costsRes.loading && (
            <p style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{t('gui.cost.no_data_available')}</p>
          )}
        </div>
      </div>

      {/* Agent cost table */}
      <div style={cardStyle}>
        <p style={cardTitleStyle}>{t('gui.cost.by_agent')}</p>
        {costsRes.loading ? <LoadingSpinner /> : (
          <AgentTable breakdown={breakdown} />
        )}
      </div>
    </div>
  );
}

export default CostTracking;
