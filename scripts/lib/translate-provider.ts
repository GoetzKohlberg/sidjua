// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * Isolated OpenAI-compatible provider client for translate-locales.ts.
 *
 * Supports multiple providers via a config map; zero provider-specific
 * branching in the call path — only baseURL, model, and keyEnvVar differ.
 * Mock this module in unit tests by replacing callProvider.
 */

export interface ProviderConfig {
  baseURL:   string;
  model:     string;
  keyEnvVar: string;
}

export interface ProviderCallConfig extends ProviderConfig {
  /** Model override applied at call time (may differ from ProviderConfig.model). */
  model: string;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  xai: {
    baseURL:   "https://api.x.ai/v1",
    model:     "grok-4-1-fast",
    keyEnvVar: "XAI_API_KEY",
  },
  deepseek: {
    baseURL:   "https://api.deepseek.com/v1",
    model:     "deepseek-chat",
    keyEnvVar: "DEEPSEEK_API_KEY",
  },
};

/**
 * Hardcoded provider pricing table (USD per 1M tokens).
 * Update manually when prices change.
 */
export const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  xai:      { inputPerM: 0.30,  outputPerM: 0.50 },
  deepseek: { inputPerM: 0.14,  outputPerM: 0.28 },
  groq:     { inputPerM: 0.05,  outputPerM: 0.10 },
  openai:   { inputPerM: 0.50,  outputPerM: 1.50 },
  xiaomi:   { inputPerM: 0.10,  outputPerM: 0.10 },
};

export interface ChatMessage {
  role:    "system" | "user" | "assistant";
  content: string;
}

export interface TranslationCallResult {
  content:      string;
  inputTokens:  number;
  outputTokens: number;
}

/**
 * Make one OpenAI-compat chat/completions call and return the raw response.
 * Throws on non-2xx HTTP status or fetch failure.
 */
export async function callProvider(
  config:   ProviderCallConfig,
  apiKey:   string,
  messages: ChatMessage[],
): Promise<TranslationCallResult> {
  const url  = `${config.baseURL}/chat/completions`;
  const body = JSON.stringify({
    model:       config.model,
    messages,
    temperature: 0.1,
  });

  const resp = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`Provider HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json() as {
    choices?: { message?: { content?: string } }[];
    usage?:   { prompt_tokens?: number; completion_tokens?: number };
  };

  const content      = data.choices?.[0]?.message?.content ?? "";
  const inputTokens  = data.usage?.prompt_tokens     ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  return { content, inputTokens, outputTokens };
}
