// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * SIDJUA — MCP Context Budget
 *
 * Utilities for estimating token count and compressing multi-turn MCP
 * conversations when approaching the model's context window limit.
 *
 * Compression strategy: keep system (role=user, index 0), last N user/assistant
 * pairs, and inject a "[context compressed]" sentinel after the initial message.
 * Tool-result messages are prioritised for removal because they are often long
 * and their content is already embedded in subsequent assistant replies.
 */

import type { McpMessage } from "./tool-executor.js";

/** Rough token estimate: ~4 chars per token + 4 overhead per message. */
function messageTokens(msg: McpMessage): number {
  const text = typeof msg.content === "string"
    ? msg.content
    : msg.content.map((b) => b.text ?? b.content ?? JSON.stringify(b)).join(" ");
  return Math.ceil(text.length / 4) + 4;
}

/**
 * Estimate total token count for a conversation.
 * Uses the same 4-char/token heuristic as the provider adapters.
 */
export function estimateTokens(messages: McpMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

export interface CompressResult {
  messages: McpMessage[];
  /** Number of messages removed by compression. */
  removed:  number;
}

/**
 * Compress a conversation to fit within `targetTokens`.
 *
 * Removes middle messages (keeping first and last), injecting a
 * `[context compressed — N messages removed]` sentinel user message.
 * Returns the original array unchanged if already within budget.
 */
export function compressContext(
  messages:     McpMessage[],
  targetTokens: number,
): CompressResult {
  if (estimateTokens(messages) <= targetTokens) {
    return { messages, removed: 0 };
  }

  // Always keep first message and the last MIN_KEEP_TAIL messages.
  // The middle (everything between first and tail) is the removal candidate.
  const MIN_KEEP_TAIL = 2;
  if (messages.length <= 1 + MIN_KEEP_TAIL) {
    // Nothing left to remove — return as-is even if over budget
    return { messages, removed: 0 };
  }

  const first  = messages[0]!;
  const tail   = messages.slice(-MIN_KEEP_TAIL);
  const middle = messages.slice(1, messages.length - MIN_KEEP_TAIL);

  const SENTINEL_TOKENS = 20;
  const firstCost  = messageTokens(first);
  const tailCost   = tail.reduce((s, m) => s + messageTokens(m), 0);
  const middleBudget = targetTokens - firstCost - SENTINEL_TOKENS - tailCost;

  const kept_middle: McpMessage[] = [];
  if (middleBudget > 0) {
    // Walk middle from the end (most recent first) until budget is exhausted
    let remaining = middleBudget;
    for (let i = middle.length - 1; i >= 0; i--) {
      const m    = middle[i]!;
      const cost = messageTokens(m);
      if (remaining - cost < 0) break;
      remaining -= cost;
      kept_middle.unshift(m);
    }
  }

  const removed = middle.length - kept_middle.length;
  const sentinel: McpMessage = {
    role:    "user",
    content: `[context compressed — ${removed} message${removed === 1 ? "" : "s"} removed]`,
  };

  const compressed: McpMessage[] = [
    first,
    ...(removed > 0 ? [sentinel] : []),
    ...kept_middle,
    ...tail,
  ];

  return { messages: compressed, removed };
}
