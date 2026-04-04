// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Failure Injector
 *
 * Schedules synthetic failures during benchmark runs to test recovery behavior.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureType = "agent-crash" | "mcp-timeout" | "budget-exhaust" | "queue-flood";

export interface FailureConfig {
  /** Unique name for this injection (used in result reporting). */
  name: string;
  /** Milliseconds from benchmark start at which to trigger the failure. */
  offsetMs: number;
  type: FailureType;
  /**
   * Target agent ID, or "all" to apply to every agent in the fleet.
   * For queue-flood, this is the tier string (e.g. "T3") to flood.
   */
  target: string;
  /** For transient failures: how long before the failure is cleared (ms). */
  durationMs?: number;
}

export interface FailureEvent {
  name: string;
  type: FailureType;
  target: string;
  /** "start" = failure begins, "end" = failure clears (transient only). */
  action: "start" | "end";
}

interface ScheduledFailure {
  config: FailureConfig;
  fired: boolean;
  recovered: boolean;
}

// ---------------------------------------------------------------------------
// FailureInjector
// ---------------------------------------------------------------------------

export class FailureInjector {
  private readonly _scheduled: ScheduledFailure[] = [];

  /**
   * Register a failure to fire at the given time offset from benchmark start.
   * Call before starting the benchmark run.
   */
  scheduleFailure(config: FailureConfig): void {
    this._scheduled.push({ config, fired: false, recovered: false });
  }

  /**
   * Check for failures that should fire or recover at `elapsedMs`.
   * Returns the list of events that just triggered.
   * Call this on every tick of the benchmark loop.
   */
  tick(elapsedMs: number): FailureEvent[] {
    const events: FailureEvent[] = [];

    for (const entry of this._scheduled) {
      // New failure to start
      if (!entry.fired && elapsedMs >= entry.config.offsetMs) {
        entry.fired = true;
        events.push({
          name:   entry.config.name,
          type:   entry.config.type,
          target: entry.config.target,
          action: "start",
        });
      }

      // Transient failure to recover
      if (
        entry.fired &&
        !entry.recovered &&
        entry.config.durationMs !== undefined &&
        elapsedMs >= entry.config.offsetMs + entry.config.durationMs
      ) {
        entry.recovered = true;
        events.push({
          name:   entry.config.name,
          type:   entry.config.type,
          target: entry.config.target,
          action: "end",
        });
      }
    }

    return events;
  }

  /** Returns names of all failures that were fired. */
  getFiredNames(): string[] {
    return this._scheduled.filter((e) => e.fired).map((e) => e.config.name);
  }

  /** Returns names of all transient failures that fully recovered. */
  getRecoveredNames(): string[] {
    return this._scheduled.filter((e) => e.recovered).map((e) => e.config.name);
  }

  /** Returns names of fired failures that have NOT yet recovered (permanent or still active). */
  getUnrecoveredNames(): string[] {
    return this._scheduled
      .filter((e) => e.fired && !e.recovered)
      .map((e) => e.config.name);
  }

  /** Reset all state (for reuse across multiple runs). */
  reset(): void {
    for (const entry of this._scheduled) {
      entry.fired = false;
      entry.recovered = false;
    }
    this._scheduled.length = 0;
  }
}
