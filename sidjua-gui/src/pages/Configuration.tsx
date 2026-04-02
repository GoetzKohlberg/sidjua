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
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
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
        fontSize:     '12px',
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <p style={{ ...cardTitleStyle, marginBottom: 0 }}>{t('gui.config.divisions_title')}</p>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {divRes.loading && <LoadingSpinner size="sm" />}
            {divisions.length > 0 && <CopyButton text={jsonStr} />}
          </div>
        </div>

        {divRes.error && (
          <p style={{ color: 'var(--color-danger)', fontSize: '13px', marginBottom: '12px' }}>{divRes.error}</p>
        )}

        {!divRes.loading && divisions.length === 0 && !divRes.error && (
          <p style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
            No divisions found. Run <code>sidjua apply</code> to provision.
          </p>
        )}

        {divisions.length > 0 && (
          // Safe React rendering — plain text, no XSS risk (FIX M3)
          <pre
            style={{
              background:   'var(--color-bg)',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding:      '16px',
              overflowX:    'auto',
              fontSize:     '12px',
              lineHeight:   1.6,
              fontFamily:   '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
              margin:       0,
            }}
          >
            <code>{jsonStr}</code>
          </pre>
        )}
      </div>

      {/* Division summary table */}
      {divisions.length > 0 && (
        <div style={cardStyle}>
          <p style={cardTitleStyle}>{t('gui.config.division_summary')}</p>
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-alt)', borderBottom: '2px solid var(--color-border)' }}>
                {[t('gui.config.col_code'), t('gui.config.col_name'), t('gui.config.col_active'), t('gui.config.col_scope'), t('gui.config.col_required')].map((h) => (
                  <th key={h} style={{
                    textAlign:     'left',
                    padding:       '8px 12px',
                    fontSize:      '11px',
                    color:         'var(--color-text-muted)',
                    fontWeight:    600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {divisions.map((d) => (
                <tr key={d.code} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '8px 12px', fontSize: '12px', fontFamily: 'monospace', color: 'var(--color-accent)' }}>{d.code}</td>
                  <td style={{ padding: '8px 12px', fontSize: '13px', color: 'var(--color-text)' }}>{d.name || '—'}</td>
                  <td style={{ padding: '8px 12px', fontSize: '12px' }}>
                    <span style={{ color: d.active ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                      {d.active ? '✓ Active' : '✗ Inactive'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>{d.scope ?? '—'}</td>
                  <td style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>{d.required ? 'Yes' : 'No'}</td>
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
    <div style={cardStyle}>
      <p style={cardTitleStyle}>{t('gui.config.system_info')}</p>
      {(hLoading || infoRes.loading) && <LoadingSpinner />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
        {rows.map(({ label, value }) => (
          <div
            key={label}
            style={{
              display:        'flex',
              justifyContent: 'space-between',
              alignItems:     'center',
              padding:        '10px 0',
              borderBottom:   '1px solid var(--color-border)',
            }}
          >
            <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>{label}</span>
            <span style={{ fontSize: '13px', color: 'var(--color-text)', fontWeight: 500, textAlign: 'right', maxWidth: '60%', wordBreak: 'break-all' }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={cardStyle}>
        <p style={cardTitleStyle}>{t('gui.config.log_levels')}</p>
        {loggingRes.loading && <LoadingSpinner />}
        {loggingRes.error && <p style={{ color: 'var(--color-danger)', fontSize: '13px' }}>{loggingRes.error}</p>}
        {status && (
          <>
            <div style={{
              display:        'flex',
              justifyContent: 'space-between',
              padding:        '10px 0',
              borderBottom:   '1px solid var(--color-border)',
              marginBottom:   '12px',
            }}>
              <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>{t('gui.config.global_level')}</span>
              <span style={{ fontSize: '13px', fontWeight: 700, color: LEVEL_COLORS[status.global] ?? 'var(--color-text)' }}>
                {status.global.toUpperCase()}
              </span>
            </div>
            <div style={{
              display:        'flex',
              gap:            '16px',
              marginBottom:   '16px',
            }}>
              <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>{t('gui.config.format_label')} <strong>{status.format}</strong></span>
              <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>{t('gui.config.output_label')} <strong>{status.output}</strong></span>
            </div>
            <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
              {t('gui.config.component_overrides')}
            </p>
            {Object.keys(status.components).length === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{t('gui.config.no_overrides')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '6px 0', fontSize: '11px', color: 'var(--color-text-muted)', fontWeight: 600 }}>{t('gui.config.col_component')}</th>
                    <th style={{ textAlign: 'right', padding: '6px 0', fontSize: '11px', color: 'var(--color-text-muted)', fontWeight: 600 }}>{t('gui.config.col_level')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(status.components).map(([comp, level]) => (
                    <tr key={comp} style={{ borderTop: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '7px 0', fontSize: '12px', fontFamily: 'monospace', color: 'var(--color-text)' }}>{comp}</td>
                      <td style={{ padding: '7px 0', textAlign: 'right', fontSize: '12px', fontWeight: 700, color: LEVEL_COLORS[level] ?? 'var(--color-text)' }}>
                        {level.toUpperCase()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '12px' }}>
              Log levels are runtime-ephemeral. Changes via{' '}
              <code>PUT /api/v1/logging/:component</code> are reset on restart.
            </p>
          </>
        )}
      </div>

      {/* Log file paths info box */}
      <div style={{
        ...cardStyle,
        background:   'var(--color-info-bg)',
        border:       '1px solid var(--color-info)',
      }}>
        <p style={cardTitleStyle}>{t('gui.config.log_files_title')}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
          <code style={{ fontSize: '12px', flex: 1, color: 'var(--color-text)' }}>
            {t('gui.config.log_error_path')}
          </code>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
          {t('gui.config.copy_logs_label')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
          <code style={{ fontSize: '12px', flex: 1, color: 'var(--color-text)', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', padding: '4px 8px' }}>
            {t('gui.config.copy_logs_command')}
          </code>
          <CopyButton text={t('gui.config.copy_logs_command')} />
        </div>
        <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
          {t('gui.config.docker_logs_label')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <code style={{ fontSize: '12px', flex: 1, color: 'var(--color-text)', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', padding: '4px 8px' }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', borderBottom: '2px solid var(--color-border)' }}>
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

      {tab === 'divisions' && <DivisionsTab />}
      {tab === 'system'    && <SystemInfoTab />}
      {tab === 'logging'   && <LoggingTab />}
    </div>
  );
}

export default Configuration;
