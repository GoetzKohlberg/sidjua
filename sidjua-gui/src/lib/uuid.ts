// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA GUI — Secure-Context-Safe UUID v4
 *
 * crypto.randomUUID() is only available in Secure Contexts (HTTPS or
 * localhost). SIDJUA is typically accessed over plain HTTP on a LAN IP,
 * where crypto.randomUUID is undefined and calling it throws TypeError.
 *
 * This helper uses crypto.randomUUID() when available (secure context,
 * dev workflows on localhost) and falls back to crypto.getRandomValues()
 * to construct an RFC 4122 v4 UUID manually. getRandomValues is NOT gated
 * on secure context and has been available since the beginning of the
 * Web Crypto API.
 *
 * New permanent rule: SECURE-CONTEXT-SAFE — any Web Platform API gated
 * on secure context must have a non-secure-context fallback, or its use
 * must be justified by a deliberate decision that breaks LAN-HTTP
 * deployment. crypto.randomUUID is the first entry on the banned-without-
 * fallback list.
 */

export function uuidV4(): string {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (c !== undefined && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c === undefined || typeof c.getRandomValues !== "function") {
    // Should not happen in any browser SIDJUA targets — crypto.getRandomValues
    // has been in every browser since 2014. Throw loudly rather than silently
    // fall back to Math.random which is not cryptographically acceptable.
    throw new Error("uuidV4: no crypto.getRandomValues available");
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // RFC 4122 v4: version bits = 0100 in byte 6, variant bits = 10 in byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h: string[] = [];
  for (let i = 0; i < 16; i++) h.push(bytes[i].toString(16).padStart(2, "0"));
  return (
    h.slice(0, 4).join("") +
    "-" +
    h.slice(4, 6).join("") +
    "-" +
    h.slice(6, 8).join("") +
    "-" +
    h.slice(8, 10).join("") +
    "-" +
    h.slice(10, 16).join("")
  );
}
