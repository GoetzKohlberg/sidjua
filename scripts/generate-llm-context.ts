#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

/**
 * Reads docs/.build/deps.json + filemap.json and calls the Anthropic API to
 * generate (or update) docs/llm/SIDJUA-ARCHITECTURE-CONTEXT.md.
 *
 * API key MUST be provided via ANTHROPIC_API_KEY environment variable.
 * Never hardcode credentials.
 */

import * as fs   from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// ─── API key guard ────────────────────────────────────────────────────────────

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// ─── Load inputs ──────────────────────────────────────────────────────────────

const repoRoot  = process.cwd();
const buildDir  = path.join(repoRoot, "docs", ".build");

let deps: unknown = { modules: [] };
try {
  deps = JSON.parse(fs.readFileSync(path.join(buildDir, "deps.json"), "utf-8")) as unknown;
} catch (_err: unknown) {
  console.warn("deps.json not found — dependency data will be empty");
}

let filemap: { files: Array<{ path: string; exports: string[]; description: string }> } = { files: [] };
try {
  const raw = fs.readFileSync(path.join(buildDir, "filemap.json"), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed === "object" && parsed !== null && "files" in parsed && Array.isArray((parsed as { files: unknown }).files)) {
    filemap = parsed as typeof filemap;
  }
} catch (_err: unknown) {
  console.error("filemap.json not found — run extract-file-map.ts first");
  process.exit(1);
}

// Read existing context doc if present (update mode)
const contextPath = path.join(repoRoot, "docs", "llm", "SIDJUA-ARCHITECTURE-CONTEXT.md");
let existingContext: string | null = null;
try {
  existingContext = fs.readFileSync(contextPath, "utf-8");
} catch (_err: unknown) {
  // First run — no existing doc
}

// ─── Build prompt ─────────────────────────────────────────────────────────────

function extractTopModules(depsData: unknown): string[] {
  const modules = new Set<string>();
  if (typeof depsData === "object" && depsData !== null && "modules" in depsData) {
    const mods = (depsData as { modules: unknown[] }).modules;
    if (Array.isArray(mods)) {
      for (const mod of mods) {
        if (typeof mod === "object" && mod !== null && "source" in mod && typeof (mod as { source: unknown }).source === "string") {
          const parts = ((mod as { source: string }).source).split("/");
          if (parts.length >= 3) {
            modules.add(parts.slice(0, 3).join("/"));
          }
        }
      }
    }
  }
  return [...modules].sort().slice(0, 30);
}

const topModules = extractTopModules(deps);
const topFiles = filemap.files.slice(0, 40).map((f) => ({
  path:    f.path,
  exports: f.exports.slice(0, 5),
}));

const prompt = `You are documenting the SIDJUA architecture for LLM consumption.

INPUTS:
- File map (${filemap.files.length} source files with exports and descriptions)
- Dependency graph (module dependencies)
${existingContext !== null ? "- Previous version of this document (update, don't rewrite from scratch)" : ""}

RULES:
- Output MUST be < 8000 tokens
- Use structured Markdown: key-value pairs, numbered lists, Mermaid diagrams
- No prose filler — every line must carry information
- Include: System Identity (1 paragraph), Core Concepts (key-value), C4 Level 2 Mermaid diagram, File Map (max 40 entries), Data Flows (numbered steps), Agent Definitions, Governance Rules, API Surface

FILE MAP (abbreviated — top 40 files):
${JSON.stringify(topFiles, null, 2)}

DEPENDENCY MODULES (top-level):
${JSON.stringify(topModules, null, 2)}

${existingContext !== null ? `PREVIOUS VERSION:\n${existingContext}` : ""}

Generate the complete SIDJUA-ARCHITECTURE-CONTEXT.md document.`;

// ─── Call API and write output ────────────────────────────────────────────────

const client = new Anthropic({ apiKey });

async function generate(): Promise<void> {
  const response = await client.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const llmDir = path.join(repoRoot, "docs", "llm");
  fs.mkdirSync(llmDir, { recursive: true });
  fs.writeFileSync(contextPath, text, "utf-8");

  // Rough token estimate: 1 token ≈ 4 chars
  const estimatedTokens = Math.ceil(text.length / 4);
  if (estimatedTokens > 8000) {
    console.warn(`WARNING: Context doc is ~${estimatedTokens} tokens (target: < 8000)`);
  }

  console.log(`Generated ${contextPath} (~${estimatedTokens} tokens)`);
}

generate().catch((err: unknown) => {
  console.error("Generation failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
