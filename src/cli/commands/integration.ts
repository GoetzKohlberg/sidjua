// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Integration Gateway CLI Commands
 *
 * sidjua integration list      — list all registered + discovered integrations
 * sidjua integration info <s>  — show adapter details for service <s>
 * sidjua integration add       — add a new integration from an OpenAPI spec URL
 * sidjua integration test <s>  — test connectivity to service <s>
 * sidjua integration audit     — query integration audit log
 * sidjua integration promote <s> — check / generate adapter for promotion
 */

import { join }        from "node:path";
import { existsSync }  from "node:fs";
import { formatTable } from "../formatters/table.js";
import { formatJson }  from "../formatters/json.js";
import { withCliDatabase }    from "../utils/with-cli-database.js";
import { AdapterRegistry }    from "../../integration-gateway/adapter-registry.js";
import { SchemaStore }        from "../../integration-gateway/schema-store.js";
import { parseOpenApiSpec }   from "../../integration-gateway/openapi-parser.js";
import { AdapterPromoter }    from "../../integration-gateway/adapter-promoter.js";
import { createLogger }       from "../../core/logger.js";
import { SidjuaError }        from "../../core/error-codes.js";
import type { AdapterDefinition } from "../../integration-gateway/types.js";
import { auditCliCommand }    from "../cli-audit.js";


/** Allowed characters for service/adapter names. */
const SERVICE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate a service or adapter name.
 * @throws SidjuaError INPUT-006 for names that contain path separators,
 *         special characters, or exceed the 64-char limit.
 */
function validateServiceName(name: string, label = "service"): string {
  if (!SERVICE_RE.test(name)) {
    throw SidjuaError.from(
      "INPUT-006",
      `Invalid ${label} name: "${name}". ` +
      "Must be 1-64 alphanumeric characters, hyphens, or underscores.",
    );
  }
  return name;
}

/**
 * Validate an OpenAPI spec URL.
 * Must be https:// or http://localhost (or http://127.0.0.1) for security.
 */
function validateSpecUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const isHttps    = parsed.protocol === "https:";
    const isLocalHttp = parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (!isHttps && !isLocalHttp) {
      throw new Error();
    }
  } catch (_e: unknown) {
    throw SidjuaError.from(
      "INPUT-006",
      `Invalid spec URL: "${url}". Must be https:// or http://localhost.`,
    );
  }
  return url;
}

const logger = createLogger("integration-cli");


function schemaDbPath(workDir: string): string {
  return join(workDir, ".system", "sidjua.db");
}


export interface IntegrationListOptions {
  workDir: string;
  json:    boolean;
}

export async function runIntegrationListCommand(
  opts: IntegrationListOptions,
): Promise<number> {
  const registry = new AdapterRegistry();
  await registry.loadFromDirectory(opts.workDir);
  const adapters = registry.listAdapters();

  // Also pull discovered schemas from schema store
  let discovered: Array<{ name: string; success_rate: number }> = [];
  const dbPath = schemaDbPath(opts.workDir);
  if (existsSync(dbPath)) {
    try {
      const store = new SchemaStore(dbPath);
      await store.init();
      const schemas = await store.listSchemas();
      discovered = schemas
        .filter((s) => adapters.every((a) => a.name !== s.service_name))
        .map((s) => ({ name: s.service_name, success_rate: s.success_rate }));
    } catch (e: unknown) {
      logger.debug("integration-cli", "Could not open schema store", {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  if (opts.json) {
    process.stdout.write(
      formatJson({
        adapters: adapters.map((a) => ({
          name:         a.name,
          protocol:     a.protocol,
          enabled:      a.enabled,
          action_count: Object.keys(a.actions).length,
          type:         a.type,
        })),
        discovered: discovered.map((d) => ({
          name:         d.name,
          type:         "discovered",
          success_rate: d.success_rate,
        })),
      }) + "\n",
    );
    return 0;
  }

  if (adapters.length === 0 && discovered.length === 0) {
    process.stdout.write("No integrations registered.\n");
    return 0;
  }

  process.stdout.write("Registered Integrations:\n\n");

  const rows = [
    ...adapters.map((a) => ({
      name:    a.name,
      protocol: protocolLabel(a.protocol),
      status:  a.enabled ? "enabled" : "disabled",
      actions: `${Object.keys(a.actions).length} actions`,
      type:    a.type,
    })),
    ...discovered.map((d) => ({
      name:    d.name,
      protocol: "?",
      status:  "enabled",
      actions: "?",
      type:    `discovered (${Math.round(d.success_rate * 100)}% success)`,
    })),
  ];

  process.stdout.write(
    formatTable(rows, {
      columns: [
        { header: "NAME",     key: "name"     },
        { header: "PROTOCOL", key: "protocol" },
        { header: "STATUS",   key: "status"   },
        { header: "ACTIONS",  key: "actions"  },
        { header: "TYPE",     key: "type"     },
      ],
      maxWidth: 140,
    }) + "\n",
  );
  return 0;
}


export interface IntegrationInfoOptions {
  workDir:  string;
  service:  string;
  json:     boolean;
}

export async function runIntegrationInfoCommand(
  opts: IntegrationInfoOptions,
): Promise<number> {
  try { validateServiceName(opts.service); }
  catch (e: unknown) {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const registry = new AdapterRegistry();
  await registry.loadFromDirectory(opts.workDir);
  const adapter = registry.getAdapter(opts.service);

  if (adapter === undefined) {
    process.stderr.write(`✗ Integration '${opts.service}' not found.\n`);
    return 1;
  }

  if (opts.json) {
    process.stdout.write(formatJson(adapter) + "\n");
    return 0;
  }

  process.stdout.write(`Integration: ${adapter.name}\n`);
  process.stdout.write(`Protocol: ${adapter.protocol.toUpperCase()}\n`);
  if (adapter.base_url)    process.stdout.write(`Base URL: ${adapter.base_url}\n`);
  if (adapter.script_path) process.stdout.write(`Script: ${adapter.script_path}\n`);
  if (adapter.auth) {
    const authDesc = adapter.auth.header
      ? `${adapter.auth.type} (${adapter.auth.header})`
      : adapter.auth.type;
    process.stdout.write(`Auth: ${authDesc}\n`);
  } else {
    process.stdout.write("Auth: none\n");
  }

  process.stdout.write("\nActions:\n");
  for (const [name, action] of Object.entries(adapter.actions)) {
    const method = action.method ?? "—";
    const path   = action.path   ?? action.function ?? action.command ?? "—";
    const gov    = action.governance;
    const approval = gov.require_approval === true ? "yes"
      : gov.require_approval === "conditional" ? "conditional" : "no";
    process.stdout.write(
      `  ${name.padEnd(20)} ${method.padEnd(6)} ${path}\n`,
    );
    process.stdout.write(
      `  ${"".padEnd(20)} Risk: ${gov.risk_level.padEnd(8)} | Approval: ${approval.padEnd(11)} | Rate: ${gov.rate_limit ?? "none"}\n`,
    );
  }
  return 0;
}


export interface IntegrationAddOptions {
  workDir:  string;
  service:  string;
  specUrl:  string;
  apiKey?:  string;
  json:     boolean;
}

export async function runIntegrationAddCommand(
  opts: IntegrationAddOptions,
): Promise<number> {
  auditCliCommand("integration", "add");
  // Validate inputs before any network I/O
  try {
    validateServiceName(opts.service);
    validateSpecUrl(opts.specUrl);
  } catch (e: unknown) {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // Fetch spec
  let specContent: string;
  try {
    const response = await fetch(opts.specUrl);
    if (!response.ok) {
      process.stderr.write(
        `✗ Failed to fetch spec from ${opts.specUrl}: HTTP ${response.status}\n`,
      );
      return 1;
    }
    specContent = await response.text();
  } catch (e: unknown) {
    process.stderr.write(
      `✗ Could not reach ${opts.specUrl}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }

  // Validate by parsing
  try {
    parseOpenApiSpec(specContent);
  } catch (e: unknown) {
    process.stderr.write(
      `✗ Invalid OpenAPI spec: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }

  // Store in schema store
  const store = new SchemaStore(schemaDbPath(opts.workDir));
  await store.init();
  await store.storeSchema({
    service_name: opts.service,
    spec_format:  "openapi3",
    spec_content: specContent,
    quality:      "discovered",
    last_used:    new Date().toISOString(),
    success_rate: 0.0,
    usage_count:  0,
  });

  if (opts.json) {
    process.stdout.write(
      formatJson({ success: true, service: opts.service, quality: "discovered" }) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `✓ Integration '${opts.service}' added (discovered quality).\n`,
  );
  if (opts.apiKey !== undefined) {
    process.stdout.write(
      `  API key provided — store it with: sidjua secret set ${opts.service}_api_key\n`,
    );
  }
  return 0;
}


export interface IntegrationTestOptions {
  workDir: string;
  service: string;
  action?: string;
  json:    boolean;
}

export async function runIntegrationTestCommand(
  opts: IntegrationTestOptions,
): Promise<number> {
  try { validateServiceName(opts.service); }
  catch (e: unknown) {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const registry = new AdapterRegistry();
  await registry.loadFromDirectory(opts.workDir);
  const adapter = registry.getAdapter(opts.service);

  if (adapter === undefined) {
    process.stderr.write(`✗ Integration '${opts.service}' not found.\n`);
    return 1;
  }

  // Pick action: specified or first read-only (risk=low)
  let actionName = opts.action;
  let action     = actionName !== undefined ? adapter.actions[actionName] : undefined;

  if (action === undefined) {
    const entry = Object.entries(adapter.actions)
      .find(([, a]) => a.governance.risk_level === "low");
    if (entry === undefined) {
      process.stderr.write(
        `✗ No safe (risk=low) action found for '${opts.service}'.\n`,
      );
      return 1;
    }
    [actionName, action] = entry;
  }

  if (adapter.base_url === undefined) {
    process.stderr.write(`✗ Adapter '${opts.service}' has no base_url for HTTP test.\n`);
    return 1;
  }

  const url     = `${adapter.base_url}${action.path ?? "/"}`;
  const method  = (action.method ?? "GET").toUpperCase();
  const startMs = Date.now();

  let statusCode: number;
  let success: boolean;

  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(10_000),
    });
    statusCode = res.status;
    success    = res.ok;
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    if (opts.json) {
      process.stdout.write(
        formatJson({ success: false, service: opts.service, error: errorMsg }) + "\n",
      );
      return 1;
    }
    process.stderr.write(`✗ Connection failed: ${errorMsg}\n`);
    return 1;
  }

  const elapsedMs = Date.now() - startMs;

  if (opts.json) {
    process.stdout.write(
      formatJson({
        success,
        service:    opts.service,
        action:     actionName,
        status:     statusCode,
        elapsed_ms: elapsedMs,
      }) + "\n",
    );
    return success ? 0 : 1;
  }

  const mark = success ? "✓" : "✗";
  process.stdout.write(
    `${mark} ${opts.service}.${actionName ?? "?"} — HTTP ${statusCode} in ${elapsedMs}ms\n`,
  );
  return success ? 0 : 1;
}


export interface IntegrationAuditOptions {
  workDir:  string;
  service?: string;
  last:     string; // e.g. "24h", "7d"
  json:     boolean;
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

export function runIntegrationAuditCommand(opts: IntegrationAuditOptions): number {
  return withCliDatabase({ workDir: opts.workDir, queryOnly: true }, (db) => {
    const conditions: string[] = ["1=1"];
    const params: (string | number)[] = [];

    const periodFilter = auditPeriodFilter(opts.last);
    if (periodFilter !== null) {
      conditions.push(periodFilter);
    }
    if (opts.service !== undefined) {
      conditions.push("service = ?");
      params.push(opts.service);
    }

    let rows: AuditRow[];
    try {
      rows = db
        .prepare<(string | number)[], AuditRow>(
          `SELECT * FROM integration_audit_events
           WHERE ${conditions.join(" AND ")}
           ORDER BY id DESC LIMIT 500`,
        )
        .all(...params);
    } catch (_e) {
      rows = [];
    }

    if (opts.json) {
      process.stdout.write(formatJson({ events: rows }) + "\n");
      return 0;
    }

    const label = opts.last === "all" ? "all time" : `last ${opts.last}`;
    process.stdout.write(`Integration Audit Log (${label}):\n\n`);

    if (rows.length === 0) {
      process.stdout.write("  No events found.\n");
      return 0;
    }

    const tableRows = rows.map((r) => ({
      timestamp:  r.timestamp.slice(0, 19).replace("T", " "),
      service:    r.service,
      action:     r.action,
      agent:      r.agent_id,
      result:     auditResultLabel(r),
      elapsed:    r.execution_ms !== null ? `${r.execution_ms}ms` : "—",
    }));

    process.stdout.write(
      formatTable(tableRows, {
        columns: [
          { header: "TIMESTAMP",  key: "timestamp" },
          { header: "SERVICE",    key: "service"   },
          { header: "ACTION",     key: "action"    },
          { header: "AGENT",      key: "agent"     },
          { header: "RESULT",     key: "result"    },
          { header: "TIME",       key: "elapsed",  align: "right" },
        ],
        maxWidth: 200,
      }) + "\n",
    );

    return 0;
  });
}


export interface IntegrationPromoteOptions {
  workDir:  string;
  service:  string;
  review:   boolean;
  json:     boolean;
}

export async function runIntegrationPromoteCommand(
  opts: IntegrationPromoteOptions,
): Promise<number> {
  const store = new SchemaStore(schemaDbPath(opts.workDir));
  await store.init();

  const schema = await store.getSchema(opts.service);
  if (schema === null) {
    process.stderr.write(`✗ No discovered schema found for '${opts.service}'.\n`);
    return 1;
  }

  const promoter   = new AdapterPromoter();
  const candidates = await promoter.getCandidates(store);
  const candidate  = candidates.find((c) => c.service_name === opts.service);

  const eligible = candidate !== undefined && candidate.recommended;

  if (opts.json) {
    const data: Record<string, unknown> = {
      service:      opts.service,
      eligible,
      usage_count:  schema.usage_count,
      success_rate: schema.success_rate,
    };
    if (opts.review && eligible) {
      data["adapter_yaml"] = await promoter.generateAdapterYaml(schema, []);
    }
    process.stdout.write(formatJson(data) + "\n");
    return 0;
  }

  process.stdout.write(`Integration Promotion: ${opts.service}\n\n`);
  process.stdout.write(`  Usage count:  ${schema.usage_count}\n`);
  process.stdout.write(`  Success rate: ${Math.round(schema.success_rate * 100)}%\n`);
  process.stdout.write(`  Status:       ${eligible ? "✓ ELIGIBLE for promotion" : "✗ Not eligible yet (need 10+ calls at 80%+ success)"}\n`);

  if (opts.review) {
    if (!eligible) {
      process.stdout.write(
        "\n  Not eligible yet — run more calls to build usage data.\n",
      );
      return 0;
    }
    const yaml = await promoter.generateAdapterYaml(schema, []);
    process.stdout.write(
      `\nSuggested YAML adapter (review before committing to governance/integrations/${opts.service}.yaml):\n\n`,
    );
    process.stdout.write(yaml + "\n");
  }

  return 0;
}


function protocolLabel(p: string): string {
  const map: Record<string, string> = {
    rest: "REST", graphql: "GraphQL", local_script: "script", cli: "CLI", mcp: "MCP",
  };
  return map[p] ?? p;
}

function auditPeriodFilter(period: string): string | null {
  switch (period) {
    case "1h":  return "timestamp >= datetime('now', '-1 hour')";
    case "24h": return "timestamp >= datetime('now', '-24 hours')";
    case "7d":  return "timestamp >= datetime('now', '-7 days')";
    case "30d": return "timestamp >= datetime('now', '-30 days')";
    default:    return null;
  }
}

function auditResultLabel(row: AuditRow): string {
  if (row.event_type === "integration_blocked") {
    return row.error ? `BLOCKED: ${row.error.slice(0, 30)}` : "BLOCKED";
  }
  if (row.event_type === "integration_approval_required") return "PENDING APPROVAL";
  if (row.event_type === "integration_success")            return "SUCCESS";
  if (row.event_type === "integration_failure")            return row.error ?? "FAILURE";
  return row.event_type;
}


export function registerIntegrationCommands(
  program: import("commander").Command,
): void {
  const integCmd = program
    .command("integration")
    .description("Manage external service integrations");

  integCmd
    .command("list")
    .description("List all registered integrations")
    .option("--json", "Output as JSON", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(async (opts: { json: boolean; workDir: string }) => {
      const code = await runIntegrationListCommand({ workDir: opts.workDir, json: opts.json });
      process.exit(code);
    });

  integCmd
    .command("info <service>")
    .description("Show details for an integration")
    .option("--json", "Output as JSON", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(async (service: string, opts: { json: boolean; workDir: string }) => {
      const code = await runIntegrationInfoCommand({
        workDir: opts.workDir, service, json: opts.json,
      });
      process.exit(code);
    });

  integCmd
    .command("add")
    .description("Add a new integration from an OpenAPI spec URL")
    .requiredOption("--service <name>", "Service name")
    .requiredOption("--spec-url <url>", "URL of the OpenAPI spec")
    .option("--api-key <key>", "API key to store (optional)")
    .option("--json", "Output as JSON", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(async (opts: {
      service: string; specUrl: string; apiKey?: string;
      json: boolean; workDir: string;
    }) => {
      const code = await runIntegrationAddCommand({
        workDir:  opts.workDir,
        service:  opts.service,
        specUrl:  opts.specUrl,
        json:     opts.json,
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      });
      process.exit(code);
    });

  integCmd
    .command("test <service>")
    .description("Test connectivity to an integration")
    .option("--action <name>", "Specific action to test")
    .option("--json", "Output as JSON", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(async (service: string, opts: {
      action?: string; json: boolean; workDir: string;
    }) => {
      const code = await runIntegrationTestCommand({
        workDir: opts.workDir, service, json: opts.json,
        ...(opts.action !== undefined ? { action: opts.action } : {}),
      });
      process.exit(code);
    });

  integCmd
    .command("audit")
    .description("Query the integration audit log")
    .option("--service <name>", "Filter by service name")
    .option("--last <period>", "Time period: 1h, 24h, 7d, 30d, all", "24h")
    .option("--json", "Output as JSON", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: {
      service?: string; last: string; json: boolean; workDir: string;
    }) => {
      const code = runIntegrationAuditCommand({
        workDir:  opts.workDir,
        last:     opts.last,
        json:     opts.json,
        ...(opts.service !== undefined ? { service: opts.service } : {}),
      });
      process.exit(code);
    });

  integCmd
    .command("promote <service>")
    .description("Check or generate adapter promotion for a discovered integration")
    .option("--review", "Generate YAML adapter config for review", false)
    .option("--json", "Output as JSON", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(async (service: string, opts: {
      review: boolean; json: boolean; workDir: string;
    }) => {
      const code = await runIntegrationPromoteCommand({
        workDir: opts.workDir, service, review: opts.review, json: opts.json,
      });
      process.exit(code);
    });
}

// Re-export AdapterDefinition for consumers
export type { AdapterDefinition };
