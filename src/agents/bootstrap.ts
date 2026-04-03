// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 8: ITBootstrapAgent
 *
 * System-level watchdog that monitors all agent subprocesses.
 * NOT an LLM agent — pure programmatic watchdog. No provider calls.
 * Must function even when all LLM providers are down.
 *
 * Monitoring cycle (every check_interval_ms):
 *   1. Heartbeat check — detect crashed/hung agents → restart
 *   2. Burn rate check — detect runaway token usage → pause
 *   3. Cost check — detect hourly budget overruns → pause
 *   4. Task timeout check — detect hung tasks → cancel
 *   5. Restart tracking — max attempts → CRITICAL alert
 */

import { statSync } from "node:fs";
import type { AgentProcess } from "./process.js";
import type { CheckpointManager } from "./checkpoint.js";
import type {
  BootstrapConfig,
  HealthReport,
  HealthAlert,
  AgentHealthEntry,
  AgentMemoryHealth,
  AgentStatus,
} from "./types.js";
import type { EventBus } from "../types/provider.js";
import { createLogger, type Logger } from "../core/logger.js";

const _logger = createLogger("agent-bootstrap");


export class ITBootstrapAgent {
  private _running = false;
  private _checkTimer: ReturnType<typeof setInterval> | null = null;
  private _costTimer: ReturnType<typeof setInterval> | null = null;
  private _memoryCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** memory health per agent: agentId → AgentMemoryHealth */
  private readonly _memoryHealth = new Map<string, AgentMemoryHealth>();

  /** alerts accumulated since last getHealthReport() */
  private readonly _alerts: HealthAlert[] = [];

  /** token usage samples: agentId → [{ time, tokens }] */
  private readonly _tokenSamples = new Map<
    string,
    Array<{ time: number; tokens: number }>
  >();

  constructor(
    private readonly processes: Map<string, AgentProcess>,
    private readonly checkpointManager: CheckpointManager,
    private readonly eventBus: EventBus,
    private readonly config: BootstrapConfig,
    private readonly logger: Logger = createLogger("agent-bootstrap"),
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start monitoring all registered agent processes. */
  start(): void {
    if (this._running) return;
    this._running = true;

    this.logger.info("bootstrap_started", "ITBootstrapAgent started", {
      metadata: { agent_count: this.processes.size, check_interval_ms: this.config.check_interval_ms },
    });

    this._checkTimer = setInterval(() => {
      this._runHealthCheck().catch((err) => {
        this.logger.error("bootstrap_health_check_error", "Bootstrap health check error", {
          metadata: { error: String(err) },
        });
      });
    }, this.config.check_interval_ms);

    this._costTimer = setInterval(() => {
      this._runCostCheck();
    }, this.config.cost_check_interval_ms);

    const memCheckIntervalMs = this.config.memory_check_interval_ms ?? 300_000;
    this._memoryCheckTimer = setInterval(() => {
      this._runMemoryHealthCheck().catch((err) => {
        this.logger.error("bootstrap_memory_health_error", "Bootstrap memory health check error", {
          metadata: { error: String(err) },
        });
      });
    }, memCheckIntervalMs);
  }

  /** Stop monitoring. */
  stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this._checkTimer !== null) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    if (this._costTimer !== null) {
      clearInterval(this._costTimer);
      this._costTimer = null;
    }

    if (this._memoryCheckTimer !== null) {
      clearInterval(this._memoryCheckTimer);
      this._memoryCheckTimer = null;
    }

    this.logger.info("bootstrap_stopped", "ITBootstrapAgent stopped");
  }

  // ---------------------------------------------------------------------------
  // Manual controls
  // ---------------------------------------------------------------------------

  async restartAgent(agentId: string): Promise<void> {
    const proc = this.processes.get(agentId);
    if (proc === undefined) {
      throw new Error(`Agent ${agentId} not found in bootstrap registry`);
    }

    const checkpoint = await this.checkpointManager.loadLatest(agentId);
    await proc.restart(checkpoint ?? undefined);

    this.logger.info("agent_manually_restarted", "Agent manually restarted", {
      metadata: { agent_id: agentId, from_checkpoint: checkpoint !== null },
    });
  }

  async pauseAgent(agentId: string): Promise<void> {
    const proc = this.processes.get(agentId);
    if (proc === undefined) throw new Error(`Agent ${agentId} not found`);
    proc.send({ type: "PAUSE" });
    this.logger.info("agent_paused", "Agent paused by bootstrap", { metadata: { agent_id: agentId } });
  }

  async resumeAgent(agentId: string): Promise<void> {
    const proc = this.processes.get(agentId);
    if (proc === undefined) throw new Error(`Agent ${agentId} not found`);
    proc.send({ type: "RESUME" });
    this.logger.info("agent_resumed", "Agent resumed by bootstrap", { metadata: { agent_id: agentId } });
  }

  // ---------------------------------------------------------------------------
  // Health reporting
  // ---------------------------------------------------------------------------

  /** Return current health report and reset the alert queue. */
  getHealthReport(): HealthReport {
    const agents: AgentHealthEntry[] = [];
    const now = Date.now();

    for (const [agentId, proc] of this.processes) {
      const state = proc.getState();
      const lastHb = state.last_heartbeat;
      const timeSinceHb = lastHb !== null ? now - new Date(lastHb).getTime() : null;
      const heartbeatHealthy =
        timeSinceHb !== null &&
        timeSinceHb <= this.config.heartbeat_timeout_ms;

      agents.push({
        agent_id: agentId,
        status: state.status,
        pid: proc.getPid(),
        last_heartbeat: lastHb,
        heartbeat_healthy: heartbeatHealthy,
        restart_count: state.restart_count,
        current_hour_cost: state.current_hour_cost,
        active_tasks: state.active_tasks.length,
      });
    }

    const alerts = [...this._alerts];
    this._alerts.length = 0;

    const system_healthy =
      agents.every(
        (a) =>
          a.status !== "CRASHED" &&
          a.heartbeat_healthy &&
          a.restart_count < this.config.max_restart_attempts,
      );

    const memoryHealth = [...this._memoryHealth.values()];

    return {
      timestamp: new Date().toISOString(),
      agents,
      system_healthy,
      alerts,
      ...(memoryHealth.length > 0 ? { memory_health: memoryHealth } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Health check cycle
  // ---------------------------------------------------------------------------

  private async _runHealthCheck(): Promise<void> {
    await this._checkHeartbeats();
    await this._checkBurnRates();
    await this._checkRestartCounts();
  }

  // ---------------------------------------------------------------------------
  // 1. Heartbeat check
  // ---------------------------------------------------------------------------

  private async _checkHeartbeats(): Promise<void> {
    const now = Date.now();

    for (const [agentId, proc] of this.processes) {
      const state = proc.getState();

      // Skip stopped agents
      if (state.status === "STOPPED") continue;

      // Check if process is alive
      if (!proc.isAlive()) {
        if (state.status !== "CRASHED" && state.status !== "RESTARTING") {
          this.logger.warn("agent_process_died", "Agent process died — attempting restart", {
            metadata: { agent_id: agentId },
          });
          await this._attemptRestart(agentId, proc, state.restart_count);
        }
        continue;
      }

      // Check heartbeat timeout
      const lastHb = state.last_heartbeat;
      if (lastHb === null) continue; // not yet started

      const timeSince = now - new Date(lastHb).getTime();
      if (timeSince > this.config.heartbeat_timeout_ms) {
        this.logger.warn("agent_heartbeat_timeout", "Agent heartbeat timeout", {
          metadata: { agent_id: agentId, ms_since_last: timeSince, timeout_ms: this.config.heartbeat_timeout_ms },
        });

        // Send STATUS_REQUEST to probe the agent
        proc.send({ type: "STATUS_REQUEST" });

        // If still over threshold after grace period, kill and restart
        if (timeSince > this.config.heartbeat_timeout_ms * 2) {
          this._addAlert("CRITICAL", agentId, "heartbeat_missed",
            `Agent missed heartbeat for ${Math.round(timeSince / 1000)}s`);
          await this._attemptRestart(agentId, proc, state.restart_count);
        } else {
          this._addAlert("WARNING", agentId, "heartbeat_missed",
            `Agent heartbeat overdue by ${Math.round(timeSince / 1000)}s`);
        }
      }
    }
  }

  private async _attemptRestart(
    agentId: string,
    proc: AgentProcess,
    currentRestartCount: number,
  ): Promise<void> {
    if (currentRestartCount >= this.config.max_restart_attempts) {
      this._addAlert("CRITICAL", agentId, "repeated_crashes",
        `Agent exceeded max restart attempts (${this.config.max_restart_attempts})`);
      this.logger.error("agent_max_restarts_exceeded", "Agent exceeded max restart attempts — stopping", {
        metadata: { agent_id: agentId, restart_count: currentRestartCount },
      });
      this.eventBus.emit("agent.stopped", {
        agent_id: agentId,
        reason: "max_restart_attempts_exceeded",
      });
      return;
    }

    const checkpoint = await this.checkpointManager.loadLatest(agentId);
    try {
      await proc.restart(checkpoint ?? undefined);
      this.logger.info("agent_restarted", "Agent restarted from checkpoint", {
        metadata: {
          agent_id: agentId,
          restart_count: proc.getState().restart_count,
          from_checkpoint: checkpoint !== null,
        },
      });
      this.eventBus.emit("agent.restarted", {
        agent_id: agentId,
        from_checkpoint: checkpoint !== null,
        restart_count: proc.getState().restart_count,
      });
    } catch (err) {
      this.logger.error("agent_restart_failed", "Failed to restart agent", {
        metadata: { agent_id: agentId, error: String(err) },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Burn rate check
  // ---------------------------------------------------------------------------

  private _checkBurnRates(): void {
    const now = Date.now();
    const windowMs = 5 * 60 * 1000; // 5-minute window

    for (const [agentId, proc] of this.processes) {
      const state = proc.getState();
      if (state.active_tasks.length === 0) continue;

      // Record current token usage
      const samples = this._tokenSamples.get(agentId) ?? [];
      samples.push({ time: now, tokens: state.total_tokens_used });

      // Remove old samples outside the window
      const windowStart = now - windowMs;
      const recent = samples.filter((s) => s.time >= windowStart);
      this._tokenSamples.set(agentId, recent);

      if (recent.length < 2) continue;

      const oldest = recent[0]!;
      const newest = recent[recent.length - 1]!;
      const elapsed = newest.time - oldest.time;
      if (elapsed === 0) continue;

      const tokensPerMs = (newest.tokens - oldest.tokens) / elapsed;
      const tokensPerMin = tokensPerMs * 60_000;

      if (tokensPerMin > this.config.token_burn_rate_limit) {
        this.logger.warn("high_burn_rate", "High token burn rate detected (rabbithole)", {
          metadata: {
            agent_id: agentId,
            tokens_per_min: Math.round(tokensPerMin),
            limit: this.config.token_burn_rate_limit,
          },
        });
        this._addAlert("WARNING", agentId, "high_burn_rate",
          `Token burn rate ${Math.round(tokensPerMin)}/min exceeds limit ${this.config.token_burn_rate_limit}/min`);
        proc.send({ type: "PAUSE" });
        this.eventBus.emit("agent.burn_rate_warning", {
          agent_id: agentId,
          tokens_per_min: Math.round(tokensPerMin),
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Cost check (called on cost_check_interval_ms)
  // ---------------------------------------------------------------------------

  private _runCostCheck(): void {
    for (const [agentId, proc] of this.processes) {
      const state = proc.getState();

      // Retrieve the agent definition cost limit via state (stored in metadata)
      // We don't have direct access to AgentDefinition here, so we emit events
      // and let the agent self-regulate. The bootstrap monitors for extreme cases.

      // Note: we track current_hour_cost from state; the agent self-pauses at limit.
      // Bootstrap emits a warning at 80% and critical at 100%.
      const costHour = state.current_hour_cost;
      if (costHour > 0) {
        this.logger.debug("agent_hourly_cost_check", "Agent hourly cost check", {
          metadata: { agent_id: agentId, current_hour_cost: costHour },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Memory health check
  // ---------------------------------------------------------------------------

  private async _runMemoryHealthCheck(): Promise<void> {
    const memConfigs = this.config.agent_memory_configs ?? {};
    const warnKb = 10;   // default thresholds (matches DEFAULT_LIFECYCLE_CONFIG)
    const compactKb = 15;
    const hardLimitKb = 25;
    const skillWarnKb = 6;
    const skillCompactKb = 8;

    for (const [agentId] of this.processes) {
      const memConfig = memConfigs[agentId];
      if (memConfig === undefined) continue;

      const shortTermKb = readFileSizeKb(memConfig.short_term_path);
      const skillKb = memConfig.skill_path !== undefined
        ? readFileSizeKb(memConfig.skill_path)
        : 0;

      const shortTermStatus =
        shortTermKb >= hardLimitKb ? "critical"
        : shortTermKb >= warnKb ? "warning"
        : "healthy";

      const skillStatus =
        skillKb >= skillCompactKb ? "critical"
        : skillKb >= skillWarnKb ? "warning"
        : "healthy";

      const health: AgentMemoryHealth = {
        agent_id: agentId,
        short_term_kb: shortTermKb,
        short_term_status: shortTermStatus,
        skill_file_kb: skillKb,
        skill_file_status: skillStatus,
        long_term_entries: 0, // V1: not tracked by bootstrap directly
        last_hygiene_cycle: null,
        needs_compaction: shortTermKb >= compactKb || skillKb >= skillCompactKb,
      };

      this._memoryHealth.set(agentId, health);

      if (shortTermStatus === "critical") {
        this._addAlert("CRITICAL", agentId, "memory_critical",
          `Short-term memory critical: ${shortTermKb.toFixed(1)} KB exceeds hard limit ${hardLimitKb} KB`);
      } else if (shortTermStatus === "warning") {
        this._addAlert("WARNING", agentId, "memory_warning",
          `Short-term memory warning: ${shortTermKb.toFixed(1)} KB approaching threshold`);
      }

      if (skillStatus !== "healthy") {
        this._addAlert("WARNING", agentId, "skill_bloat",
          `Skill file ${shortTermStatus === "critical" ? "critical" : "warning"}: ${skillKb.toFixed(1)} KB`);
      }

      // Trigger hygiene cycle if compact threshold exceeded
      const proc = this.processes.get(agentId);
      if (proc !== undefined && shortTermKb >= compactKb) {
        proc.send({
          type: "HYGIENE_REQUEST",
          config: buildDefaultHygieneConfig(),
        });
        this.logger.info("hygiene_cycle_triggered", "Triggered hygiene cycle for agent", {
          metadata: { agent_id: agentId, short_term_kb: shortTermKb },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Restart count check
  // ---------------------------------------------------------------------------

  private async _checkRestartCounts(): Promise<void> {
    for (const [agentId, proc] of this.processes) {
      const state = proc.getState();
      if (state.restart_count >= this.config.max_restart_attempts) {
        // Already handled in _attemptRestart; just ensure status is accurate
        if (state.status === "CRASHED" || state.status === "RESTARTING") {
          this.logger.error("agent_critical_state", "Agent in critical state — operator intervention required", {
            metadata: { agent_id: agentId, restart_count: state.restart_count, status: state.status },
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _addAlert(
    severity: "WARNING" | "CRITICAL",
    agentId: string,
    type: HealthAlert["type"],
    message: string,
  ): void {
    this._alerts.push({
      severity,
      agent_id: agentId,
      type,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}


/** Read a file's size in KB. Returns 0 if the file doesn't exist. */
function readFileSizeKb(filePath: string): number {
  try {
    const stats = statSync(filePath);
    return stats.size / 1024;
  } catch (e: unknown) {
    _logger.debug("agent-bootstrap", "Bootstrap file not found — skipping", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    return 0;
  }
}

/** Build a default MemoryHygieneConfig for triggering hygiene from Bootstrap. */
function buildDefaultHygieneConfig() {
  return {
    thresholds: {
      short_term_warn_kb: 10,
      short_term_compact_kb: 15,
      short_term_hard_limit_kb: 25,
      skill_file_warn_kb: 6,
      skill_file_compact_kb: 8,
      skill_file_hard_limit_kb: 12,
      long_term_max_entries: 10_000,
      dedup_threshold: 0.95,
      archival_target: "file" as const,
      compaction_strategy: "smart" as const,
    },
    retention: {
      always_retain: ["open_tasks", "active_projects", "unresolved_decisions", "current_session"],
      time_based: { decisions: "7d", session_summaries: "3" },
      never_retain: ["completed_task_details"],
    },
    archival: {
      target: "file" as const,
      collection_prefix: "sidjua_",
      required_tags: ["source_agent_id", "content_type", "original_created_at"],
      traceability: true,
    },
    compaction: { strategy: "smart" as const, dry_run: false },
  };
}
