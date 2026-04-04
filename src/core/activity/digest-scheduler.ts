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
    // Compute UTC boundaries for "yesterday" in the configured timezone.
    // year/month/day are local-timezone date parts from Intl.DateTimeFormat.
    // We compute the UTC timestamp corresponding to midnight of "today" in the
    // configured timezone, then subtract 24h for yesterday's range.
    // This correctly handles UTC offsets so the digest covers the right events.
    const todayMidnightUtc = _localMidnightToUtc(year, month, day, config.digest_timezone);
    const yesterdayStart   = new Date(todayMidnightUtc.getTime() - 86_400_000);
    const yesterdayEnd     = new Date(todayMidnightUtc.getTime() - 1);

    try {
      const digest = digestEngine.generateDailyRange(yesterdayStart.toISOString(), yesterdayEnd.toISOString());
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


// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the UTC Date corresponding to midnight of a given local date in
 * the specified IANA timezone.
 *
 * Algorithm: at UTC midnight of the given local date string, use
 * Intl.DateTimeFormat to get the local hour/minute/second at that UTC moment.
 * Adjust by that offset to find true UTC midnight for the local date.
 *
 * Works for all standard UTC offsets (-12 to +14).
 *
 * @internal exported only for testing
 */
export function _localMidnightToUtc(year: number, month: number, day: number, timezone: string): Date {
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Start with UTC midnight as a reference point
  const utcMidnight = new Date(`${dateStr}T00:00:00Z`);

  // Get the local time-of-day in the target timezone at utcMidnight
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone:  timezone,
    hour:      "2-digit",
    minute:    "2-digit",
    second:    "2-digit",
    hour12:    false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(utcMidnight).map((p) => [p.type, p.value]));
  const h = parseInt(parts["hour"]   ?? "0") % 24; // formatToParts may return "24" for midnight
  const m = parseInt(parts["minute"] ?? "0");
  const s = parseInt(parts["second"] ?? "0");

  const localOffsetMs = (h * 3600 + m * 60 + s) * 1000;

  // If local time at utcMidnight is H:M:S < 12:00:00 → local midnight is BEFORE utcMidnight
  //   (timezone is ahead of UTC, e.g. UTC+5: at UTC midnight local = 05:00, so local midnight = -5h)
  // If local time at utcMidnight is H:M:S >= 12:00:00 → local midnight is AFTER utcMidnight
  //   (timezone is behind UTC, e.g. UTC-5: at UTC midnight local = 19:00 prev day, so local midnight = +5h)
  if (h < 12) {
    return new Date(utcMidnight.getTime() - localOffsetMs);
  } else {
    const remainingMs = (24 * 3600 - (h * 3600 + m * 60 + s)) * 1000;
    return new Date(utcMidnight.getTime() + remainingMs);
  }
}
