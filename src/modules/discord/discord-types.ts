// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA Discord Module — API Types
 *
 * Minimal Discord API v10 type definitions for the operations SIDJUA needs.
 * Not exhaustive — only fields we actually use.
 */


export interface DiscordUser {
  id:            string;
  username:      string;
  discriminator: string;
  global_name:   string | null;
  bot?:          boolean;
}

export interface DiscordMessage {
  id:         string;
  content:    string;
  author:     DiscordUser;
  channel_id: string;
  timestamp:  string;
  embeds:     DiscordEmbed[];
}

export interface DiscordChannel {
  id:           string;
  type:         number;
  guild_id?:    string;
  name?:        string;
  topic?:       string | null;
  parent_id?:   string | null;
}

export interface DiscordGuildMember {
  user?:     DiscordUser;
  roles:     string[];
  nick?:     string | null;
  joined_at: string;
}

export interface DiscordGuild {
  id:                          string;
  name:                        string;
  icon:                        string | null;
  /** Populated when with_counts=true is passed to GET /guilds/{id} */
  approximate_member_count?:   number;
  /** Online members — populated with with_counts=true */
  approximate_presence_count?: number;
}

export interface DiscordThread {
  id:        string;
  name:      string;
  parent_id: string | null;
  type:      number;
}


export interface DiscordEmbedField {
  name:    string;
  value:   string;
  inline?: boolean;
}

export interface DiscordEmbedAuthor {
  name:      string;
  icon_url?: string;
}

export interface DiscordEmbedFooter {
  text:      string;
  icon_url?: string;
}

export interface DiscordEmbed {
  title?:       string;
  description?: string;
  color?:       number;
  fields?:      DiscordEmbedField[];
  author?:      DiscordEmbedAuthor;
  footer?:      DiscordEmbedFooter;
  timestamp?:   string;
}


export interface DiscordErrorBody {
  code:     number;
  message:  string;
  errors?:  Record<string, unknown>;
}

export interface RateLimitHeaders {
  limit:      number;
  remaining:  number;
  reset:      number;   // Unix timestamp
  resetAfter: number;   // seconds
  bucket:     string;
}


export interface SendMessageInput {
  channel_id: string;
  content?:   string;
  embed?:     DiscordEmbed;
}

export interface EditMessageInput {
  channel_id:  string;
  message_id:  string;
  content?:    string;
  embed?:      DiscordEmbed;
}

export interface DeleteMessageInput {
  channel_id: string;
  message_id: string;
}

export interface ReadMessagesInput {
  channel_id: string;
  limit?:     number;
  before?:    string;
  after?:     string;
}

export interface CreateThreadInput {
  channel_id:             string;
  name:                   string;
  message_id?:            string;
  auto_archive_duration?: 60 | 1440 | 4320 | 10080;
}

/**
 * Input for discord_post_dev_update — commit-centric schema per spec.
 * Color is auto-detected from commit_message keywords (fix → red, release/v* → green, else blurple).
 * Channel is resolved from module config dev_log_channel, not passed in tool args.
 */
export interface DevUpdateInput {
  commit_hash:    string;
  commit_message: string;
  test_count:     number;
  files_changed:  number;
  summary:        string;
  issue_ids?:     number[];
}

export interface AnnounceInput {
  channel_id:    string;
  message:       string;
  mention_role?: string;
}

/** Unified channel management input */
export interface ManageChannelInput {
  action:      "create" | "edit" | "delete";
  guild_id?:   string;   // required for create
  channel_id?: string;   // required for edit/delete
  name?:       string;   // required for create; optional for edit
  type?:       "text" | "voice" | "category";  // for create
  topic?:      string;   // for create/edit
  parent_id?:  string;   // category parent for create
}

/** Unified member management input */
export interface ManageMemberInput {
  action:    "add_role" | "remove_role" | "kick" | "ban";
  guild_id:  string;
  user_id:   string;
  role_id?:  string;    // required for add_role / remove_role
  reason?:   string;    // optional context for kick / ban
}

/** Server status summary returned by discord_server_status */
export interface ServerStatus {
  guild_id:        string;
  guild_name:      string;
  member_count:    number | null;
  online_count:    number | null;
  channel_count:   number;
  channels:        Array<{ id: string; name: string; type: number }>;
}


export interface DiscordModuleConfig {
  bot_token:          string;
  /** Required — Discord server (guild) ID */
  guild_id?:          string;
  /** Channel name for dev-log updates (default: "dev-log") */
  dev_log_channel?:   string;
  /** Channel name for announcements (default: "announcements") */
  announcements_channel?: string;
  /** Legacy / optional explicit IDs */
  default_channel_id?: string;
  /** Channel name for user support (default: "support") */
  support_channel?:   string;
  /** Channel name for bug reports (default: "bug-reports") */
  bug_channel?:       string;
  /** Issue tracker server URL (default: "http://localhost:8080") */
  issue_tracker_url?: string;
  /** @deprecated use issue_tracker_url instead. Will be removed in V1.2. */
  redmine_url?:       string;
  /**
   * Allow agents to execute destructive Discord operations
   * (discord_manage_channel, discord_manage_member).
   *
   * DEFAULT: false — destructive tools are blocked unless explicitly enabled.
   * Set to true only for privileged agents that require channel/member management.
   */
  enableDestructiveOps?: boolean;
  /**
   * When true, destructive operations require a governance pre-approval reference.
   * The agent must include a non-empty "_approval_ref" field in tool arguments
   * to prove the operation was approved through the governance pipeline.
   *
   * DEFAULT: false. Set to true in high-security environments.
   */
  requireApprovalForDestructive?: boolean;
}


/** Gateway opcodes per Discord docs */
export enum GatewayOpcode {
  Dispatch        = 0,
  Heartbeat       = 1,
  Identify        = 2,
  Resume          = 6,
  Reconnect       = 7,
  InvalidSession  = 9,
  Hello           = 10,
  HeartbeatACK    = 11,
}

/** Gateway events we care about */
export type GatewayEventType =
  | "READY"
  | "MESSAGE_CREATE"
  | "MESSAGE_UPDATE"
  | "GUILD_MEMBER_ADD"
  | "GUILD_MEMBER_REMOVE";

/** Raw payload received from Gateway WebSocket */
export interface GatewayPayload {
  op: GatewayOpcode;
  d:  unknown;
  s:  number | null;
  t:  string | null;
}

/** HELLO op data */
export interface HelloData {
  heartbeat_interval: number;
}

/** READY op data */
export interface ReadyData {
  session_id:          string;
  resume_gateway_url:  string;
  user: {
    id:       string;
    username: string;
  };
}

/** Attachment in a gateway message */
export interface GatewayMessageAttachment {
  filename: string;
  url:      string;
}

/**
 * Message object received via MESSAGE_CREATE dispatch.
 * Not the same as DiscordMessage (REST) — guild_id is optional, embeds typed as unknown.
 */
export interface GatewayMessage {
  id:          string;
  channel_id:  string;
  guild_id?:   string;
  author:      { id: string; username: string; bot?: boolean };
  content:     string;
  timestamp:   string;
  attachments: GatewayMessageAttachment[];
  embeds:      unknown[];
}

/** Extended module config including gateway/support channels */
export interface GatewayModuleConfig extends DiscordModuleConfig {
  support_channel?:   string;
  bug_channel?:       string;
  /** Issue tracker server URL (default: "http://localhost:8080") */
  issue_tracker_url?: string;
  /** @deprecated use issue_tracker_url instead. Will be removed in V1.2. */
  redmine_url?:       string;
}
