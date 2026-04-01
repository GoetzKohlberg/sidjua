// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: Audit Event Bridge
 *
 * Called from src/api/routes/chat.ts after each INSERT INTO audit_events.
 * Forwards governance events to the activity stream.
 *
 * This function must NEVER throw.
 */

import { activityEmitter } from "../activity-emitter.js";

export interface AuditEventInput {
  agent_id:   string;
  division:   string;
  event_type: string;
  action:     string;
  severity:   string;
  details:    string; // JSON string
}


/**
 * Bridge a written audit event into the activity stream.
 *
 * Call this immediately after the audit_events INSERT succeeds.
 * Errors are silently swallowed — the caller must not be disrupted.
 */
export function bridgeAuditEvent(input: AuditEventInput): void {
  try {
    let details: Record<string, unknown> = {};
    try { details = JSON.parse(input.details || "{}") as Record<string, unknown>; } catch (_) {}

    // Map audit severity (low/medium/high/critical) to activity severity
    const severityMap: Record<string, "debug" | "info" | "warning" | "error" | "critical"> = {
      low:      "info",
      medium:   "warning",
      high:     "error",
      critical: "critical",
    };

    activityEmitter.emit({
      event_type: "governance." + input.action,
      category:   "governance",
      agent_id:   input.agent_id   || undefined,
      division:   input.division   || "default",
      title:      input.event_type + ": " + input.action,
      details,
      severity:   severityMap[input.severity] ?? "info",
      source:     "internal",
    });
  } catch (_) { /* swallow — must never disrupt audit writes */ }
}
