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

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, extname, resolve as resolvePath } from "node:path";
import { assertWithinDirectory } from "../../utils/path-utils.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { isProcessAlive } from "../utils/process.js";
import { createLogger } from "../../core/logger.js";
import { createApiServer, DEFAULT_SERVER_CONFIG } from "../../api/server.js";
import { registerAllRoutes } from "../../api/routes/index.js";
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
import { TokenStore }                                    from "../../api/token-store.js";

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
        writeFileSync(keyFile, apiKey, { mode: 0o600 });
        logger.info("start", "Generated new server API key", { metadata: { keyFile } });
      }
    }

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
    activityEmitter.init(db);
    digestEngine.init(db);
    const registry = db !== null ? new AgentRegistry(db) : undefined;

    // DUAL PATH: cli-server.ts (Docker) does the same. Changes here MUST be mirrored there.
    // P269 / P316: Scoped token store — enables token-based auth + auto-generates admin token.
    const tokenStore = db !== null ? new TokenStore(db) : null;
    if (tokenStore !== null && !tokenStore.hasAdminToken()) {
      const adminTokenFile = join(systemDir, "admin.token");
      try {
        const { id, rawToken } = tokenStore.createToken({
          scope: "admin",
          label: "auto-generated admin token",
        });
        writeFileSync(adminTokenFile, rawToken, { encoding: "utf-8", mode: 0o600 });
        try { chmodSync(adminTokenFile, 0o600); } catch (_e) { /* best effort */ }
        logger.info("admin_token_generated", `Admin token created: ${id}`, {
          metadata: { id, file: adminTokenFile },
        });
        process.stderr.write(`[sidjua] Admin token written to: ${adminTokenFile}\n`);
        process.stderr.write(`[sidjua] WARNING: Protect this file — it grants full admin access.\n`);
      } catch (e: unknown) {
        logger.warn("admin_token_failed", "Could not write admin token file", {
          metadata: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }

    // ── Crash recovery — heal tasks interrupted by unclean shutdown ───────

    if (db !== null) {
      try {
        const now = new Date().toISOString();
        const result = db.prepare<[string], { changes: number }>(
          `UPDATE tasks SET status = 'FAILED', updated_at = ?, result_summary = 'Interrupted by unclean shutdown'
           WHERE status IN ('RUNNING', 'ASSIGNED')`,
        ).run(now);
        const recovered = (result as unknown as { changes: number }).changes ?? 0;
        if (recovered > 0) {
          process.stdout.write(
            msg("cli.start.crash_recovery").replace("{tasks}", String(recovered)),
          );
          logger.info("start", "Crash recovery: interrupted tasks marked as FAILED", {
            metadata: { recovered },
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

    // ── Create and configure HTTP API server ─────────────────────────────

    const server = createApiServer({
      ...DEFAULT_SERVER_CONFIG,
      port:      apiPort,
      api_key:   apiKey,
      // P269 / P316: wire scoped token store into auth middleware (identical to cli-server.ts)
      tokenStore,
    });

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
      workDir:      opts.workDir,
      orchestrator,
      secrets:      null as null,
      integration:  null as null,
      // P269 / P316: scoped token store — enables token CRUD + token-based auth (mirrors cli-server.ts)
      tokenStore,
      getApiKey:    () => apiKey,
      ...(sharedEventBus !== null ? { eventBus: sharedEventBus } : {}),
      ...messagingRouteServices,
      ...(registry !== undefined ? { registry } : {}),
    };
    registerAllRoutes(server.app, routeServices);

    // ── GUI static file serving (no auth required) ────────────────────────

    if (hasGui) {
      server.app.get("/", (c) => serveIndexHtmlWithBootstrap(c, guiDist, () => apiKey));
      server.app.get("/index.html", (c) => serveIndexHtmlWithBootstrap(c, guiDist, () => apiKey));
      server.app.get("/favicon.ico", (c) => serveGuiFile(c, guiDist, "favicon.ico"));
      server.app.get("/assets/*", (c) => {
        const assetPath = c.req.path.replace(/^\/assets\//, "");
        return serveGuiFile(c, join(guiDist, "assets"), assetPath);
      });
      // SPA fallback — serve index.html for unmatched non-API paths
      server.app.get("/*", (c) => {
        if (c.req.path.startsWith("/api/")) return c.notFound();
        return serveGuiFile(c, guiDist, "index.html");
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
      checkpointTimer?.stop();
      stopDigestScheduler();
      if (orchestrator !== null) {
        try { await orchestrator.stop(); } catch (_e) { /* cleanup-ignore */ }
      }
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
 * Serve index.html with the API key injected server-side.
 *
 * Mirrors the bootstrap logic in cli-server.ts so the CLI foreground path
 * has identical security properties (peer-address validation, no-store headers,
 * loopback-only key injection).
 */
function serveIndexHtmlWithBootstrap(
  c: Context,
  guiDist: string,
  getApiKey: () => string,
): Response {
  const filePath = join(guiDist, "index.html");
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch (_e) {
    return c.text("Not found", 404);
  }
  try {
    assertWithinDirectory(realPath, guiDist);
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  // Use the TCP peer address set by toWebRequest() — not the Host header.
  // Fail-closed: absent peer header (test env) → do NOT inject the key.
  const peerAddr = c.req.header("x-sidjua-peer-address") ?? "";
  const isLocal  = peerAddr === "127.0.0.1" || peerAddr === "::1" || peerAddr === "::ffff:127.0.0.1";

  let serverUrl = "";
  try { serverUrl = new URL(c.req.url).origin; } catch (_err) { /* non-fatal */ }

  const payload = isLocal
    ? JSON.stringify({ api_key: getApiKey(), server_url: serverUrl })
    : JSON.stringify({});

  const script = `<script>window.__SIDJUA_BOOTSTRAP__ = ${payload};</script>`;
  const html   = readFileSync(realPath, "utf-8").replace("</head>", `  ${script}\n  </head>`);

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
    assertWithinDirectory(realPath, dir);
  } catch (_e) {
    return c.text("Forbidden", 403);
  }

  const ext  = extname(realPath);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const body = readFileSync(realPath);
  return c.newResponse(body, 200, { "Content-Type": mime });
}
