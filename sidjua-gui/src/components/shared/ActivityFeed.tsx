// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useEffect, useRef } from 'react';
import { CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { formatTime } from '../../lib/format';

export interface ActivityEvent {
  id:          string | number;
  timestamp:   string;
  type:        string;
  description: string;
  agentId?:    string;
  outcome?:    'success' | 'blocked' | 'error' | 'info';
}

interface Props {
  events:      ActivityEvent[];
  maxItems?:   number;
  showAgent?:  boolean;
  autoScroll?: boolean;
}

function OutcomeIcon({ outcome }: { outcome?: ActivityEvent['outcome'] }) {
  const size = 14;
  switch (outcome) {
    case 'success': return <CheckCircle   size={size} style={{ color: 'var(--color-success)', flexShrink: 0 }} />;
    case 'blocked': return <XCircle       size={size} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />;
    case 'error':   return <AlertTriangle size={size} style={{ color: 'var(--color-danger)',  flexShrink: 0 }} />;
    default:        return <Clock         size={size} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />;
  }
}

function isGovernanceEvent(type: string): boolean {
  return type.startsWith('governance:');
}

export function ActivityFeed({ events, maxItems = 20, showAgent = false, autoScroll = true }: Props) {
  const listRef  = useRef<HTMLUListElement>(null);
  const prevLen  = useRef(0);
  const displayed = events.slice(0, maxItems);

  useEffect(() => {
    if (autoScroll && listRef.current && events.length > prevLen.current) {
      listRef.current.scrollTop = 0;
    }
    prevLen.current = events.length;
  }, [events.length, autoScroll]);

  if (displayed.length === 0) {
    return (
      <p style={{ fontSize: '15px', color: 'var(--color-text-muted)', padding: '16px 0' }}>
        No recent activity.
      </p>
    );
  }

  return (
    <ul
      ref={listRef}
      style={{
        listStyle: 'none',
        overflowY: 'auto',
        maxHeight: '240px',
      }}
    >
      {displayed.map((ev) => (
        <li
          key={`${ev.id}-${ev.timestamp}`}
          style={{
            display:      'flex',
            alignItems:   'flex-start',
            gap:          '8px',
            padding:      '7px 0',
            borderBottom: '1px solid var(--color-border)',
            borderLeft:   isGovernanceEvent(ev.type)
              ? '2px solid var(--color-accent)'
              : '2px solid transparent',
            paddingLeft:  isGovernanceEvent(ev.type) ? '6px' : 0,
          }}
        >
          <OutcomeIcon outcome={ev.outcome} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{
              fontSize:     '15px',
              color:        'var(--color-text)',
              whiteSpace:   'nowrap',
              overflow:     'hidden',
              textOverflow: 'ellipsis',
            }}>
              {ev.description}
            </p>
            {showAgent && ev.agentId && (
              <p style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginTop: '1px' }}>
                {ev.agentId}
              </p>
            )}
          </div>
          <time
            dateTime={ev.timestamp}
            style={{ fontSize: '13px', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {formatTime(ev.timestamp)}
          </time>
        </li>
      ))}
    </ul>
  );
}
