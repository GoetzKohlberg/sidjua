// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState } from 'react';
import { Copy, CheckCircle } from 'lucide-react';
import { useTranslation } from '../hooks/useTranslation';

import { useApi }       from '../hooks/useApi';
import { useHealth }    from '../hooks/useHealth';
import { useAgents }    from '../hooks/useAgents';
import { useDivisions } from '../hooks/useDivisions';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import { formatUptime }  from '../lib/format';
import type { SystemInfo, LoggingStatus } from '../api/types';


type TabId = 'divisions' | 'system' | 'logging';



function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    }).catch(() => undefined);
  }

  return (
    <button
      onClick={handleCopy}
      title={t('gui.common.copy_to_clipboard')}
      aria-label={t('gui.common.copy_to_clipboard')}
      style={{
        display:      'inline-flex',
        alignItems:   'center',
        gap:          '5px',
        padding:      '4px 10px',
        borderRadius: 'var(--radius-md)',
        border:       '1px solid var(--color-border)',
        background:   'var(--color-surface)',
        color:        copied ? 'var(--color-success)' : 'var(--color-text-secondary)',
        cursor:       'pointer',
        fontSize:     '16px',
        transition:   'all var(--transition-fast)',
      }}
    >
      {copied ? <CheckCircle size={13} /> : <Copy size={13} />}
      {copied ? t('gui.common.copied') : t('gui.common.copy')}
    </button>
  );
}


function DivisionsTab() {
  const { t } = useTranslation();
  const divRes = useDivisions();
  const divisions = divRes.data?.divisions ?? [];

  const jsonStr = JSON.stringify(
    { divisions: divisions.map((d) => ({
        code:    d.code,
        name:    d.name,
        active:  d.active,
        scope:   d.scope,
        required: d.required,
      }))
    },
    null,
    2,
  );

  return (
    <div className="sidjua-col-gap-16">
      <div className="sidjua-card">
        <div className="page-config--div-header">
          <p className="sidjua-card-title" style={{ marginBottom: 0 }}>{t('gui.config.divisions_title')}</p>
          <div className="sidjua-row-gap-8">
            {divRes.loading && <LoadingSpinner size="sm" />}
            {divisions.length > 0 && <CopyButton text={jsonStr} />}
          </div>
        </div>

        {divRes.error && (
          <p style={{ color: 'var(--color-danger)', fontSize: '15px', marginBottom: '12px' }}>{divRes.error}</p>
        )}

        {!divRes.loading && divisions.length === 0 && !divRes.error && (
          <p className="sidjua-text-muted-sm">
            No divisions found. Run <code>sidjua apply</code> to provision.
          </p>
        )}

        {divisions.length > 0 && (
          // Safe React rendering — plain text, no XSS risk (FIX M3)
          <pre className="page-config--code-block">
            <code>{jsonStr}</code>
          </pre>
        )}
      </div>

      {/* Division summary table */}
      {divisions.length > 0 && (
        <div className="sidjua-card">
          <p className="sidjua-card-title">{t('gui.config.division_summary')}</p>
          <div className="sidjua-table-wrap">
          <table className="sidjua-table">
            <thead>
              <tr>
                {[t('gui.config.col_code'), t('gui.config.col_name'), t('gui.config.col_active'), t('gui.config.col_scope'), t('gui.config.col_required')].map((h) => (
                  <th key={h} className="sidjua-th">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {divisions.map((d) => (
                <tr key={d.code} className="sidjua-tr--border">
                  <td className="page-config--td-code">{d.code}</td>
                  <td className="page-config--td-name">{d.name || '—'}</td>
                  <td className="page-config--td-status">
                    <span style={{ color: d.active ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                      {d.active ? '✓ Active' : '✗ Inactive'}
                    </span>
                  </td>
                  <td className="page-config--td-secondary">{d.scope ?? '—'}</td>
                  <td className="page-config--td-secondary">{d.required ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}


function SystemInfoTab() {
  const { t } = useTranslation();
  const { health, loading: hLoading } = useHealth();
  const infoRes = useApi<SystemInfo>((c) => c.info());
  const agentRes = useAgents();

  const activeAgents = (agentRes.data?.agents ?? []).filter((a) => a.status === 'active' || a.status === 'idle').length;
  const totalAgents  = (agentRes.data?.agents ?? []).length;

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'SIDJUA Version', value: health?.version ?? infoRes.data?.version ?? '—' },
    { label: 'Server Name',    value: infoRes.data?.name ?? '—' },
    { label: 'Description',    value: infoRes.data?.description ?? '—' },
    { label: 'Started at',     value: infoRes.data?.started_at ? new Date(infoRes.data.started_at).toLocaleString() : '—' },
    { label: 'Uptime',         value: health ? formatUptime(health.uptime_ms) : '—' },
    { label: 'Status',         value: health
        ? <span style={{ color: health.status === 'ok' ? 'var(--color-success)' : health.status === 'degraded' ? 'var(--color-warning)' : 'var(--color-danger)', fontWeight: 600 }}>{health.status.toUpperCase()}</span>
        : '—'
    },
    { label: 'Active agents',  value: agentRes.loading ? '—' : `${activeAgents} / ${totalAgents}` },
  ];

  return (
    <div className="sidjua-card">
      <p className="sidjua-card-title">{t('gui.config.system_info')}</p>
      {(hLoading || infoRes.loading) && <LoadingSpinner />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
        {rows.map(({ label, value }) => (
          <div key={label} className="page-config--system-row">
            <span className="page-config--system-label">{label}</span>
            <span className="page-config--system-value">
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


const LEVEL_COLORS: Record<string, string> = {
  debug: 'var(--color-text-muted)',
  info:  'var(--color-info)',
  warn:  'var(--color-warning)',
  error: 'var(--color-danger)',
  fatal: 'var(--color-danger)',
  off:   'var(--color-text-muted)',
};

function LoggingTab() {
  const loggingRes = useApi<LoggingStatus>((c) => c.loggingStatus());
  const status     = loggingRes.data;
  const { t }      = useTranslation();

  return (
    <div className="sidjua-col-gap-16">
      <div className="sidjua-card">
        <p className="sidjua-card-title">{t('gui.config.log_levels')}</p>
        {loggingRes.loading && <LoadingSpinner />}
        {loggingRes.error && <p className="sidjua-text-error-sm">{loggingRes.error}</p>}
        {status && (
          <>
            <div className="page-config--logging-header">
              <span className="page-config--system-label">{t('gui.config.global_level')}</span>
              <span style={{ fontSize: '15px', fontWeight: 700, color: LEVEL_COLORS[status.global] ?? 'var(--color-text)' }}>
                {status.global.toUpperCase()}
              </span>
            </div>
            <div className="page-config--logging-meta">
              <span className="page-config--logging-meta-label">{t('gui.config.format_label')} <strong>{status.format}</strong></span>
              <span className="page-config--logging-meta-label">{t('gui.config.output_label')} <strong>{status.output}</strong></span>
            </div>
            <p className="page-config--overrides-label">
              {t('gui.config.component_overrides')}
            </p>
            {Object.keys(status.components).length === 0 ? (
              <p className="sidjua-text-muted-sm">{t('gui.config.no_overrides')}</p>
            ) : (
              <div className="sidjua-table-wrap">
              <table className="sidjua-table">
                <thead>
                  <tr>
                    <th className="page-config--overrides-th">{t('gui.config.col_component')}</th>
                    <th className="page-config--overrides-th-right">{t('gui.config.col_level')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(status.components).map(([comp, level]) => (
                    <tr key={comp} className="page-config--overrides-tr">
                      <td className="page-config--overrides-td">{comp}</td>
                      <td style={{ padding: '7px 0', textAlign: 'right', fontSize: '16px', fontWeight: 700, color: LEVEL_COLORS[level] ?? 'var(--color-text)' }}>
                        {level.toUpperCase()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            <p className="page-config--log-note">
              Log levels are runtime-ephemeral. Changes via{' '}
              <code>PUT /api/v1/logging/:component</code> are reset on restart.
            </p>
          </>
        )}
      </div>

      {/* Log file paths info box */}
      <div className="sidjua-card sidjua-card--info">
        <p className="sidjua-card-title">{t('gui.config.log_files_title')}</p>
        <div className="page-config--log-info-row">
          <code style={{ fontSize: '16px', flex: 1, color: 'var(--color-text)' }}>
            {t('gui.config.log_error_path')}
          </code>
        </div>
        <p className="page-config--log-label">
          {t('gui.config.copy_logs_label')}
        </p>
        <div className="page-config--log-cmd-row">
          <code className="page-config--log-cmd-code">
            {t('gui.config.copy_logs_command')}
          </code>
          <CopyButton text={t('gui.config.copy_logs_command')} />
        </div>
        <p className="page-config--log-label">
          {t('gui.config.docker_logs_label')}
        </p>
        <div className="page-config--log-docker-row">
          <code className="page-config--log-cmd-code">
            {t('gui.config.docker_logs_command')}
          </code>
          <CopyButton text={t('gui.config.docker_logs_command')} />
        </div>
      </div>
    </div>
  );
}


export function Configuration() {
  const [tab, setTab] = useState<TabId>('divisions');
  const { t } = useTranslation();

  const tabs: { id: TabId; label: string }[] = [
    { id: 'divisions', label: t('gui.config.tab_divisions') },
    { id: 'system',    label: t('gui.config.tab_system') },
    { id: 'logging',   label: t('gui.config.tab_logging') },
  ];

  return (
    <div className="sidjua-col-gap-20">

      {/* Tabs */}
      <div className="sidjua-tab-bar">
        {tabs.map((tabItem) => (
          <button
            key={tabItem.id}
            onClick={() => setTab(tabItem.id)}
            style={{
              padding:      '8px 16px',
              border:       'none',
              background:   'none',
              cursor:       'pointer',
              fontSize:     '15px',
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

      {tab === 'divisions' && <DivisionsTab />}
      {tab === 'system'    && <SystemInfoTab />}
      {tab === 'logging'   && <LoggingTab />}
    </div>
  );
}

