// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — Phase 10.6: PolicyParser
 * Translates natural language rules to structured PolicyRuleInput via LLM.
 */

import OpenAI from "openai";
import type { PolicyRuleInput, PolicyRuleType, PolicyEnforcementLevel } from "../types.js";
import { createLogger, type Logger } from "../../core/logger.js";

export interface ParsedPolicyRule extends PolicyRuleInput {
  raw_input: string;
  confidence: number;
}

export class PolicyParser {
  private readonly client: OpenAI;

  constructor(
    apiKey?: string,
    private readonly model = "gpt-4o-mini",
    private readonly logger: Logger = createLogger("policy-parser"),
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async parse(naturalLanguage: string, sourceFile = "user-policy.yaml"): Promise<ParsedPolicyRule> {
    const systemPrompt = `You are a governance policy parser for SIDJUA. Convert natural language rules to structured JSON.

Output ONLY valid JSON with these fields:
{
  "rule_type": "forbidden" | "approval" | "escalation" | "budget" | "custom",
  "action_pattern": string (optional - glob pattern like "file.delete" or "data.*"),
  "condition": string (optional - simple condition like "file.path starts_with 'originals/'"),
  "enforcement": "block" | "ask_first" | "warn" | "escalate" | "log",
  "escalate_to": string (optional - "division_head" | "CEO" | agent_id),
  "reason": string,
  "confidence": number (0.0-1.0)
}`;

    const userPrompt = `Convert this rule to JSON: "${naturalLanguage}"`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as {
        rule_type?: string;
        action_pattern?: string;
        condition?: string;
        enforcement?: string;
        escalate_to?: string;
        reason?: string;
        confidence?: number;
      };

      const result: ParsedPolicyRule = {
        raw_input: naturalLanguage,
        source_file: sourceFile,
        rule_type: (parsed.rule_type ?? "custom") as PolicyRuleType,
        enforcement: (parsed.enforcement ?? "block") as PolicyEnforcementLevel,
        reason: parsed.reason ?? naturalLanguage,
        confidence: parsed.confidence ?? 0.8,
      };
      if (parsed.action_pattern !== undefined) result.action_pattern = parsed.action_pattern;
      if (parsed.condition !== undefined) result.condition = parsed.condition;
      if (parsed.escalate_to !== undefined) result.escalate_to = parsed.escalate_to;
      return result;
    } catch (err) {
      this.logger.error("policy_parser_llm_failed", "PolicyParser LLM call failed", {
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
      // Fallback: create a basic custom rule
      return {
        raw_input: naturalLanguage,
        source_file: sourceFile,
        rule_type: "custom" as PolicyRuleType,
        enforcement: "block" as PolicyEnforcementLevel,
        reason: naturalLanguage,
        confidence: 0.5,
      };
    }
  }
}
