// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { registerWebhookRoutes } from "../../src/api/routes/webhook-routes.js";
import { WebhookTokenStore } from "../../src/core/webhook/webhook-token-store.js";
import { generateWebhookToken, hashToken } from "../../src/core/webhook/webhook-auth.js";
import { clearWebhookRateLimitState } from "../../src/core/webhook/webhook-rate-limiter.js";
import { createErrorHandler } from "../../src/api/middleware/error-handler.js";

// ── Mock ExecutionBridge so we don't need a full orchestrator ───────────────
vi.mock("../../src/orchestrator/execution-bridge.js", () => ({
  ExecutionBridge: class {
    async submitTask() {
      return { task_id: "mock-task-uuid", status: "CREATED" };
    }
  },
}));

// Mock TaskEventBus
vi.mock("../../src/tasks/event-bus.js", () => ({
  TaskEventBus: class {},
}));


function makeApp(db: InstanceType<typeof Database>): Hono {
  const app   = new Hono();
  app.onError(createErrorHandler(false));
  const tokenStore = new WebhookTokenStore(db);
  registerWebhookRoutes(app, { db, webhookTokenStore: tokenStore });
  return app;
}

describe("POST /api/v1/webhook/:agentId", () => {
  let db: InstanceType<typeof Database>;
  let store: WebhookTokenStore;
  let app: Hono;
  let rawToken: string;

  beforeEach(() => {
    clearWebhookRateLimitState();
    db    = new Database(":memory:");
    store = new WebhookTokenStore(db);
    app   = makeApp(db);

    rawToken = generateWebhookToken();
    store.save({
      id:         "tok-test",
      agent_id:   "agent-alpha",
      source:     "*",
      token_hash: hashToken(rawToken),
      label:      "test token",
      enabled:    true,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("returns 401 when X-Sidjua-Token header is missing", async () => {
    const res = await app.request(
      "/api/v1/webhook/agent-alpha",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "test" }) },
    );
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("AUTH-004");
  });

  it("returns 401 for wrong token", async () => {
    const res = await app.request(
      "/api/v1/webhook/agent-alpha",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-Sidjua-Token": "wrong-token" },
        body:    JSON.stringify({ event: "test" }),
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for non-object JSON payload", async () => {
    const res = await app.request(
      "/api/v1/webhook/agent-alpha",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-Sidjua-Token": rawToken },
        body:    JSON.stringify([1, 2, 3]),
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("WEBHOOK-003");
  });

  it("returns 202 Accepted with valid token and payload", async () => {
    const res = await app.request(
      "/api/v1/webhook/agent-alpha",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-Sidjua-Token": rawToken },
        body:    JSON.stringify({ title: "Deploy complete", status: "ok" }),
      },
    );
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body["task_id"]).toBe("string");
    expect(body["source"]).toBe("generic");
  });

  it("returns 401 for unknown agent with no tokens configured", async () => {
    const res = await app.request(
      "/api/v1/webhook/unknown-agent",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-Sidjua-Token": rawToken },
        body:    JSON.stringify({ event: "test" }),
      },
    );
    expect(res.status).toBe(401);
  });
});
