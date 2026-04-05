// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — V0.9.3: Claude Chat Export Parser
 *
 * Parses Claude.ai chat export ZIP files (or raw conversations.json) into
 * ParsedDocument sections suitable for the knowledge pipeline.
 *
 * ZIP format: ZIP archive containing conversations.json
 * JSON format: array of conversation objects
 */

import { createRequire } from "node:module";
import type { Parser, ParsedDocument, ParsedSection } from "../types.js";
import { countTokens } from "../types.js";

const require = createRequire(import.meta.url);


interface ClaudeMessage {
  uuid: string;
  sender: "human" | "assistant";
  text?: string;
  content?: string | Array<{ type: string; text?: string }>;
  created_at: string;
}

interface ClaudeConversation {
  uuid: string;
  name: string;
  created_at: string;
  chat_messages: ClaudeMessage[];
}


function extractText(msg: ClaudeMessage): string {
  if (typeof msg.text === "string" && msg.text.trim().length > 0) {
    return msg.text.trim();
  }
  if (typeof msg.content === "string" && msg.content.trim().length > 0) {
    return msg.content.trim();
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => (c.text ?? "").trim())
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
}

function conversationToSection(conv: ClaudeConversation, pageNumber: number): ParsedSection | null {
  const messages = conv.chat_messages ?? [];
  const lines: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg);
    if (text.length === 0) continue;
    const prefix = msg.sender === "human" ? "Human" : "Claude";
    lines.push(`${prefix}: ${text}`);
  }

  if (lines.length === 0) return null;

  const content = lines.join("\n\n");
  const heading = (conv.name ?? "Untitled").slice(0, 80);

  return {
    content,
    heading,
    level: 1,
    page_number: pageNumber,
    metadata: {
      conversation_uuid: conv.uuid,
      conversation_created_at: conv.created_at,
      message_count: messages.length,
      source_platform: "claude_chat_export",
    },
  };
}

function parseConversations(conversations: unknown[]): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let pageNumber = 1;

  for (const raw of conversations) {
    try {
      const conv = raw as ClaudeConversation;
      const section = conversationToSection(conv, pageNumber);
      if (section !== null) {
        sections.push(section);
        pageNumber++;
      }
    } catch (err) {
      process.stderr.write(
        `[claude-export-parser] Skipping conversation: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return sections;
}


export class ClaudeExportParser implements Parser {
  async parse(content: Buffer | string, filename: string): Promise<ParsedDocument> {
    const lower = filename.toLowerCase();

    let jsonText: string;

    if (lower.endsWith(".zip")) {
      jsonText = await this._extractFromZip(typeof content === "string" ? Buffer.from(content) : content);
    } else {
      jsonText = typeof content === "string" ? content : content.toString("utf-8");
    }

    const parsed: unknown = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      throw new Error("Claude export JSON must be an array of conversations");
    }

    const sections = parseConversations(parsed as unknown[]);
    const totalTokens = sections.reduce((sum, s) => sum + countTokens(s.content), 0);

    return {
      sections,
      source_file: filename,
      total_tokens: totalTokens,
      metadata: {
        conversation_count: parsed.length,
        sections_count: sections.length,
        source_platform: "claude_chat_export",
      },
    };
  }

  /**
   * Reject ZIP entry names that could escape the target directory (ZIP-slip).
   * Entry names containing ".." or starting with "/" are not valid relative paths
   * and must never be used for file extraction or path lookups.
   */
  private _isSafeEntryName(name: string): boolean {
    if (name.startsWith("/")) return false;
    const segments = name.split(/[\\/]/);
    return !segments.includes(".") && !segments.includes("..");
  }

  private async _extractFromZip(buffer: Buffer): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AdmZip = require("adm-zip") as new (buf: Buffer) => any;
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries() as Array<{ entryName: string; getData: () => Buffer }>;

    // Reject entries with path traversal sequences before any access (ZIP-slip guard).
    const safeEntries = entries.filter((e) => this._isSafeEntryName(e.entryName));

    // Find conversations.json (may be nested) — only among safe entries
    const entry = safeEntries.find(
      (e) =>
        e.entryName === "conversations.json" ||
        e.entryName.endsWith("/conversations.json"),
    );

    if (entry === undefined) {
      const allNames = entries.map((e) => e.entryName).join(", ");
      throw new Error(
        "No conversations.json found in ZIP. Entries: " + allNames,
      );
    }

    return entry.getData().toString("utf-8");
  }
}
