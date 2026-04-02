// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: Type Definitions
 *
 * Foundation types for the unified activity stream (P336).
 * API endpoints and digest types are in P337.
 */


export type ActivityCategory =
  | 'task' | 'agent' | 'chat' | 'governance'
  | 'config' | 'budget' | 'document' | 'system'
  | 'security' | 'external';

export type ActivitySeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';
export type ActivitySource    = 'internal' | 'webhook' | 'system' | 'user';


export interface ActivityEvent {
  event_type:  string;
  category:    ActivityCategory;
  agent_id?:   string | undefined;
  division?:   string | undefined;
  user_id?:    string | undefined;
  severity?:   ActivitySeverity | undefined;
  title:       string;
  details?:    Record<string, unknown> | undefined;
  metadata?:   Record<string, unknown> | undefined;
  source?:     ActivitySource | undefined;
  parent_id?:  string | undefined;
  session_id?: string | undefined;
}

export interface ActivityRecord extends ActivityEvent {
  id:         string;
  timestamp:  string;
  // Guaranteed non-optional after storage
  severity:   ActivitySeverity;
  division:   string;
  source:     ActivitySource;
  details:    Record<string, unknown>;
  metadata:   Record<string, unknown>;
  /** True when the event was not durably persisted to SQLite (DB write failed). */
  _transient?: boolean | undefined;
}

export interface ActivityFilters {
  since?:      string | undefined;
  until?:      string | undefined;
  category?:   ActivityCategory | undefined;
  agent_id?:   string | undefined;
  division?:   string | undefined;
  severity?:   ActivitySeverity | undefined;
  source?:     ActivitySource | undefined;
  event_type?: string | undefined;
  session_id?: string | undefined;
  limit?:      number | undefined;
  offset?:     number | undefined;
}

export interface TimelineEntry {
  bucket:     string;
  count:      number;
  categories: Partial<Record<ActivityCategory, number>>;
}
