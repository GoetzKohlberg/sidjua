// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Provider Configuration REST Endpoints
 *
 * GET    /api/v1/provider/catalog         — list approved providers
 * GET    /api/v1/provider/config          — get current config (keys masked)
 * PUT    /api/v1/provider/config          — save provider config
 * DELETE /api/v1/provider/config          — reset provider config
 * POST   /api/v1/provider/test            — test an API key (rate-limited 5/min)
 */

import { createHash }         from "node:crypto";
import { Hono }               from "hono";
import { SidjuaError }        from "../../core/error-codes.js";
import { createLogger }       from "../../core/logger.js";
import { requireScope }       from "../middleware/require-scope.js";
import { getClientIp }        from "../middleware/rate-limiter.js";
import { validateProviderUrl } from "../../core/network/url-validator.js";
import { loadApprovedProviders } from "../../defaults/loader.js";
import type { ApprovedProvider } from "../../defaults/provider-types.js";
import {
  getProviderConfig,
  saveProviderConfig,
  deleteProviderConfig,
  isProviderConfigured,
} from "../../core/provider-config.js";
import type { ConfiguredProvider, ProviderConfig } from "../../core/provider-config.js";

const logger = createLogger("provider-routes");


interface TestBucket { count: number; windowStart: number }
const _testBuckets = new Map<string, TestBucket>();
const TEST_MAX     = 5;
const TEST_WINDOW  = 60_000;

/** Reset state — for testing only. */
export function clearProviderTestRateLimit(): void {
  _testBuckets.clear();
}

function checkTestRateLimit(clientKey: string): boolean {
  const now    = Date.now();
  const bucket = _testBuckets.get(clientKey);

  if (bucket === undefined || now - bucket.windowStart > TEST_WINDOW) {
    _testBuckets.set(clientKey, { count: 1, windowStart: now });
    return true;
  }

  if (bucket.count >= TEST_MAX) return false;
  bucket.count++;
  return true;
}

function testClientKey(authHeader: string | undefined, ipHeader: string | undefined): string {
  if (authHeader !== undefined) {
    const hash = createHash("sha256").update(authHeader).digest("hex").slice(0, 16);
    return `key:${hash}`;
  }
  return `ip:${ipHeader ?? "unknown"}`;
}


function isValidApiBase(url: string): boolean {
  // Delegates to validateProviderUrl with allowCustom: true so non-standard
  // endpoints are accepted, while private/reserved IP ranges are still blocked.
  return validateProviderUrl(url, { allowCustom: true }).valid;
}

/**
 * D2/D5: Detect preview-mask strings that the GUI masked for display.
 * A masked key contains "..." or "…" (Unicode ellipsis) or 4+ consecutive "*".
 * These must never be stored as real keys.
 */
function isPreviewMask(key: string): boolean {
  return key.includes('...') || key.includes('\u2026') || /\*{4,}/.test(key);
}

function maskApiKey(key: string): string {
  if (!key || key.length < 4) return "****";
  const underscoreIdx = key.indexOf("_");
  const prefix = underscoreIdx > 0 ? key.slice(0, underscoreIdx + 1) : key.slice(0, Math.min(4, key.length));
  const suffix = key.slice(-4);
  if (prefix.length + 4 >= key.length) return `${prefix}...`;
  return `${prefix}...${suffix}`;
}

function providerToPublic(p: ConfiguredProvider, catalogProviders: ApprovedProvider[]): {
  provider_id:      string;
  display_name:     string;
  api_key_set:      boolean;
  api_key_preview:  string;
  api_base?:        string;
  model?:           string;
  custom_name?:     string;
  models?:          Array<{ model: string; display_name: string; recommended: boolean }>;
} {
  const entry = catalogProviders.find((c) => c.id === p.provider_id);
  // All models from catalog providers that share the same provider name
  const providerName = entry?.name;
  const models = providerName
    ? catalogProviders
        .filter((c) => c.name === providerName)
        .map((c) => ({ model: c.model, display_name: c.display_name, recommended: c.recommended }))
    : undefined;

  return {
    provider_id:     p.provider_id,
    display_name:    p.custom_name ?? entry?.display_name ?? p.provider_id,
    api_key_set:     p.api_key.length > 0,
    api_key_preview: maskApiKey(p.api_key),
    ...(p.api_base    !== undefined ? { api_base:    p.api_base }    : {}),
    ...(p.model       !== undefined ? { model:       p.model }       : {}),
    ...(p.custom_name !== undefined ? { custom_name: p.custom_name } : {}),
    ...(models !== undefined && models.length > 0 ? { models } : {}),
  };
}


export function registerProviderRoutes(app: Hono): void {
  let _catalog: ReturnType<typeof loadApprovedProviders> | undefined;

  function catalog() {
    if (!_catalog) _catalog = loadApprovedProviders();
    return _catalog;
  }

  // ── GET /api/v1/provider/catalog ─────────────────────────────────────────
  app.get("/api/v1/provider/catalog", requireScope("readonly"), (c) => {
    return c.json(catalog());
  });

  // ── GET /api/v1/provider/config ──────────────────────────────────────────
  app.get("/api/v1/provider/config", requireScope("admin"), (c) => {
    const config      = getProviderConfig();
    const catProviders = catalog().providers;
    const configured  = config !== null && config.default_provider !== null;

    if (!configured || config === null || config.default_provider === null) {
      return c.json({ configured: false, mode: "simple", default_provider: null, agent_overrides: {} });
    }

    const overridesPublic: Record<string, ReturnType<typeof providerToPublic>> = {};
    for (const [agentId, p] of Object.entries(config.agent_overrides)) {
      overridesPublic[agentId] = providerToPublic(p, catProviders);
    }

    return c.json({
      configured:       true,
      mode:             config.mode,
      default_provider: providerToPublic(config.default_provider, catProviders),
      agent_overrides:  overridesPublic,
    });
  });

  // ── PUT /api/v1/provider/config ──────────────────────────────────────────
  app.put("/api/v1/provider/config", requireScope("admin"), async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch (_parseErr: unknown) {
      throw SidjuaError.from("PCFG-004", "Request body must be valid JSON");
    }

    const mode = body["mode"];
    if (mode !== "simple" && mode !== "advanced") {
      throw SidjuaError.from("PCFG-004", "mode must be 'simple' or 'advanced'");
    }

    const defaultProviderRaw = body["default_provider"] as Record<string, unknown> | null | undefined;
    if (defaultProviderRaw === undefined || defaultProviderRaw === null) {
      throw SidjuaError.from("PCFG-004", "default_provider is required");
    }

    const providerId = defaultProviderRaw["provider_id"];
    if (typeof providerId !== "string" || providerId.trim() === "") {
      throw SidjuaError.from("PCFG-004", "default_provider.provider_id is required");
    }

    const apiKeyRaw = defaultProviderRaw["api_key"];
    const isCustom  = providerId === "custom";

    // D2/D5: Validate api_key when present.
    // - Empty string → reject (client should omit, not send "")
    // - Preview mask → reject with PCFG-006 (defense-in-depth against GUI bug)
    // - Omitted (undefined) → keep existing stored key
    if (typeof apiKeyRaw === "string") {
      if (apiKeyRaw.trim() === "") {
        throw SidjuaError.from("PCFG-004", "default_provider.api_key must not be empty; omit the field to keep the existing key");
      }
      if (isPreviewMask(apiKeyRaw.trim())) {
        throw SidjuaError.from("PCFG-006", "default_provider.api_key appears to be a masked preview value; enter the full API key");
      }
    }

    // D5: omitted api_key → keep existing stored key for this provider.
    const existingStoredConfig = getProviderConfig();
    const storedKey =
      existingStoredConfig?.default_provider?.provider_id === providerId.trim()
        ? existingStoredConfig.default_provider.api_key
        : "";
    const apiKey = typeof apiKeyRaw === "string" ? apiKeyRaw.trim() : storedKey;

    // For custom providers, api_key is optional (Ollama doesn't need one).
    // For approved providers, api_key is required.
    if (!isCustom && apiKey === "") {
      throw SidjuaError.from("PCFG-004", "default_provider.api_key is required for non-custom providers");
    }

    // For custom providers, validate api_base
    let apiBase: string | undefined;
    if (isCustom) {
      const rawBase = defaultProviderRaw["api_base"];
      if (typeof rawBase !== "string" || rawBase.trim() === "") {
        throw SidjuaError.from("PCFG-004", "custom providers require api_base");
      }
      if (!isValidApiBase(rawBase)) {
        throw SidjuaError.from("PCFG-002", `api_base "${rawBase}" must be https:// or http://localhost`);
      }
      apiBase = rawBase.trim();
    } else {
      // Validate provider exists in catalog
      const cat     = catalog();
      const entry   = cat.providers.find((p) => p.id === providerId);
      if (!entry) {
        throw SidjuaError.from("PCFG-001", `Provider "${providerId}" not found in approved catalog`);
      }
      apiBase = entry.api_base;
    }

    const modelRaw       = defaultProviderRaw["model"];
    const customNameRaw  = defaultProviderRaw["custom_name"];

    const defaultProvider: ConfiguredProvider = {
      provider_id:  providerId.trim(),
      api_key:      apiKey,
      api_base:     apiBase,
      ...(typeof modelRaw       === "string" ? { model:       modelRaw.trim() }       : {}),
      ...(typeof customNameRaw  === "string" ? { custom_name: customNameRaw.trim() }  : {}),
    };

    // Handle agent_overrides (advanced mode) — D2/D5/D6
    const agentOverrides: Record<string, ConfiguredProvider> = {};
    const overridesRaw = body["agent_overrides"] as Record<string, unknown> | undefined;
    if (overridesRaw !== undefined && typeof overridesRaw === "object") {
      for (const [agentId, pRaw] of Object.entries(overridesRaw)) {
        const p = pRaw as Record<string, unknown>;
        const oProviderId = p["provider_id"];
        if (typeof oProviderId !== "string") continue;

        const oIsCustom  = oProviderId === "custom";
        const oApiKeyRaw = p["api_key"];

        // D2/D5: Validate api_key when present in override
        if (typeof oApiKeyRaw === "string") {
          if (oApiKeyRaw.trim() === "") {
            throw SidjuaError.from("PCFG-004", `agent_overrides['${agentId}'].api_key must not be empty; omit to inherit default`);
          }
          if (isPreviewMask(oApiKeyRaw.trim())) {
            throw SidjuaError.from("PCFG-006", `agent_overrides['${agentId}'].api_key appears to be a masked preview value`);
          }
        }

        // D5: omitted api_key in override → keep existing override key (or "" for new overrides)
        const oStoredKey = existingStoredConfig?.agent_overrides?.[agentId]?.api_key ?? "";
        const oApiKey    = typeof oApiKeyRaw === "string" ? oApiKeyRaw.trim() : oStoredKey;

        // D6: custom agent override requires api_base, model, custom_name
        if (oIsCustom) {
          const oApiBase    = p["api_base"];
          const oModel      = p["model"];
          const oCustomName = p["custom_name"];
          if (typeof oApiBase !== "string" || oApiBase.trim() === "") {
            throw SidjuaError.from("PCFG-004", `agent_overrides['${agentId}']: custom provider requires api_base`);
          }
          if (typeof oModel !== "string" || oModel.trim() === "") {
            throw SidjuaError.from("PCFG-004", `agent_overrides['${agentId}']: custom provider requires model`);
          }
          if (typeof oCustomName !== "string" || oCustomName.trim() === "") {
            throw SidjuaError.from("PCFG-004", `agent_overrides['${agentId}']: custom provider requires custom_name`);
          }
        }

        agentOverrides[agentId] = {
          provider_id: oProviderId,
          api_key:     oApiKey,  // "" means "inherit default at runtime" for new custom overrides
          ...(typeof p["api_base"]    === "string" ? { api_base:    p["api_base"] }    : {}),
          ...(typeof p["model"]       === "string" ? { model:       p["model"] }       : {}),
          ...(typeof p["custom_name"] === "string" ? { custom_name: p["custom_name"] } : {}),
        };
      }
    }

    const config: ProviderConfig = {
      mode:             mode,
      default_provider: defaultProvider,
      agent_overrides:  agentOverrides,
    };

    saveProviderConfig(config);

    const catProviders2 = catalog().providers;
    const overridesPublic: Record<string, ReturnType<typeof providerToPublic>> = {};
    for (const [agentId, p] of Object.entries(agentOverrides)) {
      overridesPublic[agentId] = providerToPublic(p, catProviders2);
    }

    return c.json({
      configured:       true,
      mode:             mode,
      default_provider: providerToPublic(defaultProvider, catProviders2),
      agent_overrides:  overridesPublic,
    });
  });

  // ── DELETE /api/v1/provider/config ───────────────────────────────────────
  app.delete("/api/v1/provider/config", requireScope("admin"), (c) => {
    deleteProviderConfig();
    return c.json({ configured: false, message: "Provider config cleared" });
  });

  // ── POST /api/v1/provider/test ───────────────────────────────────────────
  app.post("/api/v1/provider/test", requireScope("admin"), async (c) => {
    // Rate limit: 5 per minute per client key
    const clientKey = testClientKey(
      c.req.header("Authorization"),
      getClientIp(c.req.raw.headers),
    );
    if (!checkTestRateLimit(clientKey)) {
      return c.json({ status: "error", error: "Too many test requests. Try again in a minute." }, 429);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch (_parseErr: unknown) {
      throw SidjuaError.from("PCFG-004", "Request body must be valid JSON");
    }

    const providerId = body["provider_id"];
    const apiKey     = body["api_key"];
    let   apiBase    = body["api_base"];
    let   model      = body["model"];

    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw SidjuaError.from("PCFG-004", "api_key is required");
    }

    // Resolve api_base and model from catalog if provider_id is given
    if (typeof providerId === "string" && providerId !== "custom") {
      const cat   = catalog();
      const entry = cat.providers.find((p) => p.id === providerId);
      if (!entry) {
        throw SidjuaError.from("PCFG-001", `Provider "${providerId}" not found in catalog`);
      }
      if (apiBase === undefined || apiBase === "") apiBase = entry.api_base;
      if (model   === undefined || model   === "") model   = entry.model;
    }

    if (typeof apiBase !== "string" || apiBase.trim() === "") {
      throw SidjuaError.from("PCFG-002", "api_base is required");
    }
    if (!isValidApiBase(apiBase)) {
      throw SidjuaError.from("PCFG-002", `api_base "${apiBase}" must be https:// or http://localhost`);
    }
    if (typeof model !== "string" || model.trim() === "") {
      throw SidjuaError.from("PCFG-004", "model is required");
    }

    const cleanKey   = apiKey.trim();
    const cleanBase  = (apiBase as string).trim().replace(/\/$/, "");
    const cleanModel = (model as string).trim();

    // SSRF protection: validate the resolved URL before making a server-side request.
    // Private IP ranges are always blocked; unknown provider domains are blocked unless
    // the operator has explicitly enabled custom providers in their configuration.
    const urlCheck = validateProviderUrl(cleanBase, { allowCustom: false });
    if (!urlCheck.valid) {
      return c.json(
        { error: { code: "PCFG-002", message: urlCheck.reason ?? "Invalid provider URL" } },
        400,
      );
    }

    // Perform test request with 15s timeout
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 15_000);
    const start      = Date.now();

    try {
      const res = await fetch(`${cleanBase}/chat/completions`, {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${cleanKey}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          model:      cleanModel,
          messages:   [{ role: "user", content: "Reply with exactly: SIDJUA OK" }],
          max_tokens: 10,
        }),
        signal: controller.signal,
      });

      const elapsed = Date.now() - start;

      if (res.ok) {
        logger.info("provider_test", "Provider test succeeded", {
          metadata: { provider_id: providerId, response_time_ms: elapsed },
        });
        return c.json({
          status:           "ok",
          model:            cleanModel,
          response_time_ms: elapsed,
          message:          "Connection successful",
        });
      }

      // Non-2xx response
      const text = await res.text().catch(() => "");
      // Truncate to avoid leaking large error bodies; never log the key
      const detail = `${res.status} from ${new URL(cleanBase).hostname}`;
      let errorMsg = "Connection failed";
      if (res.status === 401 || res.status === 403) errorMsg = "Invalid API key";
      else if (res.status === 404)                  errorMsg = "API endpoint not found";
      else if (res.status === 429)                  errorMsg = "Provider rate limited";
      else if (res.status >= 500)                   errorMsg = "Provider server error";

      logger.info("provider_test", "Provider test failed", {
        metadata: { provider_id: providerId, http_status: res.status },
      });

      return c.json({ status: "error", error: errorMsg, details: detail });
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const isAbort2 = err instanceof Error && err.name === "AbortError";
      if (isAbort || isAbort2) {
        return c.json({ status: "error", error: "Connection timeout (15s)", details: "Request timed out" });
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.info("provider_test", "Provider test network error", {
        metadata: { provider_id: providerId, error_type: err instanceof TypeError ? "network" : "unknown" },
      });
      return c.json({ status: "error", error: "Network error", details: msg });
    } finally {
      clearTimeout(timer);
    }
  });
}

export { isProviderConfigured };
