// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11c: SSE Event Types and Filtering
 *
 * Defines SSEEvent / SSEClientFilters and the matchesFilters() predicate used
 * by EventStreamManager.broadcast() to route events to the correct clients.
 */


export type SSEEventType =
  // Agent events
  | "agent:started"
  | "agent:stopped"
  | "agent:crashed"
  | "agent:restarted"
  | "agent:heartbeat"
  // Task events
  | "task:created"
  | "task:assigned"
  | "task:progress"
  | "task:completed"
  | "task:failed"
  | "task:cancelled"
  // Governance events
  | "governance:blocked"
  | "governance:approval_needed"
  | "governance:rollback_started"
  | "governance:rollback_complete"
  // Cost events
  | "cost:budget_warning"
  | "cost:budget_exceeded"
  // System events
  | "system:health_changed"
  | "system:error"
  // Activity stream events
  | "activity:created";


export interface SSEEvent {
  /** Monotonic integer (SQLite rowid) — used for Last-Event-ID reconnection. */
  id: number;
  type: SSEEventType;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface SSEClientFilters {
  /** Only receive events from these divisions. Matches event.data.divisionId. */
  divisions?: string[];
  /** Only receive events from these agents. Matches event.data.agentId. */
  agents?: string[];
  /** Only receive events for these tasks. Matches event.data.taskId. */
  tasks?: string[];
}


/**
 * Returns true if the event should be sent to the client with the given filters.
 *
 * Rules:
 * - If a filter list is empty or undefined → that dimension is not restricted.
 * - Multiple filters combine with AND: all specified dimensions must match.
 */
export function matchesFilters(event: SSEEvent, filters: SSEClientFilters): boolean {
  const { divisions, agents, tasks } = filters;

  if (divisions !== undefined && divisions.length > 0) {
    const divisionId = event.data["divisionId"] as string | undefined;
    if (divisionId === undefined || !divisions.includes(divisionId)) return false;
  }

  if (agents !== undefined && agents.length > 0) {
    const agentId = event.data["agentId"] as string | undefined;
    if (agentId === undefined || !agents.includes(agentId)) return false;
  }

  if (tasks !== undefined && tasks.length > 0) {
    const taskId = event.data["taskId"] as string | undefined;
    if (taskId === undefined || !tasks.includes(taskId)) return false;
  }

  return true;
}
