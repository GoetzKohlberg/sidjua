// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { WebhookTokenStore } from "../../../src/core/webhook/webhook-token-store.js";
import { hashToken } from "../../../src/core/webhook/webhook-auth.js";

function makeDb(): InstanceType<typeof Database> {
  return new Database(":memory:");
}

describe("WebhookTokenStore", () => {
  let db: InstanceType<typeof Database>;
  let store: WebhookTokenStore;

  beforeEach(() => {
    db    = makeDb();
    store = new WebhookTokenStore(db);
  });

  it("saves and retrieves a token by agent ID", () => {
    const hash = hashToken("my-raw-token");
    store.save({
      id:         "tok-001",
      agent_id:   "agent-alpha",
      source:     "*",
      token_hash: hash,
      label:      "test",
      enabled:    true,
      created_at: new Date().toISOString(),
    });

    const tokens = store.findByAgent("agent-alpha");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.id).toBe("tok-001");
    expect(tokens[0]!.token_hash).toBe(hash);
    expect(tokens[0]!.enabled).toBe(true);
  });

  it("findByAgent returns only enabled tokens", () => {
    const now = new Date().toISOString();
    store.save({ id: "tok-a", agent_id: "agent-1", source: "*", token_hash: hashToken("a"), label: "", enabled: true,  created_at: now });
    store.save({ id: "tok-b", agent_id: "agent-1", source: "*", token_hash: hashToken("b"), label: "", enabled: false, created_at: now });

    // Persist disabled manually (save() only inserts enabled=1 default; use disable() to set 0)
    store.disable("tok-b");

    const tokens = store.findByAgent("agent-1");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.id).toBe("tok-a");
  });

  it("revoke hard-deletes the token", () => {
    store.save({ id: "tok-x", agent_id: "agent-2", source: "*", token_hash: hashToken("x"), label: "", enabled: true, created_at: new Date().toISOString() });

    const removed = store.revoke("tok-x");
    expect(removed).toBe(true);

    expect(store.findByAgent("agent-2")).toHaveLength(0);
  });

  it("updateLastUsed records the timestamp", () => {
    const now = new Date().toISOString();
    store.save({ id: "tok-y", agent_id: "agent-3", source: "*", token_hash: hashToken("y"), label: "", enabled: true, created_at: now });

    const ts = "2026-04-04T00:00:00.000Z";
    store.updateLastUsed("tok-y", ts);

    const token = store.getById("tok-y");
    expect(token).not.toBeNull();
    expect(token!.last_used).toBe(ts);
  });

  it("listAll returns all tokens across agents", () => {
    const now = new Date().toISOString();
    store.save({ id: "t1", agent_id: "a1", source: "*", token_hash: hashToken("t1"), label: "", enabled: true, created_at: now });
    store.save({ id: "t2", agent_id: "a2", source: "github", token_hash: hashToken("t2"), label: "ci", enabled: true, created_at: now });

    const all = store.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });
});
