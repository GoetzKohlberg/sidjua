// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: OpenAI Embedder
 * Default: text-embedding-3-large (3072 dims). Batches up to 2048 inputs per call.
 */

import OpenAI from "openai";
import type { Embedder, EmbedderOptions } from "../types.js";
import { createLogger, type Logger } from "../../core/logger.js";
import { isHttpError } from "../../core/error-codes.js";

const DEFAULT_MODEL = "text-embedding-3-large";
const MAX_BATCH_SIZE = 2048;
const BASE_BACKOFF_MS = 1000;
const MAX_RETRIES = 3;
const OPENAI_MAX_TOKENS = 8191;

/** Returns the output dimension for a known OpenAI embedding model. */
function modelDimensions(model: string): number {
  if (model === "text-embedding-3-large") return 3072;
  if (model === "text-embedding-3-small") return 1536;
  if (model === "text-embedding-ada-002")  return 1536;
  // Default assumption for unknown models
  return 1536;
}

export class OpenAIEmbedder implements Embedder {
  readonly dimensions: number;
  readonly maxTokens: number;
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(
    apiKey?: string,
    model = DEFAULT_MODEL,
    private readonly logger: Logger = createLogger("openai-embedder"),
    maxTokensOverride?: number,
  ) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.dimensions = modelDimensions(model);
    this.maxTokens = maxTokensOverride ?? OPENAI_MAX_TOKENS;
  }

  async embed(texts: string[], options?: EmbedderOptions): Promise<Float32Array[]> {
    const model = options?.model ?? this.model;
    const batchSize = Math.min(options?.batchSize ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE);
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const embeddings = await this._embedBatchWithRetry(batch, model);
      results.push(...embeddings);
    }

    return results;
  }

  private async _embedBatchWithRetry(texts: string[], model: string): Promise<Float32Array[]> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.embeddings.create({
          model,
          input: texts,
          encoding_format: "float",
        });
        return response.data
          .sort((a, b) => a.index - b.index)
          .map((d) => new Float32Array(d.embedding));
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!isHttpError(err, 429)) throw lastError;
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        this.logger.warn("embedding_rate_limit", `Embedding rate limit — retrying in ${backoff}ms`, {
          metadata: { attempt, backoff_ms: backoff },
        });
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastError ?? new Error("Embedding failed after retries");
  }
}
