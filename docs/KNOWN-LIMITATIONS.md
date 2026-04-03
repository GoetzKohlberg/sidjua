# Known Limitations (v1.0.1)

This document lists intentional constraints, deferred features, and design
trade-offs that are acknowledged but not fixed in the current release.
Each entry includes a mitigation strategy and the planned fix version.

---

## Single API Key Authentication

The REST API previously used a single shared API key for all clients.

**Impact:**
- All API consumers shared the same authentication token.
- Audit logs recorded actions but could not attribute them to specific users or services.
- Key compromise required rotating the single key for every consumer simultaneously.

**Mitigation:** Deploy the API behind a reverse proxy (nginx, Caddy, Traefik) that
provides per-client authentication, rate limiting, and audit logging before
requests reach SIDJUA.

**Resolved:** Scoped API tokens with RBAC (admin/operator/agent/readonly) are available
via `sidjua api-key generate --scope <scope>`. Per-client tokens with division and agent
scoping are supported. See the REST API documentation for details.

**Status: Resolved in V1.0.1**

---

## In-Process Rate Limiter

The HTTP rate limiter previously stored token buckets in process memory only.

**Impact:**
- Limits did not persist across restarts.
- In a multi-process deployment each process maintained an independent counter,
  allowing clients to exceed the intended rate by spawning concurrent connections.

**Mitigation:** Run a single API server process behind a load balancer. Use the
reverse proxy layer for cluster-wide rate limiting.

**Resolved:** Rate limiter state is now persisted to SQLite and restored on restart.
Single-process operation remains the recommended deployment model.

**Status: Resolved in V1.0.1**

---

## Log Tailing Uses Polling

`sidjua logs --follow` polls the database every 2 seconds (5 seconds when idle)
rather than using a push-based mechanism.

**Impact:**
- Slight delay (up to 5 seconds) before new log entries appear in follow mode.
- Unnecessary DB reads during quiet periods, even with adaptive backoff.

**Mitigation:** Acceptable for operational log tailing. For real-time event
streaming, use the SSE endpoint at `GET /api/v1/events`.

**Partially resolved:** Server-side SSE is available at `GET /api/v1/events` and used
by the Management Console for real-time updates. The CLI `sidjua logs --follow` command
still uses adaptive polling (2s/5s). CLI migration to SSE is tracked internally.

**Status: Partially Resolved**

---

## SQLite Single-Writer Concurrency

SIDJUA uses SQLite in WAL mode, which supports concurrent reads but serialises
writes. Under high task throughput, write-heavy operations may queue.

**Impact:** May cause latency spikes when many agents submit results simultaneously.

**Mitigation:** Tune `busy_timeout`; the default is 30 seconds, which handles
typical bursts. For throughput beyond ~100 concurrent agents, consider sharding
by division.

**Planned fix:** PostgreSQL adapter in V2.0 Enterprise.
