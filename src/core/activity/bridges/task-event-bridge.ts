// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: Task Event Bridge
 *
 * Subscribes to a TaskEventBus instance (via subscribeAll) and forwards all
 * task events to the activity stream.
 *
 * Mapping:
 *   taskEvent.event_type → "task.<event_type>"
 *   taskEvent.agent_to   → activity.agent_id   (receiving agent)
 *   taskEvent.division   → activity.division
 *   taskEvent.data       → activity.details
 *   task_id              → activity.metadata.task_id
 *
 * Called in start.ts / cli-server.ts immediately after the shared TaskEventBus
 * is constructed:
 *   sharedEventBus = new TaskEventBus(db);
 *   initTaskEventBridge(sharedEventBus);
 *
 * This bridge must NEVER throw — errors are logged and swallowed.
 */

import { activityEmitter }  from "../activity-emitter.js";
import type { TaskEventBus } from "../../../tasks/event-bus.js";
import { createLogger }     from "../../logger.js";

const logger = createLogger("activity-bridge");


export function initTaskEventBridge(bus: TaskEventBus): void {
  try {
    bus.subscribeAll((taskEvent) => {
      try {
        const eventType = taskEvent.event_type as string;
        const isFailed  = eventType.includes("fail") || eventType.includes("error");

        activityEmitter.emit({
          event_type: "task." + eventType,
          category:   "task",
          agent_id:   taskEvent.agent_to ?? taskEvent.agent_from ?? undefined,
          division:   taskEvent.division,
          title:      buildTaskTitle(eventType, taskEvent.task_id),
          details:    (taskEvent.data as Record<string, unknown>) ?? {},
          metadata:   {
            task_id:        taskEvent.task_id,
            parent_task_id: taskEvent.parent_task_id,
          },
          severity: isFailed ? "warning" : "info",
          source:   "internal",
        });
      } catch (_) { /* bridge must never break TaskEventBus */ }
    });

    logger.info("task_bridge_init", "Task event bridge initialised");
  } catch (err: unknown) {
    logger.warn(
      "task_bridge_init_failed",
      "Task event bridge init failed (non-fatal)",
      { metadata: { error: err instanceof Error ? err.message : String(err) } },
    );
  }
}


function buildTaskTitle(eventType: string, taskId: string): string {
  const slug  = eventType.replace(/_/g, " ");
  const short = taskId.slice(0, 8);
  return `Task ${slug} [${short}]`;
}
