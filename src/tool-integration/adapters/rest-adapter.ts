// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * REST adapter — uses native fetch() (Node 22+).
 * Injects auth headers; retries on 429/503/504 with 1s/2s/4s backoff.
 */

import type {
  ToolAdapter,
  ToolAction,
  ToolCapability,
  ToolResult,
  ToolType,
  RestToolConfig,
  RestCapabilityRoute,
} from "../types.js";
import { createLogger } from "../../core/logger.js";
import { SidjuaError } from "../../core/error-codes.js";
import { validateOutboundUrlAsync } from "../../core/network/url-validator.js";

const logger = createLogger("rest-adapter");


const RETRY_STATUS_CODES = new Set([429, 503, 504]);
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const MAX_ATTEMPTS = 3;


/**
 * Enforce SSRF protection on a URL using DNS-resolution validation.
 *
 * Calls validateOutboundUrlAsync (static checks + DNS lookup) to prevent
 * DNS rebinding attacks, then enforces any configured domain allowlist.
 *
 * @throws SidjuaError SSRF-001 on scheme / format violation
 * @throws SidjuaError SSRF-002 on private/loopback host (static check)
 * @throws SidjuaError SSRF-003 on private/loopback DNS resolution
 * @throws SidjuaError REST-SEC-002 on domain not in allowlist
 */
async function assertAllowedUrl(urlStr: string): Promise<void> {
  // DNS-resolving SSRF check (covers private IPs + DNS rebinding)
  await validateOutboundUrlAsync(urlStr);

  // Domain allowlist (operator-configured via SIDJUA_REST_ALLOWLIST)
  const allowList = process.env["SIDJUA_REST_ALLOWLIST"]
    ?.split(",")
    .map((d) => d.trim())
    .filter(Boolean) ?? [];

  if (allowList.length > 0) {
    let host: string;
    try {
      host = new URL(urlStr).hostname;
    } catch (_e) {
      throw SidjuaError.from("REST-SEC-001", `Invalid URL: ${urlStr}`);
    }
    if (!allowList.includes(host)) {
      throw SidjuaError.from("REST-SEC-002", `Request domain not in allowlist: ${host}`);
    }
  }
}


export class RestAdapter implements ToolAdapter {
  readonly id: string;
  readonly type: ToolType = "rest";

  private readonly config: RestToolConfig;
  private readonly capabilities: ToolCapability[];
  private connected = false;

  constructor(id: string, config: RestToolConfig, capabilities: ToolCapability[]) {
    this.id = id;
    this.config = config;
    this.capabilities = capabilities;
  }

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    // REST is stateless — nothing to establish
    this.connected = true;
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(action: ToolAction): Promise<ToolResult> {
    const start = Date.now();
    const params = action.params;

    // Template-based routing (populated by RestToolFactory)
    const route = this.config.routes?.[action.capability];
    if (route !== undefined) {
      return this.executeTemplated(action, route, start);
    }

    const url =
      typeof params["path"] === "string"
        ? this.config.base_url + params["path"]
        : this.config.base_url;

    const headers = this.buildAuthHeaders();
    headers["Content-Type"] = "application/json";

    const capability = action.capability.toLowerCase();

    let fetchInit: RequestInit;

    switch (capability) {
      case "get":
        fetchInit = { method: "GET", headers };
        break;

      case "post":
        fetchInit = {
          method: "POST",
          headers,
          body: JSON.stringify(params["body"] ?? {}),
        };
        break;

      case "put":
        fetchInit = {
          method: "PUT",
          headers,
          body: JSON.stringify(params["body"] ?? {}),
        };
        break;

      case "delete":
        fetchInit = { method: "DELETE", headers };
        break;

      default:
        return {
          success: false,
          error: `Unknown REST capability: ${action.capability}`,
          duration_ms: Date.now() - start,
        };
    }

    // Reject requests to private/local addresses (SSRF + DNS rebinding protection)
    await assertAllowedUrl(url);

    const timeoutMs = this.config.timeout_ms ?? 30_000;

    // Retry loop
    let lastError: string | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
        await sleep(delay);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, { ...fetchInit, signal: controller.signal });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // Network-level error (including timeout abort) — do not retry
        return {
          success: false,
          error: lastError,
          duration_ms: Date.now() - start,
        };
      } finally {
        clearTimeout(timer);
      }

      if (!RETRY_STATUS_CODES.has(response.status)) {
        // Terminal response (success or non-retryable error)
        const duration_ms = Date.now() - start;
        let data: unknown;
        try {
          data = await response.json();
        } catch (e: unknown) {
          logger.debug("rest-adapter", "REST response body not JSON — using text response", { metadata: { error: e instanceof Error ? e.message : String(e) } });
          data = null;
        }

        // Use conditional spread to satisfy exactOptionalPropertyTypes
        return {
          success: response.ok,
          ...(response.ok ? { data } : { error: response.statusText }),
          duration_ms,
        };
      }

      // Retryable status — record and loop
      lastError = `HTTP ${response.status}: ${response.statusText}`;
    }

    // All attempts exhausted
    return {
      success: false,
      error: lastError ?? "Max retries exceeded",
      duration_ms: Date.now() - start,
    };
  }

  // -------------------------------------------------------------------------
  // healthCheck
  // -------------------------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    const headers = this.buildAuthHeaders();
    const url = this.config.base_url + "/health";

    try {
      // Try /health first, fall back to base_url
      let response = await fetch(url, { method: "GET", headers });
      if (response.ok) return true;

      response = await fetch(this.config.base_url, { method: "GET", headers });
      return response.ok;
    } catch (e: unknown) {
      logger.warn("rest-adapter", "REST adapter health check failed — adapter may be unavailable", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    // No-op — REST is stateless
    this.connected = false;
  }

  // -------------------------------------------------------------------------
  // getCapabilities
  // -------------------------------------------------------------------------

  getCapabilities(): ToolCapability[] {
    return this.capabilities;
  }

  // -------------------------------------------------------------------------
  // Private: template-based routing
  // -------------------------------------------------------------------------

  /**
   * Execute a capability using a path_template route.
   * Substitutes {param} placeholders from action.params;
   * remaining params go to query string (GET) or JSON body (others).
   */
  private async executeTemplated(
    action: ToolAction,
    route: RestCapabilityRoute,
    start: number,
  ): Promise<ToolResult> {
    let pathWithQuery: string;
    let fetchInit: RequestInit;
    const headers = this.buildAuthHeaders();
    headers["Content-Type"] = "application/json";

    let substitutedPath: string;
    let remainingParams: Record<string, unknown>;
    try {
      const result = this.substitutePathTemplate(route.path_template, action.params);
      substitutedPath = result.path;
      remainingParams = result.remainingParams;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      };
    }

    if (route.method === "GET" || route.method === "DELETE") {
      // Remaining params → query string
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(remainingParams)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const queryString = qs.toString();
      pathWithQuery = queryString.length > 0 ? `${substitutedPath}?${queryString}` : substitutedPath;
      fetchInit = { method: route.method, headers };
    } else {
      // POST / PUT / PATCH → remaining params go to body
      pathWithQuery = substitutedPath;
      fetchInit = {
        method: route.method,
        headers,
        body: JSON.stringify(remainingParams),
      };
    }

    const url = this.config.base_url + pathWithQuery;
    await assertAllowedUrl(url);

    const timeoutMs = this.config.timeout_ms ?? 30_000;
    const maxResponseBytes = 1_048_576; // 1 MiB

    let lastError: string | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
        await sleep(delay);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, { ...fetchInit, signal: controller.signal });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        return { success: false, error: lastError, duration_ms: Date.now() - start };
      } finally {
        clearTimeout(timer);
      }

      if (!RETRY_STATUS_CODES.has(response.status)) {
        const duration_ms = Date.now() - start;
        let data: unknown;
        try {
          const text = await response.text();
          if (text.length > maxResponseBytes) {
            return { success: false, error: "Response exceeds 1 MiB limit", duration_ms };
          }
          try {
            data = JSON.parse(text) as unknown;
          } catch (_parseErr) {
            data = text;
          }
        } catch (e: unknown) {
          logger.debug("rest-adapter", "REST templated response body read failed", {
            metadata: { error: e instanceof Error ? e.message : String(e) },
          });
          data = null;
        }
        return {
          success: response.ok,
          ...(response.ok ? { data } : { error: response.statusText }),
          duration_ms,
        };
      }

      lastError = `HTTP ${response.status}: ${response.statusText}`;
    }

    return { success: false, error: lastError ?? "Max retries exceeded", duration_ms: Date.now() - start };
  }

  /**
   * Substitute `{param}` placeholders in a path template from action params.
   * Returns the substituted path and a map of remaining (unused) params.
   * Throws SidjuaError REST-001 if a placeholder has no corresponding param.
   */
  private substitutePathTemplate(
    template: string,
    params: Record<string, unknown>,
  ): { path: string; remainingParams: Record<string, unknown> } {
    const usedKeys = new Set<string>();
    const placeholders = [...template.matchAll(/\{([^}]+)\}/g)];

    let path = template;
    for (const match of placeholders) {
      const key = match[1];
      if (key === undefined) continue;
      const val = params[key];
      if (val === undefined || val === null) {
        throw SidjuaError.from("REST-001", `Missing required path parameter: ${key}`);
      }
      path = path.replace(`{${key}}`, encodeURIComponent(String(val)));
      usedKeys.add(key);
    }

    const remainingParams: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (!usedKeys.has(k)) remainingParams[k] = v;
    }

    return { path, remainingParams };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Build Authorization / custom headers from the configured auth block. */
  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const auth = this.config.auth;

    if (auth == null) {
      return headers;
    }

    switch (auth.type) {
      case "bearer":
        if (auth.token != null) {
          headers["Authorization"] = `Bearer ${auth.token}`;
        }
        break;

      case "basic": {
        const user = auth.username ?? "";
        const pass = auth.password ?? "";
        const b64 = Buffer.from(`${user}:${pass}`).toString("base64");
        headers["Authorization"] = `Basic ${b64}`;
        break;
      }

      case "header":
        if (auth.header_name != null && auth.header_value != null) {
          headers[auth.header_name] = auth.header_value;
        }
        break;
    }

    return headers;
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
