// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Version Check Service
 *
 * Checks for available updates via the version endpoint.
 * Falls back to GitHub Releases API if the primary endpoint fails.
 * Runs on app start and every 6 hours. Result is cached in memory.
 */

import { semverGt } from "../update/version-utils.js";
import type { VersionInfo } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("version-check");

const PRIMARY_VERSION_URL = "https://version.sidjua.com/latest";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/goetzkohlberg/sidjua/releases/latest";
const CHECK_INTERVAL_MS   = 6 * 60 * 60 * 1_000; // 6 hours
const FETCH_TIMEOUT_MS    = 10_000;

let _lastVersionInfo: VersionInfo | null = null;
let _checkTimer: ReturnType<typeof setInterval> | null = null;

/** Returns the cached version info from the last check, or null if not yet checked. */
export function getLastVersionInfo(): VersionInfo | null {
  return _lastVersionInfo;
}

/**
 * Check for an available update.
 *
 * Tries the primary version endpoint first; falls back to GitHub Releases API.
 * Returns a VersionInfo describing the latest version relative to current.
 */
export async function checkForUpdate(currentVersion: string): Promise<VersionInfo> {
  // Try primary endpoint first
  let info = await tryPrimaryEndpoint(currentVersion);
  if (info === null) {
    info = await tryGithubEndpoint(currentVersion);
  }

  const result: VersionInfo = info ?? {
    current:         currentVersion,
    latest:          currentVersion,
    updateAvailable: false,
    releaseNotes:    "",
    size:            0,
    breaking:        false,
    minUpgradeFrom:  "0.0.0",
  };

  _lastVersionInfo = result;
  return result;
}

/** Start the periodic background version check. */
export function startVersionCheckScheduler(currentVersion: string): void {
  if (_checkTimer !== null) return;

  // Check immediately, then on interval
  void checkForUpdate(currentVersion).catch((_err) => { /* background — non-fatal */ });

  _checkTimer = setInterval(() => {
    void checkForUpdate(currentVersion).catch((_err) => { /* background — non-fatal */ });
  }, CHECK_INTERVAL_MS);

  // Unref so the timer doesn't keep the process alive
  if (_checkTimer.unref) _checkTimer.unref();
}

/** Stop the periodic version check (for testing or graceful shutdown). */
export function stopVersionCheckScheduler(): void {
  if (_checkTimer !== null) {
    clearInterval(_checkTimer);
    _checkTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function tryPrimaryEndpoint(currentVersion: string): Promise<VersionInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(PRIMARY_VERSION_URL, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) return null;

    const raw: unknown = await resp.json();
    return parseVersionResponse(raw, currentVersion);
  } catch (err: unknown) {
    clearTimeout(timer);
    logger.debug("version-check", "Primary version endpoint failed", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

async function tryGithubEndpoint(currentVersion: string): Promise<VersionInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(GITHUB_RELEASES_URL, {
      signal:  controller.signal,
      headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "sidjua-version-check" },
    });
    clearTimeout(timer);

    if (!resp.ok) return null;

    const raw: unknown = await resp.json();
    return parseGithubRelease(raw, currentVersion);
  } catch (err: unknown) {
    clearTimeout(timer);
    logger.debug("version-check", "GitHub releases fallback failed", {
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

function parseVersionResponse(raw: unknown, currentVersion: string): VersionInfo | null {
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  const latest = typeof obj["version"] === "string" ? obj["version"] : null;
  if (!latest) return null;

  return {
    current:         currentVersion,
    latest,
    updateAvailable: semverGt(latest, currentVersion),
    releaseNotes:    typeof obj["releaseNotes"] === "string" ? obj["releaseNotes"] : "",
    size:            typeof obj["size"] === "number"         ? obj["size"] : 0,
    breaking:        typeof obj["breaking"] === "boolean"    ? obj["breaking"] : isMajorBump(currentVersion, latest),
    minUpgradeFrom:  typeof obj["minUpgradeFrom"] === "string" ? obj["minUpgradeFrom"] : "0.0.0",
  };
}

function parseGithubRelease(raw: unknown, currentVersion: string): VersionInfo | null {
  if (typeof raw !== "object" || raw === null) return null;

  const obj  = raw as Record<string, unknown>;
  const tag  = typeof obj["tag_name"] === "string" ? obj["tag_name"] : null;
  if (!tag) return null;

  const latest = tag.replace(/^v/, "");
  return {
    current:         currentVersion,
    latest,
    updateAvailable: semverGt(latest, currentVersion),
    releaseNotes:    typeof obj["body"] === "string" ? obj["body"] : "",
    size:            0,
    breaking:        isMajorBump(currentVersion, latest),
    minUpgradeFrom:  "0.0.0",
  };
}

function isMajorBump(current: string, latest: string): boolean {
  const curMajor = parseInt(current.split(".")[0] ?? "0", 10);
  const latMajor = parseInt(latest.split(".")[0] ?? "0", 10);
  return latMajor > curMajor;
}
