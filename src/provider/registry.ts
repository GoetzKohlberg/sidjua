// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Provider Layer: Provider Registry
 *
 * The ProviderRegistry is the single entry point for all LLM calls.
 * It orchestrates:
 *   1. Budget enforcement (pre-call, via CostTracker)
 *   2. Provider selection + retry (via RetryHandler)
 *   3. Failover to secondary provider on exhausted retries
 *   4. Cost recording (post-call, via CostTracker)
 *   5. Full audit logging (always, via ProviderAuditLogger)
 *   6. Event emission (via EventBus)
 *
 * Hot-Swap:
 *   Callers can specify an explicit provider per call via options.provider.
 *   This enables agents to switch providers mid-task without registry re-init.
 *
 * API keys:
 *   Providers are passed in already-initialised. Key retrieval from Secrets
 *   is done by the factory functions in adapters/anthropic.ts and openai.ts.
 *   The registry never sees plaintext keys.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../utils/db.js";
import { createLogger, type Logger } from "../core/logger.js";
import { reportError } from "../core/telemetry/telemetry-reporter.js";
import { MAX_TOTAL_PROVIDER_RETRIES } from "../core/constants.js";
import type {
  EventBus,
  LLMProvider,
  ProviderCallInput,
  ProviderCallRequest,
  ProviderCallResponse,
  ProviderName,
  RegistryConfig,
} from "../types/provider.js";
import { BudgetExceededError, NoOpEventBus } from "../types/provider.js";
import { CostTracker } from "./cost-tracker.js";
import { ProviderAuditLogger } from "./audit-logger.js";
import { RetryHandler } from "./retry-handler.js";
import { estimateCallCost } from "./token-counter.js";


/**
 * Unified LLM provider registry. Register providers, then call() for every LLM request.
 *
 * @example
 * const registry = new ProviderRegistry(config, [anthropicProvider], db, logger, eventBus);
 * const response = await registry.call({
 *   agentId: "agent-1",
 *   divisionCode: "engineering",
 *   provider: "anthropic",
 *   model: "claude-sonnet-4-6",
 *   messages: [{ role: "user", content: "Hello!" }],
 * });
 */
export class ProviderRegistry {
  private readonly providers: Map<ProviderName, LLMProvider>;
  private readonly costTracker: CostTracker;
  private readonly auditLogger: ProviderAuditLogger;
  private readonly retryHandler: RetryHandler;

  constructor(
    private readonly config: RegistryConfig,
    providers: LLMProvider[],
    db: Database,
    private readonly logger: Logger = createLogger("provider-registry"),
    private readonly eventBus: EventBus = new NoOpEventBus(),
  ) {
    if (providers.length === 0) {
      throw new Error("ProviderRegistry requires at least one provider");
    }

    this.providers     = new Map(providers.map((p) => [p.name, p]));
    this.costTracker   = new CostTracker(db);
    this.auditLogger   = new ProviderAuditLogger(db);
    this.retryHandler  = new RetryHandler(config.retry, logger);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Execute an LLM call.
   *
   * Flow:
   *   1. Assign callId (UUID).
   *   2. Resolve provider (options.provider → config.defaultProvider).
   *   3. Pre-call budget check — throw BudgetExceededError if denied.
   *   4. Call provider with retry (+ failover on exhausted retries).
   *   5. Record cost to cost_ledger.
   *   6. Write full audit log to provider_calls + provider_call_content.
   *   7. Emit provider.call.complete event.
   *
   * @param input - Call parameters (without callId).
   * @param options - Per-call overrides: explicit provider for hot-swap.
   */
  async call(
    input: ProviderCallInput,
    options?: { provider?: ProviderName },
  ): Promise<ProviderCallResponse> {
    const callId       = randomUUID();
    const providerName = options?.provider ?? this.config.defaultProvider;
    const provider     = this.resolveProvider(providerName);

    const request: ProviderCallRequest = { ...input, callId };

    // 1. Pre-call budget check + atomic reservation
    let reservationId = this.checkBudgetAndReserve(request, provider, providerName);

    // 2. Call with retry + failover
    const start = Date.now();
    let response: ProviderCallResponse;

    // xAI-ARCH-H3: track primary attempt count to cap total retries
    let primaryAttempts = 0;

    try {
      response = await this.retryHandler.withRetry(
        () => { primaryAttempts++; return provider.call(request); },
        { provider: providerName, callId },
      );
    } catch (primaryErr) {
      // Cancel reservation so the estimated cost doesn't permanently
      // inflate the division's spend when the call ultimately fails.
      if (reservationId !== null) {
        this.costTracker.cancelReservation(reservationId);
        reservationId = null;
      }

      // Attempt failover if configured and this wasn't already a failover call
      const fallback = this.config.fallbackProvider;
      if (fallback !== undefined && fallback !== providerName) {
        // Remaining attempts = cap - primary attempts (min 1 so failover always tries once)
        const remainingAttempts = Math.max(1, MAX_TOTAL_PROVIDER_RETRIES - primaryAttempts);
        response = await this.callWithFailover(request, fallback, primaryErr, start, remainingAttempts);
      } else {
        // Log the failed call before re-throwing
        const latencyMs = Date.now() - start;
        this.auditLogger.logError(request, primaryErr instanceof Error ? primaryErr : new Error(String(primaryErr)), latencyMs);
        throw primaryErr;
      }
    }

    // 3. Record cost: finalize reservation (happy path) or direct insert (failover path)
    if (reservationId !== null) {
      try {
        this.costTracker.finalizeReservation(
          reservationId,
          response.provider,
          response.model,
          response.usage,
          response.costUsd,
        );
      } catch (finalizeErr) {
        // Fallback: cancel the reservation then record cost directly.
        // If cancelReservation throws (e.g. DB error), skip recordCost to
        // prevent double-counting (the reservation row may still exist).
        const errMsg = finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr);
        let cancelOk = true;
        try {
          this.costTracker.cancelReservation(reservationId);
        } catch (cancelErr) {
          cancelOk = false;
          const cancelMsg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
          this.logger.warn("cancel_reservation_failed", "cancelReservation failed — skipping recordCost to prevent double-count", {
            metadata: { callId, cancelError: cancelMsg, finalizeError: errMsg },
          });
        }
        if (cancelOk) {
          this.costTracker.recordCost(
            request.divisionCode,
            request.agentId,
            response.provider,
            response.model,
            response.usage,
            response.costUsd,
            request.taskId,
          );
          this.logger.warn("finalize_reservation_failed", "finalizeReservation failed — cost recorded via fallback", {
            metadata: { callId, error: errMsg },
          });
        }
      }
    } else {
      this.costTracker.recordCost(
        request.divisionCode,
        request.agentId,
        response.provider,
        response.model,
        response.usage,
        response.costUsd,
        request.taskId,
      );
    }

    // 4. Audit log (full request + response)
    this.auditLogger.logCall(request, response);

    // 5. Events
    this.eventBus.emit("provider.call.complete", {
      callId:       response.callId,
      provider:     response.provider,
      model:        response.model,
      divisionCode: request.divisionCode,
      costUsd:      response.costUsd,
      latencyMs:    response.latencyMs,
    });

    this.logger.info("provider_call_complete", "Provider call complete", {
      metadata: {
        callId,
        provider: response.provider,
        model:    response.model,
        tokens:   response.usage.totalTokens,
        costUsd:  response.costUsd,
      },
    });

    return response;
  }

  /**
   * Retrieve a registered provider by name.
   * Throws if the provider is not registered.
   */
  getProvider(name: ProviderName): LLMProvider {
    return this.resolveProvider(name);
  }

  /** Return the default provider. */
  getDefaultProvider(): LLMProvider {
    return this.resolveProvider(this.config.defaultProvider);
  }

  /** Return all registered provider names. */
  registeredProviders(): ProviderName[] {
    return [...this.providers.keys()];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveProvider(name: ProviderName): LLMProvider {
    const provider = this.providers.get(name);
    if (provider === undefined) {
      throw new Error(`Provider "${name}" is not registered. Registered: ${[...this.providers.keys()].join(", ")}`);
    }
    return provider;
  }

  /**
   * Atomically check budget + reserve estimated cost.
   * Returns the reservation row id (passed to finalizeReservation/cancelReservation),
   * or null when no budget is configured and no reservation was needed.
   * Throws BudgetExceededError when the limit would be exceeded.
   */
  private checkBudgetAndReserve(
    request:      ProviderCallRequest,
    provider:     LLMProvider,
    providerName: ProviderName,
  ): number | null {
    const { estimatedCostUsd } = estimateCallCost(
      request.messages,
      request.model,
      request.systemPrompt,
    );

    const { result: budgetResult, reservationId } = this.costTracker.atomicCheckAndReserve(
      request.divisionCode,
      request.agentId,
      providerName,
      request.model,
      estimatedCostUsd,
      request.taskId,
    );

    if (!budgetResult.allowed) {
      this.logger.warn("call_blocked_budget", "Call blocked by budget enforcement", {
        metadata: {
          callId:       request.callId,
          divisionCode: request.divisionCode,
          reason:       budgetResult.reason,
        },
      });

      // Determine which period was exceeded for the error
      const period: "daily" | "monthly" =
        budgetResult.dailyLimitUsd !== null &&
        budgetResult.currentDailyUsd + estimatedCostUsd > budgetResult.dailyLimitUsd
          ? "daily"
          : "monthly";

      const limit   = period === "daily" ? budgetResult.dailyLimitUsd  : budgetResult.monthlyLimitUsd;
      const current = period === "daily" ? budgetResult.currentDailyUsd : budgetResult.currentMonthlyUsd;

      throw new BudgetExceededError(
        request.divisionCode,
        period,
        limit ?? 0,
        current,
        estimatedCostUsd,
      );
    }

    if (budgetResult.nearLimit) {
      this.logger.warn("budget_near_limit", "Budget near limit", {
        metadata: {
          callId:            request.callId,
          divisionCode:      request.divisionCode,
          currentDailyUsd:   budgetResult.currentDailyUsd,
          currentMonthlyUsd: budgetResult.currentMonthlyUsd,
          dailyLimitUsd:     budgetResult.dailyLimitUsd,
          monthlyLimitUsd:   budgetResult.monthlyLimitUsd,
          threshold:         budgetResult.alertThresholdPercent,
        },
      });

      this.eventBus.emit("budget.near_limit", {
        divisionCode:          request.divisionCode,
        currentDailyUsd:       budgetResult.currentDailyUsd,
        currentMonthlyUsd:     budgetResult.currentMonthlyUsd,
        dailyLimitUsd:         budgetResult.dailyLimitUsd,
        monthlyLimitUsd:       budgetResult.monthlyLimitUsd,
        alertThresholdPercent: budgetResult.alertThresholdPercent,
      });
    }

    // Suppress unused variable warning — provider is used for estimateTokens in the future
    void provider;
    return reservationId;
  }

  private async callWithFailover(
    request: ProviderCallRequest,
    fallbackName: ProviderName,
    primaryErr: unknown,
    startTime: number,
    maxAttempts?: number,  // xAI-ARCH-H3: capped remaining attempts
  ): Promise<ProviderCallResponse> {
    this.logger.warn("provider_failover", "Primary provider failed — attempting failover", {
      metadata: {
        callId:           request.callId,
        primaryProvider:  request.provider,
        fallbackProvider: fallbackName,
        primaryError:     primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        maxAttempts,
      },
    });

    this.eventBus.emit("provider.failover", {
      callId:           request.callId,
      primaryProvider:  request.provider,
      fallbackProvider: fallbackName,
    });

    const fallback = this.resolveProvider(fallbackName);
    const failoverRequest: ProviderCallRequest = { ...request, provider: fallbackName };

    // Budget check for the failover call: the primary reservation was already
    // cancelled above, so we must create a new one for the fallback provider.
    // Without this check, a failover call could bypass division budget limits.
    let failoverReservationId: number | null = null;
    try {
      failoverReservationId = this.checkBudgetAndReserve(failoverRequest, fallback, fallbackName);
    } catch (budgetErr) {
      // Failover blocked by budget — log and re-throw the original primary error
      this.logger.warn("failover_budget_blocked", "Failover call blocked by budget enforcement", {
        metadata: { callId: request.callId, fallbackProvider: fallbackName },
      });
      throw budgetErr;
    }

    try {
      const failoverResponse = await this.retryHandler.withRetry(
        () => fallback.call(failoverRequest),
        {
          provider: fallbackName,
          callId:   request.callId,
          ...(maxAttempts !== undefined ? { maxAttemptsOverride: maxAttempts } : {}),  // xAI-ARCH-H3
        },
      );
      // Finalize the failover reservation
      if (failoverReservationId !== null) {
        try {
          this.costTracker.finalizeReservation(
            failoverReservationId,
            failoverResponse.provider,
            failoverResponse.model,
            failoverResponse.usage,
            failoverResponse.costUsd,
          );
        } catch (finalizeErr) {
          try { this.costTracker.cancelReservation(failoverReservationId); } catch (_err) { /* best-effort */ }
          this.costTracker.recordCost(
            request.divisionCode, request.agentId,
            failoverResponse.provider, failoverResponse.model,
            failoverResponse.usage, failoverResponse.costUsd, request.taskId,
          );
        }
      }
      return failoverResponse;
    } catch (fallbackErr) {
      // Both primary and fallback failed — cancel failover reservation and log
      if (failoverReservationId !== null) {
        try { this.costTracker.cancelReservation(failoverReservationId); } catch (_err) { /* best-effort */ }
      }
      const latencyMs = Date.now() - startTime;
      const fallbackError = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
      this.auditLogger.logError(request, fallbackError, latencyMs);
      reportError(fallbackError, 'high');
      throw fallbackErr;
    }
  }
}
