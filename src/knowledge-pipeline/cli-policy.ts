// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: `sidjua policy` CLI commands
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { parse } from "yaml";
import { openDatabase } from "../utils/db.js";
import type { Database } from "../utils/db.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("cli-policy");
import { runKnowledgeMigrations } from "./migration.js";
import { PolicyParser } from "./policy/policy-parser.js";
import { PolicyValidator } from "./policy/policy-validator.js";
import { PolicyTester } from "./policy/policy-tester.js";
import type { TestScenario } from "./policy/policy-tester.js";
import { PolicyDeployer } from "./policy/policy-deployer.js";
import { formatTable } from "../cli/formatters/table.js";
import { formatJson } from "../cli/formatters/json.js";
import type { PolicyRuleDB, PolicyRuleInput } from "./types.js";


/** Returns the path to the sidjua SQLite database within a working directory. */
function getDbPath(workDir: string): string {
  return join(workDir, ".system", "sidjua.db");
}

/** Load all active policy rules from the database. */
function loadRules(db: Database): PolicyRuleDB[] {
  return db
    .prepare<[], PolicyRuleDB>("SELECT * FROM policy_rules WHERE active = 1 ORDER BY id")
    .all() as PolicyRuleDB[];
}

/** Load all policy rules (including inactive) from the database. */
function loadAllRules(db: Database): PolicyRuleDB[] {
  return db
    .prepare<[], PolicyRuleDB>("SELECT * FROM policy_rules ORDER BY id")
    .all() as PolicyRuleDB[];
}


/**
 * Register the `sidjua policy` command group on the given Commander program.
 *
 * Subcommands:
 *   policy add      — parse or load a policy rule, validate, and deploy
 *   policy test     — simulate a scenario against active rules
 *   policy list     — list all policy rules
 *   policy validate — detect conflicts and dead rules across active policies
 */
export function registerPolicyCommands(program: Command): void {
  const policyCmd = program
    .command("policy")
    .description("Governance policy management (add, test, list, validate)");

  // ── sidjua policy add ─────────────────────────────────────────────────────

  policyCmd
    .command("add [text]")
    .description("Add a policy rule from natural language text or a YAML file")
    .option("--file <path>", "Path to YAML policy file containing a PolicyRuleInput object")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--dry-run", "Show what would be added without deploying", false)
    .action(async (text: string | undefined, opts: {
      file?:    string;
      workDir:  string;
      dryRun:   boolean;
    }) => {
      const db = openDatabase(getDbPath(opts.workDir));
      try {
        db.pragma("foreign_keys = ON");
        runKnowledgeMigrations(db);

        // Determine source
        if (text === undefined && opts.file === undefined) {
          process.stderr.write(
            "Error: provide rule text as an argument or supply --file <path>\n",
          );
          process.exit(1);
          return;
        }

        let parsedRule: PolicyRuleInput;

        if (opts.file !== undefined) {
          // Load from YAML file
          if (!existsSync(opts.file)) {
            process.stderr.write(`Error: file not found: ${opts.file}\n`);
            process.exit(1);
            return;
          }
          const raw = readFileSync(opts.file, "utf-8");
          parsedRule = parse(raw) as PolicyRuleInput;
        } else {
          // Parse from natural language via LLM
          const apiKey = process.env["OPENAI_API_KEY"];
          if (apiKey === undefined || apiKey.length === 0) {
            process.stderr.write(
              "Error: OPENAI_API_KEY environment variable is required for natural language parsing\n",
            );
            process.exit(1);
            return;
          }
          const parser = new PolicyParser(apiKey);
          const result = await parser.parse(text!);

          process.stdout.write("Parsed rule:\n");
          process.stdout.write(`  type:        ${result.rule_type}\n`);
          process.stdout.write(`  enforcement: ${result.enforcement}\n`);
          if (result.action_pattern !== undefined) {
            process.stdout.write(`  pattern:     ${result.action_pattern}\n`);
          }
          if (result.condition !== undefined) {
            process.stdout.write(`  condition:   ${result.condition}\n`);
          }
          if (result.reason !== undefined) {
            process.stdout.write(`  reason:      ${result.reason}\n`);
          }
          process.stdout.write(`  confidence:  ${result.confidence}\n`);

          // Strip the extra parse-only fields — PolicyRuleInput is a subset
          const { raw_input: _raw, confidence: _conf, ...base } = result;
          parsedRule = base;
        }

        // Validate against existing rules
        const existingRules = loadRules(db);
        const validator = new PolicyValidator();
        const validation = validator.validate(existingRules, parsedRule);

        if (validation.conflicts.length > 0) {
          process.stderr.write("Warning: conflicts detected with existing rules:\n");
          for (const c of validation.conflicts) {
            process.stderr.write(
              `  Rule #${c.rule_a_id} vs ${String(c.rule_b_id)}: ${c.reason}\n`,
            );
          }
        }
        for (const w of validation.warnings) {
          process.stderr.write(`Warning: ${w}\n`);
        }

        if (!validation.valid) {
          process.stderr.write("Error: policy rule is not valid:\n");
          for (const e of validation.errors) {
            process.stderr.write(`  ${e}\n`);
          }
          process.exit(1);
          return;
        }

        if (opts.dryRun) {
          process.stdout.write(
            `DRY RUN: Would add policy rule: [${parsedRule.rule_type}] ` +
            `${parsedRule.action_pattern ?? "(no pattern)"} — ${parsedRule.reason ?? parsedRule.enforcement}\n`,
          );
          return;
        }

        // Deploy
        const deployer = new PolicyDeployer(
          db,
          join(opts.workDir, "governance"),
          logger,
        );
        const result = await deployer.deploy(parsedRule);
        process.stdout.write(
          `Policy rule #${result.rule_id} deployed to ${result.file_written}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      } finally {
        db.close();
      }
    });

  // ── sidjua policy test ────────────────────────────────────────────────────

  policyCmd
    .command("test [scenario]")
    .description("Simulate an action scenario against active policy rules")
    .option("--task <description>", "Action description (alternative to positional arg)")
    .option("--agent <id>", "Agent ID performing the action")
    .option("--action <pattern>", "Action pattern to test (e.g. file.delete)")
    .option("--verbose", "Show all evaluated rules, not just matching ones", false)
    .option("--json", "Output in JSON format", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(async (scenario: string | undefined, opts: {
      task?:    string;
      agent?:   string;
      action?:  string;
      verbose:  boolean;
      json:     boolean;
      workDir:  string;
    }) => {
      const db = openDatabase(getDbPath(opts.workDir));
      try {
        db.pragma("foreign_keys = ON");
        runKnowledgeMigrations(db);

        const description = scenario ?? opts.task;
        if (description === undefined && opts.action === undefined) {
          process.stderr.write(
            "Error: provide a scenario description (positional arg or --task) and/or --action\n",
          );
          process.exit(1);
          return;
        }

        const testScenario: TestScenario = {
          agent_id: opts.agent ?? "unknown",
          action: opts.action ?? description ?? "",
          ...(description !== undefined ? { description } : {}),
        };

        const rules = loadRules(db);
        const tester = new PolicyTester();
        const testResult = tester.test(testScenario, rules);

        if (opts.json) {
          process.stdout.write(formatJson(testResult) + "\n");
          return;
        }

        process.stdout.write(`Verdict: ${testResult.verdict}\n`);
        process.stdout.write(`Agent:   ${testScenario.agent_id}\n`);
        process.stdout.write(`Action:  ${testScenario.action}\n`);

        if (testResult.blocking_rule !== undefined) {
          const br = testResult.blocking_rule;
          process.stdout.write(
            `\nBlocking rule #${br.rule_id} [${br.enforcement}]` +
            (br.reason !== undefined ? `: ${br.reason}` : "") + "\n",
          );
        }

        if (testResult.triggered_rules.length > 0) {
          process.stdout.write("\nMatched rules:\n");
          for (const r of testResult.triggered_rules) {
            process.stdout.write(
              `  #${r.rule_id} [${r.enforcement}]` +
              (r.reason !== undefined ? ` — ${r.reason}` : "") + "\n",
            );
          }
        } else {
          process.stdout.write("\nNo rules matched.\n");
        }

        if (opts.verbose) {
          process.stdout.write(`\n(${rules.length} active rule(s) evaluated)\n`);
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

  // ── sidjua policy list ────────────────────────────────────────────────────

  policyCmd
    .command("list")
    .description("List all policy rules")
    .option("--type <rule-type>", "Filter by rule type (forbidden|approval|escalation|budget|custom)")
    .option("--json", "Output in JSON format", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: {
      type?:   string;
      json:    boolean;
      workDir: string;
    }) => {
      const db = openDatabase(getDbPath(opts.workDir));
      try {
        db.pragma("foreign_keys = ON");
        runKnowledgeMigrations(db);

        let rules = loadAllRules(db);

        if (opts.type !== undefined) {
          rules = rules.filter((r) => r.rule_type === opts.type);
        }

        if (opts.json) {
          process.stdout.write(formatJson(rules) + "\n");
          return;
        }

        if (rules.length === 0) {
          process.stdout.write("No policy rules found.\n");
          return;
        }

        const rows: Record<string, unknown>[] = rules.map((r) => ({
          id:          r.id,
          type:        r.rule_type,
          enforcement: r.enforcement,
          pattern:     r.action_pattern ?? "",
          reason:      r.reason ?? "",
          active:      r.active ? "yes" : "no",
        }));

        const table = formatTable(rows, {
          columns: [
            { header: "ID",          key: "id",          width: 6,  align: "right" },
            { header: "TYPE",        key: "type",        width: 12 },
            { header: "ENFORCEMENT", key: "enforcement", width: 12 },
            { header: "ACTION PATTERN", key: "pattern",  width: 30 },
            { header: "ACTIVE",      key: "active",      width: 6  },
            { header: "REASON",      key: "reason",      width: 50 },
          ],
        });
        process.stdout.write(table + "\n");
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      } finally {
        db.close();
      }
    });

  // ── sidjua policy validate ────────────────────────────────────────────────

  policyCmd
    .command("validate")
    .description("Validate active policy rules for conflicts and dead rules")
    .option("--json", "Output in JSON format", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action((opts: {
      json:    boolean;
      workDir: string;
    }) => {
      const db = openDatabase(getDbPath(opts.workDir));
      try {
        db.pragma("foreign_keys = ON");
        runKnowledgeMigrations(db);

        const rules = loadRules(db);
        const validator = new PolicyValidator();
        const result = validator.validate(rules);

        if (opts.json) {
          process.stdout.write(formatJson(result) + "\n");
          if (!result.valid) process.exit(1);
          return;
        }

        if (result.valid && result.dead_rules.length === 0) {
          process.stdout.write(
            "All policies valid. No conflicts or dead rules detected.\n",
          );
          return;
        }

        if (result.conflicts.length > 0) {
          process.stderr.write(`Found ${result.conflicts.length} conflict(s):\n`);
          for (const c of result.conflicts) {
            process.stderr.write(
              `  Rule #${c.rule_a_id} vs #${c.rule_b_id}: ${c.reason}\n`,
            );
          }
        }

        if (result.dead_rules.length > 0) {
          process.stderr.write(`Found ${result.dead_rules.length} dead rule(s):\n`);
          for (const id of result.dead_rules) {
            const rule = rules.find((r) => r.id === id);
            const desc = rule?.reason ?? rule?.action_pattern ?? String(id);
            process.stderr.write(`  Rule #${id}: ${desc}\n`);
          }
        }

        for (const w of result.warnings) {
          process.stderr.write(`Warning: ${w}\n`);
        }

        if (!result.valid) {
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
}
