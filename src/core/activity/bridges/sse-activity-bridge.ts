// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: SSE Activity Bridge
 *
 * Subscribes to activityEmitter('*') and pushes activity events to all
 * connected SSE clients via the EventStreamManager.broadcast() interface.
 *
 * The sseEmit function is injected at startup so the bridge has no direct
 * dependency on the SSE infrastructure.
 *
 * Wired in src/api/routes/index.ts after sseManager is created.
 */

import { activityEmitter }  from "../activity-emitter.js";
import type { ActivityRecord } from "../activity-types.js";
import type { SSEEvent }    from "../../../api/sse/event-filter.js";  // type-only
import { createLogger }     from "../../logger.js";

const logger = createLogger("activity-bridge");

/** Monotonic counter for synthetic SSE event IDs (activity events use UUIDs, not rowids). */
let _sseSeq = Date.now(); // start high to avoid collision with task_events rowids

/** true once the bridge has been wired — prevents double registration. */
let _wired = false;


/**
 * Wire the SSE activity bridge.
 *
 * @param sseEmit  Function that accepts an SSEEvent and broadcasts it to all
 *                 matching SSE clients. Pass `(e) => manager.broadcast(e)`.
 */
export function initSseActivityBridge(sseEmit: (event: SSEEvent) => void): void {
  if (_wired) return;

  try {
    activityEmitter.on("*", (event: ActivityRecord) => {
      try {
        _sseSeq++;
        sseEmit({
          id:        _sseSeq,
          type:      "activity:created",
          timestamp: event.timestamp,
          data: {
            id:         event.id,
            event_type: event.event_type,
            category:   event.category,
            // Use camelCase keys expected by matchesFilters() in event-filter.ts
            agentId:    event.agent_id   ?? null,
            divisionId: event.division,
            severity:   event.severity,
            title:      event.title,
          },
        });
      } catch (_) { /* SSE push is fire-and-forget */ }
    });

    _wired = true;
    logger.info("sse_activity_bridge_init", "SSE activity bridge initialised");
  } catch (err: unknown) {
    logger.warn(
      "sse_activity_bridge_failed",
      "SSE activity bridge init failed (non-fatal)",
      { metadata: { error: err instanceof Error ? err.message : String(err) } },
    );
  }
}
