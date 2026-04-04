#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.

/**
 * Walks src/ and builds a JSON file map: path → exports → description.
 * Output: docs/.build/filemap.json
 */

import * as fs   from "node:fs";
import * as path from "node:path";

interface FileEntry {
  path:        string;
  exports:     string[];
  description: string;
}

interface FileMap {
  files:       FileEntry[];
  generatedAt: string;
}

function extractExports(content: string): string[] {
  const found: string[] = [];
  const patterns: RegExp[] = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
    /export\s+const\s+(\w+)/g,
    /export\s+enum\s+(\w+)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    // Reset lastIndex between uses (patterns are module-level so they persist state)
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return [...new Set(found)];
}

function extractDescription(content: string): string {
  // First JSDoc block
  const jsdocMatch = content.match(/\/\*\*\s*([\s\S]*?)\s*\*\//);
  if (jsdocMatch?.[1] !== undefined) {
    return jsdocMatch[1]
      .replace(/\s*\*\s*/g, " ")
      .trim()
      .slice(0, 200);
  }
  // First single-line comment (skip licence headers starting with "SPDX-")
  const lineMatch = content.match(/^\/\/\s*(?!SPDX-)(.+)$/m);
  if (lineMatch?.[1] !== undefined) {
    return lineMatch[1].trim();
  }
  return "";
}

function walkDir(dir: string, base: string): FileEntry[] {
  const entries: FileEntry[] = [];
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err: unknown) {
    return entries;
  }

  for (const item of items) {
    if (item.name.startsWith(".")) continue;
    if (item.name === "node_modules" || item.name === "dist") continue;

    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      if (item.name !== "__tests__" && item.name !== "test") {
        entries.push(...walkDir(fullPath, base));
      }
    } else if (
      item.name.endsWith(".ts") &&
      !item.name.endsWith(".test.ts") &&
      !item.name.endsWith(".d.ts")
    ) {
      let content = "";
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch (_err: unknown) {
        continue;
      }
      entries.push({
        path:        path.relative(base, fullPath),
        exports:     extractExports(content),
        description: extractDescription(content),
      });
    }
  }
  return entries;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const repoRoot = process.cwd();
const files    = walkDir(path.join(repoRoot, "src"), repoRoot);
const output: FileMap = { files, generatedAt: new Date().toISOString() };

const buildDir = path.join(repoRoot, "docs", ".build");
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, "filemap.json"), JSON.stringify(output, null, 2), "utf-8");

console.log(`Extracted ${files.length} files to docs/.build/filemap.json`);
