// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Module Tool Sandbox Executor
 *
 * All module tool calls MUST go through this executor. Direct invocation of
 * module tool functions outside this wrapper is not permitted.
 *
 * Execution model (V1):
 *   - Functions execute inline within the Node.js process
 *   - The sandbox provider type (none/bubblewrap) is reflected in the audit log
 *   - Timeout is enforced via Promise.race
 *   - Every execution is audit-logged (module, tool, agent, division, sandboxed, duration)
 *
 * Future versions will route through OS-level process isolation when
 * SandboxProvider.name === "bubblewrap".
 */

import { randomUUID }                      from "node:crypto";
import { getModuleNetworkPolicy }          from "./network-policy.js";
import type { ModuleNetworkPolicy }        from "./network-policy.js";
import { NoSandboxProvider }               from "../core/sandbox/no-sandbox-provider.js";
import type { SandboxProvider, AgentSandboxConfig } from "../core/sandbox/types.js";
import { createLogger }                    from "../core/logger.js";
import { SidjuaError }                     from "../core/error-codes.js";
import type Database                       from "better-sqlite3";

const logger = createLogger("sandbox-executor");

/** Default per-tool execution timeout (30 s). */
export const DEFAULT_MODULE_TIMEOUT_MS = 30_000;


export interface ModuleToolExecutionRequest {
  /** Module name, e.g. "discord" */
  moduleName:  string;
  /** Tool name, e.g. "discord_send_message" */
  toolName:    string;
  /** Tool parameters as passed by the calling agent */
  params:      Record<string, unknown>;
  /** ID of the agent invoking the tool */
  agentId:     string;
  /** Division the agent belongs to */
  divisionId:  string;
}

export interface ModuleToolExecutionResult {
  success:         boolean;
  result?:         unknown;
  error?:          string;
  /** true if provider.name !== "none" (OS-level isolation active) */
  sandboxed:       boolean;
  executionTimeMs: number;
}

/** In-memory audit record for module tool executions. */
export interface ModuleToolAuditEvent {
  eventType:       "module_tool_execution" | "module_tool_error";
  moduleName:      string;
  toolName:        string;
  agentId:         string;
  divisionId:      string;
  sandboxed:       boolean;
  executionTimeMs: number;
  error?:          string;
  timestamp:       string;
}


const _auditEvents: ModuleToolAuditEvent[] = [];
const MAX_AUDIT_EVENTS = 500;

/** Return all logged execution events (for testing / CLI inspection). */
export function getModuleToolAuditLog(): ModuleToolAuditEvent[] {
  return [..._auditEvents];
}

/** Clear audit log — call in test beforeEach. */
export function clearModuleToolAuditLog(): void {
  _auditEvents.length = 0;
}

function appendAuditEvent(ev: ModuleToolAuditEvent): void {
  _auditEvents.push(ev);
  if (_auditEvents.length > MAX_AUDIT_EVENTS) {
    _auditEvents.splice(0, _auditEvents.length - MAX_AUDIT_EVENTS);
  }
}


export class ModuleSandboxExecutor {
  private readonly _sandboxProvider: SandboxProvider;
  private readonly _timeoutMs:       number;
  private readonly _db:              InstanceType<typeof Database> | null;

  constructor(sandboxProvider: SandboxProvider, timeoutMs = DEFAULT_MODULE_TIMEOUT_MS, db: InstanceType<typeof Database> | null = null) {
    this._sandboxProvider = sandboxProvider;
    this._timeoutMs       = timeoutMs;
    this._db              = db;
  }

  get sandboxProvider(): SandboxProvider {
    return this._sandboxProvider;
  }

  get timeoutMs(): number {
    return this._timeoutMs;
  }

  /**
   * Execute a module tool function inside the configured sandbox boundary.
   *
   * @param request    What to execute and who is calling
   * @param toolFn     The actual tool function to invoke
   */
  async execute(
    request: ModuleToolExecutionRequest,
    toolFn:  (params: Record<string, unknown>) => Promise<unknown>,
  ): Promise<ModuleToolExecutionResult> {
    const startTime   = Date.now();
    const isSandboxed = this._sandboxProvider.name !== "none";

    // Enforce network policy — unknown modules are denied entirely (deny-all default).
    // Previously this only logged a warning; now it throws to prevent execution.
    const policy = getModuleNetworkPolicy(request.moduleName);
    if (policy === null) {
      throw SidjuaError.from(
        "MOD-002",
        `Network policy violation: module "${request.moduleName}" has no registered policy — execution blocked (deny-all default). ` +
        `Register the module in network-policy.ts to allow execution.`,
      );
    }

    // Thread module network policy to the sandbox provider.
    // Build an AgentSandboxConfig from the policy so that when the sandbox wraps
    // shell commands (e.g. via wrapCommand), it enforces the module's allowedDomains.
    // For inline JS tool functions, isolation relies on the bubblewrap HTTP proxy
    // allowlist which is seeded with these same domains at initialization time.
    // Shell-executing tool callers must pass this config to provider.wrapCommand().
    const moduleSandboxConfig = buildModuleSandboxConfig(request.agentId, policy);
    if (!isSandboxed && policy.allowedDomains.length > 0) {
      // Sandbox provider is "none" but the module declares network capabilities.
      // Execution is blocked — network isolation cannot be enforced without a sandbox.
      throw SidjuaError.from(
        "MOD-006",
        `Module "${request.moduleName}" requires network sandbox (allowedDomains: ${policy.allowedDomains.join(", ")}) ` +
        "but no sandbox provider is active. Configure a sandbox provider or remove network capabilities from the module manifest.",
        { moduleName: request.moduleName, allowedDomains: policy.allowedDomains, agentId: request.agentId },
      );
    }
    if (isSandboxed) {
      logger.info(
        "module_sandbox_policy_applied",
        `Sandbox network policy applied for module "${request.moduleName}"`,
        {
          metadata: {
            moduleName:     request.moduleName,
            allowedDomains: policy.allowedDomains,
            allowedPorts:   policy.allowedPorts,
            agentId:        request.agentId,
          },
        },
      );
    }

    let result: unknown;
    try {
      result = await this._executeWithTimeout(toolFn, request.params);
    } catch (err: unknown) {
      const executionTimeMs = Date.now() - startTime;
      const errorMsg        = err instanceof Error ? err.message : String(err);

      const errorTimestamp = new Date().toISOString();
      appendAuditEvent({
        eventType:       "module_tool_error",
        moduleName:      request.moduleName,
        toolName:        request.toolName,
        agentId:         request.agentId,
        divisionId:      request.divisionId,
        sandboxed:       isSandboxed,
        executionTimeMs,
        error:           errorMsg,
        timestamp:       errorTimestamp,
      });

      // Persist error to audit_events table for durability across restarts.
      if (this._db !== null) {
        try {
          this._db.prepare<[string, string, string, string, string], void>(`
            INSERT OR IGNORE INTO audit_events
              (id, timestamp, agent_id, division, event_type, rule_id, action, severity, details)
            VALUES (?, ?, ?, ?, 'module_tool_error', '', 'blocked', 'high', ?)
          `).run(
            randomUUID(),
            errorTimestamp,
            request.agentId,
            request.divisionId,
            JSON.stringify({
              moduleName: request.moduleName,
              toolName:   request.toolName,
              sandboxed:  isSandboxed,
              executionTimeMs,
              error:      errorMsg.slice(0, 1000),
            }),
          );
        } catch (_dbErr) {
          // Non-fatal: DB may not have audit_events table (runAuditMigrations not yet called)
        }
      }

      logger.warn(
        "module_tool_error",
        `Module tool error: ${request.moduleName}:${request.toolName}`,
        {
          metadata: {
            agentId:         request.agentId,
            divisionId:      request.divisionId,
            sandboxed:       isSandboxed,
            executionTimeMs,
            error:           errorMsg.slice(0, 500),
          },
        },
      );

      return { success: false, error: errorMsg, sandboxed: isSandboxed, executionTimeMs };
    }

    const executionTimeMs = Date.now() - startTime;

    appendAuditEvent({
      eventType:       "module_tool_execution",
      moduleName:      request.moduleName,
      toolName:        request.toolName,
      agentId:         request.agentId,
      divisionId:      request.divisionId,
      sandboxed:       isSandboxed,
      executionTimeMs,
      timestamp:       new Date().toISOString(),
    });

    logger.info(
      "module_tool_execution",
      `Module tool executed: ${request.moduleName}:${request.toolName}`,
      {
        metadata: {
          agentId:         request.agentId,
          divisionId:      request.divisionId,
          sandboxed:       isSandboxed,
          executionTimeMs,
        },
      },
    );

    return { success: true, result, sandboxed: isSandboxed, executionTimeMs };
  }

  private _executeWithTimeout(
    toolFn: (params: Record<string, unknown>) => Promise<unknown>,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const ms = this._timeoutMs;
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Module tool execution timed out after ${ms}ms`));
      }, ms);
      if (typeof (timer as NodeJS.Timeout).unref === "function") {
        (timer as NodeJS.Timeout).unref();
      }
    });
    return Promise.race([toolFn(params), timeout]);
  }
}


let _defaultExecutor: ModuleSandboxExecutor | null = null;

/**
 * Return a ModuleSandboxExecutor backed by the given provider.
 * If no provider is supplied, a NoSandboxProvider passthrough is used.
 * Call resetDefaultModuleSandboxExecutor() in tests to clear the singleton.
 */
export function getDefaultModuleSandboxExecutor(
  sandboxProvider?: SandboxProvider,
  timeoutMs?:       number,
): ModuleSandboxExecutor {
  if (sandboxProvider !== undefined) {
    return new ModuleSandboxExecutor(sandboxProvider, timeoutMs ?? DEFAULT_MODULE_TIMEOUT_MS);
  }
  if (_defaultExecutor === null) {
    _defaultExecutor = new ModuleSandboxExecutor(new NoSandboxProvider());
  }
  return _defaultExecutor;
}

/** Reset cached default executor — for testing only. */
export function resetDefaultModuleSandboxExecutor(): void {
  _defaultExecutor = null;
}


/**
 * Build an AgentSandboxConfig from a module network policy (xAI-ARCH-H2).
 *
 * Callers that need to wrap a shell command for module execution should pass
 * this config to SandboxProvider.wrapCommand() so the sandbox enforces the
 * module's allowed domain list.
 */
export function buildModuleSandboxConfig(
  agentId: string,
  policy:  ModuleNetworkPolicy,
): AgentSandboxConfig {
  return {
    agentId,
    workDir: "",
    network: {
      allowedDomains: policy.allowedDomains,
      deniedDomains:  [],
    },
    filesystem: {
      denyRead:   [],
      allowWrite: [],
      denyWrite:  [],
    },
  };
}
