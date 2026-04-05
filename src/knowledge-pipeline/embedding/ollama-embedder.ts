// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V0.9.5: Ollama Embedder
 *
 * Uses a locally running Ollama instance for air-gap / privacy deployments.
 * Default model: nomic-embed-text (768 dims). Also works with mxbai-embed-large.
 *
 * Requires Ollama running locally:
 *   curl -fsSL https://ollama.com/install.sh | sh
 *   ollama pull nomic-embed-text
 *
 * REST endpoint (Ollama ≥ 0.1.26):
 *   POST http://localhost:11434/api/embed
 *   Body: { "model": string, "input": string[] }
 *   Response: { "embeddings": number[][] }
 */

import type { Embedder, EmbedderOptions } from "../types.js";

const DEFAULT_MODEL    = "nomic-embed-text";
const DEFAULT_BASE_URL = "http://localhost:11434";
const DIMENSIONS       = 768;
const MAX_BATCH        = 100;
const OLLAMA_MAX_TOKENS = 8192;

interface OllamaEmbedResponse {
  embeddings: number[][];
}

export interface OllamaEmbedderOptions {
  /** Ollama base URL (default: http://localhost:11434). */
  baseUrl?: string;
  /** Model name (default: nomic-embed-text). */
  model?:   string;
  /** Override max tokens per text (default: 8192). */
  maxTokens?: number;
}

export class OllamaEmbedder implements Embedder {
  readonly dimensions = DIMENSIONS;
  readonly maxTokens: number;

  private readonly baseUrl: string;
  private readonly model:   string;

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.baseUrl   = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model     = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? OLLAMA_MAX_TOKENS;
    // Validate scheme — Ollama is local infrastructure so private IPs are
    // allowed, but non-http/https schemes are not.
    const scheme = new URL(this.baseUrl).protocol;
    if (scheme !== "http:" && scheme !== "https:") {
      throw new Error(
        `OllamaEmbedder: unsupported URL scheme "${scheme}" — must be http or https`,
      );
    }
  }

  async embed(texts: string[], _options?: EmbedderOptions): Promise<Float32Array[]> {
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const embeddings = await this._embedBatch(batch);
      results.push(...embeddings);
    }

    return results;
  }

  private async _embedBatch(texts: string[]): Promise<Float32Array[]> {
    const url = `${this.baseUrl}/api/embed`;

    const response = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `Ollama embedding request failed: ${response.status} ${response.statusText} — ${text}`,
      );
    }

    const json = await response.json() as OllamaEmbedResponse;

    if (!Array.isArray(json.embeddings) || json.embeddings.length === 0) {
      throw new Error("Ollama returned no embeddings");
    }

    return json.embeddings.map((vec) => new Float32Array(vec));
  }
}
