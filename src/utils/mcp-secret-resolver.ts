// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * H10 — MCP Secret Resolver
 *
 * Centralises how MCP tool configurations resolve ${secrets:KEY} placeholders.
 *
 * In production (envFallback=false) only secrets stored in the secrets provider
 * are returned.  In development (envFallback=true) process.env is checked as a
 * fallback so that local testing without a running secrets store remains easy.
 *
 * The cache is a ReadonlyMap<string, string> pre-loaded from SqliteSecretsProvider
 * (or an empty map during early startup before the provider is available).
 */

export type SecretResolver = (key: string) => string | undefined;

/**
 * Build a secret resolver function.
 *
 * @param cache       Pre-loaded secrets map (namespace:key → value).
 * @param envFallback Allow falling back to process.env.  Should be false in
 *                    production to avoid leaking host environment variables.
 */
export function buildMcpSecretResolver(
  cache: ReadonlyMap<string, string>,
  envFallback: boolean,
): SecretResolver {
  return (key: string): string | undefined => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (envFallback) return process.env[key];
    return undefined;
  };
}
