// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA Discord Module — Issue Tracker Integration
 *
 * Creates tickets in the configured issue tracker from HIGH-priority
 * Discord support messages.
 *
 * Rate limit: max 5 issues per user per hour to prevent spam.
 *
 * API: POST {baseUrl}/issues.json (Redmine-compatible backend)
 * Auth: provider-specific API-key header
 *
 * Issue fields:
 * - Project: SIDJUA Free (id: 7)
 * - Tracker: Bug (id: 1)
 * - Subject: [BUG] <first 80 chars of message>
 * - Priority: Urgent (id: 3) for HIGH, Normal (id: 2) for NORMAL
 * - Assigned to: Haiku (id: 7) for triage
 */

import type { GatewayMessage } from "../discord-types.js";
import type { Priority }       from "./support-handler.js";
import type { DiscordClient }  from "../discord-client.js";


export interface IssueTrackerConfig {
  apiKey:  string;
  baseUrl: string;
}

interface IssueTrackerResponse {
  issue: { id: number; subject: string };
}


const RATE_LIMIT_MAX      = 5;
const RATE_LIMIT_WINDOW   = 3_600_000; // 1 hour in ms


export class IssueTrackerHandler {
  /** userId → array of issue-creation timestamps within the last hour */
  private readonly issueLog = new Map<string, number[]>();

  constructor(
    private readonly config:  IssueTrackerConfig,
    private readonly client:  DiscordClient,
    private readonly opts:    { fetchFn?: typeof fetch } = {},
  ) {}

  private get fetchFn(): typeof fetch {
    return this.opts.fetchFn ?? fetch;
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────

  /** Returns true if the user is within rate limit (fewer than 5 issues/hour). */
  canCreateIssue(userId: string): boolean {
    const now      = Date.now();
    const cutoff   = now - RATE_LIMIT_WINDOW;
    const times    = (this.issueLog.get(userId) ?? []).filter((t) => t > cutoff);
    return times.length < RATE_LIMIT_MAX;
  }

  private recordIssue(userId: string): void {
    const now    = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW;
    const times  = (this.issueLog.get(userId) ?? []).filter((t) => t > cutoff);
    times.push(now);
    this.issueLog.set(userId, times);
  }

  // ── Issue creation ────────────────────────────────────────────────────────

  /**
   * Create a ticket from the Discord message in the configured issue tracker.
   * Returns the created issue ID.
   */
  async createIssue(
    msg:       GatewayMessage,
    priority:  Priority,
    channelId: string,
  ): Promise<number> {
    const subject  = `[BUG] ${msg.content.slice(0, 80)}`;
    const attachmentList = msg.attachments.map((a) => `- ${a.filename}: ${a.url}`).join("\n");

    const description = [
      "Level: L4:DEV",
      "",
      `Source: Discord #${channelId} by ${msg.author.username}`,
      `Message: ${msg.content}`,
      attachmentList.length > 0 ? `Attachments:\n${attachmentList}` : "",
      `Priority: ${priority}`,
      "",
      "Auto-created by SidjuaBOT",
    ].filter((line) => line !== "").join("\n");

    const priorityId = priority === "HIGH" ? 3 : 2;

    const body = {
      issue: {
        project_id:     7,
        tracker_id:     1,
        subject,
        description,
        priority_id:    priorityId,
        assigned_to_id: 7,
      },
    };

    const res = await this.fetchFn(`${this.config.baseUrl}/issues.json`, {
      method:  "POST",
      headers: {
        "Content-Type":       "application/json",
        "X-Redmine-API-Key":  this.config.apiKey, // pipeline-ok
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Issue tracker API error: HTTP ${res.status}`);
    }

    const data = await res.json() as IssueTrackerResponse;
    const issueId = data.issue.id;

    this.recordIssue(msg.author.id);

    return issueId;
  }
}
