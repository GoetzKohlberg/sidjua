// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P378: Webhook Token Auth Primitives
 *
 * Stateless helpers for generating, hashing, and validating webhook tokens.
 * Raw tokens are never stored — only the SHA-256 hex digest is persisted.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";


/** Length of the raw hex token (32 bytes → 64 hex chars). */
const TOKEN_BYTES = 32;

/**
 * Generate a new cryptographically random webhook token.
 * Returns a 64-character hex string (256 bits of entropy).
 */
export function generateWebhookToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * Hash a raw token for storage.
 * Returns a lowercase hex SHA-256 digest.
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Validate a raw token against a stored hash.
 * Uses timing-safe comparison to prevent timing attacks.
 * Returns true when the raw token matches the stored hash.
 */
export function validateToken(raw: string, storedHash: string): boolean {
  try {
    const candidate = Buffer.from(createHash("sha256").update(raw).digest("hex"));
    const expected  = Buffer.from(storedHash);
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch (_err) {
    return false;
  }
}
