// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA Discord Module — Support Channel Message Handler
 *
 * Processes incoming messages from configured support channels:
 * 1. Ignores bot messages
 * 2. Ignores messages outside configured channel IDs
 * 3. Ignores DMs (no guild_id)
 * 4. Detects priority via keyword matching
 * 5. Responds with doc match if found
 * 6. Creates Redmine issue for HIGH priority messages
 * 7. Reacts with emoji: ✅ handled, 🔍 investigating, 🎫 ticket created
 */

import type { DiscordClient }   from "../discord-client.js";
import type { GatewayMessage }  from "../discord-types.js";
import type { DocMatcher }      from "./doc-matcher.js";
import type { RedmineHandler }  from "./redmine-handler.js";


export type Priority = "HIGH" | "NORMAL" | "LOW";

const PRIORITY_HIGH: readonly string[] = [
  "crash", "crashed", "crashing",
  "data loss", "lost data", "data gone",
  "can't start", "won't start", "fails to start", "not starting",
  "error", "exception", "stack trace", "traceback",
  "broken", "corrupted", "segfault",
  "security", "vulnerability", "exploit",
  "urgent", "critical", "blocker",
];

const PRIORITY_NORMAL: readonly string[] = [
  "bug", "issue", "problem", "wrong", "incorrect",
  "doesn't work", "not working", "failed",
  "help", "how do i", "how to",
  "confused", "stuck",
];

const PRIORITY_LOW: readonly string[] = [
  "suggestion", "feature request", "would be nice",
  "idea", "could you add", "wish",
  "question", "wondering",
];

/**
 * Detect message priority from content keywords.
 * HIGH > NORMAL > LOW (first match wins).
 */
export function detectPriority(content: string): Priority {
  const lower = content.toLowerCase();
  if (PRIORITY_HIGH.some((kw) => lower.includes(kw)))   return "HIGH";
  if (PRIORITY_NORMAL.some((kw) => lower.includes(kw))) return "NORMAL";
  if (PRIORITY_LOW.some((kw) => lower.includes(kw)))    return "LOW";
  return "LOW";
}


export interface SupportHandlerConfig {
  /** Set of channel IDs to process (resolved from channel names at daemon start). */
  supportChannelIds: Set<string>;
  /** The bot's own user ID — used to prevent self-response loops. */
  botUserId: string;
  /**
   * Whitelist of guild IDs the bot is permitted to respond in.
   * Messages from guilds not in this set are silently ignored.
   * Prevents the bot from being added to an untrusted server and leaking data.
   */
  allowedGuildIds: Set<string>;
}


/** Maximum number of tickets a single user can create per hour. */
const TICKET_RATE_LIMIT = 5;
/** Rate-limit window in milliseconds (1 hour). */
const TICKET_RATE_WINDOW_MS = 3_600_000;

export class SupportHandler {
  /** Per-user ticket creation timestamps for rate limiting. */
  private readonly ticketTimestamps = new Map<string, number[]>();

  constructor(
    private readonly client:         DiscordClient,
    private readonly docMatcher:     DocMatcher,
    private readonly redmineHandler: RedmineHandler | null,
    private readonly config:         SupportHandlerConfig,
  ) {}

  /**
   * Returns true if the user has exceeded the ticket creation rate limit.
   * Prunes stale timestamps on each call.
   */
  private isTicketRateLimited(userId: string): boolean {
    const now = Date.now();
    const cutoff = now - TICKET_RATE_WINDOW_MS;
    const times  = (this.ticketTimestamps.get(userId) ?? []).filter((t) => t > cutoff);
    if (times.length >= TICKET_RATE_LIMIT) {
      this.ticketTimestamps.set(userId, times);
      return true;
    }
    times.push(now);
    this.ticketTimestamps.set(userId, times);
    return false;
  }

  /**
   * Handle an incoming Gateway message.
   * No-ops if the message is from a bot, outside support channels, DM, or untrusted guild.
   */
  async handleMessage(msg: GatewayMessage): Promise<void> {
    // 1. Ignore bots (including ourselves)
    if (msg.author.bot === true) return;
    if (msg.author.id === this.config.botUserId) return;

    // 2. Ignore messages outside configured channels
    if (!this.config.supportChannelIds.has(msg.channel_id)) return;

    // 3. Ignore DMs (no guild_id)
    if (msg.guild_id === undefined) return;

    // 4. Guild whitelist check — reject messages from unlisted servers
    if (!this.config.allowedGuildIds.has(msg.guild_id)) return;

    const priority = detectPriority(msg.content);

    // 4. Try doc matching
    const match = this.docMatcher.match(msg.content);
    let handledByDoc = false;

    if (match !== null) {
      handledByDoc = true;
      await this.client.sendMessage(msg.channel_id, {
        content: `<@${msg.author.id}> Here's what I found:`,
        embeds: [match.embed],
      });
      await this.client.addReaction(msg.channel_id, msg.id, "✅");
    }

    // 5. Create Redmine issue for HIGH priority
    if (priority === "HIGH" && this.redmineHandler !== null) {
      if (this.isTicketRateLimited(msg.author.id)) {
        await this.client.sendMessage(msg.channel_id, {
          content: `<@${msg.author.id}> You're submitting tickets too quickly. Please wait before creating another.`,
        });
        return;
      }
      if (this.redmineHandler.canCreateIssue(msg.author.id)) {
        const issueId = await this.redmineHandler.createIssue(
          msg, priority, msg.channel_id,
        );
        await this.client.sendMessage(msg.channel_id, {
          content: `🎫 Created ticket #${issueId} — we'll look into this.`,
        });
        await this.client.addReaction(msg.channel_id, msg.id, "🎫");
        return;
      }
    }

    // 6. No doc match, not high-priority Redmine → investigating
    if (!handledByDoc) {
      await this.client.addReaction(msg.channel_id, msg.id, "🔍");
    }
  }
}
