// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11b: Route Registration Barrel
 *
 * registerAllRoutes(app, services) wires all Phase 11b route handlers onto
 * the provided Hono app. Call after createApiServer() in the CLI or tests.
 */

import Database from "better-sqlite3";
import { Hono, type Context } from "hono";
import { join } from "node:path";
import { createLogger } from "../../core/logger.js";
import { requireScope } from "../middleware/require-scope.js";

const logger = createLogger("api-routes");

import { registerTaskRoutes }        from "./tasks.js";
import { registerAgentRoutes }       from "./agents.js";
import { registerDivisionRoutes }    from "./divisions.js";
import { registerCostRoutes }        from "./costs.js";
import { registerAuditRoutes }       from "./audit.js";
import { registerGovernanceRoutes }  from "./governance.js";
import { registerLoggingRoutes }     from "./logging.js";
import { registerOrchestratorRoutes } from "./orchestrator.js";
import { registerExecutionRoutes }   from "./execution.js";
import { registerOutputRoutes }      from "./outputs.js";
import { registerSecretRoutes }      from "./secrets.js";
import { registerSseTicketRoutes }   from "./sse-ticket.js";
import { registerEventRoutes }       from "./events.js";
import { EventStreamManager }        from "../sse/event-stream.js";
import { initSseActivityBridge }     from "../../core/activity/bridges/sse-activity-bridge.js";
import { registerActivityRoutes }    from "./activity.js";
import { registerSelftestApiRoutes }  from "./selftest.js";
import { registerIntegrationRoutes }  from "./integration.js";
import type { IntegrationRouteServices } from "./integration.js";
export type { IntegrationRouteServices };
import { registerPwaRoutes }           from "./pwa.js";
import { registerStarterAgentRoutes }  from "./starter-agents.js";
import { registerProviderRoutes }      from "./provider.js";
import { registerChatRoutes }          from "./chat.js";
import { registerAgentToolRoutes }     from "./agent-tools.js";
import { registerWorkspaceConfigRoutes } from "./workspace-config.js";
import { registerLocaleRoutes }          from "./locale.js";
import { registerDaemonRoutes }          from "./daemon.js";
import { registerBackupRoutes }          from "./backup.js";
import type { DaemonManagerLike }        from "./daemon.js";
export type { DaemonManagerLike };
import { registerMessagingRoutes }       from "./messaging.js";
import type { MessagingRouteServices, AdapterRegistryLike as MessagingRegistryLike, UserMappingStoreLike } from "./messaging.js";
export type { MessagingRouteServices, MessagingRegistryLike, UserMappingStoreLike };
import { registerScheduleRoutes }        from "./schedule.js";
import type { ScheduleRouteServices, CronSchedulerLike, TaskStoreLike as ScheduleTaskStoreLike } from "./schedule.js";
export type { ScheduleRouteServices, CronSchedulerLike, ScheduleTaskStoreLike };
import { registerOrgChartRoutes }        from "./org-chart.js";
import { registerOrgPublicRoutes }       from "./org-public.js";
import type { OrgPublicRouteServices }   from "./org-public.js";
import { registerOrgImportRoutes }       from "./org-import.js";
import { registerTokenRoutes }           from "./tokens.js";
import type { TokenStore }               from "../token-store.js";
import { registerUpdaterRoutes }         from "./updater.js";
import { registerUpdateLifecycleRoutes } from "./update-lifecycle.js";
import { registerSystemLifecycleRoutes } from "./system-lifecycle.js";
import type { BackpressureManager }      from "../../core/runtime/backpressure.js";
import { setDeepHealthProvider }         from "./system.js";
import { checkDeepHealth }              from "../../core/health/deep-health.js";
import { isReadOnlyMode }               from "../middleware/readonly.js";
import { registerUploadRoutes }          from "./upload.js";
import type { UploadRouteServices }      from "./upload.js";
import type { UploadStore }              from "../../uploads/upload-store.js";
import type { FileStorage }              from "../../uploads/file-storage.js";
import type { ExtractionService }        from "../../uploads/extraction-service.js";
import { apply }                         from "../../apply/index.js";
import type { ActivityEmitter }          from "../../core/activity/activity-emitter.js";
import type { HeartbeatMonitor }         from "../../agents/heartbeat.js";
import { registerMcpRoutes }             from "./mcp-routes.js";
import type { McpRegistry }             from "../../core/mcp/mcp-registry.js";
import { registerStreamRoutes }          from "./stream-routes.js";
export type { StreamRouteServices }      from "./stream-routes.js";
import { registerWebhookRoutes }         from "./webhook-routes.js";
export type { WebhookRouteServices }     from "./webhook-routes.js";
import { WebhookTokenStore }             from "../../core/webhook/webhook-token-store.js";
import { registerMetricsRoutes }         from "./metrics-routes.js";
import { registerReportRoutes }          from "./report-routes.js";
import type { ReportRouteServices }      from "./report-routes.js";
export type { ReportRouteServices };
import { registerMemoryRoutes }          from "./memory-routes.js";
import type { MemoryRouteServices }      from "./memory-routes.js";
export type { MemoryRouteServices };
import { registerFeatureFlagRoutes }     from "./feature-flag-routes.js";

import type { AgentRegistryLike }   from "./agents.js";
import type { SecretRouteServices }    from "./secrets.js";
export type { SecretRouteServices };
import type { TaskEventBus } from "../../tasks/event-bus.js";
import type { OrchestratorLike }       from "./orchestrator.js";
import type { TicketRouteServices }    from "./sse-ticket.js";

export type { AgentRegistryLike, OrchestratorLike, TicketRouteServices };

// Re-export all route registrar functions for individual use in tests
export {
  registerTaskRoutes,
  registerAgentRoutes,
  registerDivisionRoutes,
  registerCostRoutes,
  registerAuditRoutes,
  registerGovernanceRoutes,
  registerLoggingRoutes,
  registerOrchestratorRoutes,
  registerExecutionRoutes,
  registerOutputRoutes,
  registerSecretRoutes,
  registerSelftestApiRoutes,
  registerIntegrationRoutes,
  registerDaemonRoutes,
  registerBackupRoutes,
  registerMessagingRoutes,
  registerScheduleRoutes,
  registerTokenRoutes,
  registerEventRoutes,
  registerOrgChartRoutes,
  registerOrgPublicRoutes,
  registerOrgImportRoutes,
  registerUpdaterRoutes,
  registerUpdateLifecycleRoutes,
  registerSystemLifecycleRoutes,
};


export interface AllRouteServices {
  /** Open database — required for task, agent, division, cost, audit routes. */
  db?:           InstanceType<typeof Database> | null;
  /** Working directory — required for governance routes (snapshot store). */
  workDir?:      string;
  /** AgentRegistry instance — required for agent routes. */
  registry?:     AgentRegistryLike;
  /** OrchestratorProcess instance — optional; routes return 503 if null. */
  orchestrator?: OrchestratorLike | null;
  /** Pre-initialised secrets services — optional; secrets routes omitted if absent. */
  secrets?:      SecretRouteServices | null;
  /** Integration gateway services — optional; /api/v1/integrations routes omitted if absent. */
  integration?:  IntegrationRouteServices | null;
  /** Directory containing PWA icon files (icon-192.png, icon-512.png, apple-touch-icon.png).
   *  If omitted or files absent, placeholder icons are generated in memory. */
  webPublicDir?: string;
  /** V1.1 AgentDaemonManager — optional; daemon routes return 503 if absent. */
  daemonManager?: DaemonManagerLike | null;
  /** V1.1 Messaging — optional; messaging routes return 503 if absent. */
  messaging?:     MessagingRouteServices | null;
  /** V1.1 Scheduling — optional; schedule routes return 503 if absent. */
  schedule?:      ScheduleRouteServices | null;
  /** Shared TaskEventBus — if provided, task execution and messaging subscribe to the same bus. */
  eventBus?:      TaskEventBus | null;
  /** P269: Scoped API token store — enables token-based auth + token CRUD endpoints. */
  tokenStore?:    TokenStore | null;
  /** Returns the current API key — used by the SSE events handler for ticket validation. */
  getApiKey?:     () => string;
  /** P348: Glasscheibe public org chart — CORS origin (default "*"). */
  publicCorsDomain?: string;
  /** P351: File upload services — optional. Routes omitted if absent. */
  uploadStore?: UploadStore | null;
  fileStorage?: FileStorage | null;
  /** P352: Async text extraction after upload — optional. */
  extractionService?: ExtractionService | null;
  /** P357: Activity emitter for bouncer scan events — optional. */
  activityEmitter?: ActivityEmitter | null;
  /** P359: HeartbeatMonitor instance — optional; status endpoint shows unknown if absent. */
  heartbeat?: HeartbeatMonitor | null;
  /** P374: MCP registry — optional; MCP routes return 503 if absent. */
  mcpRegistry?: McpRegistry | null;
  /** P378: Webhook token store — optional; created from db if absent. */
  webhookTokenStore?: WebhookTokenStore | null;
  /** P382: MCP registry for Puppeteer PDF rendering — reuses mcpRegistry if omitted. */
  reportMcpRegistry?: ReportRouteServices["mcpRegistry"];
  /** Backpressure manager — optional; GET /api/v1/system/backpressure returns 503 if absent. */
  backpressure?: BackpressureManager | null;
  /** P388: Feature flags — optional; routes degrade gracefully without DB. */
  featureFlags?: boolean;
}


/**
 * Register all Phase 11b REST route handlers on the given Hono app.
 *
 * @param app      Hono application (already has middleware from createApiServer)
 * @param services Service dependencies — any subset can be omitted; missing services
 *                 result in routes returning 503 or empty results as appropriate.
 */
export function registerAllRoutes(app: Hono, services: AllRouteServices = {}): void {
  const db       = services.db ?? null;
  const workDir  = services.workDir ?? process.cwd();

  // Wire deep health provider when DB is available — enriches GET /api/v1/health
  // with fields the blue/green sidecar checks: healthy, migration_complete, db_read, etc.
  if (db !== null) {
    setDeepHealthProvider(() => checkDeepHealth(db, workDir, workDir, isReadOnlyMode()));
  }

  // DB-backed routes
  if (db !== null) {
    registerTaskRoutes(app,              { db });
    registerDivisionRoutes(app,          { db });
    registerOrgChartRoutes(app,          { db, heartbeat: services.heartbeat ?? null });
    registerOrgImportRoutes(app,         { db });
    registerCostRoutes(app,              { db });
    registerAuditRoutes(app,             { db });
    registerExecutionRoutes(app,         { db, ...(services.eventBus != null ? { eventBus: services.eventBus } : {}) });
    registerOutputRoutes(app,            { db });
    registerWorkspaceConfigRoutes(app,   { db });
  }

  // Locale routes (always available — serves locale JSON and allows locale switching)
  registerLocaleRoutes(app, { db });

  // Agent routes (AgentRegistry)
  if (services.registry !== undefined) {
    registerAgentRoutes(app, { registry: services.registry });
  } else {
    // Return 503 JSON responses instead of throwing — callers can handle gracefully.
    // Body is intentionally generic — do NOT include internal service names,
    // error codes, or operational hints that could aid enumeration by unauthenticated callers.
    // Auth middleware (registered before all routes in createApiServer) ensures these handlers
    // are only reached by authenticated requests.
    const notConfigured = (c: Context) =>
      c.json(
        {
          error: {
            code:        "SYS-503",
            message:     "Service temporarily unavailable",
            recoverable: true,
          },
        },
        503,
      );

    app.get("/api/v1/agents",            notConfigured);
    app.get("/api/v1/agents/:id",        notConfigured);
    app.post("/api/v1/agents/:id/start", notConfigured);
    app.post("/api/v1/agents/:id/stop",  notConfigured);
  }

  // Secrets routes (optional — only when provider is pre-initialised)
  if (services.secrets) {
    registerSecretRoutes(app, services.secrets);
  }

  // Governance routes (always register — listSnapshots works even without DB)
  registerGovernanceRoutes(app, { workDir, db });

  // SSE ticket route (short-lived tickets for EventSource connections)
  registerSseTicketRoutes(app, {});

  // SSE events stream (consumes tickets, sends real-time events to EventSource clients)
  const sseManager = new EventStreamManager();
  initSseActivityBridge((e) => { void sseManager.broadcast(e); });
  registerEventRoutes(app, {
    getApiKey: services.getApiKey ?? (() => ""),
    manager:   sseManager,
    db:        db ?? null,
  });

  // P348: Glasscheibe — public (unauthenticated) org chart tree + live SSE
  if (db !== null) {
    registerOrgPublicRoutes(app, {
      db,
      manager: sseManager,
      ...(services.publicCorsDomain !== undefined ? { corsOrigin: services.publicCorsDomain } : {}),
    });
  }

  // P351: File upload in agent chats
  if (services.uploadStore != null && services.fileStorage != null) {
    registerUploadRoutes(app, {
      uploadStore: services.uploadStore,
      fileStorage: services.fileStorage,
      ...(services.extractionService != null ? { extractionService: services.extractionService } : {}),
      emitEvent:   (evt) => { void sseManager.broadcast(evt as any); },
    });
  }

  // Activity stream routes (always register — emitter degrades gracefully without DB)
  registerActivityRoutes(app, {});

  // Selftest routes (no DB required)
  registerSelftestApiRoutes(app, workDir);

  // Logging routes
  registerLoggingRoutes(app, workDir);

  // Integration Gateway routes (optional)
  if (services.integration !== null && services.integration !== undefined) {
    registerIntegrationRoutes(app, services.integration);
  }

  // Orchestrator routes
  registerOrchestratorRoutes(app, { orchestrator: services.orchestrator ?? null });

  // Daemon lifecycle routes
  registerDaemonRoutes(app, services.daemonManager ?? null);

  // Backup routes (always register — no DB required)
  registerBackupRoutes(app, workDir);

  // Messaging gateway routes
  registerMessagingRoutes(app, services.messaging ?? {});

  // Schedule (cron) routes
  registerScheduleRoutes(app, services.schedule ?? {});

  // PWA static assets (manifest, sw.js, offline.html, icons)
  registerPwaRoutes(app, { ...(services.webPublicDir !== undefined ? { iconDir: services.webPublicDir } : {}) });

  // Starter agent and division definitions (static, no DB required)
  registerStarterAgentRoutes(app);

  // Provider catalog + config (no DB required)
  registerProviderRoutes(app);

  // Chat endpoints (in-memory conversations; passes workDir for tool execution)
  registerChatRoutes(app, { workDir, db, uploadStore: services.uploadStore ?? null, activityEmitter: services.activityEmitter ?? null });

  // Agent tool-call endpoint
  registerAgentToolRoutes(app, { workDir, db });

  // P269: Token management routes (always register — enables token CRUD via API)
  if (services.tokenStore !== null && services.tokenStore !== undefined) {
    registerTokenRoutes(app, { tokenStore: services.tokenStore });
  }

  // MCP registry routes (optional — omitted if registry is absent)
  if (services.mcpRegistry != null) {
    registerMcpRoutes(app, { mcpRegistry: services.mcpRegistry });
  }

  // P377: LLM SSE streaming endpoint
  registerStreamRoutes(app, {
    mcpRegistry: services.mcpRegistry ?? null,
    workDir,
    db,
  });

  // P378: Webhook inbound endpoint
  if (db !== null) {
    registerWebhookRoutes(app, {
      db,
      ...(services.webhookTokenStore != null ? { webhookTokenStore: services.webhookTokenStore } : {}),
    });
  }

  // P379: Prometheus metrics endpoints
  registerMetricsRoutes(app);

  // P382: Report generation endpoints
  if (db !== null) {
    registerReportRoutes(app, {
      db,
      workDir,
      mcpRegistry: services.reportMcpRegistry ?? services.mcpRegistry ?? null,
    });
  }

  // P388: Feature flag routes (always register)
  registerFeatureFlagRoutes(app, { ...(db !== null ? { db } : {}) });

  // P388: Memory consolidation routes (requires DB)
  if (db !== null) {
    registerMemoryRoutes(app, { db, workDir });
  }

  // Blue/Green update routes
  registerUpdaterRoutes(app);
  registerUpdateLifecycleRoutes(app);
  registerSystemLifecycleRoutes(app, { backpressure: services.backpressure ?? null });

  // ── Apply endpoint — POST /api/v1/apply ──────────────────────────────────
  // Runs `sidjua apply --force` in-process. Same logic as the CLI command.
  // Idempotent — safe to call on every config change.
  app.post("/api/v1/apply", requireScope("operator"), async (c) => {
    const configPath = join(workDir, "divisions.yaml");
    try {
      const result = await apply({
        configPath,
        workDir,
        dryRun:  false,
        verbose: false,
        force:   true,
      });
      return c.json({
        success:  result.success,
        steps:    result.steps.length,
        duration: result.duration_ms,
        summary:  result.steps.map((s) => ({ step: s.step, success: s.success, summary: s.summary })),
      }, result.success ? 200 : 500);
    } catch (err: unknown) {
      return c.json({
        success: false,
        error:   err instanceof Error ? err.message : String(err),
      }, 500);
    }
  });

  // ── Detailed health endpoint (authenticated) ──────────────────────────────
  // GET /api/v1/health/details — returns per-component status.
  // Kept separate from /api/v1/health (public, load-balancer probe).
  app.get("/api/v1/health/details", requireScope("readonly"), (c) => {
    const version  = process.env["SIDJUA_VERSION"] ?? process.env["npm_package_version"] ?? "dev";
    const dbStatus = (() => {
      if (db === null) return { status: "unconfigured" as const };
      try {
        const start = Date.now();
        db.prepare("SELECT 1").get();
        return { status: "up" as const, latencyMs: Date.now() - start };
      } catch (e: unknown) {
        logger.warn("api-routes", "DB health probe failed — reporting unhealthy", { metadata: { error: e instanceof Error ? e.message : String(e) } });
        return { status: "down" as const };
      }
    })();
    const orchStatus = (() => {
      const orc = services.orchestrator ?? null;
      if (orc === null) return { status: "unconfigured" as const };
      const s = orc.getStatus();
      return { status: s.state === "RUNNING" ? "up" as const : "degraded" as const, state: s.state };
    })();
    return c.json({
      status:     "healthy",
      version,
      components: {
        database:     dbStatus,
        orchestrator: orchStatus,
      },
    });
  });
}

