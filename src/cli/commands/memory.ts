// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V0.9.3: `sidjua memory` Commands
 *
 * Subcommands:
 *   sidjua memory import <file>   — Import Claude chat export into default-memory collection
 *   sidjua memory status          — Show default-memory collection stats
 *   sidjua memory search <query>  — Shorthand for sidjua knowledge search default-memory <query>
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { MemoryWal, getWalPath } from "../../knowledge-pipeline/wal/memory-wal.js";
import type { Command } from "commander";
import { openKnowledgeDatabase } from "../utils/db-init.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger("memory-cmd");
import { CollectionManager } from "../../knowledge-pipeline/collection-manager.js";
import { EmbeddingPipeline } from "../../knowledge-pipeline/embedding/embedding-pipeline.js";
import { OpenAIEmbedder } from "../../knowledge-pipeline/embedding/openai-embedder.js";
import { CloudflareEmbedder, type CloudflareEmbedderOptions } from "../../knowledge-pipeline/embedding/cloudflare-embedder.js";
import { LocalEmbedder } from "../../knowledge-pipeline/embedding/local-embedder.js";
import { HybridRetriever } from "../../knowledge-pipeline/retrieval/hybrid-retriever.js";
import { ClaudeExportParser } from "../../knowledge-pipeline/parsers/claude-export-parser.js";
import { SemanticChunker } from "../../knowledge-pipeline/chunkers/semantic-chunker.js";
import { msg } from "../../i18n/index.js";
import type { Embedder } from "../../knowledge-pipeline/types.js";
import { countTokens } from "../../knowledge-pipeline/types.js";
import { chunkLimit, splitText } from "../../knowledge-pipeline/embedding/chunk-splitter.js";
import { formatBytes } from "../utils/format.js";
import { createVectorStore } from "../../knowledge-pipeline/vector-store/index.js";


const MEMORY_COLLECTION_ID = "default-memory";
const MEMORY_COLLECTION_NAME = "Default Memory";
const MEMORY_CLASSIFICATION = "CONFIDENTIAL";
const MEMORY_CHUNK_SIZE = 800;


interface EmbedderInfo {
  embedder: Embedder;
  providerLabel: string;
  model: string;
  dimensions: number;
}

function getEmbedder(): EmbedderInfo {
  // Optional user override — applies to whichever provider is selected
  const maxTokensEnv = process.env["SIDJUA_EMBED_MAX_TOKENS"];
  const maxTokensOverride = maxTokensEnv !== undefined && maxTokensEnv.length > 0
    ? parseInt(maxTokensEnv, 10) || undefined
    : undefined;

  const openaiKey = process.env["OPENAI_API_KEY"];
  if (openaiKey !== undefined && openaiKey.length > 0) {
    const model = "text-embedding-3-large";
    const embedder = new OpenAIEmbedder(openaiKey, model, undefined, maxTokensOverride);
    return { embedder, providerLabel: "openai", model, dimensions: embedder.dimensions };
  }

  const cfAccountId = process.env["SIDJUA_CF_ACCOUNT_ID"] ?? "";
  const cfToken     = process.env["SIDJUA_CF_TOKEN"]       ?? "";
  if (cfAccountId.length > 0 && cfToken.length > 0) {
    const model = "@cf/baai/bge-base-en-v1.5";
    const cfOpts: CloudflareEmbedderOptions = { accountId: cfAccountId, apiToken: cfToken };
    if (maxTokensOverride !== undefined) cfOpts.maxTokens = maxTokensOverride;
    const embedder = new CloudflareEmbedder(cfOpts);
    return { embedder, providerLabel: "cloudflare", model, dimensions: embedder.dimensions };
  }

  // No embedder — HybridRetriever falls back to BM25-only
  const embedder = new LocalEmbedder(maxTokensOverride);
  return { embedder, providerLabel: "none", model: "bm25", dimensions: 0 };
}

function ensureMemoryCollection(manager: CollectionManager): void {
  const existing = manager.getById(MEMORY_COLLECTION_ID);

  // Migrate legacy "default-memory" collection to "default-memory" on first access
  const legacy = manager.getById("default-memory");
  if (legacy !== undefined && existing === undefined) {
    // Rename by updating the id — not supported by CollectionManager, so just log a warning
    process.stderr.write(
      'Warning: Legacy "default-memory" collection found. To migrate, run:\n' +
      '  sidjua knowledge collections -- then manually re-import or rename.\n'
    );
  }

  if (existing !== undefined) return;

  manager.create({
    id: MEMORY_COLLECTION_ID,
    name: MEMORY_COLLECTION_NAME,
    description: "Default memory collection for Claude chat exports",
    scope: { classification: MEMORY_CLASSIFICATION },
    ingestion: {
      chunking_strategy: "semantic",
      chunk_size_tokens: MEMORY_CHUNK_SIZE,
      chunk_overlap_tokens: 80,
      embedding_model: "text-embedding-3-small",
      embedding_provider: "openai",
    },
    retrieval: {
      default_top_k: 10,
      similarity_threshold: 0.65,
      reranking: true,
      mmr_diversity: 0.3,
    },
  });
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function estimateCost(tokens: number): string {
  const usd = (tokens / 1_000_000) * 0.13;
  return `~$${usd.toFixed(4)}`;
}


export function registerMemoryCommands(program: Command): void {
  const memCmd = program
    .command("memory")
    .description("Personal memory management (Claude chat export import)");

  // ── sidjua memory import <file> ──────────────────────────────────────────

  memCmd
    .command("import <file>")
    .description("Import a Claude chat export ZIP or JSON into the default-memory collection")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (file: string, opts: { workDir: string }) => {
      const filePath = resolve(file);

      if (!existsSync(filePath)) {
        process.stderr.write(msg("errors.file_not_found", { path: filePath }) + "\n");
        process.exit(1);
      }

      const db = openKnowledgeDatabase(opts.workDir);
      const manager = new CollectionManager(db);

      // Compact WAL at start (remove fully-committed entries from prior runs)
      const wal = new MemoryWal(getWalPath(opts.workDir));
      await wal.compact();

      // Auto-create collection if needed
      ensureMemoryCollection(manager);
      process.stdout.write(`Memory collection: ${MEMORY_COLLECTION_ID}\n`);

      process.stdout.write(`Parsing export: ${basename(filePath)}...\n`);

      const MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50 MB
      const fileStats = statSync(filePath);
      if (fileStats.size > MAX_IMPORT_SIZE) {
        process.stderr.write(`Error: File too large: ${formatBytes(fileStats.size)} exceeds ${formatBytes(MAX_IMPORT_SIZE)} limit\n`);
        process.exit(1);
        return;
      }
      const content = readFileSync(filePath);
      const parser = new ClaudeExportParser();
      const doc = await parser.parse(content, basename(filePath));
      const conversationCount = doc.sections.length;

      process.stdout.write(msg("memory.import.conversations_found", { count: conversationCount }) + "\n");
      process.stdout.write(msg("memory.import.ingesting") + "\n");

      const { embedder, providerLabel, model, dimensions } = getEmbedder();
      process.stdout.write(
        msg("memory.import.embedding_provider", { provider: providerLabel, model, dimensions }) + "\n",
      );

      // Warn about dimension mismatch with existing embeddings
      const existingDimRow = db
        .prepare<[], { dim: number }>(
          "SELECT CAST(length(embedding) / 4 AS INTEGER) AS dim FROM knowledge_vectors LIMIT 1",
        )
        .get();
      if (existingDimRow !== undefined && dimensions > 0 && existingDimRow.dim !== dimensions) {
        process.stderr.write(
          msg("memory.import.dimension_mismatch", {
            name: MEMORY_COLLECTION_ID,
            existing: existingDimRow.dim,
            required: dimensions,
          }) + "\n",
        );
        process.exit(1);
      }

      const chunker = new SemanticChunker();
      const pipeline = new EmbeddingPipeline(db, parser, chunker, embedder, undefined, createVectorStore(db));

      const result = await pipeline.ingest(content, {
        collection_id: MEMORY_COLLECTION_ID,
        source_file: basename(filePath),
        chunk_size_tokens: MEMORY_CHUNK_SIZE,
        chunk_overlap_tokens: 80,
        wal,
        onProgress: (p) => {
          process.stdout.write(
            msg("memory.import.progress", { completed: p.completed, total: p.total, failed: p.failed }),
          );
        },
      });

      process.stdout.write(msg("memory.import.complete") + "\n");
      process.stdout.write(
        msg("memory.import.complete_conversations", { count: formatNumber(conversationCount) }) + "\n",
      );
      process.stdout.write(
        msg("memory.import.complete_chunks", { count: formatNumber(result.chunks_written) }) + "\n",
      );
      process.stdout.write(
        msg("memory.import.complete_tokens", { tokens: formatTokens(result.tokens_total) }) + "\n",
      );
      process.stdout.write(
        msg("memory.import.complete_cost", { cost: estimateCost(result.tokens_total) }) + "\n",
      );

      // Compact WAL: removes committed entries (pending entries = failed chunks)
      await wal.compact();

      if (result.chunks_failed > 0) {
        process.stderr.write(
          `\n\x1b[1;31mERROR: ${result.chunks_failed} chunk(s) failed to embed and have no vectors.\x1b[0m\n` +
          `Run: sidjua memory recover  (or: sidjua memory re-embed)\n`,
        );
        process.exit(1);
      }
    });

  // ── sidjua memory status ─────────────────────────────────────────────────

  memCmd
    .command("status")
    .description("Show status of the default-memory collection")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action((opts: { workDir: string }) => {
      const db = openKnowledgeDatabase(opts.workDir);
      const manager = new CollectionManager(db);

      const coll = manager.getById(MEMORY_COLLECTION_ID);
      if (coll === undefined) {
        process.stdout.write(msg("memory.status.not_found", { name: MEMORY_COLLECTION_ID }));
        return;
      }

      // Count distinct source files
      const sourcesRow = db
        .prepare<[string], { count: number }>(
          "SELECT COUNT(DISTINCT source_file) AS count FROM knowledge_chunks WHERE collection_id = ?",
        )
        .get(MEMORY_COLLECTION_ID);
      const sourcesCount = sourcesRow?.count ?? 0;

      // Integrity: actual chunk and vector counts
      const actualChunks = db
        .prepare<[string], { cnt: number }>(
          "SELECT COUNT(*) AS cnt FROM knowledge_chunks WHERE collection_id = ?",
        )
        .get(MEMORY_COLLECTION_ID)?.cnt ?? 0;
      const actualVectors = db
        .prepare<[string], { cnt: number }>(
          "SELECT COUNT(*) AS cnt FROM knowledge_vectors WHERE collection_id = ?",
        )
        .get(MEMORY_COLLECTION_ID)?.cnt ?? 0;
      const missingEmbeddings = actualChunks - actualVectors;

      // Detect stored embedding dimension
      const dimRow = db
        .prepare<[string], { dim: number }>(
          "SELECT CAST(length(embedding) / 4 AS INTEGER) AS dim FROM knowledge_vectors WHERE collection_id = ? LIMIT 1",
        )
        .get(MEMORY_COLLECTION_ID);
      const storedDim = dimRow?.dim ?? 0;
      const { providerLabel, model } = getEmbedder();
      const providerDisplay = providerLabel === "none" ? "BM25 only (no key configured)" : providerLabel;

      const lastImport = new Date(coll.updated_at).toLocaleString("en-PH", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });

      process.stdout.write(msg("memory.status.header", { id: MEMORY_COLLECTION_ID }) + "\n");
      process.stdout.write(msg("memory.status.status_line", { status: coll.status }) + "\n");
      process.stdout.write(msg("memory.status.chunks_line", { count: formatNumber(coll.chunk_count) }) + "\n");
      process.stdout.write(msg("memory.status.tokens_line", { tokens: formatTokens(coll.total_tokens) }) + "\n");
      process.stdout.write(
        msg("memory.status.sources_line", {
          count: sourcesCount,
          label: `file${sourcesCount !== 1 ? "s" : ""}`,
        }) + "\n",
      );
      process.stdout.write(msg("memory.status.last_import_line", { date: lastImport }) + "\n");
      process.stdout.write(
        msg("memory.status.embedder_line", {
          provider: providerDisplay,
          model,
          dimensions: storedDim > 0 ? storedDim : "unknown",
        }) + "\n",
      );

      // Integrity line
      if (missingEmbeddings > 0) {
        process.stdout.write(
          `\x1b[1;31mINTEGRITY: ${formatNumber(actualChunks)} chunks, ${formatNumber(actualVectors)} vectors` +
          ` — ${missingEmbeddings} chunks missing embeddings!\x1b[0m\n` +
          `Run: sidjua memory re-embed\n`,
        );
      } else if (actualChunks > 0) {
        process.stdout.write(
          `\x1b[32mINTEGRITY: ${formatNumber(actualChunks)} chunks = ${formatNumber(actualVectors)} vectors ✓\x1b[0m\n`,
        );
      }
    });

  // ── sidjua memory search <query> ─────────────────────────────────────────

  memCmd
    .command("search <query>")
    .description("Search the default-memory collection")
    .option("--top-k <n>", "Number of results", "10")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (query: string, opts: { topK: string; workDir: string }) => {
      const topK = parseInt(opts.topK, 10);
      const db = openKnowledgeDatabase(opts.workDir);

      const coll = new CollectionManager(db).getById(MEMORY_COLLECTION_ID);
      if (coll === undefined) {
        process.stderr.write(
          msg("memory.embedder.collection_not_found", { name: MEMORY_COLLECTION_ID }) + "\n",
        );
        process.exit(1);
      }

      const { embedder } = getEmbedder();
      const retriever = new HybridRetriever(db, embedder, undefined, createVectorStore(db));

      const results = await retriever.retrieve(query, {
        collection_ids: [MEMORY_COLLECTION_ID],
        top_k: topK,
        similarity_threshold: coll.config.retrieval.similarity_threshold,
      });

      if (results.length === 0) {
        process.stdout.write(msg("memory.search.no_results", { query }) + "\n");
        return;
      }

      process.stdout.write(
        "\n" + msg("memory.search.results_header", { query, count: results.length }) + "\n\n",
      );

      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const reference = r.chunk.page_number !== undefined ? `, p${r.chunk.page_number}` : "";
        process.stdout.write(
          msg("memory.search.result_entry", {
            rank: i + 1,
            score: r.score.toFixed(4),
            source: r.chunk.source_file,
            reference,
          }) + "\n" +
          `${r.chunk.content.slice(0, 400).trim()}\n` +
          (r.chunk.content.length > 400 ? "...\n" : "") +
          "\n",
        );
      }
    });

  // ── sidjua memory clear [collection] ─────────────────────────────────────

  memCmd
    .command("clear [collection]")
    .description("Delete all chunks and vectors for a collection (default: default-memory)")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (collection: string | undefined, opts: { workDir: string }) => {
      const collId = collection ?? MEMORY_COLLECTION_ID;
      const db = openKnowledgeDatabase(opts.workDir);
      const manager = new CollectionManager(db);

      const coll = manager.getById(collId);
      if (coll === undefined) {
        process.stderr.write(msg("memory_clear.not_found", { name: collId }) + "\n");
        process.exit(1);
      }

      process.stdout.write(msg("memory_clear.confirm", { name: collId }) + "\n");

      const vecCount = db.prepare<[string], { cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM knowledge_vectors WHERE collection_id = ?",
      ).get(collId)?.cnt ?? 0;

      const chunkCount = db.prepare<[string], { cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM knowledge_chunks WHERE collection_id = ?",
      ).get(collId)?.cnt ?? 0;

      db.transaction(() => {
        db.prepare<[string], void>("DELETE FROM knowledge_vectors WHERE collection_id = ?").run(collId);
        db.prepare<[string], void>("DELETE FROM knowledge_chunks WHERE collection_id = ?").run(collId);
        db.prepare<[string, string], void>(
          "UPDATE knowledge_collections SET chunk_count = 0, total_tokens = 0, status = 'empty', updated_at = ? WHERE id = ?",
        ).run(new Date().toISOString(), collId);
      })();

      // Rebuild FTS index
      try {
        db.exec(`INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('rebuild')`);
      } catch (e: unknown) {
        logger.warn("memory-cmd", "FTS index rebuild failed — search may return stale results", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      }

      // Delete WAL (collection data is gone, WAL is no longer relevant)
      new MemoryWal(getWalPath(opts.workDir)).delete();

      process.stdout.write(
        msg("memory_clear.complete", { name: collId, chunks: chunkCount, vectors: vecCount }) + "\n",
      );
    });

  // ── sidjua memory re-embed [collection] ──────────────────────────────────

  memCmd
    .command("re-embed [collection]")
    .description("Re-embed all chunks from DB with the current embedder (no original files needed)")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (collection: string | undefined, opts: { workDir: string }) => {
      const collId = collection ?? MEMORY_COLLECTION_ID;
      const db = openKnowledgeDatabase(opts.workDir);
      const manager = new CollectionManager(db);

      const coll = manager.getById(collId);
      if (coll === undefined) {
        process.stderr.write(msg("memory_clear.not_found", { name: collId }) + "\n");
        process.exit(1);
      }

      const { embedder, providerLabel, model, dimensions } = getEmbedder();
      if (dimensions === 0) {
        process.stderr.write(msg("memory_re_embed.no_embedder") + "\n");
        process.exit(1);
      }

      process.stdout.write(
        msg("memory_re_embed.start", { name: collId, provider: providerLabel, model }) + "\n",
      );

      // Read all chunks from DB
      const allChunks = db.prepare<[string], {
        id: string; content: string; source_file: string; token_count: number;
        position: number; section_path: string; page_number: number | null;
        preceding_context: string; metadata: string; created_at: string;
      }>(
        "SELECT id, content, source_file, token_count, position, section_path, " +
        "page_number, preceding_context, metadata, created_at FROM knowledge_chunks WHERE collection_id = ?",
      ).all(collId);

      if (allChunks.length === 0) {
        process.stdout.write(`No chunks found in collection "${collId}".\n`);
        return;
      }

      // Expand chunks that exceed the new embedder's limit
      const limit = chunkLimit(embedder.maxTokens);
      const expandedRows: Array<{ id: string; content: string; source_file: string;
        token_count: number; position: number; section_path: string;
        page_number: number | null; preceding_context: string; metadata: string;
        created_at: string; }> = [];
      let splitCount = 0;
      let newParts = 0;

      for (const row of allChunks) {
        const tokens = countTokens(row.content);
        if (tokens <= limit) {
          expandedRows.push(row);
        } else {
          const parts = splitText(row.content, limit);
          process.stdout.write(
            msg("memory_re_embed.split", { id: row.id, tokens, max: limit, parts: parts.length }) + "\n",
          );
          splitCount++;
          newParts += parts.length;
          parts.forEach((part, idx) => {
            const meta = JSON.parse(row.metadata) as Record<string, unknown>;
            expandedRows.push({
              ...row,
              id: randomUUID(),
              content: part,
              token_count: countTokens(part),
              section_path: JSON.stringify(
                [...(JSON.parse(row.section_path) as string[]), `part${idx + 1}`]
              ),
              metadata: JSON.stringify({ ...meta, split_from: row.id, split_part: idx + 1, split_total: parts.length }),
            });
          });
        }
      }

      // Delete existing vectors (keep chunks)
      db.prepare<[string], void>("DELETE FROM knowledge_vectors WHERE collection_id = ?").run(collId);

      // Insert any newly split chunks
      const insertChunk = db.prepare<
        [string, string, string, string, number, number, string, number | null, string, string, string],
        void
      >(`INSERT OR REPLACE INTO knowledge_chunks
          (id, collection_id, source_file, content, token_count, position,
           section_path, page_number, preceding_context, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertVector = db.prepare<[string, string, Buffer], void>(
        "INSERT OR REPLACE INTO knowledge_vectors (chunk_id, collection_id, embedding) VALUES (?, ?, ?)",
      );

      // Build token-budget batches: sum(countTokens) ≤ embedder.maxTokens per call
      const tokenBatches: typeof expandedRows[] = [];
      let tbCurrent: typeof expandedRows = [];
      let tbTokens = 0;
      for (const row of expandedRows) {
        const t = countTokens(row.content);
        if (tbCurrent.length > 0 && tbTokens + t > embedder.maxTokens) {
          tokenBatches.push(tbCurrent);
          tbCurrent = [row];
          tbTokens = t;
        } else {
          tbCurrent.push(row);
          tbTokens += t;
        }
      }
      if (tbCurrent.length > 0) tokenBatches.push(tbCurrent);

      let completed = 0;

      for (const batch of tokenBatches) {
        const texts = batch.map((r) => r.content);

        let embeddings: Float32Array[];
        try {
          embeddings = await embedder.embed(texts);
        } catch (err) {
          process.stderr.write(
            `\nEmbedding batch failed at position ${completed}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          completed += batch.length;
          continue;
        }

        const reEmbedWal = new MemoryWal(getWalPath(opts.workDir));
        const walIds: string[] = [];
        for (const row of batch) {
          walIds.push(await reEmbedWal.appendPending("chunk_write", collId, row.id));
        }

        db.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            const row = batch[j]!;
            const embedding = embeddings[j]!;
            insertChunk.run(
              row.id, collId, row.source_file, row.content, row.token_count,
              row.position, row.section_path, row.page_number,
              row.preceding_context, row.metadata, row.created_at,
            );
            insertVector.run(row.id, collId, Buffer.from(embedding.buffer));
          }
        })();

        for (let j = 0; j < batch.length; j++) {
          await reEmbedWal.markCommitted(walIds[j]!, "chunk_write", collId, batch[j]!.id);
        }

        completed += batch.length;
        process.stdout.write(
          msg("memory_re_embed.progress", { current: completed, total: expandedRows.length }),
        );
      }

      // Rebuild FTS
      try {
        db.exec(`INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('rebuild')`);
      } catch (e: unknown) {
        logger.warn("memory-cmd", "FTS index rebuild failed — search may return stale results", { metadata: { error: e instanceof Error ? e.message : String(e) } });
      }

      // Compact WAL after successful re-embed
      new MemoryWal(getWalPath(opts.workDir)).compact();

      // Update collection metadata
      db.prepare<[number, string, string], void>(
        "UPDATE knowledge_collections SET chunk_count = ?, status = 'indexed', updated_at = ? WHERE id = ?",
      ).run(expandedRows.length, new Date().toISOString(), collId);

      process.stdout.write("\n");
      process.stdout.write(
        msg("memory_re_embed.complete", {
          total: expandedRows.length,
          split_count: splitCount,
          new_parts: newParts,
          provider: providerLabel,
          dimensions,
        }) + "\n",
      );
    });

  // ── sidjua memory verify [collection] ────────────────────────────────────

  memCmd
    .command("verify [collection]")
    .description("Health-check: verify every chunk has a vector, dimensions are consistent, no duplicates")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (collection: string | undefined, opts: { workDir: string }) => {
      const collId = collection ?? MEMORY_COLLECTION_ID;
      const db = openKnowledgeDatabase(opts.workDir);

      const coll = new CollectionManager(db).getById(collId);
      if (coll === undefined) {
        process.stderr.write(`Collection "${collId}" not found.\n`);
        process.exit(1);
      }

      let exitCode = 0;
      const ok  = (s: string) => process.stdout.write(`\x1b[32m  ✓ ${s}\x1b[0m\n`);
      const err = (s: string) => { process.stderr.write(`\x1b[1;31m  ✗ ${s}\x1b[0m\n`); exitCode = 1; };
      const hdr = (s: string) => process.stdout.write(`\n${s}\n`);

      hdr(`Memory verify: ${collId}`);

      // 1. Chunk vs vector counts
      const chunkCount = db
        .prepare<[string], { cnt: number }>("SELECT COUNT(*) AS cnt FROM knowledge_chunks WHERE collection_id = ?")
        .get(collId)?.cnt ?? 0;
      const vectorCount = db
        .prepare<[string], { cnt: number }>("SELECT COUNT(*) AS cnt FROM knowledge_vectors WHERE collection_id = ?")
        .get(collId)?.cnt ?? 0;

      if (chunkCount === vectorCount) {
        ok(`Chunks = Vectors: ${formatNumber(chunkCount)}`);
      } else {
        err(`Chunks (${formatNumber(chunkCount)}) ≠ Vectors (${formatNumber(vectorCount)}) — ${chunkCount - vectorCount} missing embeddings`);
      }

      // 2. Chunks without a vector (orphaned chunks)
      const orphans = db
        .prepare<[string], { cnt: number }>(`
          SELECT COUNT(*) AS cnt FROM knowledge_chunks c
          WHERE c.collection_id = ?
            AND NOT EXISTS (SELECT 1 FROM knowledge_vectors v WHERE v.chunk_id = c.id)
        `)
        .get(collId)?.cnt ?? 0;

      if (orphans === 0) {
        ok("No orphaned chunks (every chunk has a vector)");
      } else {
        err(`${orphans} chunk(s) have no vector — run: sidjua memory re-embed`);
      }

      // 3. Vectors without a chunk (orphaned vectors)
      const orphanVecs = db
        .prepare<[string], { cnt: number }>(`
          SELECT COUNT(*) AS cnt FROM knowledge_vectors v
          WHERE v.collection_id = ?
            AND NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.id = v.chunk_id)
        `)
        .get(collId)?.cnt ?? 0;

      if (orphanVecs === 0) {
        ok("No orphaned vectors");
      } else {
        err(`${orphanVecs} vector(s) have no matching chunk`);
      }

      // 4. Dimension consistency
      const dims = db
        .prepare<[string], { dim: number; cnt: number }>(`
          SELECT CAST(length(embedding) / 4 AS INTEGER) AS dim, COUNT(*) AS cnt
          FROM knowledge_vectors WHERE collection_id = ?
          GROUP BY dim
        `)
        .all(collId);

      if (dims.length === 0) {
        ok("No vectors stored (empty collection)");
      } else if (dims.length === 1) {
        ok(`Dimensions consistent: all vectors are ${dims[0]!.dim}d`);
      } else {
        err(`Mixed dimensions: ${dims.map((d) => `${d.dim}d×${d.cnt}`).join(", ")} — collection needs re-embed`);
      }

      // 5a. WAL pending entries
      const wal = new MemoryWal(getWalPath(opts.workDir));
      await wal.compact();
      const pendingWal = await wal.readPending();
      if (pendingWal.length === 0) {
        ok(msg("memory.verify.wal_clean"));
      } else {
        const suffix = pendingWal.length === 1 ? "y" : "ies";
        err(msg("memory.verify.pending_wal", { count: pendingWal.length, suffix }));
      }

      // 5. Duplicate chunk IDs
      const dupChunks = db
        .prepare<[string], { cnt: number }>(`
          SELECT COUNT(*) AS cnt FROM (
            SELECT id FROM knowledge_chunks WHERE collection_id = ? GROUP BY id HAVING COUNT(*) > 1
          )
        `)
        .get(collId)?.cnt ?? 0;

      if (dupChunks === 0) {
        ok("No duplicate chunk IDs");
      } else {
        err(`${dupChunks} duplicate chunk ID(s) detected`);
      }

      // Summary
      process.stdout.write("\n");
      if (exitCode === 0) {
        process.stdout.write(`\x1b[1;32mAll checks passed.\x1b[0m\n`);
      } else {
        process.stderr.write(`\x1b[1;31mVerification FAILED. Run: sidjua memory re-embed\x1b[0m\n`);
      }
      process.exit(exitCode);
    });

  // ── sidjua memory recover [collection] ───────────────────────────────────

  memCmd
    .command("recover [collection]")
    .description("Re-embed chunks that have pending WAL entries but no vector (crash recovery)")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (collection: string | undefined, opts: { workDir: string }) => {
      const collId = collection ?? MEMORY_COLLECTION_ID;
      const walPath = getWalPath(opts.workDir);
      const wal = new MemoryWal(walPath);

      if (!existsSync(walPath)) {
        process.stdout.write(msg("memory.recover.wal_not_found") + "\n");
        return;
      }

      await wal.compact();
      const pending = await wal.readPending();

      if (pending.length === 0) {
        process.stdout.write(msg("memory.recover.no_pending") + "\n");
        return;
      }

      const suffix = pending.length === 1 ? "y" : "ies";
      process.stdout.write(msg("memory.recover.found_pending", { count: pending.length, suffix }) + "\n");

      const db = openKnowledgeDatabase(opts.workDir);
      const { embedder, dimensions } = getEmbedder();
      if (dimensions === 0) {
        process.stderr.write(msg("memory_re_embed.no_embedder") + "\n");
        process.exit(1);
      }

      let okCount = 0;
      let skipped = 0;
      let stale = 0;
      let failed = 0;

      const insertVector = db.prepare<[string, string, Buffer], void>(
        "INSERT OR REPLACE INTO knowledge_vectors (chunk_id, collection_id, embedding) VALUES (?, ?, ?)",
      );

      for (const entry of pending) {
        const chunk_id = entry.chunk_id;
        const coll = entry.collection || collId;

        // Check if chunk exists in DB
        const chunkRow = db.prepare<[string], { content: string }>(
          "SELECT content FROM knowledge_chunks WHERE id = ?",
        ).get(chunk_id);

        if (chunkRow === undefined) {
          // Stale entry — chunk was deleted or never committed
          process.stdout.write(msg("memory.recover.chunk_stale", { chunk_id }) + "\n");
          await wal.markCommitted(entry.id, entry.op, coll, chunk_id);
          stale++;
          continue;
        }

        // Check if vector already exists
        const hasVector = db.prepare<[string], { cnt: number }>(
          "SELECT COUNT(*) AS cnt FROM knowledge_vectors WHERE chunk_id = ?",
        ).get(chunk_id)?.cnt ?? 0;

        if (hasVector > 0) {
          process.stdout.write(msg("memory.recover.chunk_ok", { chunk_id }) + "\n");
          await wal.markCommitted(entry.id, entry.op, coll, chunk_id);
          skipped++;
          continue;
        }

        // Re-embed this chunk
        process.stdout.write(msg("memory.recover.chunk_missing", { chunk_id }) + "\n");
        try {
          const [embedding] = await embedder.embed([chunkRow.content]);
          insertVector.run(chunk_id, coll, Buffer.from(embedding!.buffer));
          await wal.markCommitted(entry.id, entry.op, coll, chunk_id);
          okCount++;
        } catch (err) {
          process.stderr.write(
            msg("memory.recover.chunk_failed", {
              chunk_id,
              error: err instanceof Error ? err.message : String(err),
            }) + "\n",
          );
          failed++;
        }
      }

      await wal.compact();

      process.stdout.write(
        msg("memory.recover.recovered", {
          ok: okCount,
          skipped,
          stale,
          failed,
        }) + "\n",
      );

      if (failed > 0) process.exit(1);
    });
}
