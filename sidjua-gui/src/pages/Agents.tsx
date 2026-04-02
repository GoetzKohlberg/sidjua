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
      <td style={{ padding: '12px 8px', fontWeight: 600, fontSize: '13px', color: 'var(--color-text)' }}>
        {agent.name}
      </td>
      <td style={{ padding: '12px 8px', fontSize: '13px', color: 'var(--color-text-secondary)' }}>
        {agent.division}
      </td>
      <td style={{ padding: '12px 8px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
        {agent.resolved_model ?? agent.model}
      </td>
      <td style={{ padding: '12px 8px', fontSize: '12px', color: 'var(--color-text-secondary)', textAlign: 'right' }}>
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
        <p style={{ color: 'var(--color-danger)', fontSize: '13px' }}>
          {agentRes.error ?? 'Agent not found.'}
        </p>
      </PanelShell>
    );
  }

  return (
    <PanelShell onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--color-text)', marginBottom: '4px' }}>
            {agent.name}
          </h2>
          <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
            {agent.division} · {t(`agent.tier.${agent.tier}`)}
          </p>
        </div>
      </div>

      {patchError && (
        <p style={{ color: 'var(--color-danger)', fontSize: '12px', marginBottom: '10px' }}>{patchError}</p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', marginBottom: '16px' }}>
        {/* Provider dropdown */}
        <div>
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>{t('gui.agents.provider')}</p>
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
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>{t('gui.agents.model')}</p>
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
        <div style={{
          background:   'var(--color-surface-alt)',
          borderRadius: 'var(--radius-md)',
          padding:      '12px',
          marginBottom: '16px',
          borderLeft:   '3px solid var(--color-accent)',
        }}>
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '4px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Current Task
          </p>
          <p style={{ fontSize: '13px', color: 'var(--color-text)', fontWeight: 500 }}>
            {currentTask.title}
          </p>
          <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
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
        <p style={{
          fontSize:      '11px',
          fontWeight:    600,
          color:         'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBottom:  '8px',
        }}>
          Recent Actions
        </p>
        <ActivityFeed events={auditEvents} maxItems={10} autoScroll={false} />
      </div>
    </PanelShell>
  );
}

function PanelShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      background:   'var(--color-surface)',
      border:       '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      padding:      '20px',
      boxShadow:    'var(--shadow-md)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' }}>
        <button
          onClick={onClose}
          aria-label="Close detail panel"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--color-text-muted)', padding: '4px',
          }}
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
      <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '2px' }}>{label}</p>
      <p style={{ fontSize: '13px', color: color ?? 'var(--color-text)', fontWeight: 500 }}>{value}</p>
    </div>
  );
}


function StarterAgentDetail({ agent, onClose, providerConfigured }: { agent: StarterAgent; onClose: () => void; providerConfigured: boolean }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <div
      style={{
        background:   'var(--color-surface)',
        border:       '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding:      '24px',
        boxShadow:    'var(--shadow-sm)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '50%',
            background: 'var(--color-accent-muted, #eff6ff)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--color-accent)', flexShrink: 0,
          }}>
            <AgentIcon name={agent.icon} size={22} />
          </div>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
              {agent.name}
            </h2>
            <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '2px 0 0' }}>
              {t(`agent.tier.desc.${agent.tier}`)}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close detail"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--color-text-muted)', padding: '4px',
            display: 'flex', alignItems: 'center',
          }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Description */}
      <p style={{ fontSize: '14px', color: 'var(--color-text)', lineHeight: 1.6, marginBottom: '20px' }}>
        {agent.description}
      </p>

      {/* Capabilities */}
      <div style={{ marginBottom: '20px' }}>
        <p style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
          {t('gui.agents.capabilities')}
        </p>
        <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {agent.capabilities.map((cap) => (
            <li key={cap} style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              {cap}
            </li>
          ))}
        </ul>
      </div>

      {/* Meta */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '20px' }}>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '2px' }}>{t('gui.agents.division')}</p>
          <p style={{ fontSize: '13px', color: 'var(--color-text)', fontWeight: 500 }}>{agent.division}</p>
        </div>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '2px' }}>{t('gui.agents.domains')}</p>
          <p style={{ fontSize: '13px', color: 'var(--color-text)', fontWeight: 500 }}>{agent.domains.join(', ')}</p>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {!providerConfigured && (
          <button
            onClick={() => navigate('/settings')}
            style={{
              padding: '8px 16px', borderRadius: 'var(--radius-md)',
              background: 'var(--color-accent)', border: 'none',
              color: 'var(--color-on-accent)', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
            }}
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
            fontSize: '13px', fontWeight: providerConfigured ? 600 : 400,
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Section header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
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
              fontSize:     '13px',
            }}
          >
            <Plus size={14} />
            {t('gui.agents.create_new')}
          </button>
          {showCreateTooltip && llmStatus !== 'configured' && (
            <div style={{
              position:     'absolute',
              top:          'calc(100% + 6px)',
              right:        0,
              background:   'var(--color-surface)',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding:      '12px 16px',
              width:        '280px',
              fontSize:     '13px',
              color:        'var(--color-text-secondary)',
              boxShadow:    'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.1))',
              zIndex:       10,
              lineHeight:   1.5,
            }}>
              Agent creation will be available after LLM provider configuration.
              Your <strong>HR Manager</strong> agent will help you define new roles.
            </div>
          )}
        </div>
      </div>

      {/* Agent cards grid */}
      {starterRes.loading && (
        <div style={{ padding: '20px', display: 'flex', justifyContent: 'center' }}>
          <LoadingSpinner label="Loading agents…" />
        </div>
      )}

      {!starterRes.loading && agents.length > 0 && (
        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap:                 '12px',
        }}>
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
        <div style={{
          background:   'var(--color-info-bg)',
          border:       '1px solid var(--color-info-border)',
          borderRadius: 'var(--radius-md)',
          padding:      '12px 16px',
          fontSize:     '13px',
          color:        'var(--color-info)',
          lineHeight:   1.5,
        }}>
          These 6 agents are your starter team. They become fully operational once you{' '}
          <button
            onClick={() => navigate('/settings')}
            style={{ background: 'none', border: 'none', color: 'var(--color-info)', cursor: 'pointer', textDecoration: 'underline', fontSize: 'inherit', padding: 0 }}
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
        <div style={{ padding: '40px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <LoadingSpinner label="Connecting to server…" />
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0 }}>
            Connecting to server…
          </p>
        </div>
      );
    }
    return (
      <div style={{
        background:   'var(--color-warning-bg)',
        border:       '1px solid var(--color-warning)',
        borderRadius: 'var(--radius-lg)',
        padding:      '20px',
        color:        'var(--color-warning)',
      }}>
        <strong>{t('gui.agents.not_connected')}</strong> — configure your server URL and API key in{' '}
        <button
          onClick={() => navigate('/settings')}
          style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', textDecoration: 'underline', fontSize: 'inherit' }}
        >
          Settings
        </button>.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* Starter agents "Your Team" section */}
      <YourTeamPanel />

      {/* Filter bar */}
      <div style={{
        display:     'flex',
        gap:         '12px',
        flexWrap:    'wrap',
        alignItems:  'center',
        background:  'var(--color-surface)',
        border:      '1px solid var(--color-border)',
        borderRadius:'var(--radius-lg)',
        padding:     '12px 16px',
        boxShadow:   'var(--shadow-sm)',
      }}>
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
          style={{
            display:      'inline-flex',
            alignItems:   'center',
            gap:          '5px',
            padding:      '6px 12px',
            borderRadius: 'var(--radius-md)',
            border:       '1px solid var(--color-border)',
            background:   'var(--color-surface)',
            color:        'var(--color-text-secondary)',
            cursor:       'pointer',
            fontSize:     '13px',
            whiteSpace:   'nowrap',
          }}
        >
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>

      {/* Agent table */}
      <div style={{
        background:   'var(--color-surface)',
        border:       '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow:    'var(--shadow-sm)',
        overflow:     'hidden',
      }}>
        {agentRes.loading && (
          <div style={{ padding: '40px', display: 'flex', justifyContent: 'center' }}>
            <LoadingSpinner label="Loading agents…" />
          </div>
        )}

        {agentRes.error && (
          <div style={{ padding: '20px', color: 'var(--color-danger)', fontSize: '13px', display: 'flex', gap: '8px' }}>
            <span>{agentRes.error}</span>
            <button
              onClick={agentRes.refetch}
              style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Retry
            </button>
          </div>
        )}

        {!agentRes.loading && !agentRes.error && agents.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '13px' }}>
            No agents found{divisionFilter || statusFilter || search ? ' matching current filters' : ''}.
          </div>
        )}

        {agents.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)' }}>
                  {[t('gui.agents.col_name'), t('gui.agents.division'), t('gui.agents.model'), t('gui.agents.col_updated')].map((h) => (
                    <th key={h} style={{
                      textAlign:     'left',
                      padding:       '10px 16px 10px 8px',
                      fontSize:      '11px',
                      color:         'var(--color-text-muted)',
                      fontWeight:    600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      background:    'var(--color-surface-alt)',
                      whiteSpace:    'nowrap',
                    }}>
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

        <div style={{
          padding:      '8px 16px',
          fontSize:     '12px',
          color:        'var(--color-text-muted)',
          borderTop:    agents.length > 0 ? '1px solid var(--color-border)' : 'none',
          background:   'var(--color-surface-alt)',
        }}>
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
  fontSize:     '13px',
  outline:      'none',
  fontWeight:   500,
};

const selectStyle: React.CSSProperties = {
  padding:      '6px 10px',
  borderRadius: 'var(--radius-md)',
  border:       '1px solid var(--color-border)',
  background:   'var(--color-bg)',
  color:        'var(--color-text)',
  fontSize:     '13px',
  outline:      'none',
};

export default Agents;
