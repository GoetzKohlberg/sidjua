// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Integration Gateway REST Endpoints
 *
 * GET  /api/v1/integrations                     — list all integrations
 * GET  /api/v1/integrations/:service            — integration details
 * POST /api/v1/integrations/:service/execute    — execute an action (main agent entry point)
 * POST /api/v1/integrations/add                 — add integration from OpenAPI spec
 * GET  /api/v1/integrations/:service/test       — test connectivity
 * GET  /api/v1/integrations/audit               — query audit log
 * GET  /api/v1/integrations/promote/:service    — check promotion status
 */

import { randomUUID } from "node:crypto";
import { Hono }       from "hono";
import { requireScope } from "../middleware/require-scope.js";
import Database       from "better-sqlite3";
import { createLogger } from "../../core/logger.js";
import { validateOutboundUrlAsync } from "../../core/outbound-validator.js";
import { parseOpenApiSpec } from "../../integration-gateway/openapi-parser.js";
import { AdapterPromoter }  from "../../integration-gateway/adapter-promoter.js";
import { reqId } from "../utils/request-id.js";
import type { AdapterRegistry }     from "../../integration-gateway/adapter-registry.js";
import type { IntegrationGateway }  from "../../integration-gateway/gateway.js";
import type { SchemaStore }         from "../../integration-gateway/schema-store.js";
import type { GatewayRequest }      from "../../integration-gateway/types.js";

const logger = createLogger("api-integration");


export interface IntegrationRouteServices {
  /** Adapter registry (loaded from governance/integrations/ YAML). */
  adapterRegistry: AdapterRegistry;
  /** Full gateway — required for /execute endpoint; routes 503 if absent. */
  gateway?: IntegrationGateway;
  /** Schema store — required for /add and /promote endpoints. */
  schemaStore?: SchemaStore;
  /** Database — required for /audit endpoint. */
  db?: InstanceType<typeof Database> | null;
}


interface AuditRow {
  id:           number;
  event_type:   string;
  request_id:   string;
  agent_id:     string;
  division:     string;
  service:      string;
  action:       string;
  path_used:    string;
  risk_level:   string;
  status_code:  number | null;
  execution_ms: number | null;
  error:        string | null;
  timestamp:    string;
}


export function registerIntegrationRoutes(
  app: Hono,
  services: IntegrationRouteServices,
): void {
  const { adapterRegistry, gateway, schemaStore, db } = services;

  // ── GET /api/v1/integrations ──────────────────────────────────────────────

  app.get("/api/v1/integrations", requireScope("readonly"), async (c) => {
    const adapters  = adapterRegistry.listAdapters();
    const discovered = schemaStore !== undefined
      ? await schemaStore.listSchemas().catch(() => [])
      : [];

    return c.json({
      adapters: adapters.map((a) => ({
        name:         a.name,
        protocol:     a.protocol,
        enabled:      a.enabled,
        action_count: Object.keys(a.actions).length,
        type:         a.type,
        base_url:     a.base_url,
      })),
      discovered: discovered
        .filter((s) => adapters.every((a) => a.name !== s.service_name))
        .map((s) => ({
          name:         s.service_name,
          type:         "discovered",
          usage_count:  s.usage_count,
          success_rate: s.success_rate,
          quality:      s.quality,
        })),
    });
  });

  // ── GET /api/v1/integrations/audit ────────────────────────────────────────
  // Registered before /:service so "audit" is not treated as a service name.

  app.get("/api/v1/integrations/audit", requireScope("readonly"), (c) => {
    if (db === null || db === undefined) {
      return c.json({ events: [] });
    }
    const service = c.req.query("service");
    const last    = c.req.query("last") ?? "24h";
    const limitN  = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);

    const conditions: string[] = ["1=1"];
    const params: (string | number)[] = [];
    const periodSql = auditPeriodSql(last);
    if (periodSql !== null) conditions.push(periodSql);
    if (service !== undefined) {
      conditions.push("service = ?");
      params.push(service);
    }

    let rows: AuditRow[] = [];
    try {
      rows = db
        .prepare<(string | number)[], AuditRow>(
          `SELECT * FROM integration_audit_events
           WHERE ${conditions.join(" AND ")}
           ORDER BY id DESC LIMIT ?`,
        )
        .all(...params, limitN);
    } catch (_e) {
      // Table may not exist yet
    }

    return c.json({ events: rows });
  });

  // ── GET /api/v1/integrations/promote/:service ─────────────────────────────

  app.get("/api/v1/integrations/promote/:service", requireScope("readonly"), async (c) => {
    const service = c.req.param("service");
    if (schemaStore === undefined) {
      return c.json({ error: "Schema store not configured" }, 503);
    }
    const schema = await schemaStore.getSchema(service).catch(() => null);
    if (schema === null) {
      return c.json({ error: `No schema found for '${service}'` }, 404);
    }

    const promoter   = new AdapterPromoter();
    const candidates = await promoter.getCandidates(schemaStore);
    const candidate  = candidates.find((ca) => ca.service_name === service);
    const eligible   = candidate !== undefined && candidate.recommended;

    let adapterYaml: string | undefined;
    if (eligible) {
      adapterYaml = await promoter.generateAdapterYaml(schema, []).catch(() => undefined);
    }

    return c.json({
      service,
      eligible,
      usage_count:  schema.usage_count,
      success_rate: schema.success_rate,
      quality:      schema.quality,
      ...(adapterYaml !== undefined ? { adapter_yaml: adapterYaml } : {}),
    });
  });

  // ── GET /api/v1/integrations/:service ────────────────────────────────────

  app.get("/api/v1/integrations/:service", requireScope("readonly"), (c) => {
    const service = c.req.param("service");
    const adapter = adapterRegistry.getAdapter(service);
    if (adapter === undefined) {
      return c.json({ error: `Integration '${service}' not found` }, 404);
    }
    return c.json(adapter);
  });

  // ── POST /api/v1/integrations/add ────────────────────────────────────────

  app.post("/api/v1/integrations/add", requireScope("operator"), async (c) => {
    if (schemaStore === undefined) {
      return c.json({ error: "Schema store not configured" }, 503);
    }

    let body: { service?: unknown; spec_url?: unknown; spec_content?: unknown };
    try {
      body = await c.req.json() as typeof body;
    } catch (_e) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const service = String(body.service ?? "");
    if (!service) return c.json({ error: "service is required" }, 400);

    let specContent: string;

    if (typeof body.spec_content === "string") {
      specContent = body.spec_content;
    } else if (typeof body.spec_url === "string") {
      // SSRF guard: reject private/loopback URLs (+ DNS rebinding) before fetch
      try {
        await validateOutboundUrlAsync(body.spec_url);
      } catch (e: unknown) {
        return c.json({ error: `Invalid spec_url: ${e instanceof Error ? e.message : String(e)}` }, 400);
      }
      try {
        const res = await fetch(body.spec_url);
        if (!res.ok) {
          return c.json({ error: `Failed to fetch spec: HTTP ${res.status}` }, 400);
        }
        specContent = await res.text();
      } catch (e: unknown) {
        return c.json({ error: `Could not reach spec URL: ${e instanceof Error ? e.message : String(e)}` }, 400);
      }
    } else {
      return c.json({ error: "spec_url or spec_content is required" }, 400);
    }

    try {
      parseOpenApiSpec(specContent);
    } catch (e: unknown) {
      return c.json({ error: `Invalid OpenAPI spec: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }

    await schemaStore.storeSchema({
      service_name: service,
      spec_format:  "openapi3",
      spec_content: specContent,
      quality:      "discovered",
      last_used:    new Date().toISOString(),
      success_rate: 0.0,
      usage_count:  0,
    });

    logger.debug("api-integration", `Added integration '${service}' via API`, {
      metadata: { requestId: reqId(c) },
    });

    return c.json({ success: true, service, quality: "discovered" }, 201);
  });

  // ── GET /api/v1/integrations/:service/test ───────────────────────────────

  app.get("/api/v1/integrations/:service/test", requireScope("readonly"), async (c) => {
    const service = c.req.param("service");
    const adapter = adapterRegistry.getAdapter(service);
    if (adapter === undefined) {
      return c.json({ error: `Integration '${service}' not found` }, 404);
    }
    if (adapter.base_url === undefined) {
      return c.json({ error: "Adapter has no base_url for HTTP test" }, 400);
    }

    // Find first read-only action
    const entry = Object.entries(adapter.actions)
      .find(([, a]) => a.governance.risk_level === "low");

    if (entry === undefined) {
      return c.json({ error: "No safe (risk=low) action found" }, 400);
    }
    const [actionName, action] = entry;
    const url    = `${adapter.base_url}${action.path ?? "/"}`;
    const method = (action.method ?? "GET").toUpperCase();
    const start  = Date.now();

    // SSRF guard on test connectivity URL (+ DNS rebinding)
    try {
      await validateOutboundUrlAsync(url);
    } catch (e: unknown) {
      return c.json({ error: `Invalid adapter base_url: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }

    try {
      const res     = await fetch(url, { method, signal: AbortSignal.timeout(10_000) });
      const elapsed = Date.now() - start;
      return c.json({
        success:    res.ok,
        service,
        action:     actionName,
        status:     res.status,
        elapsed_ms: elapsed,
      });
    } catch (e: unknown) {
      const elapsed = Date.now() - start;
      return c.json({
        success:    false,
        service,
        action:     actionName,
        error:      e instanceof Error ? e.message : String(e),
        elapsed_ms: elapsed,
      }, 502);
    }
  });

  // ── POST /api/v1/integrations/:service/execute ───────────────────────────

  app.post("/api/v1/integrations/:service/execute", requireScope("operator"), async (c) => {
    if (gateway === undefined) {
      return c.json(
        { error: { code: "SYS-503", message: "Integration gateway not configured" } },
        503,
      );
    }

    const service = c.req.param("service");
    let body: { action?: unknown; params?: unknown; agent_id?: unknown; division?: unknown };
    try {
      body = await c.req.json() as typeof body;
    } catch (_e) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const action   = String(body.action   ?? "");
    const agentId  = String(body.agent_id ?? "api-client");
    const division = String(body.division ?? "default");
    const params   = (typeof body.params === "object" && body.params !== null)
      ? body.params as Record<string, unknown>
      : {};

    if (!action) {
      return c.json({ error: "action is required" }, 400);
    }

    const gatewayRequest: GatewayRequest = {
      service,
      action,
      params,
      agent_id:   agentId,
      division,
      request_id: randomUUID(),
      timestamp:  new Date().toISOString(),
    };

    const result = await gateway.execute(gatewayRequest);

    // HTTP status mapping
    let status = result.success ? 200 : 400;
    if (result.error?.toLowerCase().includes("approval")) status = 202;
    if (result.error?.toLowerCase().includes("policy") ||
        result.error?.toLowerCase().includes("blocked")) status = 403;

    return c.json(result, status as 200 | 202 | 400 | 403 | 503);
  });
}


function auditPeriodSql(period: string): string | null {
  switch (period) {
    case "1h":  return "timestamp >= datetime('now', '-1 hour')";
    case "24h": return "timestamp >= datetime('now', '-24 hours')";
    case "7d":  return "timestamp >= datetime('now', '-7 days')";
    case "30d": return "timestamp >= datetime('now', '-30 days')";
    default:    return null;
  }
}
