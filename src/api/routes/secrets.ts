// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11b+: Secrets REST Endpoints
 *
 * Namespace-level authorization (IDOR fix)
 *   Previously all callers with a valid API key could access any namespace.
 *   Now an optional CallerContext narrows access to the caller's own division
 *   namespace (plus "global"). Operators retain full access.
 *
 * Endpoints:
 *   GET  /api/v1/secrets/namespaces
 *   GET  /api/v1/secrets/keys?ns=<namespace>
 *   GET  /api/v1/secrets/value?ns=<namespace>&key=<key>
 *   PUT  /api/v1/secrets/value               body: { ns, key, value }
 *   DELETE /api/v1/secrets/value?ns=<namespace>&key=<key>
 *   GET  /api/v1/secrets/info?ns=<namespace>&key=<key>
 *   POST /api/v1/secrets/rotate              body: { ns, key, value }
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import Database               from "better-sqlite3";
import type { SecretsProvider } from "../../types/apply.js";
import { createLogger } from "../../core/logger.js";
import { hasTable }     from "../../core/db/helpers.js";
import type { CallerContext } from "../caller-context.js";
import { requireScope, CALLER_CONTEXT_KEY } from "../middleware/require-scope.js";

// Re-export for backward compatibility — existing imports from this module still work.
export type { CallerContext };

const logger = createLogger("api-secrets");


export interface SecretAuditEvent {
  op:       string;               // "read" | "write" | "delete" | "rotate" | "list" | "info"
  ns:       string;
  key?:     string;
  agentId?: string;
  division?: string;
  role?:    string;
  outcome:  "allowed" | "denied";
  timestamp: string;
}

/** In-memory audit log — for tests; cleared by clearSecretAuditLog(). */
export const _secretAuditEvents: SecretAuditEvent[] = [];

/** Return a copy of the audit log. */
export function getSecretAuditLog(): SecretAuditEvent[] {
  return [..._secretAuditEvents];
}

/** Clear the audit log (call in test beforeEach). */
export function clearSecretAuditLog(): void {
  _secretAuditEvents.length = 0;
}


/**
 * Returns true if the caller has operator-level (unrestricted) access.
 *
 * SECURITY: Requires an explicit `role: "operator"` field.
 * Previously, an empty CallerContext `{}` (role === undefined) was granted
 * operator access, allowing any authenticated API caller without a scoped
 * CallerContext to read secrets from any division namespace — a classic IDOR.
 *
 * The fix: CallerContext MUST be set per-request by the auth middleware.
 * A missing context is denied at the `requireCallerCtx` guard in registerSecretRoutes.
 * There is no static fallback — fail-closed (Rule #12).
 */
function isOperator(ctx: CallerContext): boolean {
  return ctx.role === "operator" || ctx.role === "admin";
}

/**
 * Returns true if the caller is allowed to READ from the given namespace.
 *
 * Division-scoped agents may only read from "global" or their own
 * "divisions/<division>" namespace.
 */
export function authorizeSecretAccess(ns: string, ctx: CallerContext): boolean {
  if (isOperator(ctx)) return true;
  if (ns === "global") return true;
  if (ctx.division !== undefined && ns === `divisions/${ctx.division}`) return true;
  return false;
}

/**
 * Returns true if the caller is allowed to WRITE to the given namespace.
 *
 * Division-scoped agents may only write to their own "divisions/<division>"
 * namespace.  Writing to "global" is restricted to operators (it is a shared
 * namespace that all agents can read).
 */
export function authorizeSecretWrite(ns: string, ctx: CallerContext): boolean {
  if (isOperator(ctx)) return true;
  if (ctx.division !== undefined && ns === `divisions/${ctx.division}`) return true;
  return false;
}


function auditSecretOperation(
  op:      string,
  ns:      string,
  key:     string | undefined,
  ctx:     CallerContext,
  outcome: "allowed" | "denied",
): void {
  const event: SecretAuditEvent = {
    op,
    ns,
    ...(key            !== undefined && { key }),
    ...(ctx.agentId    !== undefined && { agentId:  ctx.agentId }),
    ...(ctx.division   !== undefined && { division: ctx.division }),
    ...(ctx.role       !== undefined && { role:     ctx.role }),
    outcome,
    timestamp: new Date().toISOString(),
  };
  _secretAuditEvents.push(event);

  if (outcome === "denied") {
    logger.warn("secret_access_denied", `Secret ${op} denied for ns=${ns}`, {
      metadata: { op, ns, key, agentId: ctx.agentId, division: ctx.division, role: ctx.role },
    });
  } else {
    logger.info("secret_audit", `Secret ${op} allowed for ns=${ns}`, {
      metadata: { op, ns, key, agentId: ctx.agentId, division: ctx.division, role: ctx.role },
    });
  }
}


export interface SecretRouteServices {
  /** Pre-initialised secrets provider (SqliteSecretsProvider) */
  provider: SecretsProvider;
  /**
   * Direct connection to secrets.db — used only for the namespaces endpoint
   * (SELECT DISTINCT namespace) which isn't in the SecretsProvider interface.
   */
  secretsDb: InstanceType<typeof Database>;
}


/**
 * Namespace names: letters, digits, underscores, hyphens, forward slashes
 * (for "divisions/<name>" pattern). Max 128 chars. Must start with letter/digit.
 */
const NS_RE = /^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,127}$/;

/**
 * Key names: letters, digits, underscores, hyphens, dots. No slashes.
 * Max 128 chars.
 */
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;


export function registerSecretRoutes(app: Hono, services: SecretRouteServices): void {
  const { provider, secretsDb } = services;

  // Ensure the secret audit table exists and has the operation column.
  // Writes to this table are fail-closed for reveal, best-effort for other ops.
  try {
    secretsDb.exec(`
      CREATE TABLE IF NOT EXISTS secret_reveal_audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        operation   TEXT NOT NULL DEFAULT 'reveal',
        ns          TEXT NOT NULL,
        key         TEXT NOT NULL DEFAULT '',
        agent_id    TEXT,
        division    TEXT,
        role        TEXT,
        revealed_at TEXT NOT NULL
      )
    `);
    // Migrate existing installations: add operation column if missing
    try {
      secretsDb.exec("ALTER TABLE secret_reveal_audit ADD COLUMN operation TEXT NOT NULL DEFAULT 'reveal'");
    } catch (_migErr) {
      // Column already exists — ignore
    }
  } catch (tableErr) {
    logger.warn("secrets_audit_init", "Could not create secret_reveal_audit table", {
      metadata: { error: tableErr instanceof Error ? tableErr.message : String(tableErr) },
    });
  }

  /**
   * Write one record to the DB audit table.
   * - failClosed=true  → throws on error (for reveals: deny if audit fails)
   * - failClosed=false → best-effort (for list/write/delete: log warning only)
   */
  function writeDbAuditRecord(
    operation: string,
    ns:        string,
    key:       string,
    ctx:       CallerContext,
    failClosed: boolean,
  ): void {
    try {
      secretsDb.prepare(
        `INSERT INTO secret_reveal_audit (operation, ns, key, agent_id, division, role, revealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(operation, ns, key, ctx.agentId ?? null, ctx.division ?? null, ctx.role ?? null, new Date().toISOString());
    } catch (auditErr: unknown) {
      if (failClosed) {
        throw auditErr;
      }
      logger.warn("secret_audit_write_failed", `Best-effort secret audit write failed for ${operation}`, {
        metadata: { operation, ns, key, error: auditErr instanceof Error ? auditErr.message : String(auditErr) },
      });
    }
  }

  // FAIL CLOSED: all secrets routes require a per-request CallerContext set by
  // auth middleware. If the context is absent the request is denied immediately —
  // we never default to operator access (Rule #12).
  const requireCallerCtx: MiddlewareHandler = async (c, next) => {
    if ((c.get(CALLER_CONTEXT_KEY) as CallerContext | undefined) === undefined) {
      logger.warn(
        "secrets_no_context",
        "Secret route accessed without CallerContext — denying",
        {},
      );
      return c.json(
        { error: { code: "SEC-403", message: "Authentication required" } },
        403,
      );
    }
    return next();
  };
  app.use("/api/v1/secrets/*", requireCallerCtx);

  // Return the per-request CallerContext. Safe after the guard above.
  function getCtx(c: import("hono").Context): CallerContext {
    return c.get(CALLER_CONTEXT_KEY) as CallerContext;
  }

  // ---- GET /api/v1/secrets/namespaces -------------------------------------
  // Namespace listing is scoped: operators/admins see all namespaces; division-scoped
  // callers see only "global" and their own "divisions/<division>" namespace.

  app.get("/api/v1/secrets/namespaces", requireScope("readonly"), (c) => {
    if (!hasTable(secretsDb, "secrets")) {
      logger.info("secrets_table_missing", "secrets table not yet created — run sidjua apply", {});
      return c.json({ namespaces: [] });
    }
    const rows = secretsDb
      .prepare<[], { namespace: string }>(
        "SELECT DISTINCT namespace FROM secrets ORDER BY namespace",
      )
      .all() as { namespace: string }[];
    const ctx        = getCtx(c);
    const namespaces = rows
      .map((r) => r.namespace)
      .filter((ns) => authorizeSecretAccess(ns, ctx));
    return c.json({ namespaces });
  });

  // ---- GET /api/v1/secrets/keys?ns=<namespace> ----------------------------

  app.get("/api/v1/secrets/keys", requireScope("readonly"), async (c) => {
    const ns = c.req.query("ns");
    if (!ns) {
      return c.json({ error: { code: "SEC-400", message: "Missing query param: ns" } }, 400);
    }
    if (!NS_RE.test(ns)) {
      return c.json({ error: { code: "INPUT-001", message: "Invalid namespace format" } }, 400);
    }
    if (!authorizeSecretAccess(ns, getCtx(c))) {
      auditSecretOperation("list", ns, undefined, getCtx(c), "denied");
      return c.json({ error: { code: "SEC-403", message: `Access denied to namespace: ${ns}` } }, 403);
    }
    auditSecretOperation("list", ns, undefined, getCtx(c), "allowed");
    writeDbAuditRecord("list", ns, "", getCtx(c), false);
    const keys = await provider.list(ns);
    return c.json({ namespace: ns, keys });
  });

  // ---- GET /api/v1/secrets/value?ns=<namespace>&key=<key> -----------------
  // Requires admin scope — reading plaintext secrets is a privileged operation.
  // Readonly callers can list keys (GET /secrets/keys) but not reveal values.

  app.get("/api/v1/secrets/value", requireScope("admin"), async (c) => {
    const ns  = c.req.query("ns");
    const key = c.req.query("key");
    if (!ns || !key) {
      return c.json({ error: { code: "SEC-400", message: "Missing query params: ns, key" } }, 400);
    }
    if (!NS_RE.test(ns))  return c.json({ error: { code: "INPUT-001", message: "Invalid namespace format" } }, 400);
    if (!KEY_RE.test(key)) return c.json({ error: { code: "INPUT-001", message: "Invalid key format" } }, 400);
    if (!authorizeSecretAccess(ns, getCtx(c))) {
      auditSecretOperation("read", ns, key, getCtx(c), "denied");
      return c.json({ error: { code: "SEC-403", message: `Access denied to namespace: ${ns}` } }, 403);
    }
    const value = await provider.get(ns, key);
    if (value === null) {
      auditSecretOperation("read", ns, key, getCtx(c), "allowed");  // allowed but not found
      return c.json(
        { error: { code: "SEC-404", message: `Secret ${ns}/${key} not found` } },
        404,
      );
    }
    // Fail-closed: write a DB-level audit record before revealing the value.
    // If the audit write fails, deny the reveal rather than leak without a trace.
    const ctx = getCtx(c);
    try {
      writeDbAuditRecord("reveal", ns, key, ctx, true);
    } catch (auditErr: unknown) {
      logger.error("secret_reveal_audit_failed", "Cannot write reveal audit — denying secret reveal (fail-closed)", {
        metadata: { ns, key, error: auditErr instanceof Error ? auditErr.message : String(auditErr) },
      });
      return c.json(
        { error: { code: "SEC-503", message: "Cannot reveal secret: audit logging unavailable" } },
        503,
      );
    }
    auditSecretOperation("read", ns, key, ctx, "allowed");
    return c.json({ namespace: ns, key, value });
  });

  // ---- PUT /api/v1/secrets/value   body: { ns, key, value } ---------------

  app.put("/api/v1/secrets/value", requireScope("agent"), async (c) => {
    let body: { ns?: unknown; key?: unknown; value?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch (e: unknown) {
      logger.debug("api-secrets", "Request body JSON parse failed — returning 400", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      return c.json({ error: { code: "SEC-400", message: "Invalid JSON body" } }, 400);
    }
    const { ns, key, value } = body;
    if (typeof ns !== "string" || typeof key !== "string" || typeof value !== "string") {
      return c.json({ error: { code: "SEC-400", message: "Body must have ns, key, value (all strings)" } }, 400);
    }
    if (!NS_RE.test(ns))  return c.json({ error: { code: "INPUT-001", message: "Invalid namespace format" } }, 400);
    if (!KEY_RE.test(key)) return c.json({ error: { code: "INPUT-001", message: "Invalid key format" } }, 400);
    if (!authorizeSecretWrite(ns, getCtx(c))) {
      auditSecretOperation("write", ns, key, getCtx(c), "denied");
      return c.json({ error: { code: "SEC-403", message: `Write access denied to namespace: ${ns}` } }, 403);
    }
    await provider.set(ns, key, value);
    auditSecretOperation("write", ns, key, getCtx(c), "allowed");
    writeDbAuditRecord("write", ns, key, getCtx(c), false);
    return c.json({ ok: true, namespace: ns, key });
  });

  // ---- DELETE /api/v1/secrets/value?ns=<namespace>&key=<key> --------------

  app.delete("/api/v1/secrets/value", requireScope("agent"), async (c) => {
    const ns  = c.req.query("ns");
    const key = c.req.query("key");
    if (!ns || !key) {
      return c.json({ error: { code: "SEC-400", message: "Missing query params: ns, key" } }, 400);
    }
    if (!NS_RE.test(ns))  return c.json({ error: { code: "INPUT-001", message: "Invalid namespace format" } }, 400);
    if (!KEY_RE.test(key)) return c.json({ error: { code: "INPUT-001", message: "Invalid key format" } }, 400);
    if (!authorizeSecretWrite(ns, getCtx(c))) {
      auditSecretOperation("delete", ns, key, getCtx(c), "denied");
      return c.json({ error: { code: "SEC-403", message: `Write access denied to namespace: ${ns}` } }, 403);
    }
    await provider.delete(ns, key);
    auditSecretOperation("delete", ns, key, getCtx(c), "allowed");
    writeDbAuditRecord("delete", ns, key, getCtx(c), false);
    return c.json({ ok: true, namespace: ns, key });
  });

  // ---- GET /api/v1/secrets/info?ns=<namespace>&key=<key> ------------------

  app.get("/api/v1/secrets/info", requireScope("readonly"), async (c) => {
    const ns  = c.req.query("ns");
    const key = c.req.query("key");
    if (!ns || !key) {
      return c.json({ error: { code: "SEC-400", message: "Missing query params: ns, key" } }, 400);
    }
    if (!NS_RE.test(ns))  return c.json({ error: { code: "INPUT-001", message: "Invalid namespace format" } }, 400);
    if (!KEY_RE.test(key)) return c.json({ error: { code: "INPUT-001", message: "Invalid key format" } }, 400);
    if (!authorizeSecretAccess(ns, getCtx(c))) {
      auditSecretOperation("info", ns, key, getCtx(c), "denied");
      return c.json({ error: { code: "SEC-403", message: `Access denied to namespace: ${ns}` } }, 403);
    }
    const meta = await provider.getMetadata(ns, key);
    if (meta === null) {
      auditSecretOperation("info", ns, key, getCtx(c), "allowed");
      return c.json(
        { error: { code: "SEC-404", message: `Secret ${ns}/${key} not found` } },
        404,
      );
    }
    auditSecretOperation("info", ns, key, getCtx(c), "allowed");
    return c.json({ namespace: ns, key, meta });
  });

  // ---- POST /api/v1/secrets/rotate   body: { ns, key, value } -------------

  app.post("/api/v1/secrets/rotate", requireScope("agent"), async (c) => {
    let body: { ns?: unknown; key?: unknown; value?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch (e: unknown) {
      logger.debug("api-secrets", "Request body JSON parse failed — returning 400", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      return c.json({ error: { code: "SEC-400", message: "Invalid JSON body" } }, 400);
    }
    const { ns, key, value } = body;
    if (typeof ns !== "string" || typeof key !== "string" || typeof value !== "string") {
      return c.json({ error: { code: "SEC-400", message: "Body must have ns, key, value (all strings)" } }, 400);
    }
    if (!NS_RE.test(ns))  return c.json({ error: { code: "INPUT-001", message: "Invalid namespace format" } }, 400);
    if (!KEY_RE.test(key)) return c.json({ error: { code: "INPUT-001", message: "Invalid key format" } }, 400);
    if (!authorizeSecretWrite(ns, getCtx(c))) {
      auditSecretOperation("rotate", ns, key, getCtx(c), "denied");
      return c.json({ error: { code: "SEC-403", message: `Write access denied to namespace: ${ns}` } }, 403);
    }
    await provider.rotate(ns, key, value);
    auditSecretOperation("rotate", ns, key, getCtx(c), "allowed");
    return c.json({ ok: true, namespace: ns, key, rotated: true });
  });
}
