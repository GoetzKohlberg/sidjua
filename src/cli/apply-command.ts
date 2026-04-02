// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua apply` command handler
 *
 * Separates CLI argument parsing (Commander, src/index.ts) from the
 * apply logic so that runApplyCommand() can be tested without spawning
 * a child process or mocking Commander internals.
 */

import { existsSync, statSync } from "node:fs";
import { resolve }              from "node:path";
import { assertWithinDirectoryReal } from "../utils/path-utils.js";
import { loadAndValidate, loadAndValidateDir } from "../apply/validate.js";
import { planFilesystem } from "../apply/filesystem.js";
import { apply } from "../apply/index.js";
import type { ApplyStep } from "../types/apply.js";
import { printApplyResult, printDryRunPlan } from "./output.js";


export interface ApplyCommandOptions {
  /** Path to divisions.yaml — may be relative (resolved against workDir). */
  config: string;
  dryRun: boolean;
  verbose: boolean;
  force: boolean;
  /** Raw step name from CLI; validated + uppercased before use. */
  step?: string;
  workDir: string;
}


const VALID_STEPS: ApplyStep[] = [
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

/**
 * Validate and normalise a raw step string from the CLI.
 * Accepts any case ("validate", "VALIDATE", "Validate").
 * @throws Error if the step name is not recognised.
 */
function parseStep(raw: string): ApplyStep {
  const upper = raw.toUpperCase() as ApplyStep;
  if (!VALID_STEPS.includes(upper)) {
    throw new Error(
      `Invalid step "${raw}". Valid steps: ${VALID_STEPS.join(", ")}`,
    );
  }
  return upper;
}


/**
 * Execute `sidjua apply` with the parsed CLI options.
 *
 * @returns Exit code: 0 on success, 1 on any failure.
 *          The caller (index.ts) is responsible for calling process.exit().
 */
export async function runApplyCommand(opts: ApplyCommandOptions): Promise<number> {
  let configPath = resolve(opts.workDir, opts.config);

  // Guard against path-traversal in --config: reject any path that resolves
  // outside the workspace root.  The fallback paths (governance/, config/)
  // are constructed by the code itself and are always within workDir.
  try {
    assertWithinDirectoryReal(configPath, opts.workDir);
  } catch (_e) {
    process.stderr.write(`Error: --config path is outside the workspace root: ${opts.config}\n`);
    return 1;
  }

  // Resolution order:
  //  1. governance/divisions/ directory (modular per-file format)
  //  2. governance/divisions.yaml       (single-file, legacy)
  //  3. config/divisions.yaml           (Docker / user-customised config dir)
  //  4. divisions.yaml                  (workspace root, ancient legacy)
  if (!existsSync(configPath)) {
    const govDirPath    = resolve(opts.workDir, "governance", "divisions");
    const govPath       = resolve(opts.workDir, "governance", "divisions.yaml");
    const configDirPath = resolve(opts.workDir, "config", "divisions.yaml");
    const rootPath      = resolve(opts.workDir, "divisions.yaml");
    if (existsSync(govDirPath) && statSync(govDirPath).isDirectory()) {
      configPath = govDirPath;
    } else if (existsSync(govPath)) {
      configPath = govPath;
    } else if (existsSync(configDirPath)) {
      configPath = configDirPath;
    } else if (existsSync(rootPath)) {
      configPath = rootPath;
    } else {
      process.stderr.write(`Error: config not found: ${configPath}\n`);
      return 1;
    }
  } else if (statSync(configPath).isDirectory()) {
    // The caller explicitly passed a directory path — accepted as-is
  }

  // -------------------------------------------------------------------------
  // Dry-run mode: validate + plan filesystem, print summary, stop.
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    try {
      const isDir = statSync(configPath).isDirectory();
      const { config, result: vResult } = isDir
        ? await loadAndValidateDir(configPath)
        : loadAndValidate(configPath);

      if (!vResult.valid || !config) {
        process.stderr.write("Validation failed:\n");
        for (const err of vResult.errors) {
          process.stderr.write(`  ✗ ${err.field}: ${err.message}\n`);
        }
        return 1;
      }

      const ops = planFilesystem(config);
      const activeDivisions = config.activeDivisions.length;
      const inactiveDivisions = config.divisions.length - activeDivisions;
      const validSummary = `${activeDivisions} active, ${inactiveDivisions} inactive divisions`;
      printDryRunPlan(validSummary, ops);
      return 0;
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  // -------------------------------------------------------------------------
  // Normal apply mode
  // -------------------------------------------------------------------------

  // Validate --step if provided
  let step: ApplyStep | undefined;
  if (opts.step !== undefined) {
    try {
      step = parseStep(opts.step);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  let result: Awaited<ReturnType<typeof apply>>;
  try {
    result = await apply({
      configPath,
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      force: opts.force,
      workDir: opts.workDir,
      ...(step !== undefined ? { step } : {}),
    });
  } catch (err) {
    process.stderr.write(
      `Error: Apply failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  printApplyResult(result, opts.verbose);
  return result.success ? 0 : 1;
}
