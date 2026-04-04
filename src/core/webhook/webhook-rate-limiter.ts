// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P378: Webhook Rate Limiter
 *
 * In-memory per-agent rate limiter for incoming webhook requests.
 * 60 requests per minute per agent ID.
 */


/** Maximum webhook requests per agent per rate-limit window. */
export const WEBHOOK_RATE_LIMIT = 60;

/** Rate-limit window duration in ms (1 minute). */
export const WEBHOOK_RATE_WINDOW_MS = 60_000;


interface AgentRateState {
  count:   number;
  resetAt: number;
}

/** In-process per-agent request counts. */
const _agentCounts = new Map<string, AgentRateState>();

/** Clear rate-limit state — for tests and graceful shutdown. */
export function clearWebhookRateLimitState(): void {
  _agentCounts.clear();
}

/**
 * Check and update the per-agent rate limit.
 *
 * Returns true when the request is within the limit; false when it should be
 * rejected (429 Too Many Requests).
 *
 * @param agentId  Agent identifier used as the rate-limit bucket key.
 */
export function webhookRateLimitCheck(agentId: string): boolean {
  const now   = Date.now();
  const state = _agentCounts.get(agentId);

  if (state !== undefined && state.resetAt > now) {
    if (state.count >= WEBHOOK_RATE_LIMIT) return false;
    state.count++;
    return true;
  }

  // New window (or new agent)
  _agentCounts.set(agentId, { count: 1, resetAt: now + WEBHOOK_RATE_WINDOW_MS });
  return true;
}
