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
    return <p className="sidjua-text-muted-sm">{t('gui.cost.no_data')}</p>;
  }

  const maxUsd = rows[0]?.usd ?? 1;

  return (
    <div className="sidjua-col-gap-12" style={{ gap: '10px' }}>
      {rows.map(({ div, usd }) => {
        const pct = total > 0 ? (usd / total) * 100 : 0;
        const barPct = maxUsd > 0 ? (usd / maxUsd) * 100 : 0;
        return (
          <div key={div}>
            <div className="page-cost--div-bar-header">
              <span className="page-cost--div-name">{div}</span>
              <span className="page-cost--div-cost">
                {formatCurrency(usd)} <span className="page-cost--div-pct">({pct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="page-cost--bar-track">
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
    return <p className="sidjua-text-muted-sm">{t('gui.cost.no_agent_data')}</p>;
  }

  const maxCost = sorted.reduce((m, e) => Math.max(m, e.cost_usd), 0);

  const columns: { key: SortKey; label: string }[] = [
    { key: 'agent_id',     label: t('gui.cost.col_agent') },
    { key: 'division_code',label: t('gui.cost.col_division') },
    { key: 'cost_usd',     label: t('gui.cost.col_cost_usd') },
    { key: 'entries',      label: t('gui.cost.col_calls') },
  ];

  return (
    <div className="sidjua-table-wrap">
      <table className="sidjua-table">
        <thead>
          <tr style={{ background: 'var(--color-surface-alt)', borderBottom: '2px solid var(--color-border)' }}>
            {columns.map((col) => (
              <th
                key={col.key}
                onClick={() => toggleSort(col.key)}
                className="page-cost--agent-th"
                style={{
                  color: sortKey === col.key ? 'var(--color-accent)' : 'var(--color-text-muted)',
                }}
              >
                {col.label} {sortKey === col.key ? (sortAsc ? '↑' : '↓') : ''}
              </th>
            ))}
            <th className="page-cost--agent-td-bar" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => (
            <tr
              key={`${e.agent_id}-${e.division_code}`}
              className="sidjua-tr--border"
              onMouseEnter={(ev) => { (ev.currentTarget as HTMLTableRowElement).style.background = 'var(--color-bg-hover)'; }}
              onMouseLeave={(ev) => { (ev.currentTarget as HTMLTableRowElement).style.background = ''; }}
            >
              <td className="page-cost--agent-td-name">
                {e.agent_id}
              </td>
              <td className="page-cost--agent-td-div">
                {e.division_code}
              </td>
              <td className="page-cost--agent-td-cost">
                {formatCurrency(e.cost_usd)}
              </td>
              <td className="page-cost--agent-td-calls">
                {e.entries}
              </td>
              <td style={{ padding: '9px 12px' }}>
                <div className="page-cost--bar-track-mini">
                  <div style={{
                    width:        `${maxCost > 0 ? (e.cost_usd / maxCost) * 100 : 0}%`,
                    height:       '100%',
                    background:   'var(--color-accent)',
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
    <div className="sidjua-col-gap-20">

      {/* Period selector */}
      <div className="page-cost--period-selector">
        <span className="page-cost--period-label">{t('gui.cost.period')}</span>
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
      <div className="page-cost--summary-grid">
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
        <div className="page-cost--error-row">
          <span>{costsRes.error}</span>
          <button onClick={costsRes.refetch} className="page-cost--retry-btn">
            {t('gui.common.retry')}
          </button>
        </div>
      )}

      {/* Charts row */}
      <div className="page-cost--charts-grid">
        <div className="sidjua-card">
          <p className="sidjua-card-title">{t('gui.cost.by_division')}</p>
          {costsRes.loading ? <LoadingSpinner /> : (
            <DivisionBars breakdown={breakdown} total={total?.total_usd ?? 1} />
          )}
        </div>

        <div className="sidjua-card">
          <p className="sidjua-card-title">{t('gui.cost.period_summary')}</p>
          {costs && (
            <div className="page-cost--period-summary">
              <div>
                <div className="page-cost--date-row">
                  <span className="page-cost--date-label">{t('gui.cost.from')}</span>
                  <span className="page-cost--date-value">{new Date(costs.period.from).toLocaleString()}</span>
                </div>
                <div className="page-cost--date-row-last">
                  <span className="page-cost--date-label">{t('gui.cost.to')}</span>
                  <span className="page-cost--date-value">{new Date(costs.period.to).toLocaleString()}</span>
                </div>
              </div>
              <hr className="page-cost--hr" />
              <div className="page-cost--stat-row">
                <span className="page-cost--stat-label">{t('gui.cost.total_api_calls')}</span>
                <span className="page-cost--stat-value">{total?.entries ?? 0}</span>
              </div>
              <div className="page-cost--stat-row">
                <span className="page-cost--stat-label">{t('gui.cost.unique_agents')}</span>
                <span className="page-cost--stat-value">
                  {new Set(breakdown.map((e) => e.agent_id)).size}
                </span>
              </div>
              <div className="page-cost--stat-row">
                <span className="page-cost--stat-label">{t('gui.cost.unique_divisions')}</span>
                <span className="page-cost--stat-value">
                  {new Set(breakdown.map((e) => e.division_code)).size}
                </span>
              </div>
            </div>
          )}
          {!costs && !costsRes.loading && (
            <p className="sidjua-text-muted-sm">{t('gui.cost.no_data_available')}</p>
          )}
        </div>
      </div>

      {/* Agent cost table */}
      <div className="sidjua-card">
        <p className="sidjua-card-title">{t('gui.cost.by_agent')}</p>
        {costsRes.loading ? <LoadingSpinner /> : (
          <AgentTable breakdown={breakdown} />
        )}
      </div>
    </div>
  );
}

export default CostTracking;
