// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 11a: HTTP API Server
 *
 * Hono app with full middleware stack:
 *   requestLogger → cors → bodyLimit → csrf → authenticate → rateLimiter → httpInputSanitizer
 *   + global error handler + 404 handler
 *
 * Server lifecycle: start() binds to configured port via node:http adapter.
 * Graceful shutdown: SIGTERM/SIGINT drain in-flight requests (5s max).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type { TlsConfig } from "./tls.js";

import { requestLogger }       from "./middleware/request-logger.js";
import { authenticate }        from "./middleware/auth.js";
import type { TokenStore }     from "./token-store.js";
import { rateLimiter }         from "./middleware/rate-limiter.js";
import { createErrorHandler }  from "./middleware/error-handler.js";
import { httpInputSanitizer }  from "./middleware/input-sanitizer.js";
import { bodyLimitMiddleware }  from "./middleware/body-limit.js";
import { csrfMiddleware }       from "./middleware/csrf.js";
import { requestTimeout }       from "./middleware/request-timeout.js";
import { contentTypeJson }      from "./middleware/content-type.js";
import { securityHeaders }      from "./middleware/security-headers.js";
import { drainMiddleware }      from "./middleware/drain.js";
import { readonlyMiddleware }   from "./middleware/readonly.js";
import { createSystemRoutes }  from "./routes/system.js";
import { createLogger }        from "../core/logger.js";
import type { RateLimitConfig } from "./middleware/rate-limiter.js";

export type { RateLimitConfig };

const logger = createLogger("api-server");


export interface ApiServerConfig {
  port:              number;          // default 3000
  host:              string;          // default '127.0.0.1'
  api_key:           string;          // primary API key (also accepts pending key during rotation)
  /** Optional getter for the grace-period (old) key during zero-downtime rotation. */
  getPendingApiKey?: () => string | null;
  cors_origins:      string[];        // default ['http://localhost:3000']
  /** Allow all origins ('*').  Logs a WARNING at startup.  Implies credentials:false. */
  cors_allow_all?:   boolean;
  cors_credentials?: boolean;         // default false
  cors_max_age?:     number;          // seconds; default 86400
  rate_limit:        RateLimitConfig;
  trust_proxy:       boolean;         // default false
  isDevelopment?:    boolean;         // if true, include detail + stack in error responses
  /** Optional TLS configuration.  When enabled the server uses HTTPS. */
  tls?:              TlsConfig;
  /** P269: Scoped API token store — enables token-based auth as primary auth path. */
  tokenStore?:       TokenStore | null;
}

export const DEFAULT_SERVER_CONFIG: Omit<ApiServerConfig, "api_key"> = {
  port:         3000,
  host:         "127.0.0.1",
  cors_origins: ["http://localhost:3000"],
  rate_limit: {
    enabled:      true,
    window_ms:    60_000,
    max_requests: 100,
    burst_max:    20,
  },
  trust_proxy:  false,
};


export interface ApiServer {
  /** The Hono application (use `.request()` in tests). */
  app: Hono;
  /** Start listening on configured host:port. */
  start(): Promise<void>;
  /** Graceful shutdown — drain in-flight requests (max 5s). */
  stop(): Promise<void>;
  /** True once start() resolves. */
  readonly running: boolean;
  /** Port actually bound (may differ from config if OS assigns). */
  readonly boundPort: number;
}


function toWebRequest(req: IncomingMessage, host: string): Request {
  const url     = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();

  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const val of v) headers.append(k, val);
    } else {
      headers.set(k, v);
    }
  }

  // Inject the real TCP peer address as a trusted server-side header.
  // Written AFTER copying client headers so any client-supplied x-sidjua-peer-address
  // is unconditionally overwritten — prevents host-spoofing via forged headers.
  const peerAddr = req.socket?.remoteAddress ?? "";
  if (peerAddr !== "") {
    headers.set("x-sidjua-peer-address", peerAddr);
  }

  const method = req.method ?? "GET";
  const hasBody = !["GET", "HEAD"].includes(method);

  return new Request(url, {
    method,
    headers,
    // Type cast justified: Node.js IncomingMessage is a Readable stream used as
    // the fetch Request body; the Web Streams ReadableStream type is incompatible
    // but the runtime accepts it — this is the standard Hono/Node.js bridge pattern.
    ...(hasBody
      ? { body: req as unknown as ReadableStream, duplex: "half" }
      : {}),
  } as RequestInit);
}

async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (webRes.body !== null) {
    const reader = webRes.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}


/**
 * Create the Hono API server with the full middleware stack.
 *
 * @param config  Server configuration
 */
export function createApiServer(config: ApiServerConfig): ApiServer {
  const app = new Hono();

  // ------------------------------------------------------------------
  // Global error handler
  // ------------------------------------------------------------------
  app.onError(createErrorHandler(config.isDevelopment ?? false));

  // ------------------------------------------------------------------
  // Build metadata (standard telemetry — injected by build pipeline)
  // ------------------------------------------------------------------
  const BUILD_META = {
    version:  process.env["SIDJUA_VERSION"] ?? process.env["npm_package_version"] ?? "dev",
    build:    process.env["BUILD_DATE"]     ?? "local",
    ref:      process.env["VCS_REF"]        ?? "none",
    platform: "sidjua",
  };

  // ------------------------------------------------------------------
  // Middleware stack (applied in order)
  // ------------------------------------------------------------------
  app.use("*", requestLogger());
  app.use("*", securityHeaders);

  // Identify responses — survives proxies and CDN rewrites
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Powered-By", `sidjua/${BUILD_META.version}`);
  });

  // CORS — wildcard '*' allows all origins but disables credentials (per spec).
  // Log a startup warning when wildcard is configured (air-gap convenience mode).
  if (config.cors_allow_all) {
    logger.warn("cors_wildcard_enabled",
      "CORS wildcard (*) is enabled — all origins are allowed. Only use in air-gapped networks.", {});
  }

  app.use("*", cors({
    origin:         config.cors_allow_all ? "*" : config.cors_origins,
    allowMethods:   ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders:   ["Content-Type", "Authorization", "Last-Event-ID"],
    exposeHeaders:  ["X-Request-Id"],
    maxAge:         config.cors_max_age     ?? 86400,
    credentials:    config.cors_allow_all ? false : (config.cors_credentials ?? false),
  }));

  // Drain mode: reject all new requests when the instance is shutting down (blue/green).
  // Registered before auth so the sidecar's final "drain" signal is never needed again.
  app.use("*", drainMiddleware());

  // Reject oversized bodies before auth/parsing (prevents OOM attack).
  app.use("*", bodyLimitMiddleware);
  // Block state-changing requests from disallowed origins (CSRF defense).
  app.use("*", csrfMiddleware);
  app.use("*", authenticate({
    getApiKey:  () => config.api_key,
    ...(config.getPendingApiKey !== undefined ? { getPendingKey: config.getPendingApiKey } : {}),
    tokenStore: config.tokenStore ?? null,
  }));
  app.use("*", rateLimiter(config.rate_limit));
  app.use("*", requestTimeout);
  // Read-only mode: block writes during update prepare, whitelist lifecycle paths.
  app.use("*", readonlyMiddleware());
  app.use("*", contentTypeJson);
  app.use("*", httpInputSanitizer({ mode: "block" }));

  // ------------------------------------------------------------------
  // Routes
  // ------------------------------------------------------------------
  app.route("/api/v1", createSystemRoutes(() => config.api_key));

  // Internal build-info endpoint — localhost only, no auth required
  app.get("/_sidjua/build", (c) => {
    const xff     = c.req.header("x-forwarded-for");
    const ip      = c.req.header("x-real-ip") ?? "";
    const isLocal = !xff && (ip === "" || ip === "127.0.0.1" || ip === "::1");
    if (!isLocal) {
      return c.json({ error: { code: "SYS-404", message: "Not Found" } }, 404);
    }
    return c.json({ ...BUILD_META, ts: Date.now() });
  });

  // ------------------------------------------------------------------
  // 404 handler
  // ------------------------------------------------------------------
  app.notFound((c) => {
    return c.json(
      {
        error: {
          code:        "SYS-404",
          message:     "Not Found",
          recoverable: false,
          request_id:  "unknown",
        },
      },
      404,
    );
  });

  // ------------------------------------------------------------------
  // Server lifecycle
  // ------------------------------------------------------------------
  let _running    = false;
  let _boundPort  = config.port;
  let _httpServer: HttpServer | null = null;
  let _inflightCount = 0;

  const host = config.host;

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      // Build request handler (shared by HTTP and HTTPS listeners)
      const handler = (req: IncomingMessage, res: ServerResponse): void => {
        _inflightCount++;
        const webReq = toWebRequest(req, `${host}:${_boundPort}`);
        Promise.resolve(app.fetch(webReq))
          .then((webRes: Response) => sendWebResponse(webRes, res))
          .catch((err: unknown) => {
            logger.error("http_handler_error", "Unhandled error in HTTP handler", {
              error: { code: "SYS-001", message: String(err) },
            });
            if (!res.headersSent) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: { code: "SYS-001", message: "Internal server error", recoverable: true } }));
            }
          })
          .finally(() => {
            _inflightCount--;
          });
      };

      // Select HTTP or HTTPS server based on TLS config
      const tls = config.tls;
      let server: HttpServer;
      if (tls?.enabled) {
        try {
          const cert = readFileSync(tls.cert, "utf-8");
          const key  = readFileSync(tls.key,  "utf-8");
          server = createHttpsServer({ cert, key }, handler) as unknown as HttpServer;
        } catch (err: unknown) {
          logger.error("tls_load_error", "Failed to load TLS cert/key — falling back to HTTP", {
            error: { code: "SYS-002", message: String(err) },
          });
          server = createServer(handler);
        }
      } else {
        server = createServer(handler);
      }

      _httpServer = server;

      server.on("error", (err) => {
        _running = false;
        reject(err);
      });

      const proto = (tls?.enabled) ? "https" : "http";
      server.listen(config.port, config.host, () => {
        const addr = server.address();
        if (addr !== null && typeof addr === "object") {
          _boundPort = addr.port;
        }
        _running = true;

        logger.info("api_server_started", `SIDJUA API server running on ${proto}://${config.host}:${_boundPort}`, {
          metadata: { port: _boundPort, host: config.host, tls: tls?.enabled ?? false },
        });

        // Register graceful shutdown signals
        const shutdown = () => {
          void stop();
        };
        process.once("SIGTERM", shutdown);
        process.once("SIGINT",  shutdown);

        resolve();
      });
    });

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (!_running || _httpServer === null) {
        resolve();
        return;
      }
      _running = false;

      const server = _httpServer;
      _httpServer  = null;

      // Close server (stop accepting new connections)
      server.close(() => {
        logger.info("api_server_stopped", "API server stopped", {});
        resolve();
      });

      // Drain in-flight requests — wait up to 5 seconds
      const drainStart = Date.now();
      const drainInterval = setInterval(() => {
        if (_inflightCount === 0 || Date.now() - drainStart > 5_000) {
          clearInterval(drainInterval);
          // Force-destroy any remaining connections
          server.closeAllConnections?.();
        }
      }, 50);
    });

  return {
    app,
    start,
    stop,
    get running()   { return _running; },
    get boundPort() { return _boundPort; },
  };
}
