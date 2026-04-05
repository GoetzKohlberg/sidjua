// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.7: Tool CLI commands
 * Registers: sidjua tool list/show/test/start/stop/test-action
 */

import type { Command } from "commander";
import { openDatabase } from "../utils/db.js";
import { runToolMigrations } from "./migration.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolGovernance } from "./tool-governance.js";
import { ToolManager } from "./tool-manager.js";
import { ToolExecutionGateway } from "./tool-execution-gateway.js";
import type { CallerContext } from "./tool-execution-gateway.js";
import type { ToolAction } from "./types.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("cli-tool");


/**
 * Register all `sidjua tool *` subcommands on the given Commander program.
 */
export function registerToolCommands(program: Command): void {
  const toolCmd = program
    .command("tool")
    .description("Manage tools, adapters, and governance rules");

  // ── sidjua tool list ───────────────────────────────────────────────────

  toolCmd
    .command("list")
    .description("List all registered tools")
    .option("--db <path>", "Path to sidjua.db", "./sidjua.db")
    .action((opts: { db: string }) => {
      const db = openDatabase(opts.db);
      try {
        runToolMigrations(db);
        const registry = new ToolRegistry(db);
        const tools = registry.list();

        if (tools.length === 0) {
          process.stdout.write("No tools registered.\n");
          process.exit(0);
          return;
        }

        // Print table header
        const idW = 36;
        const typeW = 14;
        const statusW = 10;
        const capsW = 5;
        const header =
          "ID".padEnd(idW) +
          " | " +
          "TYPE".padEnd(typeW) +
          " | " +
          "STATUS".padEnd(statusW) +
          " | " +
          "CAPS";
        const sep = "─".repeat(header.length);
        process.stdout.write(header + "\n" + sep + "\n");

        for (const tool of tools) {
          const capCount = registry.getCapabilities(tool.id).length;
          const row =
            tool.id.padEnd(idW) +
            " | " +
            tool.type.padEnd(typeW) +
            " | " +
            tool.status.padEnd(statusW) +
            " | " +
            String(capCount);
          process.stdout.write(row + "\n");
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      } finally {
        db.close();
      }
    });

  // ── sidjua tool show <id> ──────────────────────────────────────────────

  toolCmd
    .command("show <id>")
    .description("Show tool details, capabilities, and governance rules")
    .option("--db <path>", "Path to sidjua.db", "./sidjua.db")
    .action((id: string, opts: { db: string }) => {
      const db = openDatabase(opts.db);
      try {
        runToolMigrations(db);
        const registry = new ToolRegistry(db);
        const tool = registry.getById(id);

        if (tool === undefined) {
          process.stderr.write(`Error: tool '${id}' not found.\n`);
          process.exit(1);
          return;
        }

        const capabilities = registry.getCapabilities(id);
        const governance = new ToolGovernance(db);
        const rules = governance.getRules(id);

        process.stdout.write(
          `Tool: ${tool.id}\n` +
            `  Name:       ${tool.name}\n` +
            `  Type:       ${tool.type}\n` +
            `  Status:     ${tool.status}\n` +
            (tool.pid !== undefined ? `  PID:        ${tool.pid}\n` : "") +
            (tool.error_message !== undefined
              ? `  Error:      ${tool.error_message}\n`
              : "") +
            `  Created:    ${tool.created_at}\n` +
            `  Updated:    ${tool.updated_at}\n`,
        );

        if (capabilities.length > 0) {
          process.stdout.write(`\nCapabilities (${capabilities.length}):\n`);
          for (const cap of capabilities) {
            process.stdout.write(
              `  - ${cap.name} [risk: ${cap.risk_level}]` +
                (cap.requires_approval ? " [approval required]" : "") +
                `\n` +
                `    ${cap.description}\n`,
            );
          }
        } else {
          process.stdout.write("\nCapabilities: (none)\n");
        }

        if (rules.length > 0) {
          process.stdout.write(`\nGovernance Rules (${rules.length}):\n`);
          for (const rule of rules) {
            process.stdout.write(
              `  - [${rule.rule_type}] enforcement=${rule.enforcement}` +
                (rule.pattern !== undefined ? ` pattern=${rule.pattern}` : "") +
                (rule.reason !== undefined ? ` — ${rule.reason}` : "") +
                ` (${rule.active ? "active" : "inactive"})\n`,
            );
          }
        } else {
          process.stdout.write("\nGovernance Rules: (none)\n");
        }

        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      } finally {
        db.close();
      }
    });

  // ── sidjua tool test <id> ──────────────────────────────────────────────

  toolCmd
    .command("test <id>")
    .description("Run a health check on the tool adapter")
    .option("--db <path>", "Path to sidjua.db", "./sidjua.db")
    .action(async (id: string, opts: { db: string }) => {
      const db = openDatabase(opts.db);
      try {
        runToolMigrations(db);
        const registry = new ToolRegistry(db);
        const manager = new ToolManager(db, registry);
        const adapter = manager.getAdapter(id);

        if (adapter === undefined) {
          process.stderr.write(`Error: no adapter found for tool '${id}'.\n`);
          process.exit(1);
          return;
        }

        const start = Date.now();
        let passed = false;
        try {
          passed = await adapter.healthCheck();
        } catch (healthErr) {
          process.stderr.write(
            `Health check threw: ${healthErr instanceof Error ? healthErr.message : String(healthErr)}\n`,
          );
        }
        const latencyMs = Date.now() - start;

        if (passed) {
          process.stdout.write(`PASS  tool=${id}  latency=${latencyMs}ms\n`);
          process.exit(0);
        } else {
          process.stdout.write(`FAIL  tool=${id}  latency=${latencyMs}ms\n`);
          process.exit(1);
        }
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      } finally {
        db.close();
      }
    });

  // ── sidjua tool start <id> ─────────────────────────────────────────────

  toolCmd
    .command("start <id>")
    .description("Start a tool adapter")
    .option("--db <path>", "Path to sidjua.db", "./sidjua.db")
    .action(async (id: string, opts: { db: string }) => {
      const db = openDatabase(opts.db);
      try {
        runToolMigrations(db);
        const registry = new ToolRegistry(db);
        const manager = new ToolManager(db, registry);
        await manager.start(id);
        process.stdout.write(`Tool '${id}' started successfully.\n`);
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      } finally {
        db.close();
      }
    });

  // ── sidjua tool stop <id> ──────────────────────────────────────────────

  toolCmd
    .command("stop <id>")
    .description("Stop a running tool adapter")
    .option("--db <path>", "Path to sidjua.db", "./sidjua.db")
    .action(async (id: string, opts: { db: string }) => {
      const db = openDatabase(opts.db);
      try {
        runToolMigrations(db);
        const registry = new ToolRegistry(db);
        const manager = new ToolManager(db, registry);
        await manager.stop(id);
        process.stdout.write(`Tool '${id}' stopped successfully.\n`);
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      } finally {
        db.close();
      }
    });

  // ── sidjua tool test-action <tool-id> <capability> ────────────────────

  toolCmd
    .command("test-action <tool-id> <capability>")
    .description("Execute a tool capability action directly")
    .option("--params <json>", "Action parameters as JSON string", "{}")
    .option("--agent <id>", "Agent ID performing the action", "cli")
    .option("--db <path>", "Path to sidjua.db", "./sidjua.db")
    .action(
      async (
        toolId: string,
        capability: string,
        opts: { params: string; agent: string; db: string },
      ) => {
        const db = openDatabase(opts.db);
        try {
          runToolMigrations(db);

          let params: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(opts.params);
            if (
              parsed === null ||
              typeof parsed !== "object" ||
              Array.isArray(parsed)
            ) {
              throw new Error("--params must be a JSON object");
            }
            params = parsed as Record<string, unknown>;
          } catch (parseErr) {
            process.stderr.write(
              `Error: invalid --params JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n`,
            );
            process.exit(1);
            return;
          }

          const action: ToolAction = {
            tool_id: toolId,
            capability,
            params,
            agent_id: opts.agent,
          };

          const registry = new ToolRegistry(db);
          const manager  = new ToolManager(db, registry);
          const adapter  = manager.getAdapter(toolId);

          if (adapter === undefined) {
            process.stderr.write(
              `Error: no adapter found for tool '${toolId}'.\n`,
            );
            process.exit(1);
            return;
          }

          const governance = new ToolGovernance(db);
          const gateway    = new ToolExecutionGateway(governance, db);
          const callerCtx: CallerContext = {
            agent_id:      opts.agent,
            division:      "system",
            tier:          1,
            caller_source: "orchestrator", // CLI admin context
          };

          logger.warn(
            "test_action_gateway",
            "test-action routed through ToolExecutionGateway (admin/dev mode — apply governance rules to restrict)",
            { metadata: { tool_id: toolId, capability, agent_id: opts.agent } },
          );

          const result = await gateway.execute(adapter, action, callerCtx);
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
          process.exit(result.success ? 0 : 1);
        } catch (err) {
          process.stderr.write(
            `Error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        } finally {
          db.close();
        }
      },
    );
}
