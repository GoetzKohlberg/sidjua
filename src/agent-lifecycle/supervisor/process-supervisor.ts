// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.5c: ProcessSupervisor
 *
 * In-memory supervisor that tracks agent health, detects crashes, manages
 * circuit breakers, and computes exponential backoff for restarts.
 *
 * No DB dependency — all state is ephemeral. The orchestrator calls:
 *   - recordHeartbeat() on HEARTBEAT messages
 *   - checkHeartbeats() periodically
 *   - notifyCrash() from agentProcess.onExit()
 */

import { createLogger, type Logger } from "../../core/logger.js";


export interface SupervisorAgentConfig {
  /** Maximum missed heartbeats before declaring UNHEALTHY. Default: 3. */
  max_missed_heartbeats?: number;
  /** Max crashes within the window before opening the circuit. Default: 5. */
  max_crashes_in_window?: number;
  /** Rolling window for crash counting (ms). Default: 300_000 (5 min). */
  crash_window_ms?: number;
  /** Base backoff delay in ms. Default: 1_000. */
  backoff_base_ms?: number;
  /** Maximum backoff delay in ms. Default: 60_000. */
  backoff_max_ms?: number;
}

export type AgentHealthState = "HEALTHY" | "UNHEALTHY" | "CRASHED" | "CIRCUIT_OPEN" | "UNKNOWN";

export interface AgentHealthStatus {
  agent_id: string;
  state: AgentHealthState;
  last_heartbeat: string | null;
  consecutive_missed: number;
  total_crashes: number;
  restart_attempts: number;
  circuit_open: boolean;
  circuit_opened_at: string | null;
}

interface SupervisorState {
  agent_id: string;
  config: Required<SupervisorAgentConfig>;
  last_heartbeat: string | null;
  consecutive_missed: number;
  total_crashes: number;
  restart_attempts: number;
  crash_times: number[];   // epoch ms timestamps in rolling window
  circuit_open: boolean;
  circuit_opened_at: string | null;
}

type CrashHandler = (agentId: string, exitCode: number | null, signal: string | null) => void;
type CircuitHandler = (agentId: string) => void;

const DEFAULTS: Required<SupervisorAgentConfig> = {
  max_missed_heartbeats: 3,
  max_crashes_in_window: 5,
  crash_window_ms: 300_000,
  backoff_base_ms: 1_000,
  backoff_max_ms: 60_000,
};


export class ProcessSupervisor {
  private readonly agents = new Map<string, SupervisorState>();
  private readonly crashHandlers: CrashHandler[] = [];
  private readonly circuitHandlers: CircuitHandler[] = [];

  constructor(private readonly logger: Logger = createLogger("process-supervisor")) {}

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  registerAgent(id: string, config: SupervisorAgentConfig = {}): void {
    if (this.agents.has(id)) {
      this.logger.warn("agent_already_registered", "Agent already registered", { metadata: { agent_id: id } });
      return;
    }
    const resolved: Required<SupervisorAgentConfig> = {
      max_missed_heartbeats: config.max_missed_heartbeats ?? DEFAULTS.max_missed_heartbeats,
      max_crashes_in_window: config.max_crashes_in_window ?? DEFAULTS.max_crashes_in_window,
      crash_window_ms: config.crash_window_ms ?? DEFAULTS.crash_window_ms,
      backoff_base_ms: config.backoff_base_ms ?? DEFAULTS.backoff_base_ms,
      backoff_max_ms: config.backoff_max_ms ?? DEFAULTS.backoff_max_ms,
    };
    this.agents.set(id, {
      agent_id: id,
      config: resolved,
      last_heartbeat: null,
      consecutive_missed: 0,
      total_crashes: 0,
      restart_attempts: 0,
      crash_times: [],
      circuit_open: false,
      circuit_opened_at: null,
    });
    this.logger.debug("agent_registered", "Agent registered", { metadata: { agent_id: id } });
  }

  unregisterAgent(id: string): void {
    this.agents.delete(id);
    this.logger.debug("agent_unregistered", "Agent unregistered", { metadata: { agent_id: id } });
  }

  // ---------------------------------------------------------------------------
  // Heartbeat tracking
  // ---------------------------------------------------------------------------

  /** Record a heartbeat for an agent. Resets consecutive_missed to 0. */
  recordHeartbeat(agentId: string): void {
    const state = this.agents.get(agentId);
    if (state === undefined) return;
    state.last_heartbeat = new Date().toISOString();
    state.consecutive_missed = 0;
    if (state.circuit_open) {
      // Auto-recover circuit if agent is responding
      state.circuit_open = false;
      state.circuit_opened_at = null;
      this.logger.info("circuit_auto_closed", "Circuit auto-closed (heartbeat received)", { metadata: { agent_id: agentId } });
    }
  }

  /**
   * Increment missed-heartbeat counter for all registered agents that haven't
   * sent a heartbeat since the last check. Call this periodically.
   */
  checkHeartbeats(): void {
    for (const state of this.agents.values()) {
      if (state.circuit_open) continue;
      state.consecutive_missed++;
      if (state.consecutive_missed >= state.config.max_missed_heartbeats) {
        this.logger.warn("agent_heartbeat_timeout", "Agent heartbeat timeout", {
          metadata: { agent_id: state.agent_id, consecutive_missed: state.consecutive_missed },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Crash handling
  // ---------------------------------------------------------------------------

  /**
   * Notify supervisor of an agent crash.
   * Updates crash window, increments counters, opens circuit breaker if threshold reached.
   */
  notifyCrash(agentId: string, exitCode: number | null, signal: string | null): void {
    const state = this.agents.get(agentId);
    if (state === undefined) {
      this.logger.warn("notify_crash_unknown_agent", "notifyCrash called for unknown agent", { metadata: { agent_id: agentId } });
      return;
    }

    const now = Date.now();
    state.total_crashes++;
    state.restart_attempts++;

    // Prune crash_times outside the window, then hard-cap to 100 to prevent unbounded growth
    const windowStart = now - state.config.crash_window_ms;
    state.crash_times = state.crash_times.filter((t) => t >= windowStart);
    state.crash_times.push(now);
    if (state.crash_times.length > 100) { state.crash_times.splice(0, state.crash_times.length - 100); }

    this.logger.warn("agent_crash_recorded", "Agent crash recorded", {
      metadata: {
        agent_id: agentId,
        exit_code: exitCode,
        signal,
        crashes_in_window: state.crash_times.length,
      },
    });

    // Notify crash handlers
    for (const handler of this.crashHandlers) {
      handler(agentId, exitCode, signal);
    }

    // Check circuit breaker
    if (!state.circuit_open && state.crash_times.length > state.config.max_crashes_in_window) {
      state.circuit_open = true;
      state.circuit_opened_at = new Date().toISOString();
      this.logger.error("circuit_breaker_opened", "Circuit breaker opened", {
        metadata: { agent_id: agentId, crashes_in_window: state.crash_times.length },
      });
      for (const handler of this.circuitHandlers) {
        handler(agentId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Status queries
  // ---------------------------------------------------------------------------

  getAgentStatus(agentId: string): AgentHealthStatus | undefined {
    const state = this.agents.get(agentId);
    if (state === undefined) return undefined;
    return this._toHealthStatus(state);
  }

  getAllStatuses(): AgentHealthStatus[] {
    return Array.from(this.agents.values()).map((s) => this._toHealthStatus(s));
  }

  /**
   * Compute the exponential backoff delay for an agent's next restart attempt.
   * Formula: min(base * 2^attempt, max)
   */
  getBackoffMs(agentId: string): number {
    const state = this.agents.get(agentId);
    if (state === undefined) return DEFAULTS.backoff_base_ms;
    const attempt = state.restart_attempts;
    return Math.min(
      state.config.backoff_base_ms * Math.pow(2, attempt),
      state.config.backoff_max_ms,
    );
  }

  /** Manually reset the circuit breaker (operator action). */
  resetCircuit(agentId: string): void {
    const state = this.agents.get(agentId);
    if (state === undefined) return;
    state.circuit_open = false;
    state.circuit_opened_at = null;
    state.crash_times = [];
    state.restart_attempts = 0;
    this.logger.info("circuit_breaker_reset", "Circuit breaker manually reset", { metadata: { agent_id: agentId } });
  }

  // ---------------------------------------------------------------------------
  // Callback registration
  // ---------------------------------------------------------------------------

  /** Register a handler called whenever an agent crashes. */
  onAgentCrash(handler: CrashHandler): void {
    this.crashHandlers.push(handler);
  }

  /** Register a handler called when a circuit breaker opens. */
  onCircuitOpen(handler: CircuitHandler): void {
    this.circuitHandlers.push(handler);
  }

  // ---------------------------------------------------------------------------
  // P270 B5: State persistence
  // ---------------------------------------------------------------------------

  /**
   * Persist all supervisor agent states to SQLite.
   * Call on server shutdown so watchdog state survives restarts.
   */
  persistState(db: import("../../utils/db.js").Database): void {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS supervised_processes (
          agent_id           TEXT PRIMARY KEY,
          config             TEXT NOT NULL,
          last_heartbeat     TEXT,
          consecutive_missed INTEGER NOT NULL DEFAULT 0,
          total_crashes      INTEGER NOT NULL DEFAULT 0,
          restart_attempts   INTEGER NOT NULL DEFAULT 0,
          crash_times        TEXT NOT NULL DEFAULT '[]',
          circuit_open       INTEGER NOT NULL DEFAULT 0,
          circuit_opened_at  TEXT,
          updated_at         TEXT NOT NULL
        )
      `);
      const upsert = db.prepare<[string, string, string | null, number, number, number, string, number, string | null, string], void>(
        `INSERT OR REPLACE INTO supervised_processes
         (agent_id, config, last_heartbeat, consecutive_missed, total_crashes, restart_attempts, crash_times, circuit_open, circuit_opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      const run = db.transaction(() => {
        for (const [agentId, state] of this.agents) {
          upsert.run(
            agentId,
            JSON.stringify(state.config),
            state.last_heartbeat,
            state.consecutive_missed,
            state.total_crashes,
            state.restart_attempts,
            JSON.stringify(state.crash_times),
            state.circuit_open ? 1 : 0,
            state.circuit_opened_at,
            now,
          );
        }
      });
      run();
    } catch (e: unknown) {
      this.logger.warn("persist_state_failed", "persistState failed — non-fatal", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  /**
   * Restore supervisor agent states from SQLite.
   * Call on startup. Returns number of agents restored.
   */
  restoreState(db: import("../../utils/db.js").Database): number {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS supervised_processes (
          agent_id           TEXT PRIMARY KEY,
          config             TEXT NOT NULL,
          last_heartbeat     TEXT,
          consecutive_missed INTEGER NOT NULL DEFAULT 0,
          total_crashes      INTEGER NOT NULL DEFAULT 0,
          restart_attempts   INTEGER NOT NULL DEFAULT 0,
          crash_times        TEXT NOT NULL DEFAULT '[]',
          circuit_open       INTEGER NOT NULL DEFAULT 0,
          circuit_opened_at  TEXT,
          updated_at         TEXT NOT NULL
        )
      `);
      const rows = db.prepare<[], {
        agent_id: string; config: string; last_heartbeat: string | null;
        consecutive_missed: number; total_crashes: number; restart_attempts: number;
        crash_times: string; circuit_open: number; circuit_opened_at: string | null;
      }>(
        "SELECT agent_id, config, last_heartbeat, consecutive_missed, total_crashes, restart_attempts, crash_times, circuit_open, circuit_opened_at FROM supervised_processes",
      ).all();
      for (const row of rows) {
        try {
          const state: SupervisorState = {
            agent_id:           row.agent_id,
            config:             JSON.parse(row.config) as Required<SupervisorAgentConfig>,
            last_heartbeat:     row.last_heartbeat,
            consecutive_missed: row.consecutive_missed,
            total_crashes:      row.total_crashes,
            restart_attempts:   row.restart_attempts,
            crash_times:        JSON.parse(row.crash_times) as number[],
            circuit_open:       row.circuit_open === 1,
            circuit_opened_at:  row.circuit_opened_at,
          };
          this.agents.set(row.agent_id, state);
        } catch (_e) { /* skip malformed rows */ }
      }
      return rows.length;
    } catch (e: unknown) {
      this.logger.warn("restore_state_failed", "restoreState failed — starting fresh", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _toHealthStatus(state: SupervisorState): AgentHealthStatus {
    let healthState: AgentHealthState;
    if (state.circuit_open) {
      healthState = "CIRCUIT_OPEN";
    } else if (state.consecutive_missed >= state.config.max_missed_heartbeats) {
      healthState = "UNHEALTHY";
    } else if (state.last_heartbeat !== null) {
      healthState = "HEALTHY";
    } else {
      healthState = "UNKNOWN";
    }

    const status: AgentHealthStatus = {
      agent_id: state.agent_id,
      state: healthState,
      last_heartbeat: state.last_heartbeat,
      consecutive_missed: state.consecutive_missed,
      total_crashes: state.total_crashes,
      restart_attempts: state.restart_attempts,
      circuit_open: state.circuit_open,
      circuit_opened_at: state.circuit_opened_at,
    };
    return status;
  }
}
