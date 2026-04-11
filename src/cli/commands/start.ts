// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10: `sidjua start` command
 *
 * Start the orchestrator process.
 * - foreground: blocks until Ctrl-C; runs HTTP API server with all routes,
 *               serves GUI static files, shows agent startup
 * - background: forks a detached child, writes PID file
 */

import { existsSync, mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { join, extname, resolve as resolvePath } from "node:path";
import { assertWithinDirectory } from "../../utils/path-utils.js";
import { buildMcpSecretResolver } from "../../utils/mcp-secret-resolver.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { isProcessAlive } from "../utils/process.js";
import { createLogger } from "../../core/logger.js";
import { createApiServer, DEFAULT_SERVER_CONFIG } from "../../api/server.js";
import { registerAllRoutes } from "../../api/routes/index.js";
import { ConfigManager }     from "../../api/config.js";
import { FileSessionStore, SESSION_TTL_MS } from "../../api/middleware/session.js";
import { setHealthAuthProvider } from "../../api/routes/system.js";
import { DeadWorkerRecovery } from "../../core/runtime/dead-worker-recovery.js";
import { BackpressureManager } from "../../core/runtime/backpressure.js";
import { installImmutableAuditTriggers } from "../../core/runtime/sqlite-audit-immutable.js";
import { McpRegistry } from "../../core/mcp/mcp-registry.js";
import { scanModules, buildModuleConfigMap } from "../../core/modules/index.js";
import { openDatabase } from "../../utils/db.js";
import { AgentRegistry } from "../../agent-lifecycle/agent-registry.js";
import { readYamlFile } from "../../utils/yaml.js";
import type { OrchestratorConfigRaw } from "../../orchestrator/types.js";
import type { Context } from "hono";
import { TaskEventBus } from "../../tasks/event-bus.js";
import { loadMessagingConfig } from "../../messaging/config-loader.js";
import { AdapterRegistry } from "../../messaging/adapter-registry.js";
import { UserMappingStore } from "../../messaging/user-mapping.js";
import { InboundMessageGateway } from "../../messaging/inbound-gateway.js";
import { ResponseRouter } from "../../messaging/response-router.js";
import { TaskBuilder } from "../../messaging/task-builder.js";
import { ExecutionBridge } from "../../orchestrator/execution-bridge.js";
import { MessageToTaskBridge } from "../../messaging/task-bridge.js";
import { OverrideManager } from "../../messaging/override-manager.js";
import { TaskLifecycleRouter } from "../../messaging/task-lifecycle-router.js";
import { TaskStore } from "../../tasks/store.js";
import { DelegationPolicyResolver } from "../../delegation/policy-resolver.js";
import { DelegationService } from "../../delegation/delegation-service.js";
import { ResultAggregator } from "../../delegation/result-aggregator.js";
import type { AdapterInstanceConfig } from "../../messaging/types.js";
import { msg }                        from "../../i18n/index.js";
import { SIDJUA_VERSION }             from "../../version.js";
import { CheckpointTimer }            from "../../orchestrator/checkpoint-timer.js";
import { runMigrations105 }           from "../../agent-lifecycle/migration.js";
import { runAuditMigrations }         from "../../core/audit/audit-migrations.js";
import { runActivityMigrations }      from "../../core/activity/activity-migrations.js";
import { activityEmitter }            from "../../core/activity/activity-emitter.js";
import { digestEngine }               from "../../core/activity/digest-engine.js";
import { startDigestScheduler,
         stopDigestScheduler }        from "../../core/activity/digest-scheduler.js";
// DUAL PATH: cli-server.ts (Docker) runs the same migrations. Changes here MUST be mirrored there.
import { bootstrapOrchestrator }      from "../../orchestrator/bootstrap.js";
import type { OrchestratorProcess }   from "../../orchestrator/orchestrator.js";
import { detectDeploymentMode, getCheckpointIntervalMs } from "../../core/deployment-mode.js";
import { restoreChatState, persistChatState }            from "../../api/routes/chat.js";
import { restoreRateLimiterState, persistRateLimiterState } from "../../api/middleware/rate-limiter.js";
import { CostTracker }                                   from "../../provider/cost-tracker.js";
import { TokenStore }                                    from "../../api/token-store.js";
import { WebhookTokenStore }                              from "../../core/webhook/webhook-token-store.js";
import { initFeatureFlags }                              from "../../core/config/feature-flags.js";

const logger = createLogger("start-cmd");

/** File that stores the auto-generated server API key across restarts. */
const SERVER_KEY_FILE = "server.key";

/** MIME types for GUI static file serving. */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff":  "font/woff",
  ".ttf":   "font/ttf",
};


export interface StartCommandOptions {
  workDir:    string;
  foreground: boolean;
  logLevel:   string;
  config:     string;
}


/**
 * Start the orchestrator.
 *
 * Returns 0 on success (background: once PID file is written),
 * or 1 on error (already running, config not found, etc.).
 */
export async function runStartCommand(opts: StartCommandOptions): Promise<number> {
  const systemDir = join(opts.workDir, ".system");
  const pidFile   = join(systemDir, "orchestrator.pid");
  const sockFile  = join(systemDir, "orchestrator.sock");

  // ── Check already running ────────────────────────────────────────────────

  if (existsSync(pidFile)) {
    const pidText = readFileSync(pidFile, "utf8").trim();
    const pid     = parseInt(pidText, 10);

    if (!isNaN(pid) && isProcessAlive(pid)) {
      process.stderr.write(
        `✗ Orchestrator already running (PID ${pid}).\n`,
      );
      return 1;
      // else: Stale PID — will be overwritten
    }
  }

  // ── Config check ─────────────────────────────────────────────────────────

  const configPath = join(opts.workDir, opts.config);
  if (!existsSync(configPath)) {
    process.stderr.write(
      `✗ orchestrator.yaml not found. Run 'sidjua apply' first.\n`,
    );
    return 1;
  }

  // ── Ensure .system dir exists ────────────────────────────────────────────

  mkdirSync(systemDir, { recursive: true });

  // ── Foreground mode ──────────────────────────────────────────────────────

  if (opts.foreground) {
    process.stdout.write(msg("cli.start.loading_config"));

    // Read orchestrator config for api_port and runtime settings
    let apiPort = DEFAULT_SERVER_CONFIG.port;
    let deploymentMode = detectDeploymentMode();
    let checkpointIntervalMs = getCheckpointIntervalMs(deploymentMode);
    try {
      const raw = readYamlFile(configPath) as OrchestratorConfigRaw;
      if (typeof raw.api_port === "number" && raw.api_port > 0) {
        apiPort = raw.api_port;
      }
      if (raw.runtime !== undefined) {
        const runtimeMode = raw.runtime.mode;
        if (runtimeMode === "server" || runtimeMode === "desktop") {
          deploymentMode = runtimeMode;
        }
        if (typeof raw.runtime.checkpoint_interval === "number" && raw.runtime.checkpoint_interval > 0) {
          checkpointIntervalMs = raw.runtime.checkpoint_interval * 1000;
        } else {
          checkpointIntervalMs = getCheckpointIntervalMs(deploymentMode);
        }
      }
    } catch (_e) {
      // Non-fatal — use default port and auto-detected mode
    }

    // ── Port availability check ───────────────────────────────────────────

    const portFree = await isPortAvailable(apiPort, DEFAULT_SERVER_CONFIG.host);
    if (!portFree) {
      process.stderr.write(
        `✗ Port ${apiPort} is already in use.\n\n` +
        `  Try one of:\n` +
        `    • Change the port: edit governance/orchestrator.yaml → api_port: ${apiPort + 1}\n` +
        `    • Find what's using it: ss -tlnp | grep ${apiPort}\n` +
        `    • Kill the process: kill $(lsof -t -i :${apiPort})\n`,
      );
      return 1;
    }

    // Load or generate a persistent server API key
    const keyFile = join(systemDir, SERVER_KEY_FILE);
    let apiKey = process.env["SIDJUA_API_KEY"] ?? "";
    if (!apiKey) {
      if (existsSync(keyFile)) {
        apiKey = readFileSync(keyFile, "utf8").trim();
      }
      if (!apiKey) {
        apiKey = randomBytes(32).toString("hex");
        // Atomic write: write to a temp file then rename to prevent a crash
        // mid-write from leaving a truncated/empty key file.
        const tmpKeyFile = keyFile + ".tmp";
        writeFileSync(tmpKeyFile, apiKey, { mode: 0o600 });
        renameSync(tmpKeyFile, keyFile);
        logger.info("start", "Generated new server API key", { metadata: { keyFile } });
      }
    }

    // Warn operators that the raw API key now has bootstrap scope only (P311).
    // All non-bootstrap API operations require a scoped token.
    logger.warn(
      "startup_bootstrap_scope",
      "The raw API key is restricted to bootstrap scope (token creation only). " +
      "Create a scoped token for API access: sidjua token create --scope admin",
      {},
    );

    process.stdout.write(`SIDJUA Free v${SIDJUA_VERSION} — ${msg("cli.tagline")}\n`);
    process.stdout.write(`${msg("cli.licenseBanner")}\n\n`);
    process.stdout.write(msg("cli.start.starting_foreground"));
    process.stdout.write(
      msg("cli.start.runtime_mode")
        .replace("{mode}", deploymentMode)
        .replace("{interval}", String(checkpointIntervalMs / 1000)),
    );
    process.stdout.write(msg("cli.start.ctrl_c"));

    // Write own PID
    writeFileSync(pidFile, String(process.pid), "utf8");

    // ── Open database and create services ────────────────────────────────

    const dbPath = join(systemDir, "sidjua.db");
    const db     = openDatabase(dbPath);
    // DUAL PATH: cli-server.ts (Docker) runs the same migrations. Keep in sync.
    runMigrations105(db);
    runAuditMigrations(db);
    runActivityMigrations(db);
    installImmutableAuditTriggers(db);
    activityEmitter.init(db);
    digestEngine.init(db);
    // P388: Initialize feature flags (JSON defaults → env → DB override hierarchy)
    // DUAL PATH: server-startup.ts (Docker) calls the same. Changes here MUST be mirrored there.
    initFeatureFlags(opts.workDir, db);
    const registry = db !== null ? new AgentRegistry(db) : undefined;

    const tokenStore = db !== null ? new TokenStore(db) : null;

    // ── Crash recovery — heal tasks interrupted by unclean shutdown ───────

    if (db !== null) {
      try {
        const now = new Date().toISOString();
        // RUNNING tasks were actively executing — mark as FAILED (unrecoverable).
        // ASSIGNED tasks were dispatched but not yet started — reset to PENDING so
        // they can be retried by the orchestrator on the next loop iteration.
        const failResult = db.prepare<[string], { changes: number }>(
          `UPDATE tasks SET status = 'FAILED', updated_at = ?, result_summary = 'Interrupted by unclean shutdown'
           WHERE status = 'RUNNING'`,
        ).run(now);
        const pendingResult = db.prepare<[string], { changes: number }>(
          `UPDATE tasks SET status = 'PENDING', updated_at = ?
           WHERE status = 'ASSIGNED'`,
        ).run(now);
        const failed   = (failResult   as unknown as { changes: number }).changes ?? 0;
        const pending  = (pendingResult as unknown as { changes: number }).changes ?? 0;
        const recovered = failed + pending;
        if (recovered > 0) {
          process.stdout.write(
            msg("cli.start.crash_recovery").replace("{tasks}", String(recovered)),
          );
          logger.info("start", "Crash recovery: RUNNING tasks marked FAILED, ASSIGNED tasks reset to PENDING", {
            metadata: { failed, pending },
          });
        }
      } catch (e: unknown) {
        // Non-fatal: tasks table may not exist yet
        logger.debug("start", "Crash recovery skipped (tasks table not yet created)", {
          metadata: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }

    // ── Startup state restore ─────────────────────────────────────────────

    if (db !== null) {
      // Budget reservations from a dead process are always stale — delete them
      try {
        db.prepare("DELETE FROM pending_reservations WHERE 1=1").run();
      } catch (_e) { /* table may not exist — non-fatal */ }

      // Clean up cost reservations orphaned by a previous crash
      try {
        const cleaned = new CostTracker(db).cleanupOrphanedReservations();
        if (cleaned > 0) {
          logger.info("start", `Cleaned up ${cleaned} orphaned cost reservation(s) from previous run`, {
            metadata: { cleaned },
          });
        }
      } catch (_e) { /* cost_ledger may not exist yet — non-fatal */ }

      // Restore chat history and rate-limiter state persisted by previous run
      restoreChatState(db);
      restoreRateLimiterState(db);
    }

    // Locate GUI dist directory (sidjua-gui/dist relative to package root).
    // When bundled to dist/index.js, import.meta.url points to dist/ — one level up is the package root.
    const pkgRoot   = resolvePath(new URL(".", import.meta.url).pathname, "../");
    const guiDist   = join(pkgRoot, "sidjua-gui", "dist");
    const hasGui    = existsSync(join(guiDist, "index.html"));

    // ── Messaging gateway (Telegram bidirectional) ────────────────────────

    let messagingGateway:     InboundMessageGateway | null = null;
    let messagingRegistry:    AdapterRegistry | null       = null;
    let messagingUserMapping: UserMappingStore | null      = null;
    let sharedEventBus:       TaskEventBus | null          = null;
    let responseRouter:       ResponseRouter | null        = null;

    if (db !== null) {
      const messagingConfig = loadMessagingConfig(opts.workDir);
      const instances = [...messagingConfig.instances];

      // Auto-add Telegram instance when TELEGRAM_BOT_TOKEN env var is set and
      // no telegram instance is already in governance/messaging.yaml
      const telegramToken = process.env["TELEGRAM_BOT_TOKEN"];
      const hasTelegramInstance = instances.some((i) => i.adapter === "telegram");
      if (telegramToken !== undefined && telegramToken !== "" && !hasTelegramInstance) {
        const autoInstance: AdapterInstanceConfig = {
          id:                 "telegram-auto",
          adapter:            "telegram",
          enabled:            true,
          config:             { bot_token_secret: "TELEGRAM_BOT_TOKEN" },
          rate_limit_per_min: 0,
        };
        instances.push(autoInstance);
        logger.info("start", "Telegram adapter auto-configured from TELEGRAM_BOT_TOKEN", {});
      }

      const enabledInstances = instances.filter((i) => i.enabled);

      if (enabledInstances.length > 0) {
        sharedEventBus = new TaskEventBus(db);
        const adapterDir = join(pkgRoot, "adapters", "messaging");

        // Secret getter: look up env vars first (e.g. TELEGRAM_BOT_TOKEN),
        // then fallback to a descriptive error for secrets not in env.
        const getSecretFn = async (key: string): Promise<string> => {
          const fromEnv = process.env[key];
          if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
          throw new Error(`Secret '${key}' not found in environment`);
        };

        messagingUserMapping = new UserMappingStore(db);
        await messagingUserMapping.initialize();

        messagingRegistry = new AdapterRegistry(adapterDir, getSecretFn);

        if (existsSync(adapterDir)) {
          await messagingRegistry.discoverAdapters();
        }

        const governance = messagingConfig.governance;
        responseRouter = new ResponseRouter(messagingRegistry, governance);
        // Restore task origins persisted by the previous server run so that
        // in-flight task responses are routed back to the correct channel.
        if (db !== null) {
          try { responseRouter.restoreOrigins(db); } catch (_e) { /* non-fatal */ }
        }

        const taskBridgeCfg = {
          mode:            "direct_passthrough" as const,
          defaults:        { priority: 5, budget_usd: 1.0, ttl_seconds: 3600 },
          override:        { enabled: false, window_seconds: 300, non_overrideable_rules: [], require_admin_for_override: [] },
          channel_routing: {},
        };
        const noopAuditLog     = { log: () => undefined };
        const taskBuilder      = new TaskBuilder(taskBridgeCfg);
        const executionBridge  = new ExecutionBridge(db, sharedEventBus);
        const overrideManager  = new OverrideManager(taskBridgeCfg, executionBridge, responseRouter, noopAuditLog);
        const taskBridge       = new MessageToTaskBridge(
          taskBuilder,
          executionBridge,
          responseRouter,
          messagingUserMapping,
          overrideManager,
          taskBridgeCfg,
        );

        messagingGateway = new InboundMessageGateway(
          messagingRegistry,
          messagingUserMapping,
          governance,
          getSecretFn,
          taskBridge,
        );

        // Subscribe TaskLifecycleRouter to task completion events so responses
        // are routed back to the originating messaging channel.
        const taskStore          = new TaskStore(db);
        const lifecycleRouter    = new TaskLifecycleRouter(sharedEventBus, taskStore, responseRouter);
        lifecycleRouter.start();

        // Wire delegation bridge: DelegationPolicyResolver + DelegationService + ResultAggregator
        // ResultAggregator subscribes to RESULT_READY/TASK_FAILED to close the delegation loop.
        const agentRegistryForDelegation = registry ?? new (await import("../../agent-lifecycle/agent-registry.js")).AgentRegistry(db);
        const delegationPolicyResolver   = new DelegationPolicyResolver(agentRegistryForDelegation);
        const delegationService          = new DelegationService(
          taskStore,
          sharedEventBus,
          delegationPolicyResolver,
          agentRegistryForDelegation,
        );
        const resultAggregator = new ResultAggregator(
          sharedEventBus,
          taskStore,
          delegationService,
          responseRouter,
        );
        resultAggregator.start();

        // Start all configured adapter instances (best-effort — failure does not block startup)
        messagingGateway.start(enabledInstances).catch((e: unknown) => {
          logger.warn("start", "Messaging gateway failed to start", {
            metadata: { error: e instanceof Error ? e.message : String(e) },
          });
        });

        logger.info("start", "Messaging gateway started", {
          metadata: { instances: enabledInstances.length },
        });
      }
    }

    // ── Start orchestrator (MUST succeed before HTTP server starts) ───────
    //
    // GOVERNANCE GUARANTEE: Tasks submitted via API are immediately routed
    // through the governance pipeline. Starting the server without an
    // orchestrator would accept tasks but never process or audit them.

    let orchestrator: OrchestratorProcess | null = null;
    try {
      orchestrator = await bootstrapOrchestrator({
        db,
        workDir: opts.workDir,
        configPath,
      });
    } catch (err: unknown) {
      logger.error("start", "Orchestrator startup failed — aborting server start", {
        error: { code: "SYS-001", message: String(err) },
      });
      process.stderr.write(`✗ Failed to start orchestrator: ${String(err)}\n`);
      try { require("node:fs").unlinkSync(pidFile); } catch (_e) { /* cleanup-ignore */ }
      return 1;
    }

    // ── P434b/P434c: GUI auth config + session store ──────────────────────

    const configManager = new ConfigManager(opts.workDir);
    const guiConfigured = configManager.load();
    if (configManager.recoveryMode) {
      logger.warn("start", "GUI config in recovery mode — admin re-setup required via /api/v1/auth/setup", {});
      process.stderr.write("[sidjua] WARNING: GUI config.json is corrupt — recovery mode active. Re-run setup.\n");
    } else if (!guiConfigured) {
      logger.info("start", "First run: no admin password set — complete setup at /api/v1/auth/setup", {});
      process.stderr.write("[sidjua] INFO: GUI not yet configured. Open the browser to complete first-time setup.\n");
    }

    const sessionStore = new FileSessionStore(opts.workDir);
    void sessionStore.purgeExpired().catch((_e: unknown) => undefined);

    // Periodic session purge — every SESSION_TTL_MS / 2 (4 hours)
    const sessionPurgeTimer = setInterval(
      () => { void sessionStore.purgeExpired().catch((_e: unknown) => undefined); },
      SESSION_TTL_MS / 2,
    );
    sessionPurgeTimer.unref();

    setHealthAuthProvider(() => ({
      setup_required: configManager.isFirstRun(),
      recovery_mode:  configManager.recoveryMode,
    }));

    // ── Create and configure HTTP API server ─────────────────────────────

    const server = createApiServer({
      ...DEFAULT_SERVER_CONFIG,
      port:      apiPort,
      api_key:   apiKey,
      // P269 / P316: wire scoped token store into auth middleware (identical to cli-server.ts)
      tokenStore,
      // P434b: GUI session auth
      sessionStore,
      getSessionSecret: () => configManager.getConfig().sessionSecret,
    });

    // ── MCP Registry — DUAL PATH: server-startup.ts (Docker) does the same ──
    const mcpSecretResolver = buildMcpSecretResolver(new Map(), process.env["NODE_ENV"] !== "production");
    const mcpRegistry = new McpRegistry(mcpSecretResolver);
    await mcpRegistry.initialize(join(opts.workDir, "config", "mcp-servers.yaml"));

    // ── Module SDK — scan modules/ and register as additional MCP servers ──
    const installedModules = scanModules(join(opts.workDir, "modules"));
    if (installedModules.length > 0) {
      const moduleConfigs = buildModuleConfigMap(installedModules);
      await mcpRegistry.initializeWithModules(moduleConfigs);
    }

    // Register all API routes (tasks, agents, divisions, costs, governance, etc.)
    const messagingRouteServices = messagingGateway !== null && messagingRegistry !== null
      ? {
          messaging: {
            gateway:     messagingGateway,
            registry:    messagingRegistry,
            userMapping: messagingUserMapping,
          },
        }
      : {};
    const routeServices = {
      db,
      workDir:          opts.workDir,
      orchestrator,
      secrets:          null as null,
      integration:      null as null,
      tokenStore,
      getApiKey:        () => apiKey,
      activityEmitter,
      ...(sharedEventBus !== null ? { eventBus: sharedEventBus } : {}),
      ...messagingRouteServices,
      ...(registry !== undefined ? { registry } : {}),
      mcpRegistry,
      webhookTokenStore: db !== null ? new WebhookTokenStore(db) : null,
      // P434b/P434c: GUI auth
      auth: { configManager, sessionStore },
    };

    // DUAL PATH: server-startup.ts (Docker) starts the same services. Keep in sync.
    const deadWorkerRecovery = new DeadWorkerRecovery(db, {
      checkIntervalMs: parseInt(process.env["SIDJUA_DEAD_WORKER_CHECK_INTERVAL"] ?? "60000", 10),
      taskTimeoutMs:   parseInt(process.env["SIDJUA_DEAD_WORKER_TIMEOUT"] ?? "300000", 10),
      enabled: true,
    });
    deadWorkerRecovery.start();

    const backpressure = new BackpressureManager({
      maxConcurrentByTier: {
        "1": parseInt(process.env["SIDJUA_BACKPRESSURE_T1_MAX"] ?? "2",  10),
        "2": parseInt(process.env["SIDJUA_BACKPRESSURE_T2_MAX"] ?? "4",  10),
        "3": parseInt(process.env["SIDJUA_BACKPRESSURE_T3_MAX"] ?? "8",  10),
        T1:  parseInt(process.env["SIDJUA_BACKPRESSURE_T1_MAX"] ?? "2",  10),
        T2:  parseInt(process.env["SIDJUA_BACKPRESSURE_T2_MAX"] ?? "4",  10),
        T3:  parseInt(process.env["SIDJUA_BACKPRESSURE_T3_MAX"] ?? "8",  10),
      },
      maxQueueLength: parseInt(process.env["SIDJUA_BACKPRESSURE_QUEUE_MAX"] ?? "100",    10),
      queueTimeoutMs: parseInt(process.env["SIDJUA_BACKPRESSURE_QUEUE_TIMEOUT"] ?? "120000", 10),
    });
    backpressure.start();

    registerAllRoutes(server.app, { ...routeServices, backpressure });

    // ── GUI static file serving (no auth required) ────────────────────────

    if (hasGui) {
      server.app.get("/", (c) => serveIndexHtmlWithBootstrap(c, guiDist, () => apiKey));
      server.app.get("/index.html", (c) => serveIndexHtmlWithBootstrap(c, guiDist, () => apiKey));
      server.app.get("/favicon.ico", (c) => serveGuiFile(c, guiDist, "favicon.ico"));
      server.app.get("/assets/*", (c) => {
        const assetPath = c.req.path.replace(/^\/assets\//, "");
        return serveGuiFile(c, join(guiDist, "assets"), assetPath);
      });
      // SPA fallback — serve index.html for unmatched non-API paths.
      // Use serveIndexHtmlWithBootstrap (not serveGuiFile) so the nonce is
      // injected into all inline scripts, satisfying the script-src CSP directive.
      server.app.get("/*", (c) => {
        if (c.req.path.startsWith("/api/")) return c.notFound();
        return serveIndexHtmlWithBootstrap(c, guiDist, () => apiKey);
      });
    }

    // ── Start server ──────────────────────────────────────────────────────

    let serverStarted = false;
    try {
      await server.start();
      serverStarted = true;
      const port = server.boundPort ?? apiPort;
      process.stdout.write(`▸ Orchestrator running. API server listening on http://127.0.0.1:${port}\n`);
      process.stdout.write(`  API key file: ${keyFile}\n`);
      if (hasGui) {
        process.stdout.write(`  GUI:     http://127.0.0.1:${port}/\n`);
      }
      logger.info("start", `Listening on port ${port}`, { metadata: { port } });

      // Show memory reminder if memory not activated (no OPENAI_API_KEY / CF tokens in .env)
      const envPath = join(opts.workDir, ".env");
      const memoryActive = existsSync(envPath) && (
        readFileSync(envPath, "utf8").includes("OPENAI_API_KEY=") ||
        readFileSync(envPath, "utf8").includes("SIDJUA_CF_ACCOUNT_ID=")
      );
      if (!memoryActive) {
        process.stdout.write(msg("cli.start.memory_inactive"));
        process.stdout.write(msg("cli.start.memory_activate_hint"));
      }
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes("EADDRINUSE")) {
        process.stderr.write(
          `✗ Port ${apiPort} is already in use.\n\n` +
          `  Try one of:\n` +
          `    • Change the port: edit governance/orchestrator.yaml → api_port: ${apiPort + 1}\n` +
          `    • Find what's using it: ss -tlnp | grep ${apiPort}\n` +
          `    • Kill the process: kill $(lsof -t -i :${apiPort})\n`,
        );
      } else {
        process.stderr.write(`✗ Failed to start API server: ${errMsg}\n`);
      }
      try { require("node:fs").unlinkSync(pidFile); } catch (_e) { /* cleanup-ignore */ }
      return 1;
    }

    // ── Periodic auto-checkpoint timer ────────────────────────────────────

    const checkpointTimer = db !== null
      ? new CheckpointTimer(db, checkpointIntervalMs, deploymentMode)
      : null;
    if (checkpointTimer !== null) {
      checkpointTimer.start();
    }

    // Activity digest scheduler — generates daily/weekly digests automatically
    startDigestScheduler({
      digest_time:     "06:00",
      digest_timezone: "Asia/Manila",
      telegram_digest: false,
    });

    // Graceful shutdown handler
    const shutdown = async () => {
      process.stdout.write(msg("cli.start.shutting_down"));
      clearInterval(sessionPurgeTimer);
      checkpointTimer?.stop();
      stopDigestScheduler();
      deadWorkerRecovery.stop();
      backpressure.stop();
      if (orchestrator !== null) {
        try { await orchestrator.stop(); } catch (_e) { /* cleanup-ignore */ }
      }
      try { await mcpRegistry.shutdown(); } catch (_e) { /* cleanup-ignore */ }
      if (messagingGateway !== null) {
        try { await messagingGateway.stop(); } catch (_e) { /* cleanup-ignore */ }
      }
      if (serverStarted) {
        try { await server.stop(); } catch (_e) { /* cleanup-ignore */ }
      }
      if (db !== null) {
        try { persistChatState(db); }                    catch (_e) { /* persist-ignore */ }
        try { persistRateLimiterState(db); }             catch (_e) { /* persist-ignore */ }
        if (responseRouter !== null) {
          try { responseRouter.persistOrigins(db); }     catch (_e) { /* persist-ignore */ }
        }
        try { db.pragma("wal_checkpoint(TRUNCATE)"); }   catch (_e) { /* flush-ignore */ }
        try { db.close(); }                              catch (_e) { /* cleanup-ignore */ }
      }
      try { require("node:fs").unlinkSync(pidFile); } catch (_e) { /* cleanup-ignore */ }
      try { require("node:fs").unlinkSync(sockFile); } catch (_e) { /* cleanup-ignore */ }
      process.exit(0);
    };

    process.on("SIGINT",  () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });

    // Server socket keeps event loop alive — wait for shutdown signal
    await new Promise<void>((resolve) => {
      process.once("beforeExit", resolve);
    });
    return 0;
  }

  // ── Background daemon mode ───────────────────────────────────────────────

  // The daemon script is the same entry point with an env flag.
  // Use process.argv[1] to get the actual running script path — works
  // whether running via 'node dist/index.js' or a wrapper binary.
  const scriptPath = process.argv[1] ?? "";

  // Use spawn instead of fork — Node.js 22 requires IPC channel with fork(),
  // but we don't need IPC for a detached daemon.
  const child = spawn(process.execPath, [scriptPath, "start", "--foreground", "--work-dir", opts.workDir], {
    detached:  true,
    stdio:     "ignore",
    env:       { ...process.env, SIDJUA_DAEMON: "1" },
  });

  child.unref();

  // Wait briefly for PID file to appear (daemon writes it on startup)
  let waited = 0;
  while (!existsSync(pidFile) && waited < 3000) {
    await sleep(100);
    waited += 100;
  }

  if (!existsSync(pidFile)) {
    // Daemon failed to start — write our child PID as fallback
    writeFileSync(pidFile, String(child.pid ?? ""), "utf8");
  }

  const pid = existsSync(pidFile)
    ? readFileSync(pidFile, "utf8").trim()
    : String(child.pid ?? "?");

  process.stdout.write(`Orchestrator started (PID ${pid}).\n`);
  process.stdout.write(msg("cli.start.health_hint"));

  return 0;
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if a TCP port is available on the given host. */
async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => { srv.close(); resolve(true); });
    srv.listen(port, host);
  });
}

/**
 * Serve index.html with CSP nonce injection for Vite inline scripts.
 *
 * Bootstrap payload injection removed (P434a / #779 — SPEC-BOOTSTRAP-V2 §4.4).
 * The `_getApiKey` parameter is retained for call-site compatibility.
 */
function serveIndexHtmlWithBootstrap(
  c: Context,
  guiDist: string,
  _getApiKey: () => string,
): Response {
  const filePath = join(guiDist, "index.html");
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch (_e) {
    return c.text("Not found", 404);
  }
  try {
    assertWithinDirectory(realPath, realpathSync(guiDist));
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  // Retrieve the per-request nonce set by the securityHeaders middleware so
  // any Vite-injected inline scripts (e.g. modulepreload polyfill) are
  // whitelisted by the script-src CSP directive.
  const nonce = (c.get as (k: string) => string | undefined)("nonce" as never) ?? "";
  let html = readFileSync(realPath, "utf-8");

  // Add nonce to any inline <script> tags injected by vite (no src=, no nonce= yet).
  if (nonce) {
    html = html.replace(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
  }

  return c.newResponse(html, 200, {
    "Content-Type":  "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache",
    "Pragma":        "no-cache",
  });
}

/** Serve a static file from the GUI dist directory. */
function serveGuiFile(c: Context, dir: string, filename: string) {
  const filePath = join(dir, filename);

  // Security: resolve symlinks FIRST, then verify the real path stays within dir.
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch (_e) {
    return c.text("Not found", 404);
  }

  try {
    assertWithinDirectory(realPath, realpathSync(dir));
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  const ext  = extname(realPath);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const body = readFileSync(realPath);
  return c.newResponse(body, 200, { "Content-Type": mime });
}
