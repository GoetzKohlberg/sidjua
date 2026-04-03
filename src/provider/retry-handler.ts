// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Provider Layer: Retry Handler
 *
 * Implements exponential backoff with jitter for transient provider errors.
 *
 * Retry policy:
 *   - Only ProviderError instances with isRetryable=true trigger retries.
 *   - Non-retryable errors (4xx, invalid auth, etc.) are re-thrown immediately.
 *   - Non-ProviderError errors (programming bugs) are re-thrown immediately.
 *   - Delay sequence: initialDelayMs → * backoffMultiplier → capped at maxDelayMs.
 *   - Jitter: ±10% random variation on each delay to reduce thundering herd.
 *
 * Failover (handled by ProviderRegistry, not here):
 *   After all retries are exhausted on the primary provider, the registry
 *   delegates failover to a secondary provider. The RetryHandler is stateless
 *   and provider-agnostic — it operates on any async operation.
 */

import type { Logger } from "../core/logger.js";
import type { RetryConfig } from "../types/provider.js";
import { ProviderError } from "../types/provider.js";


/** Context passed to withRetry for logging and diagnostics. */
export interface RetryContext {
  /** Provider being called (for log messages). */
  provider: string;
  /** Call UUID (for log correlation). */
  callId: string;
  /**
   * Override the configured maxAttempts for this specific call.
   * Used by the failover path to cap total retries across primary + failover
   * at MAX_TOTAL_PROVIDER_RETRIES (xAI-ARCH-H3).
   * When omitted, the handler uses its configured maxAttempts.
   */
  maxAttemptsOverride?: number;
}

/**
 * Stateless retry handler with exponential backoff.
 * Inject into ProviderRegistry to wrap provider calls.
 */
export class RetryHandler {
  constructor(
    private readonly config: RetryConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Execute `operation` with exponential backoff.
   *
   * @param operation - Async function to retry on transient failure.
   * @param context - Metadata for log messages.
   * @returns The result of `operation` on first success.
   * @throws The last error after all attempts are exhausted.
   * @throws Immediately on non-retryable ProviderError or unknown error types.
   */
  async withRetry<T>(operation: () => Promise<T>, context: RetryContext): Promise<T> {
    let lastError: unknown = new Error("No attempts made");
    let delayMs = this.config.initialDelayMs;

    // xAI-ARCH-H3: honour per-call cap to bound total primary+failover retries
    const effectiveMax = context.maxAttemptsOverride !== undefined
      ? Math.min(context.maxAttemptsOverride, this.config.maxAttempts)
      : this.config.maxAttempts;

    for (let attempt = 1; attempt <= effectiveMax; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;

        // Never retry non-ProviderErrors (programming errors, budget errors, etc.)
        if (!(err instanceof ProviderError)) {
          throw err;
        }

        // Non-retryable provider error (4xx, bad key, etc.) — fail immediately
        if (!err.isRetryable) {
          this.logger.warn("non_retryable_provider_error", "Non-retryable provider error — aborting", {
            metadata: {
              callId:   context.callId,
              provider: context.provider,
              code:     err.code,
              message:  err.message,
            },
          });
          throw err;
        }

        // Last attempt — throw without scheduling another delay
        if (attempt === effectiveMax) {
          this.logger.warn("retry_attempts_exhausted", "All retry attempts exhausted", {
            metadata: {
              callId:   context.callId,
              provider: context.provider,
              attempts: effectiveMax,
              code:     err.code,
            },
          });
          break;
        }

        // Retryable error — log and wait
        const jitteredDelay = applyJitter(delayMs);
        this.logger.warn("retryable_error", `Retryable error — retrying in ${jitteredDelay}ms`, {
          metadata: {
            callId:     context.callId,
            provider:   context.provider,
            attempt,
            maxAttempts: this.config.maxAttempts,
            code:        err.code,
            nextDelayMs: jitteredDelay,
          },
        });

        await sleep(jitteredDelay);
        delayMs = Math.min(delayMs * this.config.backoffMultiplier, this.config.maxDelayMs);
      }
    }

    throw lastError;
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply ±10% random jitter to a delay to reduce request synchronisation.
 */
function applyJitter(ms: number): number {
  const jitterFactor = 0.9 + Math.random() * 0.2; // 0.9 – 1.1
  return Math.ceil(ms * jitterFactor);
}


/**
 * Sensible defaults for production use.
 * initialDelayMs=1000 gives delays of ~1s, ~2s, ~4s on a 3-attempt config.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts:      3,
  initialDelayMs:   1_000,
  maxDelayMs:       30_000,
  backoffMultiplier: 2,
};

/**
 * Fast retry config for integration tests — minimal delays.
 */
export const TEST_RETRY_CONFIG: RetryConfig = {
  maxAttempts:      3,
  initialDelayMs:   10,
  maxDelayMs:       100,
  backoffMultiplier: 2,
};
