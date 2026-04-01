// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * audit-trail — read-only access to the governance audit_events table.
 * Agent: Auditor (CCO)
 */

import type { InternalToolDef } from "../adapters/internal-adapter.js";
import type { Database }        from "../../utils/db.js";

let _db: Database | null = null;
export function setAuditToolDb(db: Database): void { _db = db; }

export const auditTrailTool: InternalToolDef = {
  id:          "internal-audit-trail",
  name:        "query_audit_trail",
  description: "Query the governance audit trail — blocked actions, violations, escalations",
  capabilities: [
    {
      name:              "query_audit",
      description:       "Search audit_events by agent, division, action, date range. Returns audit records.",
      risk_level:        "low",
      requires_approval: false,
      input_schema: {
        type: "object",
        properties: {
          agent_id:   { type: "string",  description: "Filter by agent ID" },
          division:   { type: "string",  description: "Filter by division" },
          event_type: { type: "string",  description: "Filter by event_type" },
          action:     { type: "string",  description: "Filter by action: allowed|blocked|escalated" },
          severity:   { type: "string",  description: "Filter by severity: low|medium|high|critical" },
          since:      { type: "string",  description: "Start timestamp ISO" },
          until:      { type: "string",  description: "End timestamp ISO" },
          limit:      { type: "number",  description: "Max results (default 50, max 200)", default: 50 },
        },
        additionalProperties: false,
      },
      output_schema: { type: "object" },
    },
  ],
  execute: async (params) => {
    if (!_db) return { error: "Database not initialized" };

    const wheres: string[] = [];
    const values: unknown[] = [];

    if (params["agent_id"])   { wheres.push("agent_id = ?");            values.push(params["agent_id"]); }
    if (params["division"])   { wheres.push("division = ?");            values.push(params["division"]); }
    if (params["event_type"]) { wheres.push("event_type = ?");          values.push(params["event_type"]); }
    if (params["action"])     { wheres.push("action = ?");              values.push(params["action"]); }
    if (params["severity"])   { wheres.push("severity = ?");            values.push(params["severity"]); }
    if (params["since"])      { wheres.push("timestamp >= ?");          values.push(params["since"]); }
    if (params["until"])      { wheres.push("timestamp <= ?");          values.push(params["until"]); }

    const where = wheres.length > 0 ? "WHERE " + wheres.join(" AND ") : "";
    const limit = Math.min(Number(params["limit"]) || 50, 200);

    const rows = _db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...values, limit);

    return { count: rows.length, events: rows };
  },
};
