// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

import { describe, it, expect } from "vitest";
import {
  normalizeWebhookPayload,
  extractSafeFields,
} from "../../../src/core/webhook/webhook-adapter.js";

describe("extractSafeFields", () => {
  it("passes through string, number, and boolean values", () => {
    const fields = extractSafeFields({ name: "test", count: 42, active: true });
    expect(fields).toEqual({ name: "test", count: "42", active: "true" });
  });

  it("drops nested objects and arrays", () => {
    const fields = extractSafeFields({ ok: "yes", obj: { nested: "x" }, arr: [1, 2] });
    expect(fields).toEqual({ ok: "yes" });
  });

  it("returns empty object for empty input", () => {
    expect(extractSafeFields({})).toEqual({});
  });
});

describe("normalizeWebhookPayload — github", () => {
  it("detects GitHub payload by action + repository keys", () => {
    const payload = {
      action:     "opened",
      repository: { full_name: "org/repo" },
      sender:     { login: "alice" },
    };
    const result = normalizeWebhookPayload(payload);
    expect(result.source).toBe("github");
    expect(result.title).toContain("opened");
    expect(result.title).toContain("org/repo");
    expect(result.description).toContain("alice");
  });

  it("uses explicit source override", () => {
    const result = normalizeWebhookPayload({ action: "push", repository: {} }, "github");
    expect(result.source).toBe("github");
  });
});

describe("normalizeWebhookPayload — grafana", () => {
  it("detects Grafana payload by ruleName key", () => {
    const payload = { ruleName: "HighCPU", state: "alerting" };
    const result = normalizeWebhookPayload(payload);
    expect(result.source).toBe("grafana");
    expect(result.title).toContain("HighCPU");
    expect(result.description).toContain("alerting");
  });
});

describe("normalizeWebhookPayload — generic", () => {
  it("uses 'title' field when present", () => {
    const result = normalizeWebhookPayload({ title: "Deploy failed", status: "error" });
    expect(result.source).toBe("generic");
    expect(result.title).toBe("Deploy failed");
  });

  it("falls back to 'Webhook event' when no known title field", () => {
    const result = normalizeWebhookPayload({ foo: "bar" });
    expect(result.title).toBe("Webhook event");
  });

  it("includes scalar fields in description", () => {
    const result = normalizeWebhookPayload({ status: "ok", count: 5 });
    expect(result.description).toContain("status: ok");
    expect(result.description).toContain("count: 5");
  });
});
