// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Backpressure Manager
 *
 * Tracks active workers per agent tier, enforces configurable concurrency
 * limits, and queues excess tasks with priority ordering (high > normal > low).
 * Rejects new tasks when the queue is full (503 territory).
 */

import { createLogger } from "../logger.js";
import { getMetrics }   from "../metrics/metrics-collector.js";

const logger = createLogger("backpressure");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackpressureConfig {
  /** Max concurrent tasks per tier key (e.g. "T1", "T2", "T3" or tier number as string). */
  maxConcurrentByTier: Record<string, number>;
  /** Max tasks waiting in queue before new acquisitions are rejected. Default: 100. */
  maxQueueLength: number;
  /** Max time (ms) a queued task waits before timing out. Default: 120 000 (2 min). */
  queueTimeoutMs: number;
}

interface QueuedTask {
  id:          string;
  tier:        string;
  priority:    "low" | "normal" | "high";
  enqueuedAt:  number;
  resolve:     () => void;
  reject:      (reason: BackpressureError) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: BackpressureConfig = {
  maxConcurrentByTier: { "1": 2, "2": 4, "3": 8, T1: 2, T2: 4, T3: 8 },
  maxQueueLength: 100,
  queueTimeoutMs: 120_000,
};

// ---------------------------------------------------------------------------
// BackpressureError
// ---------------------------------------------------------------------------

export class BackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackpressureError";
  }
}

// ---------------------------------------------------------------------------
// BackpressureManager
// ---------------------------------------------------------------------------

export class BackpressureManager {
  private readonly config: BackpressureConfig;
  private readonly activeCounts: Record<string, number> = {};
  private queue: QueuedTask[] = [];
  private cleanupHandle: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<BackpressureConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Acquire a worker slot for the given tier and priority.
   * Returns immediately if a slot is available, otherwise queues the request.
   * Throws BackpressureError if the queue is full.
   */
  async acquire(
    taskId:   string,
    tier:     string,
    priority: "low" | "normal" | "high" = "normal",
  ): Promise<void> {
    const maxForTier = this._maxForTier(tier);
    const current    = this.activeCounts[tier] ?? 0;

    if (current < maxForTier) {
      this.activeCounts[tier] = current + 1;
      this._updateMetrics();
      return;
    }

    // Slot unavailable — try to queue
    if (this.queue.length >= this.config.maxQueueLength) {
      logger.warn("backpressure", "Queue full — rejecting task", {
        metadata: { taskId, tier, queueLength: this.queue.length },
      });
      throw new BackpressureError(
        "System overloaded — task queue is full, please try again later",
      );
    }

    // Queue with timeout
    return new Promise<void>((resolve, reject) => {
      const entry: QueuedTask = {
        id:         taskId,
        tier,
        priority,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      };

      const insertAt = this._findInsertIndex(priority);
      this.queue.splice(insertAt, 0, entry);
      this._updateMetrics();

      // Per-entry timeout
      setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this._updateMetrics();
          reject(new BackpressureError("Queue timeout — task waited too long for a worker slot"));
        }
      }, this.config.queueTimeoutMs);
    });
  }

  /**
   * Release a worker slot for the given tier after task completion.
   * Dequeues the next waiting task for this tier, if any.
   */
  release(tier: string): void {
    const current = this.activeCounts[tier] ?? 0;
    if (current > 0) {
      this.activeCounts[tier] = current - 1;
    }

    // Promote next queued task of this tier
    const nextIdx = this.queue.findIndex((t) => t.tier === tier);
    if (nextIdx !== -1) {
      const next = this.queue.splice(nextIdx, 1)[0];
      if (next !== undefined) {
        this.activeCounts[tier] = (this.activeCounts[tier] ?? 0) + 1;
        next.resolve();
      }
    }

    this._updateMetrics();
  }

  /** Current status snapshot for monitoring. */
  getStatus(): { active: Record<string, number>; queueLength: number; maxConcurrentByTier: Record<string, number> } {
    return {
      active:              { ...this.activeCounts },
      queueLength:         this.queue.length,
      maxConcurrentByTier: { ...this.config.maxConcurrentByTier },
    };
  }

  /** Start the background cleanup timer for expired queue entries. */
  start(): void {
    if (this.cleanupHandle !== null) return;
    this.cleanupHandle = setInterval(() => this._cleanupExpired(), 10_000);
  }

  /** Stop the cleanup timer and reject all queued tasks. */
  stop(): void {
    if (this.cleanupHandle !== null) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }
    for (const entry of this.queue) {
      entry.reject(new BackpressureError("System shutting down"));
    }
    this.queue = [];
    this._updateMetrics();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _maxForTier(tier: string): number {
    return (
      this.config.maxConcurrentByTier[tier] ??
      this.config.maxConcurrentByTier["T3"] ??
      8
    );
  }

  /** Find insertion index preserving high > normal > low order. */
  private _findInsertIndex(priority: "low" | "normal" | "high"): number {
    const weights: Record<"low" | "normal" | "high", number> = {
      high: 3, normal: 2, low: 1,
    };
    const weight = weights[priority];
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      if (entry !== undefined && weights[entry.priority] < weight) return i;
    }
    return this.queue.length;
  }

  private _cleanupExpired(): void {
    const now = Date.now();
    this.queue = this.queue.filter((entry) => {
      if (now - entry.enqueuedAt > this.config.queueTimeoutMs) {
        entry.reject(new BackpressureError("Queue timeout — task waited too long"));
        return false;
      }
      return true;
    });
    this._updateMetrics();
  }

  private _updateMetrics(): void {
    try {
      const metrics = getMetrics();
      for (const [tier, count] of Object.entries(this.activeCounts)) {
        metrics.activeWorkersByTier.set({ tier }, count);
      }
      metrics.backpressureQueueLength.set({}, this.queue.length);
    } catch (_err) {
      // metrics not critical — never throw
    }
  }
}
