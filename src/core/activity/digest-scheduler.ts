// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Activity Stream: Digest Scheduler
 *
 * Interval-based scheduler that auto-generates daily and weekly digests.
 * Ticks every 5 minutes and checks whether the configured delivery time
 * has been reached in the target timezone.
 *
 * - Daily:  generated every day at digest_time in digest_timezone
 * - Weekly: generated every Monday at digest_time in digest_timezone
 *
 * Uses Node.js Intl.DateTimeFormat (no external dependencies).
 * Errors during generation are swallowed — the scheduler never crashes.
 */

import type { DigestResult }  from "./digest-engine.js";
import { digestEngine }       from "./digest-engine.js";
import { createLogger }       from "../logger.js";

const logger = createLogger("digest-scheduler");

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes


export interface SchedulerConfig {
  /** HH:MM in 24-hour format, e.g. "06:00" */
  digest_time:      string;
  /** IANA timezone string, e.g. "Asia/Manila" */
  digest_timezone:  string;
  /** Whether to send digests via Telegram */
  telegram_digest:  boolean;
  /** Async callback for Telegram delivery (injected at startup) */
  deliverTelegram?: (digest: DigestResult) => Promise<void>;
}


// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _interval:        NodeJS.Timeout | null = null;
let _lastDailyDate:   string | null         = null;
let _lastWeeklyDate:  string | null         = null;


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the digest scheduler. No-op if already running.
 * Call after digestEngine.init(db).
 */
export function startDigestScheduler(config: SchedulerConfig): void {
  if (_interval !== null) return;

  _interval = setInterval(() => {
    try {
      _tick(config);
    } catch (err: unknown) {
      logger.warn("scheduler_tick_failed", "Scheduler tick failed (non-fatal)", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }, TICK_INTERVAL_MS);

  logger.info("scheduler_started", `Digest scheduler started (${config.digest_time} ${config.digest_timezone})`, {});
}

/** Stop the scheduler. Safe to call if not running. */
export function stopDigestScheduler(): void {
  if (_interval !== null) {
    clearInterval(_interval);
    _interval = null;
  }
}

/**
 * Reset internal last-generated state. Used by tests only.
 * @internal
 */
export function _resetSchedulerState(): void {
  _lastDailyDate  = null;
  _lastWeeklyDate = null;
}


// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _tick(config: SchedulerConfig): void {
  const now = new Date();

  // Use Intl.DateTimeFormat.formatToParts for reliable timezone handling.
  // toLocaleString + new Date() is locale-dependent and can break in non-en-US environments.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone:    config.digest_timezone,
    year:        "numeric",
    month:       "2-digit",
    day:         "2-digit",
    hour:        "2-digit",
    minute:      "2-digit",
    weekday:     "short",
    hour12:      false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(now).map((p) => [p.type, p.value]));

  const hours     = parseInt(parts["hour"]    ?? "0",  10) % 24; // formatToParts may return "24" for midnight
  const minutes   = parseInt(parts["minute"]  ?? "0",  10);
  const year      = parseInt(parts["year"]    ?? "0",  10);
  const month     = parseInt(parts["month"]   ?? "0",  10);
  const day       = parseInt(parts["day"]     ?? "0",  10);
  // weekday: "Sun"=0, "Mon"=1 ... "Sat"=6
  const WEEKDAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = WEEKDAY_MAP[parts["weekday"] ?? ""] ?? -1;

  const [targetH, targetM] = config.digest_time.split(":").map(Number);
  const todayStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  // Daily digest window: [targetTime, targetTime + 10 min) once per day
  const inWindow = hours === targetH && minutes >= (targetM ?? 0) && minutes < (targetM ?? 0) + 10;

  if (inWindow && _lastDailyDate !== todayStr) {
    _lastDailyDate = todayStr;
    // Compute yesterday in the target timezone using the local date parts
    const localDate  = new Date(Date.UTC(year, month - 1, day));
    const yesterday  = new Date(localDate.getTime() - 86_400_000);
    const yesterdayStr = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;

    try {
      const digest = digestEngine.generateDaily(yesterdayStr);
      logger.info("daily_digest_generated", `Daily digest generated: ${digest.event_count} events`, {});
      if (config.telegram_digest && config.deliverTelegram !== undefined) {
        config.deliverTelegram(digest).catch((err: unknown) => {
          logger.warn("telegram_delivery_failed", "Telegram delivery failed", {
            metadata: { error: err instanceof Error ? err.message : String(err) },
          });
        });
      }
    } catch (err: unknown) {
      logger.warn("daily_digest_failed", "Daily digest generation failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Weekly digest window: Monday only, same time window
  if (dayOfWeek === 1 && inWindow && _lastWeeklyDate !== todayStr) {
    _lastWeeklyDate = todayStr;
    const localDate    = new Date(Date.UTC(year, month - 1, day));
    const weekStart    = new Date(localDate.getTime() - 7 * 86_400_000);
    const weekStartStr = `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth() + 1).padStart(2, "0")}-${String(weekStart.getUTCDate()).padStart(2, "0")}`;

    try {
      const digest = digestEngine.generateWeekly(weekStartStr);
      logger.info("weekly_digest_generated", `Weekly digest generated: ${digest.event_count} events`, {});
      if (config.telegram_digest && config.deliverTelegram !== undefined) {
        config.deliverTelegram(digest).catch((_e: unknown) => undefined);
      }
    } catch (err: unknown) {
      logger.warn("weekly_digest_failed", "Weekly digest generation failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
