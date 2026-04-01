// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * P348 — Glasscheibe public org chart privacy filter.
 *
 * Strips internal/sensitive fields from the org-chart tree before
 * serving it to unauthenticated callers:
 *
 *   Removed from agents:    tier, division_code, delegate_to
 *   Removed from divisions: parent_division_code, budget_allocation,
 *                           head_agent (raw ID), active
 *   Retained on agents:     id, name, role_title, reports_to, active
 *   Retained on divisions:  code, name, head_role, children, agents
 *
 * Also filters SSE events: only agent lifecycle events (agent:started,
 * agent:stopped, agent:crashed, agent:restarted) pass through, and only
 * safe data fields (agentId, divisionId, status) are forwarded.
 */

import type { OrgNode, OrgTreeResponse, OrgAgentNode } from "../../org-chart/org-chart-store.js";
import type { SSEEvent, SSEEventType }                  from "../sse/event-filter.js";

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

export interface PublicAgentEntry {
  id:         string;
  name:       string;
  role_title: string | null;
  reports_to: string | null;
  active:     boolean;
}

export interface PublicDivisionNode {
  code:      string;
  name:      string;
  head_role: string | null;
  agents:    PublicAgentEntry[];
  children:  PublicDivisionNode[];
}

export interface PublicOrgTree {
  roots:        PublicDivisionNode[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Event types allowed through the public SSE stream
// ---------------------------------------------------------------------------

const PUBLIC_SSE_EVENTS: ReadonlySet<SSEEventType> = new Set<SSEEventType>([
  "agent:started",
  "agent:stopped",
  "agent:crashed",
  "agent:restarted",
]);

// ---------------------------------------------------------------------------
// Filter functions
// ---------------------------------------------------------------------------

/**
 * Convert a full OrgTreeResponse to the public-safe shape.
 */
export function toPublicTree(internal: OrgTreeResponse): PublicOrgTree {
  return {
    roots:        internal.roots.map(filterNode),
    generated_at: new Date().toISOString(),
  };
}

function filterNode(node: OrgNode): PublicDivisionNode {
  return {
    code:      node.division.code,
    name:      node.division.name_en,
    head_role: node.division.head_role,
    agents:    node.agents.map(filterAgent),
    children:  node.children.map(filterNode),
  };
}

function filterAgent(agent: OrgAgentNode): PublicAgentEntry {
  return {
    id:         agent.id,
    name:       agent.name,
    role_title: agent.role_title,
    reports_to: agent.reports_to,
    active:     agent.active,
  };
}

/**
 * Filter an SSE event for the public stream.
 *
 * Returns null if the event type is not public-safe.
 * Returns a sanitised copy retaining only non-sensitive data fields.
 */
export function filterPublicEvent(event: SSEEvent): SSEEvent | null {
  if (!PUBLIC_SSE_EVENTS.has(event.type)) return null;

  const safe: Record<string, unknown> = {};
  if (typeof event.data["agentId"]    === "string") safe["agentId"]    = event.data["agentId"];
  if (typeof event.data["divisionId"] === "string") safe["divisionId"] = event.data["divisionId"];
  if (typeof event.data["status"]     === "string") safe["status"]     = event.data["status"];

  return { ...event, data: safe };
}
