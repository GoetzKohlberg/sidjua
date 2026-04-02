// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState } from 'react';
import { ShieldCheck, CheckCircle, XCircle, AlertTriangle, Clock, ChevronRight } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAgents } from '../hooks/useAgents';
import { useDivisions } from '../hooks/useDivisions';
import { useApi as useAuditApi } from '../hooks/useApi';
import { MetricCard }    from '../components/shared/MetricCard';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import { formatRelative } from '../lib/format';
import { todayIso }      from '../lib/format';
import type { GovernanceStatus, GovernanceHistory, GovernanceSnapshot, AuditResponse } from '../api/types';
import { useTranslation } from '../hooks/useTranslation';


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


type TabId = 'overview' | 'pipeline' | 'policies' | 'history';


interface PipelineStep {
  num:    number;
  label:  string;
  desc:   string;
  action: string;
}

const PIPELINE_STEPS: PipelineStep[] = [
  {
    num:    1,
    label:  'Input Sanitization',
    desc:   'Scans action input for injection patterns, secret leakage, and oversized payloads.',
    action: 'Block / Sanitize',
  },
  {
    num:    2,
    label:  'Budget Check',
    desc:   'Verifies that the requesting agent has sufficient budget at org, division, and task level.',
    action: 'Block (402)',
  },
  {
    num:    3,
    label:  'Policy Evaluation',
    desc:   'Evaluates all enabled governance policies. Forbidden actions are blocked immediately.',
    action: 'Block / Approve / Escalate',
  },
  {
    num:    4,
    label:  'Classification',
    desc:   'Assigns data sensitivity level (PUBLIC → FYEO) based on content and context.',
    action: 'Classify',
  },
  {
    num:    5,
    label:  'Decision',
    desc:   'Final allow / block / escalate decision combining all upstream stage results.',
    action: 'Allow / Block / Escalate',
  },
];


function OverviewTab({
  status,
  statusLoading,
  statusError,
  auditEntries,
  auditLoading,
}: {
  status: GovernanceStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  auditEntries: AuditResponse['entries'];
  auditLoading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={cardStyle}>
        <p style={cardTitleStyle}>{t('gui.governance.status_title')}</p>
        {statusLoading && <LoadingSpinner />}
        {statusError && <p style={{ color: 'var(--color-danger)', fontSize: '13px' }}>{statusError}</p>}
        {status && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
            <StatusRow label="Snapshots"   value={String(status.snapshot_count)} />
            <StatusRow label="Last apply"  value={status.last_apply_at ? formatRelative(status.last_apply_at) : '—'} />
            <StatusRow label="Work dir"    value={status.work_dir} mono />
            <StatusRow
              label="Latest snapshot"
              value={status.latest_snapshot
                ? `v${status.latest_snapshot.version} (${formatRelative(status.latest_snapshot.timestamp)})`
                : 'None'}
            />
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <p style={cardTitleStyle}>{t('gui.governance.activity_today')}</p>
        {auditLoading && <LoadingSpinner />}
        {!auditLoading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
            {[
              { label: 'Total actions', value: auditEntries.length, color: undefined },
              { label: 'Blocked',       value: auditEntries.filter((e) => e.outcome === 'blocked').length,   color: 'var(--color-warning)' },
              { label: 'Escalated',     value: auditEntries.filter((e) => e.outcome === 'escalated').length, color: 'var(--color-danger)' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <p style={{ fontSize: '28px', fontWeight: 700, color: color ?? 'var(--color-text)', lineHeight: 1 }}>
                  {value}
                </p>
                <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>{label}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PipelineTab() {
  return (
    <div style={cardStyle}>
      <p style={cardTitleStyle}>
        <ShieldCheck size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
        Pre-Action Governance Pipeline
      </p>
      <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '24px' }}>
        Every agent action passes through this 5-stage pipeline before execution.
        Each stage can block, modify, or allow the action.
      </p>

      {/* Desktop: horizontal flow */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '4px', overflowX: 'auto', paddingBottom: '8px' }}>
        {PIPELINE_STEPS.map((step, idx) => (
          <React.Fragment key={step.num}>
            <div style={{
              flex:          '1 1 160px',
              minWidth:      '140px',
              background:    'var(--color-accent-muted)',
              border:        '1px solid var(--color-accent)',
              borderRadius:  'var(--radius-md)',
              padding:       '14px',
            }}>
              <div style={{
                display:        'flex',
                alignItems:     'center',
                gap:            '8px',
                marginBottom:   '8px',
              }}>
                <span style={{
                  display:        'inline-flex',
                  alignItems:     'center',
                  justifyContent: 'center',
                  width:          '22px',
                  height:         '22px',
                  borderRadius:   '50%',
                  background:     'var(--color-accent)',
                  color:          'var(--color-text-inverse)',
                  fontSize:       '11px',
                  fontWeight:     700,
                  flexShrink:     0,
                }}>
                  {step.num}
                </span>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-accent)' }}>
                  {step.label}
                </span>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '8px', lineHeight: 1.4 }}>
                {step.desc}
              </p>
              <span style={{
                display:       'inline-block',
                fontSize:      '10px',
                fontWeight:    600,
                padding:       '2px 6px',
                borderRadius:  'var(--radius-sm)',
                background:    'var(--color-surface)',
                color:         'var(--color-accent)',
                border:        '1px solid var(--color-accent)',
              }}>
                {step.action}
              </span>
            </div>
            {idx < PIPELINE_STEPS.length - 1 && (
              <ChevronRight size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0, marginTop: '24px' }} />
            )}
          </React.Fragment>
        ))}
      </div>

      <div style={{
        display:      'flex',
        gap:          '16px',
        marginTop:    '20px',
        padding:      '12px',
        background:   'var(--color-surface-alt)',
        borderRadius: 'var(--radius-md)',
        fontSize:     '12px',
      }}>
        {[
          { icon: <CheckCircle size={14} style={{ color: 'var(--color-success)' }} />, label: 'Allow — action proceeds normally' },
          { icon: <XCircle     size={14} style={{ color: 'var(--color-danger)'  }} />, label: 'Block — action rejected, audit logged' },
          { icon: <AlertTriangle size={14} style={{ color: 'var(--color-warning)' }} />, label: 'Escalate — T1 operator approval required' },
          { icon: <Clock size={14} style={{ color: 'var(--color-info)' }} />, label: 'Queue — pending budget/approval' },
        ].map(({ icon, label }) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--color-text-secondary)' }}>
            {icon} {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function PoliciesTab() {
  const { t } = useTranslation();
  return (
    <div style={cardStyle}>
      <p style={cardTitleStyle}>{t('gui.governance.policies')}</p>
      <div style={{
        background:   'var(--color-surface-alt)',
        borderRadius: 'var(--radius-md)',
        padding:      '24px',
        textAlign:    'center',
      }}>
        <ShieldCheck size={32} style={{ color: 'var(--color-text-muted)', marginBottom: '12px' }} />
        <p style={{ fontWeight: 600, color: 'var(--color-text)', marginBottom: '8px' }}>
          Policy management not yet exposed via REST API
        </p>
        <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
          Governance policies are defined in <code>divisions.yaml</code> under each division's{' '}
          <code>governance:</code> block. Use the CLI to list and manage policies.
        </p>
        <div style={{
          display:      'inline-block',
          background:   'var(--color-bg)',
          borderRadius: 'var(--radius-md)',
          border:       '1px solid var(--color-border)',
          padding:      '12px 20px',
          textAlign:    'left',
          fontFamily:   'monospace',
          fontSize:     '12px',
          color:        'var(--color-text)',
        }}>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: '4px' }}># CLI commands</p>
          <p>sidjua governance list</p>
          <p>sidjua governance status</p>
          <p>sidjua governance rollback &lt;version&gt;</p>
        </div>
      </div>
    </div>
  );
}

function HistoryTab({ history, loading, error }: { history: GovernanceHistory | null; loading: boolean; error: string | null }) {
  const { t } = useTranslation();
  return (
    <div style={cardStyle}>
      <p style={cardTitleStyle}>{t('gui.governance.snapshots')}</p>
      {loading && <LoadingSpinner />}
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '13px' }}>{error}</p>}
      {!loading && !error && (history?.snapshots ?? []).length === 0 && (
        <p style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
          No snapshots yet. Run <code>sidjua apply</code> to create the first one.
        </p>
      )}
      {(history?.snapshots ?? []).map((snap) => (
        <SnapshotRow key={snap.id} snap={snap} />
      ))}
    </div>
  );
}

function SnapshotRow({ snap }: { snap: GovernanceSnapshot }) {
  return (
    <div style={{
      display:      'flex',
      alignItems:   'center',
      gap:          '16px',
      padding:      '10px 0',
      borderBottom: '1px solid var(--color-border)',
    }}>
      <span style={{
        display:        'inline-flex',
        alignItems:     'center',
        justifyContent: 'center',
        width:          '28px',
        height:         '28px',
        borderRadius:   '50%',
        background:     'var(--color-accent-muted)',
        color:          'var(--color-accent)',
        fontSize:       '12px',
        fontWeight:     700,
        flexShrink:     0,
      }}>
        v{snap.version}
      </span>
      <div style={{ flex: 1 }}>
        <p style={{ fontSize: '13px', color: 'var(--color-text)', fontWeight: 500 }}>
          Snapshot {snap.id.slice(0, 8)}
        </p>
        <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
          Trigger: {snap.trigger} · Hash: {snap.divisions_yaml_hash.slice(0, 12)}…
        </p>
      </div>
      <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
        {formatRelative(snap.timestamp)}
      </span>
    </div>
  );
}

// Small helpers
function StatusRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '2px' }}>{label}</p>
      <p style={{
        fontSize:   '13px',
        color:      'var(--color-text)',
        fontWeight: 500,
        fontFamily: mono ? 'monospace' : 'inherit',
        wordBreak:  'break-all',
      }}>
        {value}
      </p>
    </div>
  );
}


export function Governance() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>('overview');

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview',  label: t('gui.governance.tab_overview') },
    { id: 'pipeline',  label: t('gui.governance.tab_pipeline') },
    { id: 'policies',  label: t('gui.governance.policies') },
    { id: 'history',   label: t('gui.governance.snapshots') },
  ];

  const statusRes  = useApi<GovernanceStatus>((c)  => c.governanceStatus());
  const historyRes = useApi<GovernanceHistory>((c)  => c.governanceHistory());
  const agentRes   = useAgents();
  const divRes     = useDivisions();
  const auditRes   = useAuditApi<AuditResponse>((c) => c.listAudit({ from: todayIso(), limit: 200 }));

  const auditEntries = auditRes.data?.entries ?? [];
  const blocked      = auditEntries.filter((e) => e.outcome === 'blocked').length;
  const compliance   = auditEntries.length > 0
    ? (((auditEntries.length - blocked) / auditEntries.length) * 100).toFixed(1)
    : '100.0';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Summary metric cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
        <MetricCard
          title={t('gui.governance.active_divisions')}
          value={divRes.loading ? <LoadingSpinner size="sm" /> : (divRes.data?.divisions.filter((d) => d.active).length ?? '—')}
          icon={<ShieldCheck size={22} />}
        />
        <MetricCard
          title={t('gui.governance.actions_today')}
          value={auditRes.loading ? <LoadingSpinner size="sm" /> : auditEntries.length}
          subtitle="governance audit entries"
        />
        <MetricCard
          title={t('gui.governance.blocked_today')}
          value={auditRes.loading ? <LoadingSpinner size="sm" /> : blocked}
          subtitle={blocked > 0 ? 'review audit log' : 'none blocked'}
        />
        <MetricCard
          title={t('gui.governance.compliance_rate')}
          value={auditRes.loading ? <LoadingSpinner size="sm" /> : `${compliance}%`}
          subtitle="actions passed governance"
        />
      </div>

      {/* Tabs */}
      <div>
        <div style={{ display: 'flex', gap: '4px', borderBottom: '2px solid var(--color-border)', marginBottom: '20px' }}>
          {tabs.map((tabItem) => (
            <button
              key={tabItem.id}
              onClick={() => setTab(tabItem.id)}
              style={{
                padding:      '8px 16px',
                border:       'none',
                background:   'none',
                cursor:       'pointer',
                fontSize:     '13px',
                fontWeight:   tab === tabItem.id ? 700 : 400,
                color:        tab === tabItem.id ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                borderBottom: tab === tabItem.id ? '2px solid var(--color-accent)' : '2px solid transparent',
                marginBottom: '-2px',
                transition:   'all var(--transition-fast)',
              }}
            >
              {tabItem.label}
            </button>
          ))}
        </div>

        {tab === 'overview'  && (
          <OverviewTab
            status={statusRes.data ?? null}
            statusLoading={statusRes.loading}
            statusError={statusRes.error}
            auditEntries={auditEntries}
            auditLoading={auditRes.loading}
          />
        )}
        {tab === 'pipeline'  && <PipelineTab />}
        {tab === 'policies'  && <PoliciesTab />}
        {tab === 'history'   && (
          <HistoryTab
            history={historyRes.data ?? null}
            loading={historyRes.loading}
            error={historyRes.error}
          />
        )}
      </div>
    </div>
  );
}

export default Governance;
