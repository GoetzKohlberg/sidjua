// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { RefreshCw, X, Plus } from 'lucide-react';
import { useTranslation } from '../hooks/useTranslation';

import { useAgents }    from '../hooks/useAgents';
import { useAgent }     from '../hooks/useAgent';
import { useDivisions } from '../hooks/useDivisions';
import { useApi }       from '../hooks/useApi';
import { useSse }       from '../hooks/useSse';
import { useAppConfig } from '../lib/config';
import { formatRelative, todayIso } from '../lib/format';
import { ProgressBar }   from '../components/shared/ProgressBar';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import { ActivityFeed }   from '../components/shared/ActivityFeed';
import { AgentCard }      from '../components/shared/AgentCard';
import { AgentIcon }      from '../components/shared/AgentIcon';
import type { ActivityEvent } from '../components/shared/ActivityFeed';
import type { Agent, AgentLifecycleStatus, TasksResponse, AuditResponse, StarterAgentsResponse, StarterAgent, ProviderConfigResponse, ProviderCatalogResponse } from '../api/types';
import { formatGuiError } from '../i18n/gui-errors';


const FLASH_DURATION_MS = 1_500;

interface AgentRowProps {
  agent:      Agent;
  isSelected: boolean;
  isFlashing: boolean;
  onClick:    () => void;
}

function AgentRow({ agent, isSelected, isFlashing, onClick }: AgentRowProps) {
  return (
    <tr
      onClick={onClick}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      aria-selected={isSelected}
      style={{
        cursor:     'pointer',
        background: isSelected
          ? 'var(--color-accent-muted)'
          : isFlashing
          ? 'var(--color-warning-bg)'
          : 'transparent',
        transition: 'background 0.3s ease',
        borderBottom: '1px solid var(--color-border)',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = 'var(--color-bg-hover)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = isFlashing ? 'var(--color-warning-bg)' : '';
      }}
    >
      <td className="page-agents--td-name">
        {agent.name}
      </td>
      <td className="page-agents--td-division">
        {agent.division}
      </td>
      <td className="page-agents--td-model">
        {agent.resolved_model ?? agent.model}
      </td>
      <td className="page-agents--td-updated">
        {formatRelative(agent.updated_at)}
      </td>
    </tr>
  );
}


function AgentDetail({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const agentRes = useAgent(agentId);
  const agent    = agentRes.data?.agent;
  const { client } = useAppConfig();

  const { t } = useTranslation();

  // Provider/model selection state
  const catalogRes  = useApi<ProviderCatalogResponse>((c) => c.getProviderCatalog());
  const [patchError, setPatchError] = useState<string | null>(null);

  async function handleProviderChange(provider: string, model: string): Promise<void> {
    if (!client || !agent) return;
    setPatchError(null);
    try {
      await client.patchAgent(agentId, { provider, model });
      agentRes.refetch();
    } catch (err: unknown) {
      setPatchError(formatGuiError(err));
    }
  }

  const tasksRes = useApi<TasksResponse>(
    (c) => c.listTasks({ agent: agentId, status: 'RUNNING', limit: 1 }),
    [agentId],
  );
  const doneRes = useApi<TasksResponse>(
    (c) => c.listTasks({ agent: agentId, status: 'DONE',   limit: 1 }),
    [agentId],
  );
  const failedRes = useApi<TasksResponse>(
    (c) => c.listTasks({ agent: agentId, status: 'FAILED', limit: 1 }),
    [agentId],
  );
  const auditRes = useApi<AuditResponse>(
    (c) => c.listAudit({ agent: agentId, from: todayIso(), limit: 10 }),
    [agentId],
  );

  const currentTask  = tasksRes.data?.tasks?.[0];
  const doneTotal    = doneRes.data?.total    ?? 0;
  const failedTotal  = failedRes.data?.total  ?? 0;

  const auditEvents: ActivityEvent[] = (auditRes.data?.entries ?? []).map((e) => ({
    id:          e.id,
    timestamp:   e.timestamp,
    type:        e.action_type,
    description: e.action_type,
    agentId:     e.agent_id,
    outcome:     e.outcome === 'blocked' ? 'blocked' : 'info',
  }));

  if (agentRes.loading) {
    return (
      <PanelShell onClose={onClose}>
        <LoadingSpinner label="Loading agent…" />
      </PanelShell>
    );
  }

  if (agentRes.error || !agent) {
    return (
      <PanelShell onClose={onClose}>
        <p className="sidjua-text-error-sm">
          {agentRes.error ?? 'Agent not found.'}
        </p>
      </PanelShell>
    );
  }

  return (
    <PanelShell onClose={onClose}>
      <div className="page-agents--detail-header">
        <div>
          <h2 className="page-agents--detail-h2">
            {agent.name}
          </h2>
          <p className="page-agents--detail-sub">
            {agent.division} · {t(`agent.tier.${agent.tier}`)}
          </p>
        </div>
      </div>

      {patchError && (
        <p style={{ color: 'var(--color-danger)', fontSize: '16px', marginBottom: '10px' }}>{patchError}</p>
      )}

      <div className="page-agents--detail-grid">
        {/* Provider dropdown */}
        <div>
          <p className="page-agents--field-label">{t('gui.agents.provider')}</p>
          <select
            value={agent.provider}
            onChange={(e) => {
              const prov = catalogRes.data?.providers.find((p) => p.id === e.target.value);
              void handleProviderChange(e.target.value, prov?.model ?? agent.model);
            }}
            style={{ ...detailSelectStyle, width: '100%' }}
            aria-label="Agent provider"
          >
            {catalogRes.data?.providers.map((p) => (
              <option key={p.id} value={p.id}>{p.display_name}</option>
            ))}
            {/* Always keep current value selectable even if catalog not yet loaded */}
            {(!catalogRes.data || !catalogRes.data.providers.some((p) => p.id === agent.provider)) && (
              <option value={agent.provider}>{agent.provider}</option>
            )}
          </select>
        </div>

        {/* Model dropdown — all models from the same provider family */}
        <div>
          <p className="page-agents--field-label">{t('gui.agents.model')}</p>
          {(() => {
            const selectedProv   = catalogRes.data?.providers.find((p) => p.id === agent.provider);
            const providerFamily = selectedProv?.name;
            const familyEntries  = providerFamily
              ? (catalogRes.data?.providers ?? []).filter((p) => p.name === providerFamily)
              : selectedProv ? [selectedProv] : [];
            const currentModel   = agent.resolved_model ?? agent.model;
            const inFamily       = familyEntries.some((p) => p.model === currentModel);
            return (
              <select
                value={currentModel}
                onChange={(e) => {
                  const match = familyEntries.find((p) => p.model === e.target.value);
                  void handleProviderChange(match?.id ?? agent.provider, e.target.value);
                }}
                style={{ ...detailSelectStyle, width: '100%' }}
                aria-label="Agent model"
              >
                {familyEntries.map((p) => (
                  <option key={p.id} value={p.model}>
                    {p.recommended ? '★ ' : ''}{p.model} ({p.quality})
                  </option>
                ))}
                {!inFamily && currentModel && (
                  <option value={currentModel}>{currentModel}</option>
                )}
              </select>
            );
          })()}
        </div>

        <DetailRow label="Created"  value={formatRelative(agent.created_at)} />
        <DetailRow label="Updated"  value={formatRelative(agent.updated_at)} />
        <DetailRow label="Tasks done"   value={String(doneTotal)} />
        <DetailRow label="Tasks failed" value={String(failedTotal)} color={failedTotal > 0 ? 'var(--color-danger)' : undefined} />
      </div>

      {currentTask && (
        <div className="page-agents--current-task">
          <p className="page-agents--current-task-label">
            Current Task
          </p>
          <p className="page-agents--current-task-title">
            {currentTask.title}
          </p>
          <p className="page-agents--current-task-ts">
            {currentTask.id.slice(0, 8)} · started {formatRelative(currentTask.created_at)}
          </p>
        </div>
      )}

      {doneTotal + failedTotal > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <ProgressBar
            value={doneTotal + failedTotal > 0 ? (doneTotal / (doneTotal + failedTotal)) * 100 : 0}
            label="Success rate"
            color="var(--color-success)"
          />
        </div>
      )}

      <div>
        <p className="page-agents--recent-label">
          Recent Actions
        </p>
        <ActivityFeed events={auditEvents} maxItems={10} autoScroll={false} />
      </div>
    </PanelShell>
  );
}

function PanelShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sidjua-card sidjua-card--elevated">
      <div className="page-agents--panel-close-wrap">
        <button
          onClick={onClose}
          aria-label="Close detail panel"
          className="page-agents--icon-btn"
        >
          <X size={16} />
        </button>
      </div>
      {children}
    </div>
  );
}

function DetailRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <p className="page-agents--field-label" style={{ marginBottom: '2px' }}>{label}</p>
      <p style={{ fontSize: '15px', color: color ?? 'var(--color-text)', fontWeight: 500 }}>{value}</p>
    </div>
  );
}


function StarterAgentDetail({ agent, onClose, providerConfigured }: { agent: StarterAgent; onClose: () => void; providerConfigured: boolean }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <div className="page-agents--starter-card">
      {/* Header */}
      <div className="page-agents--starter-header">
        <div className="page-agents--starter-icon-row">
          <div className="page-agents--starter-icon">
            <AgentIcon name={agent.icon} size={22} />
          </div>
          <div>
            <h2 className="page-agents--starter-name">
              {agent.name}
            </h2>
            <p className="page-agents--starter-tier">
              {t(`agent.tier.desc.${agent.tier}`)}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close detail"
          className="page-agents--close-btn"
        >
          <X size={18} />
        </button>
      </div>

      {/* Description */}
      <p className="page-agents--starter-desc">
        {agent.description}
      </p>

      {/* Capabilities */}
      <div className="page-agents--capabilities-section">
        <p className="page-agents--capabilities-label">
          {t('gui.agents.capabilities')}
        </p>
        <ul className="page-agents--capabilities-list">
          {agent.capabilities.map((cap) => (
            <li key={cap} className="page-agents--capability-item">
              {cap}
            </li>
          ))}
        </ul>
      </div>

      {/* Meta */}
      <div className="page-agents--meta-row">
        <div>
          <p className="page-agents--meta-label">{t('gui.agents.division')}</p>
          <p className="page-agents--meta-value">{agent.division}</p>
        </div>
        <div>
          <p className="page-agents--meta-label">{t('gui.agents.domains')}</p>
          <p className="page-agents--meta-value">{agent.domains.join(', ')}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="page-agents--actions-row">
        {!providerConfigured && (
          <button
            onClick={() => navigate('/settings')}
            className="page-agents--primary-btn"
          >
            Configure LLM Provider
          </button>
        )}
        <button
          onClick={providerConfigured ? () => navigate(`/chat/${agent.id}`) : undefined}
          disabled={!providerConfigured}
          title={providerConfigured ? `Chat with ${agent.name}` : 'Configure an LLM provider in Settings first'}
          style={{
            padding: '8px 16px', borderRadius: 'var(--radius-md)',
            background: providerConfigured ? 'var(--color-accent)' : 'var(--color-bg)',
            border: providerConfigured ? 'none' : '1px solid var(--color-border)',
            color: providerConfigured ? 'var(--color-on-accent)' : 'var(--color-text-muted)',
            cursor: providerConfigured ? 'pointer' : 'not-allowed',
            fontSize: '15px', fontWeight: providerConfigured ? 600 : 400,
          }}
        >
          Chat with {agent.name}
        </button>
      </div>
    </div>
  );
}


function YourTeamPanel() {
  const navigate  = useNavigate();
  const { t } = useTranslation();
  const { client } = useAppConfig();
  const starterRes    = useApi<StarterAgentsResponse>((c) => c.listStarterAgents());
  const providerRes   = useApi<ProviderConfigResponse>((c) => c.getProviderConfig());
  const [selectedAgent, setSelectedAgent] = useState<StarterAgent | null>(null);
  const [showCreateTooltip, setShowCreateTooltip] = useState(false);

  const agents        = starterRes.data?.agents ?? [];
  const llmStatus: 'configured' | 'not_configured' = providerRes.data?.configured ? 'configured' : 'not_configured';
  const defaultLabel  = providerRes.data?.default_provider?.display_name ?? undefined;
  const agentOverrides = providerRes.data?.agent_overrides ?? {};

  if (!client) return null;

  return (
    <div className="sidjua-col-gap-16">
      {/* Section header */}
      <div className="page-agents--team-header">
        <h2 className="page-agents--team-h2">
          {t('gui.agents.your_team')}
        </h2>
        <div style={{ position: 'relative' }}>
          <button
            onClick={llmStatus === 'configured'
              ? () => navigate('/chat/hr')
              : () => setShowCreateTooltip((v) => !v)
            }
            onBlur={() => setShowCreateTooltip(false)}
            title={llmStatus === 'configured' ? undefined : 'Configure an LLM provider first'}
            style={{
              display:      'inline-flex',
              alignItems:   'center',
              gap:          '6px',
              padding:      '6px 14px',
              borderRadius: 'var(--radius-md)',
              border:       `1px solid ${llmStatus === 'configured' ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background:   llmStatus === 'configured' ? 'var(--color-accent)' : 'var(--color-surface)',
              color:        llmStatus === 'configured' ? 'var(--color-text-inverse)' : 'var(--color-text-secondary)',
              cursor:       'pointer',
              fontSize:     '15px',
            }}
          >
            <Plus size={14} />
            {t('gui.agents.create_new')}
          </button>
          {showCreateTooltip && llmStatus !== 'configured' && (
            <div className="page-agents--tooltip">
              Agent creation will be available after LLM provider configuration.
              Your <strong>HR Manager</strong> agent will help you define new roles.
            </div>
          )}
        </div>
      </div>

      {/* Agent cards grid */}
      {starterRes.loading && (
        <div className="page-agents--loading-center">
          <LoadingSpinner label="Loading agents…" />
        </div>
      )}

      {!starterRes.loading && agents.length > 0 && (
        <div className="page-agents--cards-grid">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              selected={selectedAgent?.id === agent.id}
              onClick={() => setSelectedAgent(selectedAgent?.id === agent.id ? null : agent)}
              llmStatus={providerRes.loading ? undefined : llmStatus}
              providerLabel={
                llmStatus === 'configured'
                  ? (agentOverrides[agent.id]?.display_name ?? defaultLabel)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {/* Detail panel */}
      {selectedAgent && (
        <StarterAgentDetail
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          providerConfigured={providerRes.data?.configured === true}
        />
      )}

      {/* Info banner — only shown when no provider is configured yet */}
      {llmStatus !== 'configured' && (
        <div className="page-agents--info-banner">
          These 6 agents are your starter team. They become fully operational once you{' '}
          <button
            onClick={() => navigate('/settings')}
            className="page-agents--info-link"
          >
            configure an LLM provider
          </button>
          {' '}in Settings. The <strong>Guide</strong> agent is your first point of contact — start there to learn how SIDJUA works.
        </div>
      )}
    </div>
  );
}


const ALL_STATUSES: AgentLifecycleStatus[] = ['active', 'idle', 'starting', 'stopping', 'stopped', 'error'];

export function Agents() {
  const navigate             = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { client }           = useAppConfig();

  const divisionParam = searchParams.get('division') ?? '';
  const statusParam   = searchParams.get('status')   ?? '';
  const searchQuery   = searchParams.get('q')        ?? '';

  const [divisionFilter, setDivisionFilter] = useState(divisionParam);
  const [statusFilter,   setStatusFilter]   = useState(statusParam);
  const [search,         setSearch]         = useState(searchQuery);
  const [selectedId,     setSelectedId]     = useState<string | null>(null);
  const [flashingIds,    setFlashingIds]    = useState<Set<string>>(new Set());
  const [refreshKey,     setRefreshKey]     = useState(0);
  const { t } = useTranslation();

  // Escape closes detail panel
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && selectedId) setSelectedId(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  const divRes   = useDivisions();
  const agentRes = useAgents({}, refreshKey);
  const { lastEvent } = useSse();

  // Live agent map for real-time status updates
  const [agentMap, setAgentMap] = useState<Map<string, Agent>>(new Map());

  // Sync agentMap when REST data loads
  useEffect(() => {
    const agents = agentRes.data?.agents ?? [];
    setAgentMap(new Map(agents.map((a) => [a.id, a])));
  }, [agentRes.data]);

  // Apply SSE agent status changes
  useEffect(() => {
    if (!lastEvent) return;
    const data = lastEvent.data as Record<string, unknown>;
    const agentId = String(data['agentId'] ?? '');
    if (!agentId) return;

    const status: AgentLifecycleStatus | undefined =
      lastEvent.type === 'agent:started'   ? 'active'  :
      lastEvent.type === 'agent:stopped'   ? 'stopped' :
      lastEvent.type === 'agent:crashed'   ? 'error'   :
      lastEvent.type === 'agent:restarted' ? 'starting' :
      undefined;

    if (status) {
      setAgentMap((prev) => {
        const existing = prev.get(agentId);
        if (!existing) return prev;
        const updated = new Map(prev);
        updated.set(agentId, { ...existing, status, updated_at: new Date().toISOString() });
        return updated;
      });

      // Flash the row
      setFlashingIds((prev) => new Set([...prev, agentId]));
      setTimeout(() => {
        setFlashingIds((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }, FLASH_DURATION_MS);
    }
  }, [lastEvent]);

  // Filtered + sorted agent list
  const agents = useMemo(() => {
    let list = [...agentMap.values()];
    if (divisionFilter) list = list.filter((a) => a.division === divisionFilter);
    if (statusFilter)   list = list.filter((a) => a.status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((a) =>
        a.name.toLowerCase().includes(q) ||
        a.division.toLowerCase().includes(q) ||
        (a.resolved_model ?? a.model).toLowerCase().includes(q),
      );
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [agentMap, divisionFilter, statusFilter, search]);

  function updateFilter(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    });
  }

  const { bootstrapping } = useAppConfig();

  if (!client) {
    if (bootstrapping) {
      return (
        <div className="page-agents--bootstrapping">
          <LoadingSpinner label="Connecting to server…" />
          <p className="page-agents--bootstrapping-text">
            Connecting to server…
          </p>
        </div>
      );
    }
    return (
      <div className="page-agents--not-connected">
        <strong>{t('gui.agents.not_connected')}</strong> — configure your server URL and API key in{' '}
        <button
          onClick={() => navigate('/settings')}
          className="page-agents--settings-link"
        >
          Settings
        </button>.
      </div>
    );
  }

  return (
    <div className="sidjua-col-gap-24">

      {/* Starter agents "Your Team" section */}
      <YourTeamPanel />

      {/* Filter bar */}
      <div className="page-agents--filter-bar">
        <select
          value={divisionFilter}
          onChange={(e) => { setDivisionFilter(e.target.value); updateFilter('division', e.target.value); }}
          aria-label="Filter by division"
          style={selectStyle}
        >
          <option value="">{t('gui.agents.all_divisions')}</option>
          {(divRes.data?.divisions ?? []).map((d) => (
            <option key={d.code} value={d.code}>{d.name || d.code}</option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); updateFilter('status', e.target.value); }}
          aria-label="Filter by status"
          style={selectStyle}
        >
          <option value="">{t('gui.agents.all_statuses')}</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s} style={{ textTransform: 'capitalize' }}>{s}</option>
          ))}
        </select>

        <input
          type="search"
          value={search}
          onChange={(e) => { setSearch(e.target.value); updateFilter('q', e.target.value); }}
          placeholder="Search agents…"
          aria-label="Search agents"
          style={{ ...selectStyle, flex: 1, minWidth: '160px' }}
        />

        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          aria-label="Refresh agents"
          className="page-agents--refresh-btn"
        >
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>

      {/* Agent table */}
      <div className="page-agents--table-outer">
        {agentRes.loading && (
          <div className="page-agents--table-loading">
            <LoadingSpinner label="Loading agents…" />
          </div>
        )}

        {agentRes.error && (
          <div className="page-agents--table-error">
            <span>{agentRes.error}</span>
            <button
              onClick={agentRes.refetch}
              className="page-agents--retry-link"
            >
              Retry
            </button>
          </div>
        )}

        {!agentRes.loading && !agentRes.error && agents.length === 0 && (
          <div className="page-agents--table-empty">
            No agents found{divisionFilter || statusFilter || search ? ' matching current filters' : ''}.
          </div>
        )}

        {agents.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)' }}>
                  {[t('gui.agents.col_name'), t('gui.agents.division'), t('gui.agents.model'), t('gui.agents.col_updated')].map((h) => (
                    <th key={h} className="page-agents--th">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    isSelected={selectedId === agent.id}
                    isFlashing={flashingIds.has(agent.id)}
                    onClick={() => setSelectedId(selectedId === agent.id ? null : agent.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div
          className="page-agents--table-footer"
          style={{ borderTop: agents.length > 0 ? '1px solid var(--color-border)' : 'none' }}
        >
          {agents.length > 0
            ? `${agents.length} agent${agents.length !== 1 ? 's' : ''}${(divisionFilter || statusFilter || search) ? ' (filtered)' : ''}`
            : 'No agents deployed yet — run \u2018sidjua apply\u2019 to create agents from your workspace'
          }
        </div>
      </div>

      {/* Detail panel */}
      {selectedId && (
        <AgentDetail
          agentId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}


const detailSelectStyle: React.CSSProperties = {
  padding:      '4px 8px',
  borderRadius: 'var(--radius-md)',
  border:       '1px solid var(--color-border)',
  background:   'var(--color-bg)',
  color:        'var(--color-text)',
  fontSize:     '15px',
  outline:      'none',
  fontWeight:   500,
};

const selectStyle: React.CSSProperties = {
  padding:      '6px 10px',
  borderRadius: 'var(--radius-md)',
  border:       '1px solid var(--color-border)',
  background:   'var(--color-bg)',
  color:        'var(--color-text)',
  fontSize:     '15px',
  outline:      'none',
};

