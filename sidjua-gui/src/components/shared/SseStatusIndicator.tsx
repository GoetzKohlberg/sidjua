// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — SSE Connection Status Indicator
 *
 * Renders a small coloured dot + label showing the live-event-stream
 * connection state.  Used in the app header next to the HTTP API status.
 */

import React from 'react';
import type { SseStatus } from '../../hooks/useSse';


const STATUS_META: Record<SseStatus, { color: string; label: string; pulse: boolean }> = {
  connected:    { color: 'var(--color-success)',     label: 'Live',           pulse: true  },
  connecting:   { color: 'var(--color-warning)',     label: 'Connecting…',    pulse: true  },
  disconnected: { color: 'var(--color-text-muted)',  label: 'Offline',        pulse: false },
  error:        { color: 'var(--color-warning)',     label: 'Reconnecting…',  pulse: true  },
};


interface Props {
  status: SseStatus;
}

export function SseStatusIndicator({ status }: Props) {
  const { color, label, pulse } = STATUS_META[status];

  return (
    <span
      title={`Event stream: ${label}`}
      aria-label={`Event stream status: ${label}`}
      style={{
        display:    'inline-flex',
        alignItems: 'center',
        gap:        '6px',
        fontSize:   '15px',
        color:      'var(--color-text-secondary)',
      }}
    >
      <span
        aria-hidden
        style={{
          width:        '8px',
          height:       '8px',
          borderRadius: '50%',
          background:   color,
          flexShrink:   0,
          ...(pulse ? { animation: 'sidjua-pulse 2s ease-in-out infinite' } : {}),
        }}
      />
      {label}
    </span>
  );
}
