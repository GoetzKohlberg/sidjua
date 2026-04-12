// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * OrgChart page — replaces the flat Agents tab with a hierarchical view.
 * Shows divisions as a drillable tree; breadcrumb navigation.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation }       from '../hooks/useTranslation';
import { useOrgTree }           from '../hooks/useOrgTree';
import { useAgentStatus }       from '../hooks/useAgentStatus';
import { OrgChartTree }         from '../components/shared/OrgChartTree';
import { OrgChartBreadcrumb, type BreadcrumbItem } from '../components/shared/OrgChartBreadcrumb';
import { LoadingSpinner }       from '../components/shared/LoadingSpinner';
import type { OrgNode }         from '../api/types';

/** Root breadcrumb sentinel — represents the org-chart root before tree loads. */
const ROOT_CRUMB: BreadcrumbItem = { id: '__root__', name: 'Organization' };

export function OrgChart() {
  const { t }                           = useTranslation();
  const { tree, loading, error, refresh } = useOrgTree();
  const { statuses: agentStatuses }     = useAgentStatus(10_000);

  const [breadcrumb,    setBreadcrumb]    = useState<BreadcrumbItem[]>([ROOT_CRUMB]);
  const [currentNodes,  setCurrentNodes]  = useState<OrgNode[]>([]);
  const [selectedId,    setSelectedId]    = useState<string | null>(null);

  // When tree first loads, show root divisions and update root crumb name
  useEffect(() => {
    if (!tree) return;
    setCurrentNodes(tree.roots);
    setSelectedId(null);
    setBreadcrumb([{ id: '__root__', name: t('gui.nav.organization') }]);
  }, [tree, t]);

  // Drill down into a division's children
  const handleSelect = useCallback((node: OrgNode) => {
    if (node.children.length === 0) {
      // Leaf node — toggle selection only
      setSelectedId((prev) => prev === node.division.code ? null : node.division.code);
      return;
    }
    setSelectedId(null);
    setCurrentNodes(node.children);
    setBreadcrumb((prev) => [
      ...prev,
      { id: node.division.code, name: node.division.name_en, role: node.division.head_role },
    ]);
  }, []);

  // Navigate back to a breadcrumb level
  const handleBreadcrumbNav = useCallback((index: number) => {
    if (!tree) return;
    const newPath = breadcrumb.slice(0, index + 1);
    setBreadcrumb(newPath);
    setSelectedId(null);

    if (index === 0) {
      setCurrentNodes(tree.roots);
    } else {
      const targetId = newPath[newPath.length - 1]!.id;
      const found    = findNodeByCode(tree.roots, targetId);
      setCurrentNodes(found ? found.children : []);
    }
  }, [tree, breadcrumb]);

  if (loading) return <LoadingSpinner />;

  if (error) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-danger)' }}>
        {error}
        <button
          onClick={refresh}
          style={{
            marginLeft:   '12px',
            cursor:       'pointer',
            background:   'none',
            border:       '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding:      '4px 10px',
            color:        'var(--color-text)',
            fontFamily:   'inherit',
            fontSize:     '15px',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const totalAgents    = countAgents(tree?.roots ?? []);
  const totalDivisions = countDivisions(tree?.roots ?? []);

  return (
    <div style={{ padding: '16px', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'center',
        marginBottom:   '8px',
      }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--color-text)' }}>
          {t('gui.nav.organization')}
        </h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {/* Status legend */}
          {agentStatuses !== null && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', fontSize: '13px', color: 'var(--color-text-muted)' }}>
              <span style={{ fontWeight: 600 }}>{t('gui.org.status_legend')}:</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--color-success, #22c55e)', display: 'inline-block' }} />
                {t('gui.org.status_healthy')}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--color-error, #ef4444)', display: 'inline-block' }} />
                {t('gui.org.status_unhealthy').replace(' — last seen {time}', '')}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--color-text-muted, #6b7280)', display: 'inline-block' }} />
                {t('gui.org.status_unknown')}
              </span>
            </div>
          )}
          {tree && (
            <span style={{ fontSize: '16px', color: 'var(--color-text-muted)' }}>
              {totalAgents} agent{totalAgents !== 1 ? 's' : ''}
              {' · '}
              {totalDivisions} division{totalDivisions !== 1 ? 's' : ''}
            </span>
          )}
          <button
            onClick={refresh}
            aria-label="Refresh"
            style={{
              background:   'none',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding:      '6px',
              cursor:       'pointer',
              color:        'var(--color-text-muted)',
              display:      'flex',
              alignItems:   'center',
            }}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Breadcrumb */}
      <OrgChartBreadcrumb path={breadcrumb} onNavigate={handleBreadcrumbNav} />

      {/* Tree */}
      <OrgChartTree
        nodes={currentNodes}
        selectedId={selectedId}
        onSelect={handleSelect}
        agentStatuses={agentStatuses ?? undefined}
      />

      {/* Selected division's agents */}
      {selectedId && (() => {
        const sel = findNodeByCode(currentNodes, selectedId);
        if (!sel || sel.agents.length === 0) return null;
        return (
          <div style={{ marginTop: '24px' }}>
            <div style={{
              fontSize:     '16px',
              fontWeight:   600,
              color:        'var(--color-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '12px',
            }}>
              Agents in {sel.division.name_en}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              {sel.agents.map((agent) => {
                const st = agentStatuses?.[agent.id];
                return (
                  <div
                    key={agent.id}
                    style={{
                      padding:      '10px 14px',
                      background:   'var(--color-surface)',
                      border:       '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      fontSize:     '15px',
                      minWidth:     '160px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {st !== undefined && (
                        <span
                          title={st.health}
                          style={{
                            width:           '8px',
                            height:          '8px',
                            borderRadius:    '50%',
                            backgroundColor: st.health === 'healthy' ? 'var(--color-success, #22c55e)'
                              : st.health === 'unhealthy' ? 'var(--color-error, #ef4444)'
                              : 'var(--color-text-muted, #6b7280)',
                            flexShrink:      0,
                            animation:       (st.health === 'healthy' && st.is_busy) ? 'sidjua-pulse 1.5s infinite' : 'none',
                          }}
                        />
                      )}
                      <div style={{ fontWeight: 600, color: 'var(--color-text)' }}>{agent.name}</div>
                    </div>
                    {agent.role_title && (
                      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                        {agent.role_title}
                      </div>
                    )}
                    <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                      Tier {agent.tier}
                      {!agent.active && (
                        <span style={{ marginLeft: '6px', color: 'var(--color-text-muted)' }}>· inactive</span>
                      )}
                      {st !== undefined && st.recent_task_count > 0 && (
                        <span style={{ marginLeft: '6px' }}>· {st.recent_task_count} task{st.recent_task_count !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findNodeByCode(nodes: OrgNode[], code: string): OrgNode | null {
  for (const node of nodes) {
    if (node.division.code === code) return node;
    const found = findNodeByCode(node.children, code);
    if (found) return found;
  }
  return null;
}

function countAgents(nodes: OrgNode[]): number {
  return nodes.reduce((sum, n) => sum + n.agents.length + countAgents(n.children), 0);
}

function countDivisions(nodes: OrgNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countDivisions(n.children), 0);
}
