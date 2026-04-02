// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React from 'react';
import type { OrgNode, AgentStatus } from '../../api/types';
import { OrgChartCard } from './OrgChartCard';

interface OrgChartTreeProps {
  nodes:          OrgNode[];
  selectedId:     string | null;
  onSelect:       (node: OrgNode) => void;
  /** Optional agent status map to pass through to each card. */
  agentStatuses?: Record<string, AgentStatus>;
}

/**
 * Horizontal flexbox tree layout: division cards side-by-side.
 * No external library dependency.
 */
export function OrgChartTree({ nodes, selectedId, onSelect, agentStatuses }: OrgChartTreeProps) {
  if (nodes.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--color-text-muted)' }}>
        No divisions at this level
      </div>
    );
  }

  return (
    <div
      style={{
        display:         'flex',
        flexWrap:        'wrap',
        gap:             '16px',
        justifyContent:  'center',
        padding:         '16px 0',
      }}
    >
      {nodes.map((node) => (
        <OrgChartCard
          key={node.division.code}
          node={node}
          isSelected={selectedId === node.division.code}
          onClick={onSelect}
          hasChildren={node.children.length > 0}
          agentStatuses={agentStatuses}
        />
      ))}
    </div>
  );
}
