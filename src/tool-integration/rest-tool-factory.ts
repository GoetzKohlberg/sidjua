// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — REST Tool Factory (P389)
 *
 * Reads rest-tools.yaml, creates RestAdapter instances with path_template routing,
 * registers them in ToolRegistry, and mounts them in ToolManager.
 */

import { createLogger } from "../core/logger.js";
import { ToolRegistry }  from "./tool-registry.js";
import { ToolManager }   from "./tool-manager.js";
import { RestAdapter }   from "./adapters/rest-adapter.js";
import {
  loadRestToolsConfig,
  toCapabilityRoute,
  type RestToolEntry,
} from "./rest-config.js";
import type { RestToolConfig, ToolCapability } from "./types.js";

const logger = createLogger("rest-tool-factory");


/** Signature of SecretsService.resolve — injected to avoid a hard circular dep. */
export type SecretResolver = (value: string) => string;


export class RestToolFactory {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly manager:  ToolManager,
    private readonly resolveSecret: SecretResolver = (v) => v,
  ) {}

  /**
   * Load rest-tools.yaml from `configPath` (default: `./config/rest-tools.yaml`),
   * register each valid tool, and return the count of successfully registered tools.
   */
  async loadAndRegister(configPath?: string): Promise<number> {
    const config = loadRestToolsConfig(configPath);

    if (config.tools.length === 0) {
      logger.info("rest_factory_no_tools", "No REST tools configured — skipping registration", {});
      return 0;
    }

    let count = 0;
    for (const entry of config.tools) {
      try {
        this.registerTool(entry);
        count++;
      } catch (err) {
        logger.warn("rest_factory_register_error", "Failed to register REST tool — skipping", {
          metadata: { id: entry.id, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    logger.info("rest_factory_registered", `Registered ${count} REST tool(s)`, { metadata: { count } });
    return count;
  }

  /**
   * Register a single REST tool entry into ToolRegistry + ToolManager.
   * Idempotent: if the tool already exists in the registry, re-registers the adapter
   * in ToolManager (adapter is always recreated to pick up config changes).
   */
  registerTool(entry: RestToolEntry): void {
    const restConfig = this.buildRestConfig(entry);
    const capabilities = this.buildCapabilities(entry);

    // Upsert into ToolRegistry (create only if not already present)
    let exists = false;
    try { this.registry.getById(entry.id); exists = true; } catch (_e) { /* not found */ }

    if (!exists) {
      this.registry.create({
        id:   entry.id,
        name: entry.name,
        type: "rest",
        config: restConfig,
        capabilities: capabilities.map(({ id: _id, tool_id: _tid, ...rest }) => rest),
      });
    }

    // Always mount a fresh adapter in ToolManager (picks up any config/secret changes)
    const adapter = new RestAdapter(entry.id, restConfig, capabilities);
    this.manager.registerAdapter(entry.id, adapter);

    logger.info("rest_tool_registered", `REST tool registered: ${entry.id}`, {
      metadata: { id: entry.id, capabilities: capabilities.length },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildRestConfig(entry: RestToolEntry): RestToolConfig {
    const routes: RestToolConfig["routes"] = {};

    for (const cap of entry.capabilities) {
      routes[cap.name] = toCapabilityRoute(cap);
    }

    const resolvedAuth = entry.auth !== undefined
      ? this.resolveAuth(entry.auth)
      : undefined;

    return {
      type:     "rest",
      base_url: this.resolveEnvUrl(entry.base_url),
      routes,
      ...(entry.timeout_ms !== undefined ? { timeout_ms: entry.timeout_ms } : {}),
      ...(resolvedAuth !== undefined ? { auth: resolvedAuth } : {}),
    };
  }

  private resolveAuth(auth: NonNullable<RestToolEntry["auth"]>): RestToolConfig["auth"] {
    switch (auth.type) {
      case "bearer":
        return {
          type: "bearer",
          ...(auth.token !== undefined ? { token: this.resolveSecret(auth.token) } : {}),
        };

      case "basic":
        return {
          type: "basic",
          ...(auth.username !== undefined ? { username: this.resolveSecret(auth.username) } : {}),
          ...(auth.password !== undefined ? { password: this.resolveSecret(auth.password) } : {}),
        };

      case "header":
        return {
          type: "header",
          ...(auth.header_name  !== undefined ? { header_name:  auth.header_name } : {}),
          ...(auth.header_value !== undefined ? { header_value: this.resolveSecret(auth.header_value) } : {}),
        };
    }
  }

  private buildCapabilities(entry: RestToolEntry): ToolCapability[] {
    return entry.capabilities.map((cap) => ({
      id:                `${entry.id}:${cap.name}`,
      tool_id:           entry.id,
      name:              cap.name,
      description:       cap.description,
      risk_level:        cap.risk_level,
      requires_approval: cap.requires_approval,
      input_schema:      cap.input_schema  ?? {},
      output_schema:     cap.output_schema ?? {},
    }));
  }

  /**
   * Resolve `${ENV_VAR:-default}` syntax in base_url strings.
   * Supports only the `${VAR:-default}` form; plain `${VAR}` also supported.
   */
  private resolveEnvUrl(url: string): string {
    return url.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const colonDash = expr.indexOf(":-");
      if (colonDash !== -1) {
        const varName    = expr.slice(0, colonDash);
        const defaultVal = expr.slice(colonDash + 2);
        return process.env[varName] ?? defaultVal;
      }
      return process.env[expr] ?? "";
    });
  }
}
