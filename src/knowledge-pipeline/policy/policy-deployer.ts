// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: PolicyDeployer
 * Writes validated rules to governance/ YAML files. Triggers hot-reload.
 */

import { writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { Database } from "../../utils/db.js";
import type { PolicyRuleInput } from "../types.js";
import { createLogger, type Logger } from "../../core/logger.js";
import { resolveContainedPath } from "../../utils/path-security.js";

export interface DeployResult {
  file_written: string;
  rule_id: number;
}

export class PolicyDeployer {
  constructor(
    private readonly db: Database,
    private readonly governanceDir: string,
    private readonly logger: Logger = createLogger("policy-deployer"),
  ) {}

  async deploy(rule: PolicyRuleInput): Promise<DeployResult> {
    const now = new Date().toISOString();

    // Write to DB
    const stmt = this.db.prepare<
      [
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
      ],
      void
    >(`
      INSERT INTO policy_rules
        (source_file, rule_type, action_pattern, condition, enforcement, escalate_to, reason, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);
    stmt.run(
      rule.source_file,
      rule.rule_type,
      rule.action_pattern ?? null,
      rule.condition ?? null,
      rule.enforcement,
      rule.escalate_to ?? null,
      rule.reason ?? null,
      now,
    );

    const idRow = this.db
      .prepare<[], { id: number }>("SELECT last_insert_rowid() AS id")
      .get() as { id: number };
    const ruleId = idRow.id;

    // Write to YAML governance file — validate source_file stays within governanceDir
    const filePath = resolveContainedPath(this.governanceDir, rule.source_file);
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });

    // Append rule to YAML file
    const ruleYaml = stringifyYaml({
      id: `rule_${ruleId}`,
      type: rule.rule_type,
      ...(rule.action_pattern !== undefined ? { action: rule.action_pattern } : {}),
      ...(rule.condition !== undefined ? { condition: rule.condition } : {}),
      enforcement: rule.enforcement,
      ...(rule.escalate_to !== undefined ? { escalate_to: rule.escalate_to } : {}),
      ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
      created_at: now,
    });

    const fileExists = await access(filePath).then(() => true).catch(() => false);
    const separator = fileExists ? "\n---\n" : "";
    await writeFile(filePath, separator + ruleYaml, { flag: "a" });

    this.logger.info("policy_rule_deployed", "Policy rule deployed", {
      metadata: { rule_id: ruleId, source_file: rule.source_file },
    });

    return { file_written: filePath, rule_id: ruleId };
  }
}
