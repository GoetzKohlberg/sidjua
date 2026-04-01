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
import { registerTokenRoutes }           from "./tokens.js";
import type { TokenStore }               from "../token-store.js";
import { apply }                         from "../../apply/index.js";

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

  // DB-backed routes
  if (db !== null) {
    registerTaskRoutes(app,              { db });
    registerDivisionRoutes(app,          { db });
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
  registerChatRoutes(app, { workDir, db });

  // Agent tool-call endpoint
  registerAgentToolRoutes(app, { workDir, db });

  // P269: Token management routes (always register — enables token CRUD via API)
  if (services.tokenStore !== null && services.tokenStore !== undefined) {
    registerTokenRoutes(app, { tokenStore: services.tokenStore });
  }

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

