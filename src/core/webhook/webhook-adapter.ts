// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — P378: Webhook Payload Adapter
 *
 * Normalizes incoming webhook payloads from various sources into a canonical
 * task description. Only scalar values (string, number, boolean) are forwarded
 * to prevent object injection attacks.
 */


export type WebhookSource = "github" | "grafana" | "generic";

export interface NormalizedWebhookPayload {
  /** Human-readable task title derived from the payload. */
  title:       string;
  /** Full task description combining relevant payload fields. */
  description: string;
  /** Detected or declared source type. */
  source:      WebhookSource;
  /** Extracted safe scalar fields (no nested objects or arrays). */
  fields:      Record<string, string>;
}


/** Keys that must never appear in the extracted output — prototype pollution vector. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Extract only scalar (string/number/boolean) top-level values from an object.
 * Nested objects and arrays are dropped to prevent injection via structured data.
 * Prototype-pollution keys (__proto__, constructor, prototype) are silently skipped.
 */
export function extractSafeFields(obj: Record<string, unknown>): Record<string, string> {
  // Object.create(null) produces a prototype-less object so even if a dangerous
  // key slips through the DANGEROUS_KEYS check it cannot shadow Object.prototype.
  const out = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Detect the webhook source from the payload structure.
 * Falls back to "generic" when no known signature is present.
 */
function detectSource(payload: Record<string, unknown>): WebhookSource {
  // GitHub: has "action" + "repository" keys
  if ("action" in payload && "repository" in payload) return "github";
  // Grafana: has "ruleName" or "alerts" keys
  if ("ruleName" in payload || "alerts" in payload) return "grafana";
  return "generic";
}

/**
 * Normalize a GitHub webhook payload.
 * Extracts repo name, event action, and sender for the task description.
 */
function normalizeGithub(payload: Record<string, unknown>): NormalizedWebhookPayload {
  const action = typeof payload["action"] === "string" ? payload["action"] : "event";
  const repo   = (() => {
    const r = payload["repository"];
    if (typeof r === "object" && r !== null && "full_name" in r) {
      return typeof (r as Record<string, unknown>)["full_name"] === "string"
        ? (r as Record<string, unknown>)["full_name"] as string
        : "unknown-repo";
    }
    return "unknown-repo";
  })();
  const sender = (() => {
    const s = payload["sender"];
    if (typeof s === "object" && s !== null && "login" in s) {
      return typeof (s as Record<string, unknown>)["login"] === "string"
        ? (s as Record<string, unknown>)["login"] as string
        : "unknown";
    }
    return "unknown";
  })();

  const title       = `GitHub ${action} on ${repo}`;
  const description = `GitHub webhook received.\nAction: ${action}\nRepository: ${repo}\nSender: ${sender}`;

  return {
    title,
    description,
    source: "github",
    fields: extractSafeFields(payload),
  };
}

/**
 * Normalize a Grafana webhook payload.
 * Supports both legacy (ruleName) and unified alerting (alerts[0]) formats.
 */
function normalizeGrafana(payload: Record<string, unknown>): NormalizedWebhookPayload {
  const ruleName = typeof payload["ruleName"] === "string"
    ? payload["ruleName"]
    : (() => {
        const alerts = payload["alerts"];
        if (Array.isArray(alerts) && alerts.length > 0) {
          const first = alerts[0] as Record<string, unknown>;
          return typeof first["labels"] === "object" && first["labels"] !== null &&
            "alertname" in (first["labels"] as Record<string, unknown>)
            ? String((first["labels"] as Record<string, unknown>)["alertname"])
            : "alert";
        }
        return "alert";
      })();
  const state = typeof payload["state"] === "string" ? payload["state"] : "unknown";

  const title       = `Grafana alert: ${ruleName}`;
  const description = `Grafana alert fired.\nRule: ${ruleName}\nState: ${state}`;

  return {
    title,
    description,
    source: "grafana",
    fields: extractSafeFields(payload),
  };
}

/**
 * Normalize a generic webhook payload.
 * Uses "title"/"event"/"type" fields if present; falls back to a generic label.
 */
function normalizeGeneric(payload: Record<string, unknown>): NormalizedWebhookPayload {
  const title = (() => {
    for (const key of ["title", "event", "type", "name"]) {
      if (typeof payload[key] === "string" && (payload[key] as string).length > 0) {
        return payload[key] as string;
      }
    }
    return "Webhook event";
  })();

  const fields      = extractSafeFields(payload);
  const fieldLines  = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const description = `Webhook received.\n${fieldLines}`;

  return {
    title,
    description,
    source: "generic",
    fields,
  };
}

/**
 * Normalize an incoming webhook payload into a canonical task description.
 *
 * @param payload  Parsed JSON body from the incoming request.
 * @param source   Declared source override; auto-detected when omitted.
 */
export function normalizeWebhookPayload(
  payload: Record<string, unknown>,
  source?: string,
): NormalizedWebhookPayload {
  const detected: WebhookSource = (source === "github" || source === "grafana")
    ? source
    : detectSource(payload);

  switch (detected) {
    case "github":  return normalizeGithub(payload);
    case "grafana": return normalizeGrafana(payload);
    default:        return normalizeGeneric(payload);
  }
}
