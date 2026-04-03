// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 9: PeerRouter
 *
 * Routes same-tier consultation requests to available peer agents.
 *
 * Peer consultation is advisory, NOT a parent-child sub-task relationship:
 *   - No synthesis step
 *   - No sub_tasks_expected increment
 *   - Result is advisory — requester uses it as it sees fit
 *   - Budget: 20% of requester's remaining budget (set when task created)
 *   - Priority: reduced (lower than delegation tasks)
 */

import type { Database } from "../utils/db.js";
import type { Task } from "../tasks/types.js";
import { TaskStore } from "../tasks/store.js";
import { TaskEventBus } from "../tasks/event-bus.js";
import type { AgentInstance, PeerRouteResult } from "./types.js";
import { WorkDistributor } from "./distributor.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("peer-router");


export class PeerRouter {
  private readonly store: TaskStore;

  constructor(
    private readonly db: Database,
    private readonly eventBus: TaskEventBus,
    private readonly distributor: WorkDistributor,
    private readonly agents: Map<string, AgentInstance>,
  ) {
    this.store = new TaskStore(db);
  }

  // ---------------------------------------------------------------------------
  // Core: route
  // ---------------------------------------------------------------------------

  /**
   * Route a consultation task to an available same-tier peer agent.
   *
   * Steps:
   *   1. Validate task type is "consultation"
   *   2. Find peer via WorkDistributor.findPeer()
   *   3. If peer found → assign + notify via IPC
   *   4. If no peer → return routed=false, requester handles without consultation
   */
  route(consultation: Task): PeerRouteResult {
    if (consultation.type !== "consultation") {
      logger.warn("peer_router", "Non-consultation task passed to route()", { metadata: {
        task_id: consultation.id,
        type:    consultation.type,
      } });
      return {
        routed:     false,
        peer_agent: null,
        reason:     `Task type must be 'consultation', got '${consultation.type}'`,
      };
    }

    const requestingAgentId = consultation.assigned_agent ?? "";
    const allAgents         = [...this.agents.values()];

    const peer = this.distributor.findPeer(requestingAgentId, consultation, allAgents);

    if (peer === null) {
      logger.info("peer_router", "No peer available for consultation", { metadata: {
        task_id:          consultation.id,
        requesting_agent: requestingAgentId,
      } });
      return {
        routed:     false,
        peer_agent: null,
        reason:     "No available peer agent for consultation",
      };
    }

    // Assign consultation task to peer
    this.store.update(consultation.id, {
      assigned_agent: peer.definition.id,
      status:         "ASSIGNED",
    });

    // Notify peer via EventBus
    this.eventBus.emitTask({
      event_type:     "TASK_ASSIGNED",
      task_id:        consultation.id,
      parent_task_id: consultation.parent_id,
      agent_from:     "orchestrator",
      agent_to:       peer.definition.id,
      division:       consultation.division,
      data:           { task_id: consultation.id },
    }).catch(() => undefined);

    // Send IPC directly to peer process
    const peerInstance = this.agents.get(peer.definition.id);
    if (peerInstance !== undefined) {
      peerInstance.process.send({ type: "TASK_ASSIGNED", task_id: consultation.id });
    }

    logger.info("peer_router", "Consultation routed to peer", { metadata: {
      task_id:          consultation.id,
      requesting_agent: requestingAgentId,
      peer_agent:       peer.definition.id,
    } });

    return {
      routed:     true,
      peer_agent: peer.definition.id,
      reason:     `Routed to peer ${peer.definition.id} (tier ${peer.definition.tier})`,
    };
  }
}
