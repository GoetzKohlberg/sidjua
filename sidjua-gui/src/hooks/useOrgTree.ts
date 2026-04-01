// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import { useCallback } from 'react';
import { useApi }       from './useApi';
import { useAppConfig } from '../lib/config';
import type { OrgTreeResponse, OrgAgentDetail } from '../api/types';

export interface UseOrgTreeResult {
  tree:           OrgTreeResponse | null;
  loading:        boolean;
  error:          string | null;
  refresh:        () => void;
  getAgentDetail: (id: string) => Promise<OrgAgentDetail | null>;
}

export function useOrgTree(): UseOrgTreeResult {
  const { client } = useAppConfig();

  const { data: tree, loading, error, refetch } = useApi(
    (c, signal) => c.get<OrgTreeResponse>('/api/v1/org/tree', 10_000, signal),
  );

  const getAgentDetail = useCallback(async (id: string): Promise<OrgAgentDetail | null> => {
    if (!client) return null;
    try {
      return await client.get<OrgAgentDetail>(`/api/v1/org/agent/${encodeURIComponent(id)}`);
    } catch (_e) {
      return null;
    }
  }, [client]);

  return { tree, loading, error, refresh: refetch, getAgentDetail };
}
