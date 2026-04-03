// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppConfig } from '../lib/config';
import type { AgentStatus, AgentStatusResponse } from '../api/types';

const DEFAULT_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS     = 60_000;

export interface UseAgentStatusResult {
  statuses: Record<string, AgentStatus> | null;
  loading:  boolean;
  error:    string | null;
  refresh:  () => void;
}

export function useAgentStatus(refreshIntervalMs?: number): UseAgentStatusResult {
  const { client } = useAppConfig();
  const baseInterval = refreshIntervalMs ?? DEFAULT_INTERVAL_MS;

  const [statuses, setStatuses] = useState<Record<string, AgentStatus> | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const controllerRef     = useRef<AbortController | null>(null);
  const lastHashRef       = useRef<string>('');
  const unchangedCountRef = useRef(0);
  const currentIntervalRef = useRef(baseInterval);
  const timerRef          = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleNext = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      refresh(); // eslint-disable-line @typescript-eslint/no-use-before-define
    }, currentIntervalRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
          const hash = JSON.stringify(resp.agents);
          if (hash === lastHashRef.current) {
            unchangedCountRef.current++;
            // Double interval after 3 consecutive identical responses, up to MAX
            if (unchangedCountRef.current >= 3) {
              currentIntervalRef.current = Math.min(
                currentIntervalRef.current * 2,
                MAX_INTERVAL_MS,
              );
            }
          } else {
            unchangedCountRef.current    = 0;
            currentIntervalRef.current   = baseInterval;
            lastHashRef.current          = hash;
          }
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
          scheduleNext();
        }
      });
  }, [client, baseInterval, scheduleNext]);

  // Initial fetch — subsequent fetches are self-scheduled via scheduleNext()
  useEffect(() => {
    currentIntervalRef.current = baseInterval;
    refresh();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      controllerRef.current?.abort();
    };
  }, [refresh, baseInterval]);

  return { statuses, loading, error, refresh };
}
