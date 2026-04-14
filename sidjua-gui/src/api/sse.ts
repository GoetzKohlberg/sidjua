// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — SSE Client
 *
 * Two-step authentication flow:
 *   1. POST API_PATHS.sseTicket()  (Authorization: Bearer <api-key>)
 *      → { ticket: string, expires_in: number }
 *   2. GET  API_PATHS.sseEvents()?ticket=<ticket>
 *      → SSE stream
 *
 * Auto-reconnects with exponential backoff on connection drops.
 * Respects Last-Event-ID for missed-event replay.
 */

import { API_PATHS }      from './paths';
import { rawFetchHeaders } from './client';

export type SseEventType =
  // Agent events
  | 'agent:started'
  | 'agent:stopped'
  | 'agent:crashed'
  | 'agent:restarted'
  | 'agent:heartbeat'
  // Task events
  | 'task:created'
  | 'task:assigned'
  | 'task:progress'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled'
  // Governance events
  | 'governance:blocked'
  | 'governance:approval_needed'
  | 'governance:rollback_started'
  | 'governance:rollback_complete'
  // Cost events
  | 'cost:budget_warning'
  | 'cost:budget_exceeded'
  // System events
  | 'system:health_changed'
  | 'system:error'
  | string; // forward-compatible

export interface SseEvent {
  id?: string;
  type: SseEventType;
  data: unknown;
}

export type SseEventHandler = (event: SseEvent) => void;
export type SseErrorHandler = (error: Error) => void;

export interface SseFilters {
  divisions?: string[];
  agents?: string[];
  tasks?: string[];
}

export interface SseClientOptions {
  baseUrl: string;
  apiKey: string;
  filters?: SseFilters;
  /** Initial reconnect delay in ms (doubles on each failure, capped at maxBackoffMs). */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onEvent?: SseEventHandler;
  onError?: SseErrorHandler;
  onConnect?: () => void;
  onDisconnect?: () => void;
}


const DEFAULT_INITIAL_BACKOFF = 1_000;
const DEFAULT_MAX_BACKOFF = 30_000;

export class SidjuaSSEClient {
  private readonly opts: Required<Omit<SseClientOptions, 'filters'>> & { filters: SseFilters };
  private evtSource: EventSource | null = null;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId: string | null = null;
  private stopped = false;

  constructor(opts: SseClientOptions) {
    this.opts = {
      ...opts,
      filters:          opts.filters          ?? {},
      initialBackoffMs: opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF,
      maxBackoffMs:     opts.maxBackoffMs     ?? DEFAULT_MAX_BACKOFF,
      onEvent:          opts.onEvent          ?? (() => undefined),
      onError:          opts.onError          ?? (() => undefined),
      onConnect:        opts.onConnect        ?? (() => undefined),
      onDisconnect:     opts.onDisconnect     ?? (() => undefined),
    };
    this.backoffMs = this.opts.initialBackoffMs;
  }

  // ---- Public API ----------------------------------------------------------

  /** Start connecting. Safe to call multiple times (no-op if already running). */
  start(): void {
    if (this.evtSource !== null || this.stopped) return;
    void this.connect();
  }

  /** Permanently stop the client. Cannot be restarted after this. */
  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.closeSource();
  }

  // ---- Internal ------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;

    let ticket: string;
    try {
      ticket = await this.fetchTicket();
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
      return;
    }

    const url = this.buildUrl(ticket);
    const src = new EventSource(url);
    this.evtSource = src;

    src.onopen = () => {
      this.backoffMs = this.opts.initialBackoffMs; // reset on successful connect
      this.opts.onConnect();
    };

    src.onmessage = (ev) => {
      this.handleRawEvent('message', ev);
    };

    src.onerror = () => {
      this.opts.onDisconnect();
      this.closeSource();
      this.scheduleReconnect();
    };

    // Subscribe to all known named event types (must use EventSource.addEventListener)
    const namedTypes: SseEventType[] = [
      'agent:started', 'agent:stopped', 'agent:crashed', 'agent:restarted', 'agent:heartbeat',
      'task:created', 'task:assigned', 'task:progress', 'task:completed', 'task:failed', 'task:cancelled',
      'governance:blocked', 'governance:approval_needed', 'governance:rollback_started', 'governance:rollback_complete',
      'cost:budget_warning', 'cost:budget_exceeded',
      'system:health_changed', 'system:error',
    ];
    for (const type of namedTypes) {
      src.addEventListener(type, (ev) => {
        this.handleRawEvent(type, ev as MessageEvent);
      });
    }
  }

  private handleRawEvent(type: string, ev: MessageEvent): void {
    if (ev.lastEventId) {
      this.lastEventId = ev.lastEventId;
    }

    let data: unknown = ev.data;
    try {
      data = JSON.parse(ev.data as string);
    } catch {
      // leave as raw string
    }

    this.opts.onEvent({ id: ev.lastEventId || undefined, type, data });
  }

  private async fetchTicket(): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}${API_PATHS.sseTicket()}`, {
      method: 'POST',
      headers: rawFetchHeaders(this.opts.apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ticket request failed (${res.status}): ${body}`);
    }

    const json = await res.json() as { ticket?: string };
    if (typeof json.ticket !== 'string') {
      throw new Error('Ticket response missing "ticket" field');
    }

    return json.ticket;
  }

  private buildUrl(ticket: string): string {
    // NOTE: EventSource API does not support custom headers.
    // The ticket is passed as a URL query parameter — this is an accepted risk for V1.
    // Mitigations: short TTL (enforced by backend), single-use ticket (enforced by backend).
    // V2: Replace EventSource with fetch()-based SSE streaming which supports custom headers,
    //     eliminating the need to embed the ticket in the URL.
    const params = new URLSearchParams({ ticket });
    const { filters } = this.opts;
    if (filters.divisions?.length) params.set('divisions', filters.divisions.join(','));
    if (filters.agents?.length)    params.set('agents',    filters.agents.join(','));
    if (filters.tasks?.length)     params.set('tasks',     filters.tasks.join(','));
    if (this.lastEventId !== null)  params.set('lastEventId', this.lastEventId);
    return `${this.opts.baseUrl}${API_PATHS.sseEvents()}?${params.toString()}`;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSource(): void {
    if (this.evtSource !== null) {
      this.evtSource.close();
      this.evtSource = null;
    }
  }
}
