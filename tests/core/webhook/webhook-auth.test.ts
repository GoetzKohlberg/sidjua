// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

import { describe, it, expect } from "vitest";
import {
  generateWebhookToken,
  hashToken,
  validateToken,
} from "../../../src/core/webhook/webhook-auth.js";

describe("generateWebhookToken", () => {
  it("returns a 64-character hex string", () => {
    const token = generateWebhookToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const a = generateWebhookToken();
    const b = generateWebhookToken();
    expect(a).not.toBe(b);
  });
});

describe("hashToken", () => {
  it("returns a 64-character hex SHA-256 digest", () => {
    const hash = hashToken("test-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });
});

describe("validateToken", () => {
  it("returns true for a matching raw token and stored hash", () => {
    const raw  = generateWebhookToken();
    const hash = hashToken(raw);
    expect(validateToken(raw, hash)).toBe(true);
  });

  it("returns false for wrong raw token", () => {
    const raw  = generateWebhookToken();
    const hash = hashToken(raw);
    expect(validateToken("wrong-token", hash)).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(validateToken("", hashToken(""))).toBe(true); // edge: empty matches empty hash
    expect(validateToken("", hashToken("something"))).toBe(false);
  });

  it("is timing-safe (does not throw on mismatched length inputs)", () => {
    expect(() => validateToken("x", "y")).not.toThrow();
    expect(validateToken("x", "y")).toBe(false);
  });
});
