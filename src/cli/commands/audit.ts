// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua audit` CLI Command Group
 *
 * Provides analyzed compliance reporting on top of the raw event data
 * that `sidjua logs` exposes.  Aggregates violations, trust scores, and
 * compliance metrics into human-readable tables and machine-readable JSON.
 *
 * Note: PDF export (#365 spec) is deferred — too complex for V1.0.
 * Implement as a post-processor plugin when a reporting library is chosen.
 *
 * Usage:
 *   sidjua audit report      [--division] [--agent] [--since] [--until] [--json]
 *   sidjua audit violations  [--division] [--agent] [--since] [--until] [--severity] [--json]
 *   sidjua audit agents      [--division] [--agent] [--since] [--until] [--json]
 *   sidjua audit summary     [--since] [--json]
 *   sidjua audit export      --format csv|json [--output <path>]
 */

import { writeFileSync }          from "node:fs";
import { join, resolve, relative } from "node:path";
import type { Command }           from "commander";
import { withCliDatabaseAsync }   from "../utils/with-cli-database.js";
import { writeJsonOutput }        from "../utils/output.js";
import { formatTable }            from "../formatters/table.js";
import { AuditService }           from "../../core/audit/audit-service.js";
import { createLogger }           from "../../core/logger.js";
import type { AuditFilters }      from "../../core/audit/audit-service.js";
import { msg }                    from "../../i18n/index.js";

const logger = createLogger("audit-cmd");


export function registerAuditCommands(program: Command): void {
  const auditCmd = program
    .command("audit")
    .description("Compliance reporting and audit analysis");

  // --------------------------------------------------------------------------
  // sidjua audit report
  // --------------------------------------------------------------------------

  auditCmd
    .command("report")
    .description("Generate a compliance report showing rules enforced and compliance score")
    .option("--division <name>",     "Filter by division")
    .option("--agent <id>",          "Filter by agent ID")
    .option("--since <date>",        "Start of period (ISO date, default: 30 days ago)")
    .option("--until <date>",        "End of period (ISO date, default: now)")
    .option("--policy-type <type>",  "Filter by policy/rule type")
    .option("--json",                "Output as JSON")
    .option("--work-dir <path>",     "Workspace directory", process.cwd())
    .action(async (opts: {
      division?:   string;
      agent?:      string;
      since?:      string;
      until?:      string;
      policyType?: string;
      json?:       boolean;
      workDir:     string;
    }) => {
      const code = await withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
        const svc = new AuditService(db);
        const filters: AuditFilters = {};
        if (opts.division   !== undefined) filters.division   = opts.division;
        if (opts.agent      !== undefined) filters.agentId    = opts.agent;
        if (opts.since      !== undefined) filters.since      = opts.since;
        if (opts.until      !== undefined) filters.until      = opts.until;
        if (opts.policyType !== undefined) filters.policyType = opts.policyType;

        try {
          const report = await svc.generateReport(filters);

          if (writeJsonOutput(report, { json: opts.json ?? false })) {
            return 0;
          }

          process.stdout.write(`\nCompliance Report\n`);
          process.stdout.write(`  Period:  ${report.period.from.slice(0, 10)} → ${report.period.to.slice(0, 10)}\n`);
          process.stdout.write(`  Events:  ${report.totalEvents.toLocaleString()}\n`);
          process.stdout.write(`  Score:   ${report.complianceScore}%\n\n`);

          if (report.rulesEnforced.length === 0) {
            process.stdout.write("  No audit events found for the specified period.\n\n");
          } else {
            const table = formatTable(
              report.rulesEnforced.map((r) => ({
                ruleId:        r.ruleId,
                division:      r.division,
                enforcedCount: r.enforcedCount,
                lastEnforced:  r.lastEnforced.slice(0, 19).replace("T", " "),
              })),
              {
                columns: [
                  { header: "Rule",      key: "ruleId",        width: 32 },
                  { header: "Division",  key: "division",      width: 20 },
                  { header: "Count",     key: "enforcedCount", width: 8,  align: "right" },
                  { header: "Last",      key: "lastEnforced",  width: 20 },
                ],
              },
            );
            process.stdout.write(table + "\n\n");
          }

          process.stdout.write(`Summary: ${report.summary}\n`);
          return 0;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error("audit-cmd", "report failed", { error: { code: "AUDIT_REPORT_ERR", message: msg } });
          process.stderr.write(`Error: ${msg}\n`);
          return 1;
        }
      });
      process.exit(code);
    });

  // --------------------------------------------------------------------------
  // sidjua audit violations
  // --------------------------------------------------------------------------

  auditCmd
    .command("violations")
    .description("List policy violations (blocked and escalated events)")
    .option("--division <name>",     "Filter by division")
    .option("--agent <id>",          "Filter by agent ID")
    .option("--since <date>",        "Start of period (ISO date, default: 30 days ago)")
    .option("--until <date>",        "End of period (ISO date, default: now)")
    .option("--severity <level>",    "Filter by severity: low|medium|high|critical")
    .option("--json",                "Output as JSON")
    .option("--work-dir <path>",     "Workspace directory", process.cwd())
    .action(async (opts: {
      division?: string;
      agent?:    string;
      since?:    string;
      until?:    string;
      severity?: string;
      json?:     boolean;
      workDir:   string;
    }) => {
      const code = await withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
        const svc = new AuditService(db);
        const filters: AuditFilters = {};
        if (opts.division !== undefined) filters.division = opts.division;
        if (opts.agent    !== undefined) filters.agentId  = opts.agent;
        if (opts.since    !== undefined) filters.since    = opts.since;
        if (opts.until    !== undefined) filters.until    = opts.until;
        if (opts.severity !== undefined) {
          filters.severity = opts.severity as "low" | "medium" | "high" | "critical";
        }

        try {
          const violations = await svc.getViolations(filters);

          if (writeJsonOutput(violations, { json: opts.json ?? false })) {
            return 0;
          }

          if (violations.length === 0) {
            process.stdout.write("No violations found for the specified period.\n");
            return 0;
          }

          const table = formatTable(
            violations.map((v) => ({
              timestamp: v.timestamp.slice(0, 19).replace("T", " "),
              agentId:   v.agentId,
              division:  v.division,
              action:    v.action,
              severity:  v.severity,
              reason:    v.reason,
            })),
            {
              columns: [
                { header: "Timestamp",  key: "timestamp", width: 20 },
                { header: "Agent",      key: "agentId",   width: 24 },
                { header: "Division",   key: "division",  width: 16 },
                { header: "Action",     key: "action",    width: 10 },
                { header: "Severity",   key: "severity",  width: 10 },
                { header: "Reason",     key: "reason",    width: 40 },
              ],
            },
          );
          process.stdout.write(table + "\n");
          return 0;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error("audit-cmd", "violations failed", { error: { code: "AUDIT_VIOLATIONS_ERR", message: msg } });
          process.stderr.write(`Error: ${msg}\n`);
          return 1;
        }
      });
      process.exit(code);
    });

  // --------------------------------------------------------------------------
  // sidjua audit agents
  // --------------------------------------------------------------------------

  auditCmd
    .command("agents")
    .description("Show agent trust scores and compliance metrics")
    .option("--division <name>",  "Filter by division")
    .option("--agent <id>",       "Filter by agent ID")
    .option("--since <date>",     "Start of period (ISO date, default: 30 days ago)")
    .option("--until <date>",     "End of period (ISO date, default: now)")
    .option("--json",             "Output as JSON")
    .option("--work-dir <path>",  "Workspace directory", process.cwd())
    .action(async (opts: {
      division?: string;
      agent?:    string;
      since?:    string;
      until?:    string;
      json?:     boolean;
      workDir:   string;
    }) => {
      const code = await withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
        const svc = new AuditService(db);
        const filters: AuditFilters = {};
        if (opts.division !== undefined) filters.division = opts.division;
        if (opts.agent    !== undefined) filters.agentId  = opts.agent;
        if (opts.since    !== undefined) filters.since    = opts.since;
        if (opts.until    !== undefined) filters.until    = opts.until;

        try {
          const agents = await svc.getAgentTrust(filters);

          if (writeJsonOutput(agents, { json: opts.json ?? false })) {
            return 0;
          }

          if (agents.length === 0) {
            process.stdout.write("No agent data found for the specified period.\n");
            return 0;
          }

          const table = formatTable(
            agents.map((a) => ({
              agentId:    a.agentId,
              division:   a.division,
              totalTasks: a.totalTasks,
              violations: a.violations,
              trustScore: `${a.trustScore}%`,
              trend:      a.trend,
            })),
            {
              columns: [
                { header: "Agent",       key: "agentId",    width: 28 },
                { header: "Division",    key: "division",   width: 16 },
                { header: "Tasks",       key: "totalTasks", width: 8,  align: "right" },
                { header: "Violations",  key: "violations", width: 10, align: "right" },
                { header: "Trust",       key: "trustScore", width: 8,  align: "right" },
                { header: "Trend",       key: "trend",      width: 12 },
              ],
            },
          );
          process.stdout.write(table + "\n");
          return 0;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error("audit-cmd", "agents failed", { error: { code: "AUDIT_AGENTS_ERR", message: msg } });
          process.stderr.write(`Error: ${msg}\n`);
          return 1;
        }
      });
      process.exit(code);
    });

  // --------------------------------------------------------------------------
  // sidjua audit summary
  // --------------------------------------------------------------------------

  auditCmd
    .command("summary")
    .description("Show a compact compliance summary for the period")
    .option("--since <date>",     "Start of period (ISO date, default: 30 days ago)")
    .option("--until <date>",     "End of period (ISO date, default: now)")
    .option("--json",             "Output as JSON")
    .option("--work-dir <path>",  "Workspace directory", process.cwd())
    .action(async (opts: {
      since?:   string;
      until?:   string;
      json?:    boolean;
      workDir:  string;
    }) => {
      const code = await withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
        const svc = new AuditService(db);
        const filters: AuditFilters = {};
        if (opts.since !== undefined) filters.since = opts.since;
        if (opts.until !== undefined) filters.until = opts.until;

        try {
          const summary = await svc.getSummary(filters);

          if (writeJsonOutput(summary, { json: opts.json ?? false })) {
            return 0;
          }

          process.stdout.write(`\nCompliance Summary\n`);
          process.stdout.write(`  Period:       ${summary.period.from.slice(0, 10)} → ${summary.period.to.slice(0, 10)}\n`);
          process.stdout.write(`  Agents:       ${summary.totalAgents}\n`);
          process.stdout.write(`  Divisions:    ${summary.totalDivisions}\n`);
          process.stdout.write(`  Tasks:        ${summary.totalTasks.toLocaleString()}\n`);
          process.stdout.write(`  Violations:   ${summary.totalViolations}\n`);
          process.stdout.write(`  Compliance:   ${summary.complianceRate}%\n`);

          if (summary.topViolationTypes.length > 0) {
            process.stdout.write(`\nTop Violation Types:\n`);
            for (const v of summary.topViolationTypes) {
              process.stdout.write(`  ${v.rule.padEnd(32)}  ${v.count}\n`);
            }
          }

          if (summary.divisionBreakdown.length > 0) {
            process.stdout.write(`\nDivision Breakdown:\n`);
            const table = formatTable(
              summary.divisionBreakdown.map((d) => ({
                division:       d.division,
                complianceRate: `${d.complianceRate}%`,
                violations:     d.violations,
              })),
              {
                columns: [
                  { header: "Division",    key: "division",       width: 24 },
                  { header: "Compliance",  key: "complianceRate", width: 12, align: "right" },
                  { header: "Violations",  key: "violations",     width: 10, align: "right" },
                ],
              },
            );
            process.stdout.write(table + "\n");
          }

          process.stdout.write("\n");
          return 0;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error("audit-cmd", "summary failed", { error: { code: "AUDIT_SUMMARY_ERR", message: msg } });
          process.stderr.write(`Error: ${msg}\n`);
          return 1;
        }
      });
      process.exit(code);
    });

  // --------------------------------------------------------------------------
  // sidjua audit export
  // --------------------------------------------------------------------------

  auditCmd
    .command("export")
    .description("Export audit data to file (CSV or JSON)")
    .requiredOption("--format <fmt>",  "Output format: csv or json")
    .option("--output <path>",         "Output file path (default: sidjua-audit-YYYY-MM-DD.{ext})")
    .option("--division <name>",       "Filter by division")
    .option("--agent <id>",            "Filter by agent ID")
    .option("--since <date>",          "Start of period (ISO date, default: 30 days ago)")
    .option("--until <date>",          "End of period (ISO date, default: now)")
    .option("--work-dir <path>",       "Workspace directory", process.cwd())
    .action(async (opts: {
      format:    string;
      output?:   string;
      division?: string;
      agent?:    string;
      since?:    string;
      until?:    string;
      workDir:   string;
    }) => {
      const fmt = opts.format.toLowerCase();
      if (fmt !== "csv" && fmt !== "json") {
        process.stderr.write("Error: --format must be 'csv' or 'json'\n");
        process.exit(1);
      }

      const code = await withCliDatabaseAsync({ workDir: opts.workDir }, async (db) => {
        const svc = new AuditService(db);
        const filters: AuditFilters = {};
        if (opts.division !== undefined) filters.division = opts.division;
        if (opts.agent    !== undefined) filters.agentId  = opts.agent;
        if (opts.since    !== undefined) filters.since    = opts.since;
        if (opts.until    !== undefined) filters.until    = opts.until;

        const dateStr   = new Date().toISOString().slice(0, 10);
        const defaultFn = `sidjua-audit-${dateStr}.${fmt}`;
        const baseWorkDir = resolve(opts.workDir);
        const outPath   = opts.output ?? join(baseWorkDir, defaultFn);

        // Reject path traversal in caller-supplied --output argument.
        if (opts.output !== undefined) {
          const baseDir     = baseWorkDir;
          const resolvedOut = resolve(opts.output);
          const rel         = relative(baseDir, resolvedOut);
          if (rel.startsWith("..") || resolve(baseDir, rel) !== resolvedOut) {
            process.stderr.write(
              msg("audit.export.path_outside_workdir", { dir: baseDir }) + "\n",
            );
            return 1;
          }
        }

        try {
          let content: string;
          if (fmt === "json") {
            const data = await svc.exportJson(filters);
            content = JSON.stringify(data, null, 2);
          } else {
            content = await svc.exportCsv(filters);
          }

          writeFileSync(outPath, content, "utf-8");
          process.stdout.write(`Audit data exported to: ${outPath}\n`);
          return 0;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error("audit-cmd", "export failed", { error: { code: "AUDIT_EXPORT_ERR", message: msg } });
          process.stderr.write(`Error: ${msg}\n`);
          return 1;
        }
      });
      process.exit(code);
    });
}
