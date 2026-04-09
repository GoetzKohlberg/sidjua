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
            <StatusRow label={t('gui.governance.label_snapshots')}        value={String(status.snapshot_count)} />
            <StatusRow label={t('gui.governance.label_last_apply')}       value={status.last_apply_at ? formatRelative(status.last_apply_at) : '—'} />
            <StatusRow label={t('gui.governance.label_work_dir')}         value={status.work_dir} mono />
            <StatusRow
              label={t('gui.governance.label_latest_snapshot')}
              value={status.latest_snapshot
                ? `v${status.latest_snapshot.version} (${formatRelative(status.latest_snapshot.timestamp)})`
                : t('gui.governance.label_none')}
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
              { label: t('gui.governance.label_total_actions'), value: auditEntries.length, color: undefined },
              { label: t('gui.governance.label_blocked'),       value: auditEntries.filter((e) => e.outcome === 'blocked').length,   color: 'var(--color-warning)' },
              { label: t('gui.governance.label_escalated'),     value: auditEntries.filter((e) => e.outcome === 'escalated').length, color: 'var(--color-danger)' },
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
  const { t } = useTranslation();
  const steps = [
    { num: 1, label: t('gui.governance.pipeline_step_1_label'), desc: t('gui.governance.pipeline_step_1_desc'), action: t('gui.governance.pipeline_step_1_action') },
    { num: 2, label: t('gui.governance.pipeline_step_2_label'), desc: t('gui.governance.pipeline_step_2_desc'), action: t('gui.governance.pipeline_step_2_action') },
    { num: 3, label: t('gui.governance.pipeline_step_3_label'), desc: t('gui.governance.pipeline_step_3_desc'), action: t('gui.governance.pipeline_step_3_action') },
    { num: 4, label: t('gui.governance.pipeline_step_4_label'), desc: t('gui.governance.pipeline_step_4_desc'), action: t('gui.governance.pipeline_step_4_action') },
    { num: 5, label: t('gui.governance.pipeline_step_5_label'), desc: t('gui.governance.pipeline_step_5_desc'), action: t('gui.governance.pipeline_step_5_action') },
  ];
  return (
    <div className="sidjua-card">
      <p className="sidjua-card-title">
        <ShieldCheck size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
        {t('gui.governance.pipeline_title')}
      </p>
      <p className="page-gov--pipeline-desc">
        {t('gui.governance.pipeline_desc')}
      </p>

      {/* Desktop: horizontal flow */}
      <div className="page-gov--pipeline-flow">
        {steps.map((step, idx) => (
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
            {idx < steps.length - 1 && (
              <ChevronRight size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0, marginTop: '24px' }} />
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="page-gov--legend">
        {[
          { icon: <CheckCircle size={14} style={{ color: 'var(--color-success)' }} />, label: t('gui.governance.legend_allow') },
          { icon: <XCircle     size={14} style={{ color: 'var(--color-danger)'  }} />, label: t('gui.governance.legend_block') },
          { icon: <AlertTriangle size={14} style={{ color: 'var(--color-warning)' }} />, label: t('gui.governance.legend_escalate') },
          { icon: <Clock size={14} style={{ color: 'var(--color-info)' }} />, label: t('gui.governance.legend_queue') },
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
          {t('gui.governance.policies_api_note')}
        </p>
        <p className="page-gov--policies-desc">
          {t('gui.governance.policies_desc')}
        </p>
        <div className="page-gov--code-box">
          <p className="page-gov--code-comment">{t('gui.governance.policies_cli_comment')}</p>
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
          {t('gui.governance.no_snapshots')}
        </p>
      )}
      {(history?.snapshots ?? []).map((snap) => (
        <SnapshotRow key={snap.id} snap={snap} />
      ))}
    </div>
  );
}

function SnapshotRow({ snap }: { snap: GovernanceSnapshot }) {
  const { t } = useTranslation();
  return (
    <div className="page-gov--snapshot-row">
      <span className="page-gov--snapshot-badge">
        v{snap.version}
      </span>
      <div style={{ flex: 1 }}>
        <p className="page-gov--snapshot-id">
          {t('gui.governance.snapshot_label')} {snap.id.slice(0, 8)}
        </p>
        <p className="page-gov--snapshot-meta">
          {t('gui.governance.snapshot_trigger')} {snap.trigger} · {t('gui.governance.snapshot_hash')} {snap.divisions_yaml_hash.slice(0, 12)}…
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
          subtitle={t('gui.governance.metric_audit_entries')}
        />
        <MetricCard
          title={t('gui.governance.blocked_today')}
          value={auditRes.loading ? <LoadingSpinner size="sm" /> : blocked}
          subtitle={blocked > 0 ? t('gui.governance.metric_review_audit') : t('gui.governance.metric_none_blocked')}
        />
        <MetricCard
          title={t('gui.governance.compliance_rate')}
          value={auditRes.loading ? <LoadingSpinner size="sm" /> : `${compliance}%`}
          subtitle={t('gui.governance.metric_actions_passed')}
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

