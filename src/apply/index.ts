// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua apply` orchestrator
 *
 * Executes all 10 provisioning steps in strict sequential order.
 * Each step is idempotent — re-running produces the same result.
 *
 * Execution order:
 *   1. VALIDATE      — Parse + validate divisions.yaml
 *   2. FILESYSTEM    — Create directory structure
 *   3. DATABASE      — Create/migrate SQLite tables
 *   4. SECRETS       — Provision secrets store
 *   5. RBAC          — Generate role assignments
 *   6. ROUTING       — Build agent routing table
 *   7. SKILLS        — Assign skill directories
 *   8. AUDIT         — Initialize audit views + config
 *   9. COST_CENTERS  — Set up budget tracking
 *  10. FINALIZE      — Write state file + README
 *
 * When `options.step` is set, the orchestrator runs all steps up to and
 * including the requested step. This is useful for debugging individual steps
 * while maintaining correct prerequisite ordering.
 *
 * The database handle (sidjua.db) is opened in Step 3 and closed in the
 * finally block — it is shared with Steps 4 (SECRETS), 8 (AUDIT), and
 * 9 (COST_CENTERS).
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadAndValidate, loadAndValidateDir } from "./validate.js";
import { planFilesystem, executeFilesystemOps } from "./filesystem.js";
import { applyDatabase } from "./database.js";
import { applyAgents } from "./agents.js";
import { applySecrets } from "./secrets.js";
import { applyRBAC } from "./rbac.js";
import { applyRouting } from "./routing.js";
import { applySkills } from "./skills.js";
import { applyAudit } from "./audit.js";
import { applyCostCenters } from "./cost-centers.js";
import { applyFinalize } from "./finalize.js";
import { ApplyError } from "../types/apply.js";
import type {
  ApplyOptions,
  ApplyResult,
  ApplyStep,
  StepResult,
} from "../types/apply.js";
import type { ParsedConfig } from "../types/config.js";
import type { Database } from "../utils/db.js";
import { createLogger } from "../core/logger.js";
import { createSnapshot } from "../governance/rollback.js";

const logger = createLogger("apply");


/**
 * Canonical step execution order — must match the spec exactly.
 * When `options.step` is specified, steps are executed up to (and including)
 * the requested step index.
 */
const STEP_ORDER: ApplyStep[] = [
  "VALIDATE",
  "FILESYSTEM",
  "DATABASE",
  "AGENTS",
  "SECRETS",
  "RBAC",
  "ROUTING",
  "SKILLS",
  "AUDIT",
  "COST_CENTERS",
  "FINALIZE",
];

function stepIndex(step: ApplyStep): number {
  return STEP_ORDER.indexOf(step);
}

function shouldRun(onlyStep: ApplyStep | undefined, step: ApplyStep): boolean {
  if (!onlyStep) return true;
  return stepIndex(step) <= stepIndex(onlyStep);
}


function buildResult(
  success: boolean,
  steps: StepResult[],
  config: ParsedConfig,
  overallStart: number,
): ApplyResult {
  return {
    success,
    steps,
    config,
    duration_ms: Date.now() - overallStart,
  };
}

/**
 * Run the full (or partial) `sidjua apply` pipeline.
 *
 * @throws Never — all errors are captured in the returned ApplyResult.
 */
export async function apply(options: ApplyOptions): Promise<ApplyResult> {
  const overallStart = Date.now();
  const steps: StepResult[] = [];
  let config: ParsedConfig | null = null;
  let db: Database | null = null;

  const { step: onlyStep } = options;

  try {
    // -----------------------------------------------------------------------
    // Step 1: VALIDATE (always runs — required for ParsedConfig)
    // -----------------------------------------------------------------------
    {
      const stepStart = Date.now();
      let stepResult: StepResult;

      try {
        const isDir = existsSync(options.configPath) && statSync(options.configPath).isDirectory();
        const { config: parsed, result: vResult } = isDir
          ? await loadAndValidateDir(options.configPath)
          : loadAndValidate(options.configPath);

        stepResult = {
          step: "VALIDATE",
          success: vResult.valid,
          duration_ms: Date.now() - stepStart,
          summary: vResult.valid
            ? `${parsed!.activeDivisions.length} active, ${parsed!.divisions.length - parsed!.activeDivisions.length} inactive divisions`
            : `${vResult.errors.length} validation error(s)`,
          details: {
            errors: vResult.errors,
            warnings: vResult.warnings,
          },
        };

        if (vResult.valid && parsed) {
          config = parsed;
        }
      } catch (err) {
        stepResult = {
          step: "VALIDATE",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        };
      }

      steps.push(stepResult);

      if (!stepResult.success || !config) {
        logger.error("validate", "Validation failed — aborting apply");
        return buildResult(false, steps, config ?? ({} as ParsedConfig), overallStart);
      }

      // Create a governance snapshot BEFORE applying any changes.
      // Best-effort: a snapshot failure must not abort the apply.
      try {
        // When configPath is a directory, pass null so the snapshot skips
        // single-file capture and falls back to directory-level capture.
        const snapConfigPath = existsSync(options.configPath) && statSync(options.configPath).isDirectory()
          ? null
          : options.configPath;
        createSnapshot(options.workDir, snapConfigPath, null, "apply");
      } catch (snapErr) {
        logger.warn(
          "system",
          "Governance snapshot failed (non-fatal); apply continues",
          { metadata: { error: snapErr instanceof Error ? snapErr.message : String(snapErr) } },
        );
      }

      if (!shouldRun(onlyStep, "FILESYSTEM")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: FILESYSTEM
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "FILESYSTEM")) {
      const stepStart = Date.now();

      try {
        const ops = planFilesystem(config);
        const fsResult = executeFilesystemOps(ops, options.workDir);
        steps.push({
          step: "FILESYSTEM",
          success: true,
          duration_ms: Date.now() - stepStart,
          summary: `${fsResult.created} dirs created, ${fsResult.skipped} skipped, ${fsResult.written} files written`,
          details: {
            created: fsResult.created,
            skipped: fsResult.skipped,
            written: fsResult.written,
          },
        });
      } catch (err) {
        steps.push({
          step: "FILESYSTEM",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }

      if (!shouldRun(onlyStep, "DATABASE")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 3: DATABASE (returns an open Database handle)
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "DATABASE")) {
      // Guarantee .system/ directory exists before opening the DB
      const systemDir = join(options.workDir, ".system");
      if (!existsSync(systemDir)) {
        mkdirSync(systemDir, { recursive: true });
      }

      const stepStart = Date.now();
      try {
        const { result: dbResult, db: openedDb } = applyDatabase(config, options.workDir);
        db = openedDb;
        steps.push({ ...dbResult, duration_ms: Date.now() - stepStart });
      } catch (err) {
        steps.push({
          step: "DATABASE",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }

      if (!shouldRun(onlyStep, "AGENTS")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 4: AGENTS (needs DB handle)
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "AGENTS")) {
      if (!db) {
        throw new ApplyError(
          "DATABASE_ERROR",
          "AGENTS",
          "Database must be open before running AGENTS step",
        );
      }
      const stepStart = Date.now();
      try {
        const result = applyAgents(config, options.workDir, db);
        steps.push({ ...result, duration_ms: Date.now() - stepStart });
      } catch (err) {
        steps.push({
          step: "AGENTS",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }

      if (!shouldRun(onlyStep, "SECRETS")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 5: SECRETS (async — needs DB handle)
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "SECRETS")) {
      if (!db) {
        throw new ApplyError(
          "DATABASE_ERROR",
          "SECRETS",
          "Database must be open before running SECRETS step",
        );
      }
      const stepStart = Date.now();
      try {
        const result = await applySecrets(config, options.workDir, db);
        steps.push({ ...result, duration_ms: Date.now() - stepStart });
      } catch (err) {
        steps.push({
          step: "SECRETS",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }

      if (!shouldRun(onlyStep, "RBAC")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 6: RBAC
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "RBAC")) {
      const stepStart = Date.now();
      try {
        const result = applyRBAC(config, options.workDir, db);
        steps.push({ ...result, duration_ms: Date.now() - stepStart });
      } catch (err) {
        steps.push({
          step: "RBAC",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }

      if (!shouldRun(onlyStep, "ROUTING")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 7: ROUTING
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "ROUTING")) {
      const stepStart = Date.now();
      try {
        const result = applyRouting(config, options.workDir);
        steps.push({ ...result, duration_ms: Date.now() - stepStart });
      } catch (err) {
        steps.push({
          step: "ROUTING",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }

      if (!shouldRun(onlyStep, "SKILLS")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 8: SKILLS
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "SKILLS")) {
      const stepStart = Date.now();
      try {
        const result = applySkills(config, options.workDir);
        steps.push({ ...result, duration_ms: Date.now() - stepStart });
      } catch (err) {
        steps.push({
          step: "SKILLS",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }

      if (!shouldRun(onlyStep, "AUDIT")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 9: AUDIT (needs DB handle)
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "AUDIT")) {
      if (!db) {
        throw new ApplyError(
          "DATABASE_ERROR",
          "AUDIT",
          "Database must be open before running AUDIT step",
        );
      }
      const stepStart = Date.now();
      try {
        const result = applyAudit(config, options.workDir, db);
        steps.push({ ...result, duration_ms: Date.now() - stepStart });
      } catch (err) {
        steps.push({
          step: "AUDIT",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }

      if (!shouldRun(onlyStep, "COST_CENTERS")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 10: COST_CENTERS (needs DB handle)
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "COST_CENTERS")) {
      if (!db) {
        throw new ApplyError(
          "DATABASE_ERROR",
          "COST_CENTERS",
          "Database must be open before running COST_CENTERS step",
        );
      }
      const stepStart = Date.now();
      try {
        const result = applyCostCenters(config, options.workDir, db);
        steps.push({ ...result, duration_ms: Date.now() - stepStart });
      } catch (err) {
        steps.push({
          step: "COST_CENTERS",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }

      if (!shouldRun(onlyStep, "FINALIZE")) {
        return buildResult(true, steps, config, overallStart);
      }
    }

    // -----------------------------------------------------------------------
    // Step 11: FINALIZE
    // -----------------------------------------------------------------------
    if (shouldRun(onlyStep, "FINALIZE")) {
      const stepStart = Date.now();
      try {
        const result = applyFinalize(config, options.workDir, Date.now() - overallStart);
        steps.push({ ...result, duration_ms: Date.now() - stepStart });
      } catch (err) {
        steps.push({
          step: "FINALIZE",
          success: false,
          duration_ms: Date.now() - stepStart,
          summary: err instanceof Error ? err.message : String(err),
        });
        return buildResult(false, steps, config, overallStart);
      }
    }

    const totalMs = Date.now() - overallStart;
    logger.info("system", `Apply completed in ${totalMs}ms (${steps.length} steps)`);

    return buildResult(true, steps, config, overallStart);
  } catch (err) {
    // Unhandled error (e.g. ApplyError thrown for missing DB prerequisite)
    const message = err instanceof Error ? err.message : String(err);
    logger.error("system", `Apply aborted: ${message}`);
    return {
      success: false,
      steps,
      config: config ?? ({} as ParsedConfig),
      duration_ms: Date.now() - overallStart,
    };
  } finally {
    // Always close the database handle, even on error
    if (db) {
      db.close();
      db = null;
    }
  }
}
