// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

export { generateWebhookToken, hashToken, validateToken } from "./webhook-auth.js";
export { WebhookTokenStore }                               from "./webhook-token-store.js";
export type { WebhookToken }                               from "./webhook-token-store.js";
export { normalizeWebhookPayload, extractSafeFields }      from "./webhook-adapter.js";
export type { NormalizedWebhookPayload, WebhookSource }    from "./webhook-adapter.js";
export {
  webhookRateLimitCheck,
  clearWebhookRateLimitState,
  WEBHOOK_RATE_LIMIT,
  WEBHOOK_RATE_WINDOW_MS,
} from "./webhook-rate-limiter.js";
