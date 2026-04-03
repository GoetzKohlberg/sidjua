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
    <div className="sidjua-col-gap-16">
      <div className="sidjua-card">
        <p className="sidjua-card-title">{t('gui.governance.status_title')}</p>
        {statusLoading && <LoadingSpinner />}
        {statusError && <p className="sidjua-text-error-sm">{statusError}</p>}
        {status && (
          <div className="page-gov--status-grid">
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

      <div className="sidjua-card">
        <p className="sidjua-card-title">{t('gui.governance.activity_today')}</p>
        {auditLoading && <LoadingSpinner />}
        {!auditLoading && (
          <div className="page-gov--activity-grid">
            {[
              { label: 'Total actions', value: auditEntries.length, color: undefined },
              { label: 'Blocked',       value: auditEntries.filter((e) => e.outcome === 'blocked').length,   color: 'var(--color-warning)' },
              { label: 'Escalated',     value: auditEntries.filter((e) => e.outcome === 'escalated').length, color: 'var(--color-danger)' },
            ].map(({ label, value, color }) => (
              <div key={label} className="page-gov--stat-center">
                <p className="page-gov--stat-number" style={{ color: color ?? 'var(--color-text)' }}>
                  {value}
                </p>
                <p className="page-gov--stat-label">{label}</p>
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
    <div className="sidjua-card">
      <p className="sidjua-card-title">
        <ShieldCheck size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
        Pre-Action Governance Pipeline
      </p>
      <p className="page-gov--pipeline-desc">
        Every agent action passes through this 5-stage pipeline before execution.
        Each stage can block, modify, or allow the action.
      </p>

      {/* Desktop: horizontal flow */}
      <div className="page-gov--pipeline-flow">
        {PIPELINE_STEPS.map((step, idx) => (
          <React.Fragment key={step.num}>
            <div className="page-gov--pipeline-step">
              <div className="page-gov--step-header">
                <span className="page-gov--step-badge">
                  {step.num}
                </span>
                <span className="page-gov--step-label">
                  {step.label}
                </span>
              </div>
              <p className="page-gov--step-desc">
                {step.desc}
              </p>
              <span className="page-gov--action-badge">
                {step.action}
              </span>
            </div>
            {idx < PIPELINE_STEPS.length - 1 && (
              <ChevronRight size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0, marginTop: '24px' }} />
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="page-gov--legend">
        {[
          { icon: <CheckCircle size={14} style={{ color: 'var(--color-success)' }} />, label: 'Allow — action proceeds normally' },
          { icon: <XCircle     size={14} style={{ color: 'var(--color-danger)'  }} />, label: 'Block — action rejected, audit logged' },
          { icon: <AlertTriangle size={14} style={{ color: 'var(--color-warning)' }} />, label: 'Escalate — T1 operator approval required' },
          { icon: <Clock size={14} style={{ color: 'var(--color-info)' }} />, label: 'Queue — pending budget/approval' },
        ].map(({ icon, label }) => (
          <span key={label} className="page-gov--legend-item">
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
    <div className="sidjua-card">
      <p className="sidjua-card-title">{t('gui.governance.policies')}</p>
      <div className="page-gov--policies-placeholder">
        <ShieldCheck size={32} style={{ color: 'var(--color-text-muted)', marginBottom: '12px' }} />
        <p className="page-gov--policies-heading">
          Policy management not yet exposed via REST API
        </p>
        <p className="page-gov--policies-desc">
          Governance policies are defined in <code>divisions.yaml</code> under each division's{' '}
          <code>governance:</code> block. Use the CLI to list and manage policies.
        </p>
        <div className="page-gov--code-box">
          <p className="page-gov--code-comment"># CLI commands</p>
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
    <div className="sidjua-card">
      <p className="sidjua-card-title">{t('gui.governance.snapshots')}</p>
      {loading && <LoadingSpinner />}
      {error && <p className="sidjua-text-error-sm">{error}</p>}
      {!loading && !error && (history?.snapshots ?? []).length === 0 && (
        <p className="sidjua-text-muted-sm">
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
    <div className="page-gov--snapshot-row">
      <span className="page-gov--snapshot-badge">
        v{snap.version}
      </span>
      <div style={{ flex: 1 }}>
        <p className="page-gov--snapshot-id">
          Snapshot {snap.id.slice(0, 8)}
        </p>
        <p className="page-gov--snapshot-meta">
          Trigger: {snap.trigger} · Hash: {snap.divisions_yaml_hash.slice(0, 12)}…
        </p>
      </div>
      <span className="page-gov--snapshot-ts">
        {formatRelative(snap.timestamp)}
      </span>
    </div>
  );
}

// Small helpers
function StatusRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="page-gov--status-label">{label}</p>
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
    <div className="sidjua-col-gap-20">

      {/* Summary metric cards */}
      <div className="page-gov--metrics-grid">
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
        <div className="page-gov--tab-bar">
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
