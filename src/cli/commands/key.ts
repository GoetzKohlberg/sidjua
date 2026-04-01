// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13d: `sidjua key` CLI Command
 *
 * Manage API key references for LLM providers.
 * Key references store the source (env var name or literal) — not the actual key value.
 *
 * Commands:
 *   sidjua key add <name>     — register a named key reference
 *   sidjua key list           — list all key references
 *   sidjua key test <name>    — resolve + validate a key reference
 *   sidjua key remove <name>  — remove a named key reference
 */

import type { Command } from "commander";
import { ProviderKeyManager } from "../../providers/key-manager.js";
import { msg } from "../../i18n/index.js";


export function registerKeyCommands(program: Command): void {
  const keyCmd = program
    .command("key")
    .description("Manage LLM provider API key references");

  // ── add ───────────────────────────────────────────────────────────────────
  keyCmd
    .command("add <name>")
    .description("Register a named key reference")
    .requiredOption("--provider <id>",   "Provider ID this key is for (e.g. anthropic)")
    .requiredOption("--source <spec>",   "Key source: env:VAR_NAME or literal:VALUE")
    .option("--agent <id>",              "Restrict to specific agent (repeatable)", collect, [])
    .option("--allow-plaintext",         "Allow literal key values (deprecated, insecure)")
    .action((
      name: string,
      opts: { provider: string; source: string; agent: string[]; allowPlaintext?: boolean },
    ) => {
      // Warn and block literal: sources based on environment.
      if (opts.source.startsWith("literal:")) {
        const isDev = process.env["NODE_ENV"] === "development" || process.env["NODE_ENV"] === "test";
        if (!isDev && !opts.allowPlaintext) {
          process.stderr.write("Error: literal: key source is blocked in production (exposes secrets in shell history).\n");
          process.stderr.write("Use: sidjua key add --source env:MY_KEY_VAR  or pipe from stdin.\n");
          process.stderr.write("In development: set NODE_ENV=development to allow.\n");
          process.exitCode = 1;
          return;
        }
        if (isDev) {
          process.stderr.write("WARNING: literal: key source exposes secrets in shell history. Use env: in production.\n");
        }
      }

      const manager = new ProviderKeyManager();
      manager.addKeyRef({
        name,
        provider: opts.provider,
        source:   opts.source,
        ...(opts.agent.length > 0 && { agents: opts.agent }),
      });
      process.stdout.write(`Key ref "${name}" registered for provider ${opts.provider}.\n`);
      process.stdout.write(`  source: ${maskSource(opts.source)}\n`);
    });

  // ── list ──────────────────────────────────────────────────────────────────
  keyCmd
    .command("list")
    .description("List all registered key references")
    .action(() => {
      const manager = new ProviderKeyManager();
      const refs    = manager.listKeyRefs();

      if (refs.length === 0) {
        process.stdout.write("No key references registered.\n");
        process.stdout.write("Use `sidjua key add` to register one, or set environment variables directly.\n");
        return;
      }

      process.stdout.write(`${"NAME".padEnd(24)} ${"PROVIDER".padEnd(16)} SOURCE\n`);
      process.stdout.write(`${"-".repeat(24)} ${"-".repeat(16)} ------\n`);

      for (const ref of refs) {
        const name     = ref.name.padEnd(24);
        const provider = ref.provider.padEnd(16);
        const source   = maskSource(ref.source);
        process.stdout.write(`${name} ${provider} ${source}\n`);
      }
    });

  // ── test ──────────────────────────────────────────────────────────────────
  keyCmd
    .command("test <name>")
    .description("Resolve and validate a named key reference")
    .action(async (name: string) => {
      const manager = new ProviderKeyManager();
      const ref     = manager.getKeyByRef(name);

      if (ref === undefined) {
        process.stderr.write(`Key ref "${name}" not found. Use \`sidjua key list\` to see all.\n`);
        process.exit(1);
      }

      process.stdout.write(`Testing key ref "${name}" (provider: ${ref.provider})...\n`);

      let resolved: string;
      try {
        resolved = await manager.resolveKeyRef(name);
      } catch (err) {
        process.stderr.write(`  [error] Could not resolve key: ${String(err)}\n`);
        process.exit(1);
      }

      process.stdout.write(`  Resolved: ${maskKey(resolved)}\n`);

      const valid = await manager.validateKeyRef(name);
      if (valid) {
        process.stdout.write(`  Validation: [ok] Key accepted by ${ref.provider}\n`);
      } else {
        process.stdout.write(`  Validation: [fail] Key rejected or provider unreachable\n`);
        process.exit(1);
      }
    });

  // ── remove ────────────────────────────────────────────────────────────────
  keyCmd
    .command("remove <name>")
    .description("Remove a named key reference")
    .action((name: string) => {
      const manager = new ProviderKeyManager();

      if (manager.getKeyByRef(name) === undefined) {
        process.stderr.write(`Key ref "${name}" not found.\n`);
        process.exit(1);
      }

      manager.removeKeyRef(name);
      process.stdout.write(`Key ref "${name}" removed.\n`);
    });
}


function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/** Mask a source spec for display — show type, hide value. */
function maskSource(source: string): string {
  const [type, ...rest] = source.split(":");
  if (type === "env")     return `env:${rest.join(":")}`;  // env var name is safe to show
  if (type === "literal") return "literal:****";
  return source;
}

/**
 * Mask an actual API key for display — show NO actual characters.
 *
 * Showing even trailing characters can reveal key-family versioning info
 * and reduces brute-force search space.
 *
 * Rules:
 *   - All characters are replaced with asterisks.
 *   - Minimum 8 asterisks regardless of key length (avoids leaking exact length
 *     for short keys while still indicating the field is populated).
 *
 * @example maskKey("sk-ant-abcdefghijklmn1234") → "************************"
 */
export function maskKey(key: string): string {
  if (key.length === 0) return "****";
  return "*".repeat(Math.max(key.length, 8));
}
