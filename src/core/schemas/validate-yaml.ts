// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — YAML parse + Zod validation helpers.
 *
 * parseAndValidateYaml   — throws SidjuaError on invalid data
 * parseAndValidateYamlSafe — returns { success, data } | { success: false, error }
 *
 * Both functions accept a pre-parsed object (from yaml.parse) and a Zod schema.
 * Keeping YAML parsing separate means callers can apply their own error handling
 * to the fs/parse step while delegating structure validation to these helpers.
 */

import { z } from "zod";
import { SidjuaError } from "../error-codes.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a YAML-parsed value against a Zod schema.
 *
 * @throws SidjuaError CONFIG-003 if validation fails
 */
export function parseAndValidateYaml<T>(
  schema: z.ZodType<T>,
  value:  unknown,
  label:  string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")} — ${i.message}`)
      .join("; ");
    throw SidjuaError.from(
      "CONFIG-003",
      `${label}: ${issues}`,
    );
  }
  return result.data;
}

/**
 * Validate a YAML-parsed value against a Zod schema, returning a discriminated
 * union instead of throwing.
 */
export function parseAndValidateYamlSafe<T>(
  schema: z.ZodType<T>,
  value:  unknown,
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(value);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return { success: true, data: result.data };
}
