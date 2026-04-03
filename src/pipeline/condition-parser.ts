// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Condition expression parser
 *
 * Evaluates simple condition strings used in governance YAML configs.
 *
 * V1 grammar: <field> <operator> <value>
 *   - field:    dot-path resolved against the ActionRequest
 *   - operator: >, <, >=, <=, ==, !=, contains
 *   - value:    quoted string | number | boolean | field reference
 *
 * Examples:
 *   "amount_usd > 500"
 *   "target contains 'audit'"
 *   "parameters.intent != 'deceptive'"
 *   "target_division != division_code"
 *   "parameters.contains_pii != true"
 *
 * Design rules:
 *   - NO eval(), NO arbitrary code execution
 *   - Parse errors → return false (fail-open: unparseable ≠ BLOCK)
 *   - Numeric comparisons only for >, <, >=, <=
 *   - String/field comparisons for == and !=
 *   - "contains" checks string containment
 */

import type { ActionRequest, ConditionOperator, ParsedCondition } from "../types/pipeline.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("condition-parser");


/**
 * Thrown when a governance condition string cannot be parsed.
 * Callers should treat this as a fail-closed signal (deny the action).
 */
export class GovernanceParseError extends Error {
  public readonly condition: string;
  constructor(
    condition: string,
    rootCause: unknown,
  ) {
    super(
      `Governance condition parse error: "${condition}" — ${rootCause instanceof Error ? rootCause.message : String(rootCause)}`,
      { cause: rootCause },
    );
    this.name = "GovernanceParseError";
    this.condition = condition;
  }
}

const VALID_OPERATORS = new Set<string>([">=", "<=", "!=", "==", "contains", ">", "<"]);


/**
 * Parse a condition string into a structured representation.
 *
 * @throws {Error} if the condition cannot be parsed
 */
export function parseCondition(condition: string): ParsedCondition {
  const trimmed = condition.trim();

  // Tokenize: split on whitespace but keep quoted strings together
  const tokens = tokenize(trimmed);

  if (tokens.length < 3) {
    throw new GovernanceParseError(condition, new Error(`Condition must have at least 3 tokens (field op value), got: "${condition}"`));
  }

  const field = tokens[0];
  const opToken = tokens[1];
  const rawValueParts = tokens.slice(2);

  if (field === undefined || opToken === undefined || rawValueParts.length === 0) {
    throw new GovernanceParseError(condition, new Error(`Invalid condition: "${condition}"`));
  }

  if (!VALID_OPERATORS.has(opToken)) {
    throw new GovernanceParseError(condition, new Error(`Unknown operator "${opToken}" in condition: "${condition}"`));
  }

  const operator = opToken as ConditionOperator;
  const rawValue = rawValueParts.join(" ");

  const { value, valueIsFieldRef } = parseValue(rawValue);

  return { field, operator, value, valueIsFieldRef };
}


/**
 * Evaluate a condition expression against a pipeline request.
 *
 * Returns true on parse errors (fail-closed: malformed condition = block the action).
 * A error is logged with full context when the condition cannot be parsed.
 */
export function evaluateCondition(condition: string, request: ActionRequest): boolean {
  try {
    const parsed = parseCondition(condition);
    const fieldValue = resolveField(parsed.field, request);

    // Resolve the compare-with value: either a literal or another field ref
    const compareWith: unknown = parsed.valueIsFieldRef
      ? resolveField(parsed.value as string, request)
      : parsed.value;

    // When comparing two field references and either side is undefined (not
    // applicable in this context), the condition is not triggered (fail-open).
    if (parsed.valueIsFieldRef && (fieldValue === undefined || compareWith === undefined)) {
      return false;
    }

    return compareValues(fieldValue, parsed.operator, compareWith);
  } catch (err) {
    // Fail-closed: malformed governance condition triggers the rule (deny/block)
    // Log error with full context so governance config authors can fix it
    logger.warn("system", "Governance condition parse error (fail-closed — action blocked)", { metadata: {
      condition,
      error: err instanceof Error ? err.message : String(err),
      agent_id: request.agent_id,
      action_type: request.action.type,
    } });
    return true;
  }
}


/**
 * Resolve a field name to its value in the ActionRequest.
 *
 * Supported fields:
 *   target, type, estimated_cost_usd, amount_usd, data_classification,
 *   division_code, target_division, agent_tier, agent_id,
 *   parameters.<key>
 *
 * Memory lifecycle fields (resolved from action.parameters):
 *   memory_size_kb, skill_file_size_kb, target_has_no_open_task_refs,
 *   has_required_tags, changes_role_definition
 *
 * Returns undefined if the field is not found.
 */
export function resolveField(field: string, request: ActionRequest): unknown {
  // Dotted path: "parameters.<key>"
  if (field.startsWith("parameters.")) {
    const paramKey = field.slice("parameters.".length);
    return request.action.parameters?.[paramKey];
  }

  switch (field) {
    case "target":              return request.action.target;
    case "type":                return request.action.type;
    case "estimated_cost_usd":
    case "amount_usd":          return request.action.estimated_cost_usd;
    case "data_classification": return request.action.data_classification;
    case "division_code":       return request.context.division_code;
    // target_division falls back to own division_code for same-division operations
    case "target_division":
      return request.context.target_division ?? request.context.division_code;
    case "agent_tier":          return request.agent_tier;
    case "agent_id":            return request.agent_id;

    // Memory lifecycle fields — resolved from action.parameters
    case "memory_size_kb":
      return request.action.parameters?.["memory_size_kb"];
    case "skill_file_size_kb":
      return request.action.parameters?.["skill_file_size_kb"];
    case "target_has_no_open_task_refs":
      return (request.action.parameters?.["open_task_refs"] as number) === 0;
    case "has_required_tags":
      return request.action.parameters?.["has_required_tags"] === true;
    case "changes_role_definition":
      return request.action.parameters?.["changes_role_definition"] === true;

    default:
      // Try direct parameter key as a shorthand
      return request.action.parameters?.[field];
  }
}


/**
 * Compare two values using the given operator.
 *
 * - >, <, >=, <=: numeric comparison; returns false if either value is not a number
 * - ==, !=: string comparison (both sides cast to string)
 * - contains: string containment; returns false if either side is not a string
 */
export function compareValues(
  fieldValue: unknown,
  operator: ConditionOperator,
  compareWith: unknown,
): boolean {
  switch (operator) {
    case ">":
      return typeof fieldValue === "number" &&
             typeof compareWith === "number" &&
             fieldValue > compareWith;

    case "<":
      return typeof fieldValue === "number" &&
             typeof compareWith === "number" &&
             fieldValue < compareWith;

    case ">=":
      return typeof fieldValue === "number" &&
             typeof compareWith === "number" &&
             fieldValue >= compareWith;

    case "<=":
      return typeof fieldValue === "number" &&
             typeof compareWith === "number" &&
             fieldValue <= compareWith;

    case "==":
      // Use string coercion so booleans, numbers, and strings compare intuitively
      return String(fieldValue ?? "") === String(compareWith ?? "");

    case "!=":
      return String(fieldValue ?? "") !== String(compareWith ?? "");

    case "contains":
      return typeof fieldValue === "string" &&
             typeof compareWith === "string" &&
             fieldValue.includes(compareWith);
  }
}


/**
 * Simple tokenizer: splits on whitespace, treating single-quoted and
 * double-quoted sequences as single tokens.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i] ?? "")) {
      i++;
      continue;
    }

    // Quoted string
    const quote = input[i];
    if (quote === "'" || quote === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== quote) j++;
      tokens.push(input.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // Regular token
    let j = i;
    while (j < input.length && !/\s/.test(input[j] ?? "")) j++;
    tokens.push(input.slice(i, j));
    i = j;
  }

  return tokens;
}

interface ParsedValue {
  value: string | number | boolean;
  valueIsFieldRef: boolean;
}

/**
 * Parse a raw value token into a typed value.
 * - Quoted strings → string literal (strip quotes)
 * - "true" / "false" → boolean literal
 * - Numeric string → number literal
 * - Anything else → field reference (unresolved string)
 */
function parseValue(raw: string): ParsedValue {
  // Quoted string literal
  if (
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) ||
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)
  ) {
    return { value: raw.slice(1, -1), valueIsFieldRef: false };
  }

  // Boolean literal
  if (raw === "true")  return { value: true,  valueIsFieldRef: false };
  if (raw === "false") return { value: false, valueIsFieldRef: false };

  // Numeric literal
  if (raw !== "") {
    const num = Number(raw);
    if (!isNaN(num)) return { value: num, valueIsFieldRef: false };
  }

  // Field reference
  return { value: raw, valueIsFieldRef: true };
}
