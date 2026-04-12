// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Network, Bot, ListTodo, DollarSign, RefreshCw,
  Server, ShieldCheck,
} from 'lucide-react';

import { useHealth }       from '../hooks/useHealth';
import { useDivisions }    from '../hooks/useDivisions';
import { useAgents }       from '../hooks/useAgents';
import { useApi }          from '../hooks/useApi';
import { useSse }          from '../hooks/useSse';
import { useAppConfig }    from '../lib/config';
import { useTranslation }  from '../hooks/useTranslation';
import { formatCurrency, formatUptime, todayIso, describeEvent } from '../lib/format';
import { MetricCard }      from '../components/shared/MetricCard';
import { LoadingSpinner }  from '../components/shared/LoadingSpinner';
import { ActivityFeed }    from '../components/shared/ActivityFeed';
import type { ActivityEvent } from '../components/shared/ActivityFeed';
import type { TasksResponse } from '../api/types';
import type { CostsResponse } from '../api/types';
import type { AuditResponse } from '../api/types';


const cardStyle: React.CSSProperties = {
  background:   'var(--color-surface)',
  border:       '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  padding:      '20px',
  boxShadow:    'var(--shadow-sm)',
};

const cardTitleStyle: React.CSSProperties = {
  fontSize:      '15px',
  fontWeight:    600,
  color:         'var(--color-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom:  '16px',
};


export function Dashboard() {
  const navigate  = useNavigate();
  const { t }     = useTranslation();
  const { buildInfo } = useAppConfig();

  const { health }  = useHealth();
  const divRes      = useDivisions();
  const agentRes    = useAgents();
  const { lastEvent } = useSse();

  const tasksRes = useApi<TasksResponse>(
    (c) => c.listTasks({ status: 'RUNNING', limit: 50 }),
  );
  const costsRes = useApi<CostsResponse>(
    (c) => c.listCosts({ period: '24h' }),
  );
  const auditRes = useApi<AuditResponse>(
    (c) => c.listAudit({ from: todayIso(), limit: 100 }),
  );

  // ---- Real-time activity feed -------------------------------------------
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);

  // Seed from audit entries on first load
  useEffect(() => {
    const entries = auditRes.data?.entries ?? [];
    const seeded: ActivityEvent[] = entries.slice(0, 20).map((e) => ({
      id:          e.id,
      timestamp:   e.timestamp,
      type:        e.action_type,
      description: e.action_type,
      agentId:     e.agent_id,
      outcome:     e.outcome === 'blocked' ? 'blocked' : 'info',
    }));
    setActivityEvents(seeded);
  }, [auditRes.data]);

  // Prepend new SSE events
  useEffect(() => {
    if (!lastEvent) return;
    const data = lastEvent.data as Record<string, unknown>;
    const ev: ActivityEvent = {
      id:          lastEvent.id ?? crypto.randomUUID(),
      timestamp:   new Date().toISOString(),
      type:        lastEvent.type,
      description: describeEvent(lastEvent.type, data),
      agentId:     String(data['agentId'] ?? ''),
      outcome:
        lastEvent.type.startsWith('governance:blocked')  ? 'blocked' :
        lastEvent.type.endsWith(':completed') || lastEvent.type.endsWith(':started') ? 'success' :
        lastEvent.type.endsWith(':failed') || lastEvent.type.endsWith(':crashed')    ? 'error' :
        'info',
    };
    setActivityEvents((prev) => [ev, ...prev].slice(0, 50));
  }, [lastEvent]);

  // ---- Computed metrics ---------------------------------------------------
  const divisions   = divRes.data?.divisions   ?? [];
  const agents      = agentRes.data?.agents     ?? [];
  const activeAgents = agents.filter((a) => a.status === 'active' || a.status === 'idle');
  const activeTasks = tasksRes.data?.tasks?.length ?? 0;
  const todayCost   = costsRes.data?.total?.total_usd ?? 0;

  // Governance summary derived from today's audit
  const auditEntries = auditRes.data?.entries ?? [];
  const blocked   = auditEntries.filter((e) => e.outcome === 'blocked').length;
  const escalated = auditEntries.filter((e) => e.outcome === 'escalated').length;
  const compliance = auditEntries.length > 0
    ? (((auditEntries.length - blocked) / auditEntries.length) * 100).toFixed(1)
    : '100.0';

  // ---- Responsive layout -------------------------------------------------
  const [isTablet, setIsTablet] = useState(() => window.innerWidth <= 1024);

  useEffect(() => {
    function onResize() { setIsTablet(window.innerWidth <= 1024); }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const twoColGrid: React.CSSProperties = {
    display:             'grid',
    gridTemplateColumns: isTablet ? '1fr' : '1fr 1fr',
    gap:                 '20px',
  };

  // ---- Refresh -----------------------------------------------------------
  const [refreshing, setRefreshing] = useState(false);

  const isLoading = divRes.loading || agentRes.loading || tasksRes.loading || costsRes.loading || auditRes.loading;

  // Clear refreshing indicator once all data loads complete
  useEffect(() => {
    if (refreshing && !isLoading) setRefreshing(false);
  }, [refreshing, isLoading]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    divRes.refetch();
    agentRes.refetch();
    tasksRes.refetch();
    costsRes.refetch();
    auditRes.refetch();
  }, [divRes, agentRes, tasksRes, costsRes, auditRes]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label={t('gui.dashboard.refresh')}
          style={{
            display:      'inline-flex',
            alignItems:   'center',
            gap:          '6px',
            padding:      '6px 14px',
            borderRadius: 'var(--radius-md)',
            border:       '1px solid var(--color-border)',
            background:   'var(--color-surface)',
            color:        'var(--color-text-secondary)',
            cursor:       refreshing ? 'default' : 'pointer',
            fontSize:     '15px',
            opacity:      refreshing ? 0.6 : 1,
          }}
        >
          <RefreshCw size={14} />
          {refreshing ? t('gui.dashboard.refreshing') : t('gui.dashboard.refresh')}
        </button>
      </div>

      {/* Summary cards */}
      <div style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap:                 '16px',
      }}>
        <MetricCard
          title={t('gui.dashboard.metric.divisions')}
          value={divRes.loading ? <LoadingSpinner size="sm" /> : divisions.length}
          subtitle={t('gui.dashboard.metric.divisions_active', { count: divisions.filter((d) => d.active).length })}
          icon={<Network size={22} />}
          onClick={() => navigate('/governance')}
        />
        <MetricCard
          title={t('gui.dashboard.metric.agents')}
          value={agentRes.loading ? <LoadingSpinner size="sm" /> : agents.length}
          subtitle={t('gui.dashboard.metric.agents_active', { count: activeAgents.length })}
          icon={<Bot size={22} />}
          onClick={() => navigate('/agents')}
        />
        <MetricCard
          title={t('gui.dashboard.metric.active_tasks')}
          value={tasksRes.loading ? <LoadingSpinner size="sm" /> : activeTasks}
          subtitle={t('gui.dashboard.metric.active_tasks_subtitle')}
          icon={<ListTodo size={22} />}
          onClick={() => navigate('/audit')}
        />
        <MetricCard
          title={t('gui.dashboard.metric.todays_cost')}
          value={costsRes.loading ? <LoadingSpinner size="sm" /> : formatCurrency(todayCost)}
          subtitle={t('gui.dashboard.metric.todays_cost_subtitle')}
          icon={<DollarSign size={22} />}
          onClick={() => navigate('/costs')}
        />
      </div>

      {/* Middle row */}
      <div style={twoColGrid}>

        {/* Division Overview */}
        <div style={cardStyle}>
          <p style={cardTitleStyle}>{t('gui.dashboard.section.division_overview')}</p>
          {divRes.loading && <LoadingSpinner />}
          {divRes.error && <ErrorText message={divRes.error} onRetry={divRes.refetch} />}
          {!divRes.loading && !divRes.error && divisions.length === 0 && (
            <EmptyState message={t('gui.dashboard.no_divisions')} />
          )}
          {divisions.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {[
                    t('gui.dashboard.table.division'),
                    t('gui.dashboard.table.agents'),
                    t('gui.dashboard.table.status'),
                  ].map((h) => (
                    <th key={h} style={{
                      textAlign:  'left',
                      fontSize:   '13px',
                      color:      'var(--color-text-muted)',
                      fontWeight: 600,
                      padding:    '0 0 8px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {divisions.map((div) => {
                  const divAgents = agents.filter((a) => a.division === div.code);
                  const hasError  = divAgents.some((a) => a.status === 'error');
                  const allStopped = divAgents.length > 0 && divAgents.every((a) => a.status === 'stopped');
                  const dotColor  = hasError ? 'var(--color-danger)' : allStopped ? 'var(--color-warning)' : 'var(--color-success)';

                  return (
                    <tr
                      key={div.code}
                      onClick={() => navigate(`/agents?division=${div.code}`)}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/agents?division=${div.code}`); } }}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = 'var(--color-bg-hover)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = ''; }}
                    >
                      <td style={{ padding: '8px 0', fontSize: '15px', color: 'var(--color-text)' }}>
                        {div.name_key ? t(div.name_key) : (div.name || div.code)}
                      </td>
                      <td style={{ padding: '8px 0', fontSize: '15px', color: 'var(--color-text-secondary)' }}>
                        {divAgents.length}
                      </td>
                      <td style={{ padding: '8px 0' }}>
                        <span style={{
                          display:      'inline-block',
                          width:        '8px',
                          height:       '8px',
                          borderRadius: '50%',
                          background:   dotColor,
                        }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <p style={{ ...cardTitleStyle, marginBottom: 0 }}>{t('gui.dashboard.section.recent_activity')}</p>
            <button
              onClick={() => navigate('/audit')}
              style={{
                background: 'none', border: 'none', color: 'var(--color-accent)',
                cursor: 'pointer', fontSize: '16px',
              }}
            >
              {t('gui.dashboard.section.view_all')}
            </button>
          </div>
          <ActivityFeed events={activityEvents} maxItems={20} showAgent autoScroll />
        </div>
      </div>

      {/* Bottom row */}
      <div style={twoColGrid}>

        {/* System Health */}
        <div style={cardStyle}>
          <p style={cardTitleStyle}>
            <Server size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
            {t('gui.dashboard.section.system_health')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <HealthRow
              label={t('gui.dashboard.health.server')}
              value={health ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{
                    width: '8px', height: '8px', borderRadius: '50%',
                    background: health.status === 'ok' ? 'var(--color-success)' : health.status === 'degraded' ? 'var(--color-warning)' : 'var(--color-danger)',
                    display: 'inline-block',
                  }} />
                  {health.status === 'ok'
                    ? t('gui.dashboard.health.running', { uptime: formatUptime(health.uptime_ms) })
                    : health.status}
                </span>
              ) : '—'}
            />
            <HealthRow label={t('gui.dashboard.health.version')} value={health?.version ?? '—'} />
            <HealthRow
              label={t('gui.dashboard.health.agents')}
              value={t('gui.dashboard.health.agents_count', { active: activeAgents.length, total: agents.length })}
            />
          </div>
        </div>

        {/* Governance Summary */}
        <div style={cardStyle}>
          <p style={cardTitleStyle}>
            <ShieldCheck size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
            {t('gui.dashboard.section.governance')}
          </p>
          {auditRes.loading && <LoadingSpinner />}
          {!auditRes.loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <GovRow label={t('gui.dashboard.gov.actions_today')} value={auditEntries.length} />
              <GovRow label={t('gui.dashboard.gov.blocked')}       value={blocked}    color={blocked > 0 ? 'var(--color-warning)' : undefined} />
              <GovRow label={t('gui.dashboard.gov.escalated')}     value={escalated}  color={escalated > 0 ? 'var(--color-danger)' : undefined} />
              <GovRow label={t('gui.dashboard.gov.compliance')}    value={`${compliance}%`} color={parseFloat(compliance) < 90 ? 'var(--color-warning)' : 'var(--color-success)'} />
            </div>
          )}
        </div>
      </div>

      {/* Version footer (B4) */}
      {buildInfo && (
        <div style={{
          textAlign:  'center',
          fontSize:   '13px',
          color:      'var(--color-text-muted)',
          paddingTop: '8px',
        }}>
          SIDJUA v{buildInfo.version}
          {buildInfo.buildNumber ? ` · Build #${buildInfo.buildNumber}` : ''}
          {buildInfo.buildDate   ? ` · ${buildInfo.buildDate.slice(0, 10)}` : ''}
        </div>
      )}
    </div>
  );
}


function HealthRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '15px', color: 'var(--color-text-secondary)' }}>{label}</span>
      <span style={{ fontSize: '15px', color: 'var(--color-text)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function GovRow({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '15px', color: 'var(--color-text-secondary)' }}>{label}</span>
      <span style={{ fontSize: '15px', fontWeight: 600, color: color ?? 'var(--color-text)' }}>{value}</span>
    </div>
  );
}

function ErrorText({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ color: 'var(--color-danger)', fontSize: '15px', display: 'flex', gap: '8px', alignItems: 'center' }}>
      <span>{message}</span>
      <button
        onClick={onRetry}
        style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', textDecoration: 'underline', fontSize: '16px' }}
      >
        Retry
      </button>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p style={{ fontSize: '15px', color: 'var(--color-text-muted)' }}>{message}</p>;
}

