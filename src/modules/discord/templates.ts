// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA Discord Module — Embedded File Templates
 *
 * Template content embedded as TypeScript strings so the module ships as
 * a single compiled artifact with no runtime file path dependencies.
 */


export const DISCORD_MODULE_YAML = `id: discord
name: "Discord Bot"
version: "1.0.0"
description: "Manage Discord servers with a SIDJUA agent — post updates, manage channels and roles."
category: communication
sidjua_min_version: "0.9.0"

agent:
  id: discord-admin
  definition: agent.yaml
  skill: skill.md

secrets:
  - key: DISCORD_BOT_TOKEN
    description: "Discord Bot Token from discord.com/developers/applications"
    required: true
    validation: "^[A-Za-z0-9._-]+$"
  - key: ISSUE_TRACKER_API_KEY
    description: "API key for the configured issue tracker; enables auto-ticket creation from support messages (Redmine-compatible)"
    required: false

config:
  - key: guild_id
    description: "Your Discord server (guild) ID"
    required: true
  - key: dev_log_channel
    description: "Channel name for dev updates"
    required: false
    default: "dev-log"
  - key: announcements_channel
    description: "Channel name for announcements"
    required: false
    default: "announcements"
  - key: support_channel
    description: "Channel name for user support (Gateway listener)"
    required: false
    default: "support"
  - key: bug_channel
    description: "Channel name for bug reports (Gateway listener)"
    required: false
    default: "bug-reports"
  - key: issue_tracker_url
    description: "Issue tracker server URL for auto-ticket creation (Redmine-compatible)"
    required: false
    default: "http://localhost:8080"

commands:
  - discord status
  - discord post-dev-update
  - discord announce
  - discord listen start
  - discord listen stop
  - discord listen status
  - discord listen logs
`;


export const DISCORD_AGENT_YAML = `id: discord-admin
name: "Discord Admin"
tier: 2
division: press-marketing
reports_to: human
provider: default
module: discord
capabilities:
  - discord-server-management
  - community-moderation
  - dev-log-automation
  - team-lead
tools:
  - discord_send_message
  - discord_read_messages
  - discord_create_thread
  - discord_manage_channel
  - discord_manage_member
  - discord_server_status
  - discord_post_dev_update
secrets:
  - DISCORD_BOT_TOKEN
budget:
  per_task_usd: 0.00
  per_hour_usd: 0.00
  per_month_usd: 0.00
max_concurrent_tasks: 5
schedule: on-demand
knowledge_urls:
  - https://discord.com/developers/docs/reference
  - https://discord.com/developers/docs/resources/channel
  - https://discord.com/developers/docs/resources/guild
  - https://discord.com/developers/docs/topics/permissions
  - https://discord.com/developers/docs/topics/rate-limits
`;


export const DISCORD_SKILL_MD = `# Discord Admin Agent — T2 Team Lead

You are the SIDJUA Discord Admin agent. You lead the community management
team in the Press & Marketing division.

## Role
Tier 2 team lead. You manage the SIDJUA Discord community server and can
request T3 specialist agents for specific tasks (e.g. moderation specialist,
onboarding specialist, analytics specialist) as the community grows.

## Responsibilities
1. Dev-Log Updates: post formatted commit updates to #dev-log
2. Announcements: post releases and important news to #announcements
3. Community: monitor #support, moderate content
4. Maintenance: keep channel topics current
5. Team Growth: identify when specialist agents are needed, propose creation

## Knowledge Sources
Always consult the official Discord documentation for current API behavior:
- API Reference: https://discord.com/developers/docs/reference
- Channels & Messages: https://discord.com/developers/docs/resources/channel
- Guilds & Members: https://discord.com/developers/docs/resources/guild
- Permissions: https://discord.com/developers/docs/topics/permissions
- Rate Limits: https://discord.com/developers/docs/topics/rate-limits

These URLs are your authoritative source. When unsure about API behavior,
fetch the relevant documentation page before acting.

## Tools Available

- \`discord_send_message\` — Send a message (text or embed) to any channel
- \`discord_read_messages\` — Read recent messages from a channel
- \`discord_create_thread\` — Create a discussion thread
- \`discord_manage_channel\` — Create, edit, or delete a channel
- \`discord_manage_member\` — Add/remove role, kick, or ban a member
- \`discord_server_status\` — Server stats (members, channels, online count)
- \`discord_post_dev_update\` — Post a structured commit update to #dev-log

## Embed Colors
- #5865F2 — features (Discord blurple)
- #ED4245 — bug fixes (red)
- #57F287 — releases (green)

## Rules
- Professional but friendly tone
- Use Discord embeds for structured info
- NEVER post sensitive info (tokens, internal URLs, credentials)
- NEVER ban/kick without clear policy violation
- Use threads for extended discussions
- Post in English (international community)
`;


export const DISCORD_README_MD = `# SIDJUA Discord Bot Module

Connects SIDJUA agents to your Discord server via the Discord REST API.

## Prerequisites

1. A Discord account and server (guild) where you have Admin permissions
2. A Discord Bot application with a Bot Token

## Setup

### Step 1: Create a Discord Bot

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it "SIDJUA Bot"
3. Go to **Bot** tab → click **Add Bot**
4. Under **Token**, click **Reset Token** → copy the token
5. Under **Privileged Gateway Intents**: enable **Server Members Intent**

### Step 2: Invite the Bot to Your Server

1. Go to **OAuth2** → **URL Generator**
2. Select scopes: \`bot\`
3. Select permissions: \`Send Messages\`, \`Embed Links\`, \`Read Message History\`,
   \`Create Public Threads\`, \`Manage Roles\` (if using role management)
4. Copy the generated URL and open it in your browser
5. Select your server and authorize

### Step 3: Install the Module

\`\`\`bash
sidjua module install discord
\`\`\`

### Step 4: Configure the Bot Token

\`\`\`bash
sidjua discord status   # Shows what needs to be configured
\`\`\`

Set the bot token (stored securely in your workspace):
\`\`\`bash
export DISCORD_BOT_TOKEN=your.bot.token.here
sidjua module install discord  # Re-run to pick up the token
\`\`\`

Or set it manually in \`.system/modules/discord/.env\`:
\`\`\`
DISCORD_BOT_TOKEN=your.bot.token.here
\`\`\`

## Usage

### CLI

\`\`\`bash
# Check bot status and configuration
sidjua discord status

# Post a dev update
sidjua discord post-dev-update --channel dev-updates --type feature \\
  --title "New search feature" \\
  --description "Full-text search is now available across all agent logs."

# Post an announcement
sidjua discord announce --channel general \\
  --message "System maintenance at 2:00 AM UTC"
\`\`\`

### From a SIDJUA Agent

The \`discord-bot\` agent is automatically available after install.
Run a task:

\`\`\`bash
sidjua run "Post a feature update about our new API endpoints to #dev-updates" \\
  --agent discord-bot --wait
\`\`\`

## Channels Configuration

Edit \`.system/modules/discord/config.yaml\`:

\`\`\`yaml
default_guild_id: "1234567890"
default_channel_id: "1234567891"
dev_channel_id: "1234567892"
announce_channel_id: "1234567893"
\`\`\`

Find channel IDs by right-clicking a channel in Discord with Developer Mode enabled
(Settings → Advanced → Developer Mode).

## Gateway Listener (Community Support Bot)

The Gateway listener connects to Discord's WebSocket API and automatically responds
to support messages in configured channels.

### IMPORTANT: Enable Privileged Gateway Intents

The MESSAGE_CONTENT intent is required to read message content. Before using the
Gateway listener, you MUST enable it in the Discord Developer Portal:

1. Go to https://discord.com/developers/applications
2. Select your bot application
3. Go to Bot → Privileged Gateway Intents
4. Enable **MESSAGE CONTENT INTENT**
5. Save Changes

Without this, the bot receives messages but content will be empty.

### Start the Gateway Listener

\`\`\`bash
# Start the listener as a systemd service
sidjua discord listen start

# Check status
sidjua discord listen status

# View logs
sidjua discord listen logs

# Stop
sidjua discord listen stop
\`\`\`

The daemon listens on the \`support\` and \`bug-reports\` channels by default.
Configure alternative channels in \`.system/modules/discord/config.yaml\`.
`;


export const DISCORD_SERVICE_FILE = `[Unit]
Description=SIDJUA Discord Gateway Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<username>
WorkingDirectory=/home/<username>/sidjua
ExecStart=/usr/bin/node dist/modules/discord/gateway-daemon-bin.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sidjua-discord

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/<username>/.sidjua

# Environment
Environment=NODE_ENV=production
Environment=SIDJUA_WORK_DIR=/home/<username>/sidjua

[Install]
WantedBy=multi-user.target
`;
