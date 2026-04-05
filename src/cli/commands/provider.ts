// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 13d: `sidjua provider` CLI Command
 *
 * Manage LLM providers in the catalog.
 *
 * Commands:
 *   sidjua provider list               — list all providers (builtin + custom)
 *   sidjua provider add <id>           — interactive add for builtin provider
 *   sidjua provider add-custom         — add any OpenAI-compatible endpoint
 *   sidjua provider remove <id>        — remove a custom provider
 *   sidjua provider test               — auto-detect capabilities of an endpoint
 *   sidjua provider models <id>        — list models for a provider
 */

import type { Command } from "commander";
import { ProviderCatalog }         from "../../providers/catalog.js";
import { CustomProviderManager }   from "../../providers/custom-provider.js";
import { ProviderAutoDetect }      from "../../providers/auto-detect.js";
import { askSecret }               from "../utils/interactive-prompt.js";


/** Read all of stdin as a single trimmed string (for non-TTY API key piping). */
function readStdinLine(): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = "";
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => { data += chunk; };
    const onEnd  = () => {
      process.stdin.removeListener("data", onData);
      resolve(data.trim());
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

export function registerProviderCommands(program: Command): void {
  const providerCmd = program
    .command("provider")
    .description("Manage LLM providers");

  // ── list ──────────────────────────────────────────────────────────────────
  providerCmd
    .command("list")
    .description("List all available providers")
    .option("--cloud", "Show only cloud providers")
    .option("--local", "Show only local/self-hosted providers")
    .option("--custom", "Show only custom providers")
    .action((opts: { cloud?: boolean; local?: boolean; custom?: boolean }) => {
      const catalog = new ProviderCatalog();
      let providers = catalog.getAll();

      if (opts.cloud)  providers = catalog.getCloud();
      if (opts.local)  providers = catalog.getLocal();
      if (opts.custom) providers = catalog.getCustom();

      if (providers.length === 0) {
        process.stdout.write("No providers found.\n");
        return;
      }

      process.stdout.write(`${"ID".padEnd(24)} ${"NAME".padEnd(28)} ${"TYPE".padEnd(10)} MODELS\n`);
      process.stdout.write(`${"-".repeat(24)} ${"-".repeat(28)} ${"-".repeat(10)} ------\n`);

      for (const p of providers) {
        const id      = p.id.padEnd(24);
        const name    = p.name.padEnd(28);
        const type    = p.category.padEnd(10);
        const models  = p.models.map((m) => m.id).join(", ");
        process.stdout.write(`${id} ${name} ${type} ${models}\n`);
      }
    });

  // ── models ────────────────────────────────────────────────────────────────
  providerCmd
    .command("models <id>")
    .description("List models for a specific provider")
    .action((id: string) => {
      const catalog  = new ProviderCatalog();
      const provider = catalog.getById(id);

      if (provider === undefined) {
        process.stderr.write(`Provider "${id}" not found.\n`);
        process.exit(1);
      }

      if (provider.models.length === 0) {
        process.stdout.write(`No models listed for provider "${id}".\n`);
        return;
      }

      process.stdout.write(`Models for ${provider.name}:\n`);
      for (const m of provider.models) {
        const ctx    = m.context_window ? ` (${(m.context_window / 1000).toFixed(0)}k ctx)` : "";
        const price  = m.pricing
          ? ` | $${m.pricing.input_per_1m_tokens}/M in, $${m.pricing.output_per_1m_tokens}/M out`
          : "";
        process.stdout.write(`  ${m.id}${ctx}${price}\n`);
      }
    });

  // ── add-custom ────────────────────────────────────────────────────────────
  providerCmd
    .command("add-custom")
    .description("Add a custom OpenAI-compatible provider endpoint")
    .requiredOption("--id <id>",         "Provider ID (lowercase, letters/digits/-/_)")
    .requiredOption("--name <name>",     "Display name")
    .requiredOption("--base-url <url>",  "Base URL of the OpenAI-compatible endpoint")
    .requiredOption("--model <model>",   "Default model ID")
    // --api-key removed: key is read from interactive prompt (TTY) or stdin (pipe)
    // to prevent the credential appearing in shell history or process listings.
    .option("--header <kv>",             "Custom header (key:value), repeatable", collect, [])
    .option("--no-probe",                "Skip capability auto-detection")
    .action(async (opts: {
      id:       string;
      name:     string;
      baseUrl:  string;
      model:    string;
      header:   string[];
      probe:    boolean;
    }) => {
      // Read API key securely: prompt (TTY) or stdin (pipe). Never from CLI args.
      const apiKey = process.stdin.isTTY
        ? await askSecret("API key (leave empty to skip)")
        : await readStdinLine();

      const customHeaders = parseHeaders(opts.header);
      const catalog       = new ProviderCatalog();
      const manager       = new CustomProviderManager(catalog);

      // Auto-detect capabilities (unless --no-probe)
      if (opts.probe) {
        const detector = new ProviderAutoDetect();
        process.stdout.write(`Probing ${opts.baseUrl}...\n`);
        const result = await detector.probe({
          base_url: opts.baseUrl,
          model:    opts.model,
          ...(apiKey !== ""                                   && { api_key:        apiKey }),
          ...(Object.keys(customHeaders).length > 0          && { custom_headers: customHeaders }),
        });

        process.stdout.write(`  alive:     ${result.alive}\n`);
        process.stdout.write(`  chat:      ${result.chat_completions}\n`);
        process.stdout.write(`  tool use:  ${result.tool_use}\n`);
        process.stdout.write(`  latency:   ${result.response_time_ms}ms\n`);

        if (result.errors.length > 0) {
          process.stdout.write("  warnings:\n");
          for (const e of result.errors) {
            process.stdout.write(`    - ${e}\n`);
          }
        }
      }

      const entry = await manager.add({
        id:                opts.id,
        name:              opts.name,
        base_url:          opts.baseUrl,
        api_key_required:  apiKey !== "",
        models:            [opts.model],
        supports_tool_use: "auto",
        ...(Object.keys(customHeaders).length > 0 && { custom_headers: customHeaders }),
      });

      process.stdout.write(`Provider "${entry.id}" added successfully.\n`);
    });

  // ── remove ────────────────────────────────────────────────────────────────
  providerCmd
    .command("remove <id>")
    .description("Remove a custom provider")
    .action(async (id: string) => {
      const catalog = new ProviderCatalog();
      const manager = new CustomProviderManager(catalog);

      if (!catalog.getById(id)) {
        process.stderr.write(`Provider "${id}" not found.\n`);
        process.exit(1);
      }

      await manager.remove(id);
      process.stdout.write(`Provider "${id}" removed.\n`);
    });

  // ── test ──────────────────────────────────────────────────────────────────
  providerCmd
    .command("test")
    .description("Test an endpoint's capabilities (auto-detect probe)")
    .requiredOption("--base-url <url>",  "Base URL of the OpenAI-compatible endpoint")
    .requiredOption("--model <model>",   "Model ID to test with")
    .option("--api-key <key>",           "[deprecated] API key — use SIDJUA_PROVIDER_KEY env variable instead")
    .option("--timeout <ms>",            "Timeout per probe step in ms", "15000")
    .action(async (opts: {
      baseUrl:  string;
      model:    string;
      apiKey?:  string;
      timeout:  string;
    }) => {
      // Resolve effective API key.
      // Priority: SIDJUA_PROVIDER_KEY env var (secure) > --api-key flag (deprecated).
      const envKey = process.env["SIDJUA_PROVIDER_KEY"];
      let effectiveKey: string | undefined;

      if (envKey !== undefined && envKey !== "") {
        effectiveKey = envKey;
      } else if (opts.apiKey !== undefined) {
        process.stderr.write(
          "Warning: --api-key passes credentials via the command line, which is visible in\n" +
          "process listings (ps, /proc) and shell history. Use the SIDJUA_PROVIDER_KEY\n" +
          "environment variable instead: SIDJUA_PROVIDER_KEY=<key> sidjua provider test ...\n",
        );
        effectiveKey = opts.apiKey;
      }

      const detector  = new ProviderAutoDetect(parseInt(opts.timeout, 10));

      process.stdout.write(`Probing ${opts.baseUrl}...\n\n`);

      const result = await detector.probe({
        base_url: opts.baseUrl,
        model:    opts.model,
        ...(effectiveKey !== undefined && { api_key: effectiveKey }),
      });

      const tick = (v: boolean): string => (v ? "[ok]" : "[--]");

      process.stdout.write(`${tick(result.alive)}            Endpoint reachable\n`);
      process.stdout.write(`${tick(result.models_endpoint)} GET /models supported\n`);
      process.stdout.write(`${tick(result.chat_completions)} POST /chat/completions\n`);
      process.stdout.write(`${tick(result.tool_use)}        Tool calling\n`);
      process.stdout.write(`\nResponse time: ${result.response_time_ms}ms\n`);

      if (result.available_models.length > 0) {
        process.stdout.write(`\nAvailable models: ${result.available_models.slice(0, 5).join(", ")}\n`);
      }

      if (result.errors.length > 0) {
        process.stdout.write("\nWarnings:\n");
        for (const e of result.errors) {
          process.stdout.write(`  - ${e}\n`);
        }
      }
    });
}


function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function parseHeaders(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers) {
    const idx = h.indexOf(":");
    if (idx === -1) continue;
    const key = h.slice(0, idx).trim();
    const val = h.slice(idx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}
