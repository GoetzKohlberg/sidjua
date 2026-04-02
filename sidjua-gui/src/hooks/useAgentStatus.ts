// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppConfig } from '../lib/config';
import type { AgentStatus, AgentStatusResponse } from '../api/types';

const DEFAULT_INTERVAL_MS = 10_000;

export interface UseAgentStatusResult {
  statuses: Record<string, AgentStatus> | null;
  loading:  boolean;
  error:    string | null;
  refresh:  () => void;
}

export function useAgentStatus(refreshIntervalMs?: number): UseAgentStatusResult {
  const { client } = useAppConfig();
  const interval   = refreshIntervalMs ?? DEFAULT_INTERVAL_MS;

  const [statuses, setStatuses] = useState<Record<string, AgentStatus> | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (!client) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);

    client.get<AgentStatusResponse>('/api/v1/org/status', 10_000, controller.signal)
      .then((resp) => {
        if (!controller.signal.aborted) {
          setStatuses(resp.agents);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
  }, [client]);

  // Initial fetch + interval polling
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, interval);
    return () => {
      clearInterval(timer);
      controllerRef.current?.abort();
    };
  }, [refresh, interval]);

  return { statuses, loading, error, refresh };
}
