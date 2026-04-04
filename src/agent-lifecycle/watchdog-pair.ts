// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V1.1: WatchdogPair
 *
 * Implements the 4-eyes mutual monitoring system.
 * Two system agents (IT-Admin + Guide) each run performHealthCheck() on their
 * daemon loop iteration. They monitor all other agents AND each other.
 *
 * Escalation chain:
 *   Agent unhealthy (missed N heartbeats)
 *   → Primary watchdog (IT-Admin) restarts
 *     → Secondary (Guide) waits grace_period_ms before overriding
 *       → If budget exhausted: notify human + emit WATCHDOG_ESCALATION
 */

import type { AgentDaemonManager } from "./daemon-manager.js";
import type { ProcessSupervisor } from "./supervisor/process-supervisor.js";
import type { WatchdogAgentConfig } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("watchdog-pair");


/** Minimal interface for sending watchdog alerts. Implement per-channel. */
export interface NotificationService {
  notify(message: string, level: "info" | "warning" | "critical"): Promise<void>;
}

/** No-op implementation used when no notification channel is configured. */
export const NULL_NOTIFIER: NotificationService = {
  notify: async () => undefined,
};


export interface RestartAction {
  agent_id:      string;
  action:        "restarted" | "skipped_grace_period" | "skipped_budget";
  restarted_by:  string;
  timestamp:     number;
}

export interface HealthCheckResult {
  checked:   number;
  unhealthy: number;
  actions:   RestartAction[];
}


interface HandlingEntry {
  watchdog_id: string;
  since:       number;  // epoch ms
}


const DEFAULTS: Required<WatchdogAgentConfig> = {
  watchdog_a:                   "it-admin",
  watchdog_b:                   "guide",
  heartbeat_interval_ms:        10_000,
  missed_heartbeat_threshold:   3,
  grace_period_ms:              15_000,
  restart_budget_per_hour:      10,
};


export class WatchdogPair {
  private readonly config: Required<WatchdogAgentConfig>;

  /**
   * handlingMap tracks which watchdog is responsible for restarting each agent.
   * Key: agent_id. Value: which watchdog picked it up and when.
   */
  private readonly handlingMap = new Map<string, HandlingEntry>();

  /**
   * restartLog is a rolling list of restart timestamps (for budget enforcement).
   * Shared across both watchdog roles — the budget is per-watchdog-instance.
   */
  private restartLog: { timestamp: number; agent_id: string }[] = [];

  constructor(
    config:
      | Partial<WatchdogAgentConfig>
      | Required<WatchdogAgentConfig>
      | WatchdogAgentConfig,
    private readonly daemonManager: AgentDaemonManager,
    private readonly supervisor:    ProcessSupervisor,
    private readonly notifier:      NotificationService = NULL_NOTIFIER,
  ) {
    this.config = {
      watchdog_a:                   config.watchdog_a                   ?? DEFAULTS.watchdog_a,
      watchdog_b:                   config.watchdog_b                   ?? DEFAULTS.watchdog_b,
      heartbeat_interval_ms:        config.heartbeat_interval_ms        ?? DEFAULTS.heartbeat_interval_ms,
      missed_heartbeat_threshold:   config.missed_heartbeat_threshold   ?? DEFAULTS.missed_heartbeat_threshold,
      grace_period_ms:              config.grace_period_ms              ?? DEFAULTS.grace_period_ms,
      restart_budget_per_hour:      config.restart_budget_per_hour      ?? DEFAULTS.restart_budget_per_hour,
    };
  }

  // ---------------------------------------------------------------------------
  // Main health check
  // ---------------------------------------------------------------------------

  /**
   * Perform a health check pass from the perspective of one watchdog agent.
   * Should be called once per daemon loop iteration for agents with
   * `config.watchdog.restart_authority === true`.
   */
  async performHealthCheck(watchdogId: string): Promise<HealthCheckResult> {
    const statuses  = this.daemonManager.getAllStatuses();
    const actions:  RestartAction[] = [];
    let   unhealthy = 0;

    for (const status of statuses) {
      const targetId = status.agent_id;

      // A watchdog cannot restart itself
      if (targetId === watchdogId) continue;

      const health = this.supervisor.getAgentStatus(targetId);
      const isUnhealthy =
        health !== undefined &&
        (health.state === "UNHEALTHY" ||
          health.state === "CRASHED"   ||
          health.state === "CIRCUIT_OPEN");

      if (!isUnhealthy) continue;

      unhealthy++;

      const action = await this._handleUnhealthy(watchdogId, targetId);
      if (action) actions.push(action);
    }

    // Clean up handling map entries for agents that have recovered
    const healthyIds = statuses
      .filter((s) => {
        const h = this.supervisor.getAgentStatus(s.agent_id);
        return h === undefined || h.state === "HEALTHY" || h.state === "UNKNOWN";
      })
      .map((s) => s.agent_id);
    this.cleanupHandlingMap(healthyIds);

    return { checked: statuses.length, unhealthy, actions };
  }

  // ---------------------------------------------------------------------------
  // Handling logic
  // ---------------------------------------------------------------------------

  private async _handleUnhealthy(
    watchdogId: string,
    targetId:   string,
  ): Promise<RestartAction | null> {
    const existing = this.handlingMap.get(targetId);

    if (existing !== undefined && existing.watchdog_id !== watchdogId) {
      // Another watchdog is already handling this agent
      const gracePassed = this.gracePeriodExpired(targetId);
      if (!gracePassed) {
        // Wait for the primary to act
        return {
          agent_id:     targetId,
          action:       "skipped_grace_period",
          restarted_by: watchdogId,
          timestamp:    Date.now(),
        };
      }
      // Grace period expired — take over
    }

    // Claim the restart BEFORE the async budget check to prevent duplicate restarts
    // by the other watchdog during the await window (dual-restart race condition).
    this.handlingMap.set(targetId, { watchdog_id: watchdogId, since: Date.now() });

    // Check restart budget
    if (!this._isWithinRestartBudget()) {
      logger.warn("watchdog-pair", "Restart budget exceeded — skipping restart, notifying human", {
        metadata: { watchdog_id: watchdogId, agent_id: targetId },
      });
      await this.notifier.notify(
        `WATCHDOG_ESCALATION: restart budget exhausted — agent ${targetId} needs manual recovery`,
        "critical",
      );
      return {
        agent_id:     targetId,
        action:       "skipped_budget",
        restarted_by: watchdogId,
        timestamp:    Date.now(),
      };
    }

    logger.info("watchdog-pair", "Restarting unhealthy agent", {
      metadata: { watchdog_id: watchdogId, agent_id: targetId },
    });

    await this.daemonManager.restartAgent(targetId);
    this._recordRestart(targetId);

    await this.notifier.notify(
      `WATCHDOG_RESTART: ${watchdogId} restarted agent ${targetId}`,
      "warning",
    );

    return {
      agent_id:     targetId,
      action:       "restarted",
      restarted_by: watchdogId,
      timestamp:    Date.now(),
    };
  }

  // ---------------------------------------------------------------------------
  // Predicates (public for testability)
  // ---------------------------------------------------------------------------

  /** True if this watchdog is currently responsible for restarting agentId. */
  isHandling(watchdogId: string, agentId: string): boolean {
    const entry = this.handlingMap.get(agentId);
    return entry !== undefined && entry.watchdog_id === watchdogId;
  }

  /** True if the grace period for an agent's handling entry has elapsed. */
  gracePeriodExpired(agentId: string): boolean {
    const entry = this.handlingMap.get(agentId);
    if (entry === undefined) return true;
    return Date.now() - entry.since >= this.config.grace_period_ms;
  }

  /** Remove handling entries for agents that have recovered. */
  cleanupHandlingMap(healthyAgentIds: string[]): void {
    for (const id of healthyAgentIds) {
      this.handlingMap.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Budget
  // ---------------------------------------------------------------------------

  private _isWithinRestartBudget(): boolean {
    const cutoff = Date.now() - 3_600_000;
    this.restartLog = this.restartLog.filter((r) => r.timestamp > cutoff);
    return this.restartLog.length < this.config.restart_budget_per_hour;
  }

  private _recordRestart(agentId: string): void {
    this.restartLog.push({ timestamp: Date.now(), agent_id: agentId });
  }

  /** Expose restart log length for testing. */
  get restartCount(): number {
    const cutoff = Date.now() - 3_600_000;
    return this.restartLog.filter((r) => r.timestamp > cutoff).length;
  }
}
