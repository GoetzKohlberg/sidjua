// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useCallback, useEffect } from 'react';
import { Download, ChevronLeft, ChevronRight, X } from 'lucide-react';

import { useAppConfig }  from '../lib/config';
import { useDivisions }  from '../hooks/useDivisions';
import { useSse }        from '../hooks/useSse';
import { formatTime, formatRelative, todayIso } from '../lib/format';
import { downloadJson, downloadCsv } from '../lib/download';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import type { AuditEntry, AuditResponse } from '../api/types';
import { formatGuiError, GUI_ERRORS } from '../i18n/gui-errors';
import { useTranslation } from '../hooks/useTranslation';


const PAGE_SIZE = 50;


const OUTCOME_COLORS: Record<string, string> = {
  blocked:   'var(--color-warning)',
  escalated: 'var(--color-danger)',
  approved:  'var(--color-success)',
  allowed:   'var(--color-success)',
};

function OutcomeBadge({ outcome }: { outcome?: string }) {
  if (!outcome) return <span style={{ color: 'var(--color-text-muted)', fontSize: '16px' }}>—</span>;
  const color = OUTCOME_COLORS[outcome.toLowerCase()] ?? 'var(--color-text-secondary)';
  return (
    <span style={{
      fontSize:      '13px',
      fontWeight:    600,
      color,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>
      {outcome}
    </span>
  );
}


function ExportMenu({ entries }: { entries: AuditEntry[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  function handleJson() {
    downloadJson(entries, `sidjua-audit-${new Date().toISOString().slice(0,10)}.json`);
    setOpen(false);
  }

  function handleCsv() {
    const rows = entries.map((e) => ({
      id:            String(e.id),
      timestamp:     e.timestamp,
      action_type:   e.action_type,
      agent_id:      e.agent_id ?? '',
      division_code: e.division_code ?? '',
      outcome:       e.outcome ?? '',
      metadata:      typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata ?? ''),
    }));
    downloadCsv(rows, `sidjua-audit-${new Date().toISOString().slice(0,10)}.csv`);
    setOpen(false);
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display:      'inline-flex',
          alignItems:   'center',
          gap:          '6px',
          padding:      '6px 14px',
          borderRadius: 'var(--radius-md)',
          border:       '1px solid var(--color-border)',
          background:   'var(--color-surface)',
          color:        'var(--color-text-secondary)',
          cursor:       'pointer',
          fontSize:     '15px',
        }}
      >
        <Download size={14} />
        {t('gui.audit.export')}
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 10 }}
          />
          <div style={{
            position:     'absolute',
            right:        0,
            top:          '100%',
            marginTop:    '4px',
            background:   'var(--color-surface)',
            border:       '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow:    'var(--shadow-md)',
            zIndex:       20,
            minWidth:     '160px',
            overflow:     'hidden',
          }}>
            {[
              { label: t('gui.audit.export_json'), fn: handleJson },
              { label: t('gui.audit.export_csv'),  fn: handleCsv  },
            ].map(({ label, fn }) => (
              <button
                key={label}
                onClick={fn}
                style={{
                  display:    'block',
                  width:      '100%',
                  padding:    '10px 16px',
                  textAlign:  'left',
                  background: 'none',
                  border:     'none',
                  cursor:     'pointer',
                  fontSize:   '15px',
                  color:      'var(--color-text)',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


function DetailPanel({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const { t } = useTranslation();
  let parsedMeta: unknown = null;
  if (typeof entry.metadata === 'string') {
    try { parsedMeta = JSON.parse(entry.metadata); } catch { parsedMeta = entry.metadata; }
  } else {
    parsedMeta = entry.metadata;
  }

  return (
    <div style={{
      background:   'var(--color-surface)',
      border:       '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      padding:      '20px',
      boxShadow:    'var(--shadow-md)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
        <div>
          <p style={{ fontSize: '17px', fontWeight: 700, color: 'var(--color-text)' }}>{entry.action_type}</p>
          <p style={{ fontSize: '16px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
            {entry.timestamp}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)' }}
        >
          <X size={16} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', marginBottom: '16px' }}>
        {[
          { label: t('gui.audit.detail_entry_id'),  value: String(entry.id) },
          { label: t('gui.audit.detail_outcome'),   value: entry.outcome ?? '—' },
          { label: 'Agent',       value: entry.agent_id ?? '—' },
          { label: 'Division',    value: entry.division_code ?? '—' },
          { label: 'Task',        value: entry.parent_task_id ?? '—' },
        ].map(({ label, value }) => (
          <div key={label}>
            <p style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '2px' }}>{label}</p>
            <p style={{ fontSize: '15px', color: 'var(--color-text)', fontWeight: 500, wordBreak: 'break-all' }}>{value}</p>
          </div>
        ))}
      </div>

      {parsedMeta !== null && (
        <div>
          <p style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '6px', fontWeight: 600, textTransform: 'uppercase' }}>
            {t('gui.audit.metadata')}
          </p>
          <pre style={{
            background:   'var(--color-surface-alt)',
            borderRadius: 'var(--radius-md)',
            padding:      '12px',
            fontSize:     '16px',
            color:        'var(--color-text)',
            overflowX:    'auto',
            whiteSpace:   'pre-wrap',
            wordBreak:    'break-all',
            margin:       0,
          }}>
            {JSON.stringify(parsedMeta, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}


export function AuditLog() {
  const { client } = useAppConfig();
  const divRes     = useDivisions();
  const { lastEvent } = useSse();

  // Filter state
  const [fromDate,  setFromDate]  = useState(todayIso().slice(0, 10));
  const [toDate,    setToDate]    = useState('');
  const [division,  setDivision]  = useState('');
  const [agentId,   setAgentId]   = useState('');
  const [eventType, setEventType] = useState('');
  const [offset,    setOffset]    = useState(0);

  // Data state
  const [entries,    setEntries]    = useState<AuditEntry[]>([]);
  const [total,      setTotal]      = useState(0);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [selected,   setSelected]   = useState<AuditEntry | null>(null);
  const [newEntryIds, setNewEntryIds] = useState<Set<string | number>>(new Set());
  const { t } = useTranslation();

  // Escape closes detail panel
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && selected) setSelected(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const fetch = useCallback(async (fetchOffset = 0) => {
    if (!client) { setError(`${GUI_ERRORS['GUI-CONN-005'].message} ${GUI_ERRORS['GUI-CONN-005'].suggestion}`); return; }
    setLoading(true);
    setError(null);
    try {
      const params: Parameters<typeof client.listAudit>[0] = {
        limit:  PAGE_SIZE,
        offset: fetchOffset,
      };
      if (fromDate)  params.from     = new Date(fromDate).toISOString();
      if (toDate)    params.to       = new Date(toDate + 'T23:59:59Z').toISOString();
      if (division)  params.division = division;
      if (agentId)   params.agent    = agentId;
      if (eventType) params.event    = eventType;

      const res: AuditResponse = await client.listAudit(params);
      setEntries(res.entries);
      setTotal(res.total);
      setOffset(fetchOffset);
    } catch (err: unknown) {
      setError(formatGuiError(err));
    } finally {
      setLoading(false);
    }
  }, [client, fromDate, toDate, division, agentId, eventType]);

  // Initial load
  useEffect(() => { void fetch(0); }, [fetch]);

  // SSE real-time prepend
  useEffect(() => {
    if (!lastEvent) return;
    const type = lastEvent.type;
    if (!type.startsWith('task:') && !type.startsWith('governance:') && !type.startsWith('agent:')) return;
    void fetch(0); // simple: just refetch to get latest entries
  }, [lastEvent, fetch]);

  const totalPages  = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const inputStyle: React.CSSProperties = {
    padding:      '6px 10px',
    borderRadius: 'var(--radius-md)',
    border:       '1px solid var(--color-border)',
    background:   'var(--color-bg)',
    color:        'var(--color-text)',
    fontSize:     '15px',
    outline:      'none',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Filter bar */}
      <div style={{
        background:   'var(--color-surface)',
        border:       '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding:      '14px 16px',
        boxShadow:    'var(--shadow-sm)',
        display:      'flex',
        gap:          '10px',
        flexWrap:     'wrap',
        alignItems:   'center',
      }}>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="From date" style={inputStyle} />
        <span style={{ color: 'var(--color-text-muted)', fontSize: '16px' }}>to</span>
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="To date" style={inputStyle} />

        <select value={division} onChange={(e) => setDivision(e.target.value)} aria-label="Division" style={inputStyle}>
          <option value="">{t('gui.audit.all_divisions')}</option>
          {(divRes.data?.divisions ?? []).map((d) => (
            <option key={d.code} value={d.code}>{d.name || d.code}</option>
          ))}
        </select>

        <input
          type="text"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          placeholder="Agent ID…"
          aria-label="Agent ID"
          style={{ ...inputStyle, width: '130px' }}
        />

        <input
          type="text"
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          placeholder="Event type…"
          aria-label="Event type"
          style={{ ...inputStyle, width: '140px' }}
        />

        <button
          onClick={() => void fetch(0)}
          style={{
            padding:      '6px 14px',
            borderRadius: 'var(--radius-md)',
            border:       'none',
            background:   'var(--color-accent)',
            color:        'var(--color-text-inverse)',
            cursor:       'pointer',
            fontSize:     '15px',
            fontWeight:   600,
          }}
        >
          {t('gui.audit.apply')}
        </button>

        <div style={{ marginLeft: 'auto' }}>
          <ExportMenu entries={entries} />
        </div>
      </div>

      {/* Table */}
      <div style={{
        background:   'var(--color-surface)',
        border:       '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow:    'var(--shadow-sm)',
        overflow:     'hidden',
      }}>
        {loading && (
          <div style={{ padding: '40px', display: 'flex', justifyContent: 'center' }}>
            <LoadingSpinner label="Loading audit log…" />
          </div>
        )}
        {error && (
          <div style={{ padding: '20px', color: 'var(--color-danger)', fontSize: '15px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span>{error}</span>
            <button onClick={() => void fetch(offset)} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', textDecoration: 'underline', fontSize: '16px' }}>
              Retry
            </button>
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <p style={{ padding: '40px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '15px' }}>
            {t('gui.audit.no_entries')}
          </p>
        )}
        {entries.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--color-surface-alt)', borderBottom: '2px solid var(--color-border)' }}>
                  {[t('gui.audit.col_time'), t('gui.audit.col_action_type'), t('gui.audit.col_agent'), t('gui.audit.col_division'), t('gui.audit.col_outcome')].map((h) => (
                    <th key={h} style={{
                      textAlign:     'left',
                      padding:       '9px 12px',
                      fontSize:      '13px',
                      color:         'var(--color-text-muted)',
                      fontWeight:    600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      whiteSpace:    'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const isNew = newEntryIds.has(e.id);
                  const isSelected = selected?.id === e.id;
                  return (
                    <tr
                      key={`${e.id}-${e.timestamp}`}
                      onClick={() => setSelected(isSelected ? null : e)}
                      style={{
                        cursor:       'pointer',
                        borderBottom: '1px solid var(--color-border)',
                        background:   isSelected ? 'var(--color-accent-muted)' : isNew ? 'var(--color-info-bg)' : 'transparent',
                        transition:   'background 0.3s',
                      }}
                      onMouseEnter={(e2) => { if (!isSelected) (e2.currentTarget as HTMLTableRowElement).style.background = 'var(--color-bg-hover)'; }}
                      onMouseLeave={(e2) => { if (!isSelected) (e2.currentTarget as HTMLTableRowElement).style.background = ''; }}
                    >
                      <td style={{ padding: '9px 12px', fontSize: '16px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                        {formatTime(e.timestamp)}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: '15px', color: 'var(--color-text)', fontWeight: 500 }}>
                        {e.action_type}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: '16px', color: 'var(--color-text-secondary)' }}>
                        {e.agent_id ?? '—'}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: '16px', color: 'var(--color-text-secondary)' }}>
                        {e.division_code ?? '—'}
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        <OutcomeBadge outcome={e.outcome} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination footer */}
        <div style={{
          display:        'flex',
          justifyContent: 'space-between',
          alignItems:     'center',
          padding:        '10px 16px',
          borderTop:      entries.length > 0 ? '1px solid var(--color-border)' : 'none',
          background:     'var(--color-surface-alt)',
          fontSize:       '16px',
          color:          'var(--color-text-secondary)',
        }}>
          <span>
            {total > 0 ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total} entries` : `${entries.length} entries`}
          </span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={() => void fetch(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || loading}
              aria-label="Previous page"
              style={{
                display:      'inline-flex',
                alignItems:   'center',
                padding:      '4px 8px',
                borderRadius: 'var(--radius-sm)',
                border:       '1px solid var(--color-border)',
                background:   'var(--color-surface)',
                color:        offset === 0 ? 'var(--color-text-muted)' : 'var(--color-text)',
                cursor:       offset === 0 ? 'default' : 'pointer',
              }}
            >
              <ChevronLeft size={14} />
            </button>
            <span style={{ padding: '4px 8px', fontSize: '16px' }}>
              {currentPage} / {totalPages || 1}
            </span>
            <button
              onClick={() => void fetch(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || loading}
              aria-label="Next page"
              style={{
                display:      'inline-flex',
                alignItems:   'center',
                padding:      '4px 8px',
                borderRadius: 'var(--radius-sm)',
                border:       '1px solid var(--color-border)',
                background:   'var(--color-surface)',
                color:        offset + PAGE_SIZE >= total ? 'var(--color-text-muted)' : 'var(--color-text)',
                cursor:       offset + PAGE_SIZE >= total ? 'default' : 'pointer',
              }}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Detail panel */}
      {selected && <DetailPanel entry={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

