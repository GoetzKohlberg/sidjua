// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: Knowledge Pipeline CLI commands
 *
 * Registers `sidjua knowledge <subcommand>` on an existing Commander program.
 * Subcommands: create, import, list, show, search, reindex, delete.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { openKnowledgeDatabase } from "../cli/utils/db-init.js";
import { CollectionManager } from "./collection-manager.js";
import { EmbeddingPipeline } from "./embedding/embedding-pipeline.js";
import { OpenAIEmbedder } from "./embedding/openai-embedder.js";
import { LocalEmbedder } from "./embedding/local-embedder.js";
import { HybridRetriever } from "./retrieval/hybrid-retriever.js";
import { MarkdownParser } from "./parsers/markdown-parser.js";
import { PdfParser } from "./parsers/pdf-parser.js";
import { DocxParser } from "./parsers/docx-parser.js";
import { HtmlParser } from "./parsers/html-parser.js";
import { CsvParser } from "./parsers/csv-parser.js";
import { CodeParser } from "./parsers/code-parser.js";
import { ClaudeExportParser } from "./parsers/claude-export-parser.js";
import { SemanticChunker } from "./chunkers/semantic-chunker.js";
import { FixedChunker } from "./chunkers/fixed-chunker.js";
import { ParagraphChunker } from "./chunkers/paragraph-chunker.js";
import { formatTable } from "../cli/formatters/table.js";
import { formatJson } from "../cli/formatters/json.js";
import { formatBytes } from "../cli/utils/format.js";
import type { CollectionScope, Parser, Chunker } from "./types.js";
import { createVectorStore } from "./vector-store/index.js";


function getEmbedder(): OpenAIEmbedder | LocalEmbedder {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (apiKey !== undefined && apiKey.length > 0) {
    return new OpenAIEmbedder(apiKey);
  }
  return new LocalEmbedder();
}

function getParser(filePath: string): Parser {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
    case ".txt":
      return new MarkdownParser();
    case ".pdf":
      return new PdfParser();
    case ".docx":
      return new DocxParser();
    case ".html":
    case ".htm":
      return new HtmlParser();
    case ".csv":
      return new CsvParser();
    case ".zip":
      return new ClaudeExportParser();
    case ".json":
      if (basename(filePath).toLowerCase().includes("conversation")) {
        return new ClaudeExportParser();
      }
      return new MarkdownParser();
    case ".ts":
    case ".js":
    case ".py":
    case ".go":
    case ".rs":
    case ".java":
    case ".cpp":
    case ".c":
    case ".h":
      return new CodeParser();
    default:
      return new MarkdownParser();
  }
}

function getChunker(strategy: string): Chunker {
  switch (strategy) {
    case "fixed":
      return new FixedChunker();
    case "paragraph":
      return new ParagraphChunker();
    default:
      return new SemanticChunker();
  }
}

/**
 * Parse a --scope option string into a CollectionScope.
 * Format: "all" or comma-separated "type:value" pairs.
 * E.g. "division:content,division:ops,tier:1"
 */
function parseScope(scopeStr: string | undefined, classification: string): CollectionScope {
  if (scopeStr === undefined || scopeStr === "all") {
    return { classification };
  }

  const divisions: string[] = [];
  const agents: string[] = [];
  const tiers: number[] = [];

  const parts = scopeStr.split(",");
  for (const part of parts) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue;
    const type = part.slice(0, colonIdx).trim();
    const value = part.slice(colonIdx + 1).trim();

    if (type === "division") {
      divisions.push(value);
    } else if (type === "agent") {
      agents.push(value);
    } else if (type === "tier") {
      const n = parseInt(value, 10);
      if (!isNaN(n)) tiers.push(n);
    }
  }

  const scope: CollectionScope = { classification };
  if (divisions.length > 0) scope.divisions = divisions;
  if (agents.length > 0) scope.agents = agents;
  if (tiers.length > 0) scope.tiers = tiers;
  return scope;
}

/**
 * Prompt the user for confirmation via stdin using readline.
 * Returns true if the user typed "yes".
 */
async function promptConfirm(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });
    process.stderr.write(`${message} (yes/no): `);
    rl.once("line", (line) => {
      rl.close();
      resolve(line.trim() === "yes");
    });
    rl.once("close", () => resolve(false));
  });
}


/**
 * Register all `sidjua knowledge *` subcommands on the given Commander program.
 */
export function registerKnowledgeCommands(program: Command): void {
  const knowledge = program
    .command("knowledge")
    .description("Manage knowledge collections and document ingestion");

  // ── sidjua knowledge create <id> ─────────────────────────────────────────

  knowledge
    .command("create <id>")
    .description("Create a new knowledge collection")
    .option("--name <name>", "Display name for the collection")
    .option("--description <text>", "Description of the collection")
    .option(
      "--scope <spec>",
      "Access scope: 'all' or comma-separated type:value pairs (division:xxx, agent:xxx, tier:n)",
    )
    .option("--classification <level>", "Classification level", "INTERNAL")
    .option("--chunking <strategy>", "Chunking strategy: semantic|fixed|paragraph", "semantic")
    .option("--chunk-size <n>", "Target chunk size in tokens", "500")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          description?: string;
          scope?: string;
          classification: string;
          chunking: string;
          chunkSize: string;
          workDir: string;
        },
      ) => {
        const dbPath = join(opts.workDir, ".system", "sidjua.db");
        if (!existsSync(dbPath)) {
          process.stderr.write(
            `Error: database not found at ${dbPath}. Run 'sidjua apply' first.\n`,
          );
          process.exit(1);
        }

        const db = openKnowledgeDatabase(opts.workDir);
        try {
          const scope = parseScope(opts.scope, opts.classification);
          const chunkSizeTokens = parseInt(opts.chunkSize, 10) || 500;

          const manager = new CollectionManager(db);
          manager.create({
            id,
            name: opts.name ?? id,
            ...(opts.description !== undefined ? { description: opts.description } : {}),
            scope,
            ingestion: {
              chunking_strategy:
                opts.chunking === "fixed" || opts.chunking === "paragraph" || opts.chunking === "page"
                  ? opts.chunking
                  : "semantic",
              chunk_size_tokens: chunkSizeTokens,
            },
          });

          process.stdout.write(`Knowledge collection '${id}' created successfully.\n`);
          process.exit(0);
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

  // ── sidjua knowledge import <collection-id> <file> ───────────────────────

  knowledge
    .command("import <collection-id> <file>")
    .description("Import a document into a knowledge collection")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--chunk-size <n>", "Override chunk size in tokens (0 = use collection default)", "0")
    .action(
      async (
        collectionId: string,
        file: string,
        opts: {
          workDir: string;
          chunkSize: string;
        },
      ) => {
        const dbPath = join(opts.workDir, ".system", "sidjua.db");
        if (!existsSync(dbPath)) {
          process.stderr.write(
            `Error: database not found at ${dbPath}. Run 'sidjua apply' first.\n`,
          );
          process.exit(1);
        }
        if (!existsSync(file)) {
          process.stderr.write(`Error: file not found: ${file}\n`);
          process.exit(1);
        }

        const db = openKnowledgeDatabase(opts.workDir);
        try {
          const manager = new CollectionManager(db);
          const collection = manager.getById(collectionId);
          if (collection === undefined) {
            process.stderr.write(
              `Error: collection '${collectionId}' not found. Run 'sidjua knowledge create' first.\n`,
            );
            process.exit(1);
          }

          const MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50 MB
          const fileStats = statSync(file);
          if (fileStats.size > MAX_IMPORT_SIZE) {
            process.stderr.write(`Error: File too large: ${formatBytes(fileStats.size)} exceeds ${formatBytes(MAX_IMPORT_SIZE)} limit
`);
            process.exit(1);
            return;
          }
          const content = readFileSync(file);
          const parser = getParser(file);
          const chunker = getChunker(collection.config.ingestion.chunking_strategy);
          const embedder = getEmbedder();

          const pipeline = new EmbeddingPipeline(db, parser, chunker, embedder, undefined, createVectorStore(db));

          const chunkSizeOverride = parseInt(opts.chunkSize, 10);
          const pipelineOpts: {
            collection_id: string;
            source_file: string;
            chunk_size_tokens?: number;
            onProgress?: (progress: { total: number; completed: number; failed: number }) => void;
          } = {
            collection_id: collectionId,
            source_file: basename(file),
            onProgress: (progress) => {
              process.stderr.write(
                `\rIngesting: ${progress.completed}/${progress.total} chunks` +
                  (progress.failed > 0 ? ` (${progress.failed} failed)` : "") +
                  "  ",
              );
            },
          };
          if (chunkSizeOverride > 0) {
            pipelineOpts.chunk_size_tokens = chunkSizeOverride;
          }

          try {
            const result = await pipeline.ingest(content, pipelineOpts);
            process.stderr.write("\n");
            process.stdout.write(
              `Imported '${basename(file)}' into collection '${collectionId}':\n` +
                `  Chunks written: ${result.chunks_written}\n` +
                `  Total tokens:   ${result.tokens_total}\n`,
            );
            process.exit(0);
          } catch (err) {
            process.stderr.write("\n");
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("Local embedding not yet available")) {
              process.stderr.write(
                "Error: Local embedding is not available in V1.\n" +
                  "Set the OPENAI_API_KEY environment variable to use OpenAI embeddings:\n" +
                  "  export OPENAI_API_KEY=sk-...\n", // pipeline-ok
              );
            } else {
              process.stderr.write(`Error during ingestion: ${msg}\n`);
            }
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
      },
    );

  // ── sidjua knowledge list ─────────────────────────────────────────────────

  knowledge
    .command("list")
    .description("List all knowledge collections")
    .option("--json", "Output in JSON format", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(
      (opts: { json: boolean; workDir: string }) => {
        const dbPath = join(opts.workDir, ".system", "sidjua.db");
        if (!existsSync(dbPath)) {
          process.stderr.write(
            `Error: database not found at ${dbPath}. Run 'sidjua apply' first.\n`,
          );
          process.exit(1);
        }

        const db = openKnowledgeDatabase(opts.workDir);
        try {
          const manager = new CollectionManager(db);
          const collections = manager.list();

          if (opts.json) {
            process.stdout.write(formatJson(collections) + "\n");
            process.exit(0);
          }

          if (collections.length === 0) {
            process.stdout.write("No knowledge collections found.\n");
            process.exit(0);
          }

          const rows: Record<string, unknown>[] = collections.map((c) => ({
            id: c.id,
            status: c.status,
            chunks: c.chunk_count,
            tokens: c.total_tokens,
            classification: c.scope.classification,
            updated: c.updated_at.slice(0, 10),
          }));

          const table = formatTable(rows, {
            columns: [
              { header: "COLLECTION", key: "id", width: 30 },
              { header: "STATUS", key: "status", width: 12 },
              { header: "CHUNKS", key: "chunks", width: 7, align: "right" },
              { header: "TOKENS", key: "tokens", width: 7, align: "right" },
              { header: "CLASSIFICATION", key: "classification", width: 15 },
              { header: "UPDATED", key: "updated", width: 10 },
            ],
          });
          process.stdout.write(table + "\n");
          process.exit(0);
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

  // ── sidjua knowledge show <id> ────────────────────────────────────────────

  knowledge
    .command("show <id>")
    .description("Show details of a knowledge collection")
    .option("--json", "Output in JSON format", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(
      (
        id: string,
        opts: { json: boolean; workDir: string },
      ) => {
        const dbPath = join(opts.workDir, ".system", "sidjua.db");
        if (!existsSync(dbPath)) {
          process.stderr.write(
            `Error: database not found at ${dbPath}. Run 'sidjua apply' first.\n`,
          );
          process.exit(1);
        }

        const db = openKnowledgeDatabase(opts.workDir);
        try {
          const manager = new CollectionManager(db);
          const collection = manager.getById(id);

          if (collection === undefined) {
            process.stderr.write(`Error: collection '${id}' not found.\n`);
            process.exit(1);
          }

          if (opts.json) {
            process.stdout.write(formatJson(collection) + "\n");
            process.exit(0);
          }

          process.stdout.write(
            `Collection: ${collection.id}\n` +
              `  Name:           ${collection.name}\n` +
              `  Description:    ${collection.description || "(none)"}\n` +
              `  Status:         ${collection.status}\n` +
              `  Chunks:         ${collection.chunk_count}\n` +
              `  Total tokens:   ${collection.total_tokens}\n` +
              `  Classification: ${collection.scope.classification}\n` +
              `  Divisions:      ${collection.scope.divisions?.join(", ") ?? "all"}\n` +
              `  Agents:         ${collection.scope.agents?.join(", ") ?? "all"}\n` +
              `  Tiers:          ${collection.scope.tiers?.join(", ") ?? "all"}\n` +
              `  Chunking:       ${collection.config.ingestion.chunking_strategy}\n` +
              `  Chunk size:     ${collection.config.ingestion.chunk_size_tokens} tokens\n` +
              `  Overlap:        ${collection.config.ingestion.chunk_overlap_tokens} tokens\n` +
              `  Embedding:      ${collection.config.ingestion.embedding_provider}/${collection.config.ingestion.embedding_model}\n` +
              `  Created:        ${collection.created_at}\n` +
              `  Updated:        ${collection.updated_at}\n`,
          );
          process.exit(0);
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

  // ── sidjua knowledge search <collection-id> <query> ──────────────────────

  knowledge
    .command("search <collection-id> <query>")
    .description("Search a knowledge collection")
    .option("--top-k <n>", "Number of results to return", "5")
    .option("--json", "Output in JSON format", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(
      async (
        collectionId: string,
        query: string,
        opts: { topK: string; json: boolean; workDir: string },
      ) => {
        const dbPath = join(opts.workDir, ".system", "sidjua.db");
        if (!existsSync(dbPath)) {
          process.stderr.write(
            `Error: database not found at ${dbPath}. Run 'sidjua apply' first.\n`,
          );
          process.exit(1);
        }

        const db = openKnowledgeDatabase(opts.workDir);
        try {
          const topK = parseInt(opts.topK, 10) || 5;
          const embedder = getEmbedder();
          const retriever = new HybridRetriever(db, embedder, undefined, createVectorStore(db));

          let results;
          try {
            results = await retriever.retrieve(query, {
              top_k: topK,
              collection_ids: [collectionId],
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("Local embedding not yet available")) {
              process.stderr.write(
                "Error: Local embedding is not available in V1.\n" +
                  "Set the OPENAI_API_KEY environment variable to use OpenAI embeddings:\n" +
                  "  export OPENAI_API_KEY=sk-...\n", // pipeline-ok
              );
            } else {
              process.stderr.write(`Error during search: ${msg}\n`);
            }
            process.exit(1);
          }

          if (opts.json) {
            process.stdout.write(formatJson(results) + "\n");
            process.exit(0);
          }

          if (results.length === 0) {
            process.stdout.write(`No results found for query: "${query}"\n`);
            process.exit(0);
          }

          process.stdout.write(
            `Search results for: "${query}" (top ${results.length})\n` +
              `${"─".repeat(60)}\n`,
          );
          for (let i = 0; i < results.length; i++) {
            const r = results[i]!;
            const pageInfo =
              r.chunk.page_number !== undefined ? ` | page ${r.chunk.page_number}` : "";
            process.stdout.write(
              `\n[${i + 1}] score=${r.score.toFixed(4)} | ${r.chunk.source_file}${pageInfo}\n`,
            );
            if (r.chunk.section_path.length > 0) {
              process.stdout.write(`    Section: ${r.chunk.section_path.join(" > ")}\n`);
            }
            const preview = r.chunk.content.slice(0, 200).replace(/\n/g, " ");
            process.stdout.write(
              `    ${preview}${r.chunk.content.length > 200 ? "…" : ""}\n`,
            );
          }
          process.stdout.write("\n");
          process.exit(0);
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

  // ── sidjua knowledge reindex <id> ────────────────────────────────────────

  knowledge
    .command("reindex <id>")
    .description("Mark a knowledge collection for reindexing")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(
      (id: string, opts: { workDir: string }) => {
        const dbPath = join(opts.workDir, ".system", "sidjua.db");
        if (!existsSync(dbPath)) {
          process.stderr.write(
            `Error: database not found at ${dbPath}. Run 'sidjua apply' first.\n`,
          );
          process.exit(1);
        }

        const db = openKnowledgeDatabase(opts.workDir);
        try {
          const manager = new CollectionManager(db);
          const collection = manager.getById(id);
          if (collection === undefined) {
            process.stderr.write(`Error: collection '${id}' not found.\n`);
            process.exit(1);
          }

          manager.markForReindex(id);
          process.stdout.write(
            `Collection '${id}' marked for reindexing (status: needs_reindex).\n`,
          );
          process.exit(0);
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

  // ── sidjua knowledge delete <id> ─────────────────────────────────────────

  knowledge
    .command("delete <id>")
    .description("Delete a knowledge collection and all its chunks")
    .option("--force", "Skip confirmation prompt", false)
    .option("--work-dir <path>", "Working directory", process.cwd())
    .action(
      async (
        id: string,
        opts: { force: boolean; workDir: string },
      ) => {
        const dbPath = join(opts.workDir, ".system", "sidjua.db");
        if (!existsSync(dbPath)) {
          process.stderr.write(
            `Error: database not found at ${dbPath}. Run 'sidjua apply' first.\n`,
          );
          process.exit(1);
        }

        const db = openKnowledgeDatabase(opts.workDir);
        try {
          const manager = new CollectionManager(db);
          const collection = manager.getById(id);
          if (collection === undefined) {
            process.stderr.write(`Error: collection '${id}' not found.\n`);
            process.exit(1);
          }

          if (!opts.force) {
            const confirmed = await promptConfirm(
              `Are you sure you want to delete collection '${id}'? This cannot be undone.`,
            );
            if (!confirmed) {
              process.stdout.write("Aborted.\n");
              process.exit(0);
            }
          }

          manager.delete(id);
          process.stdout.write(`Knowledge collection '${id}' deleted.\n`);
          process.exit(0);
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
