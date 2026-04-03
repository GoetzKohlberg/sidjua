// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua discord` Commands
 *
 * Subcommands:
 *   sidjua discord status                  — Check bot status + connectivity
 *   sidjua discord post-dev-update         — Post a commit-centric dev-log embed
 *   sidjua discord announce                — Post an announcement
 *
 * Requires the Discord module to be installed:
 *   sidjua module install discord
 */

import { resolve, join }        from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Command }         from "commander";
import {
  getModuleStatus,
  loadModuleSecrets,
  loadModuleConfig,
}                               from "../../modules/module-loader.js";
import { DiscordClient }        from "../../modules/discord/discord-client.js";
import { formatDevUpdateEmbed } from "../../modules/discord/discord-tools.js";
import type { DiscordModuleConfig } from "../../modules/discord/discord-types.js";
import { DISCORD_SERVICE_FILE } from "../../modules/discord/templates.js";
import { readPidFile }          from "../../modules/discord/gateway-daemon.js";
import { isProcessAlive }       from "../utils/process.js";
import { createLogger }         from "../../core/logger.js";

const logger    = createLogger("discord");
const MODULE_ID = "discord";


export function registerDiscordCommands(program: Command): void {
  const discordCmd = program
    .command("discord")
    .description("Interact with the Discord bot module");

  discordCmd
    .command("status")
    .description("Check Discord bot installation and connectivity")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (opts: { workDir: string }) => {
      const exitCode = await runDiscordStatus({ workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });

  discordCmd
    .command("post-dev-update")
    .description("Post a commit-centric dev update to the configured dev-log channel")
    .requiredOption("--commit <hash>",        "Git commit hash")
    .requiredOption("--message <msg>",        "Git commit message (first line)")
    .requiredOption("--tests <n>",            "Number of passing tests", parseInt)
    .requiredOption("--files <n>",            "Number of files changed", parseInt)
    .requiredOption("--summary <text>",       "Human-readable summary")
    .option("--issues <ids>",                 "Comma-separated issue numbers (e.g. 42,43)")
    .option("--work-dir <path>",              "Workspace directory", process.cwd())
    .action(async (opts: {
      commit:   string;
      message:  string;
      tests:    number;
      files:    number;
      summary:  string;
      issues?:  string;
      workDir:  string;
    }) => {
      const postOpts: Parameters<typeof runDiscordPostDevUpdate>[0] = {
        workDir:       resolve(opts.workDir),
        commitHash:    opts.commit,
        commitMessage: opts.message,
        testCount:     opts.tests,
        filesChanged:  opts.files,
        summary:       opts.summary,
      };
      if (opts.issues) {
        postOpts.issueIds = opts.issues
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n));
      }
      const exitCode = await runDiscordPostDevUpdate(postOpts);
      process.exit(exitCode);
    });

  discordCmd
    .command("announce")
    .description("Post an announcement to Discord")
    .requiredOption("--channel <id>",      "Discord channel ID or name")
    .requiredOption("--message <msg>",     "Announcement message")
    .option("--mention-role <roleId>",     "Role ID to mention")
    .option("--work-dir <path>",           "Workspace directory", process.cwd())
    .action(async (opts: {
      channel:      string;
      message:      string;
      mentionRole?: string;
      workDir:      string;
    }) => {
      const announceOpts: Parameters<typeof runDiscordAnnounce>[0] = {
        workDir:   resolve(opts.workDir),
        channelId: opts.channel,
        message:   opts.message,
      };
      if (opts.mentionRole) announceOpts.mentionRole = opts.mentionRole;
      const exitCode = await runDiscordAnnounce(announceOpts);
      process.exit(exitCode);
    });

  // ── listen subcommand ────────────────────────────────────────────────────

  const listenCmd = discordCmd
    .command("listen")
    .description("Manage the Discord Gateway listener daemon");

  listenCmd
    .command("start")
    .description("Install and start the Discord Gateway daemon (systemd service)")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (opts: { workDir: string }) => {
      const exitCode = await runDiscordListenStart({ workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });

  listenCmd
    .command("stop")
    .description("Stop the Discord Gateway daemon")
    .action(async () => {
      const exitCode = await runDiscordListenStop();
      process.exit(exitCode);
    });

  listenCmd
    .command("status")
    .description("Show Discord Gateway daemon status")
    .option("--work-dir <path>", "Workspace directory", process.cwd())
    .action(async (opts: { workDir: string }) => {
      const exitCode = await runDiscordListenStatus({ workDir: resolve(opts.workDir) });
      process.exit(exitCode);
    });

  listenCmd
    .command("logs")
    .description("Tail journalctl logs for sidjua-discord")
    .action(async () => {
      const exitCode = await runDiscordListenLogs();
      process.exit(exitCode);
    });
}


export async function runDiscordStatus(opts: { workDir: string }): Promise<number> {
  try {
    const status = await getModuleStatus(opts.workDir, MODULE_ID);

    if (!status.installed) {
      process.stdout.write("Discord module is not installed.\n");
      process.stdout.write("Install with: sidjua module install discord\n");
      return 1;
    }

    process.stdout.write("Discord Bot Module\n");
    process.stdout.write("──────────────────────────────────────────\n");
    process.stdout.write(`  Installed:    yes\n`);
    process.stdout.write(`  Path:         ${status.installPath ?? "unknown"}\n`);
    process.stdout.write(`  Secrets set:  ${status.secretsSet ? "yes" : "no"}\n`);

    if (!status.secretsSet) {
      process.stdout.write(`\n  Missing secrets:\n`);
      for (const key of status.missingSecrets) {
        process.stdout.write(`    ${key}\n`);
      }
      process.stdout.write(`\n  Add to: ${status.installPath}/.env\n`);
      return 1;
    }

    // Try to connect to Discord API
    const config = await resolveConfig(opts.workDir);
    if (!config) {
      process.stdout.write("  Token not found in config.\n");
      return 1;
    }

    const client = new DiscordClient(config.bot_token);
    process.stdout.write("  Connecting to Discord API ...\n");

    const user = await client.getCurrentUser();
    process.stdout.write(`  Bot user:     ${user.username}#${user.discriminator}\n`);
    process.stdout.write(`  Bot ID:       ${user.id}\n`);
    process.stdout.write(`  Status:       online\n`);

    if (config.guild_id) {
      const guild = await client.getGuild(config.guild_id, true);
      process.stdout.write(`  Server:       ${guild.name} (${guild.id})\n`);
      if (guild.approximate_member_count !== undefined) {
        process.stdout.write(`  Members:      ${guild.approximate_member_count}\n`);
      }
    }

    if (config.dev_log_channel) {
      process.stdout.write(`  Dev-log:      #${config.dev_log_channel}\n`);
    }

    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    return 1;
  }
}


export async function runDiscordPostDevUpdate(opts: {
  workDir:       string;
  commitHash:    string;
  commitMessage: string;
  testCount:     number;
  filesChanged:  number;
  summary:       string;
  issueIds?:     number[];
}): Promise<number> {
  const config = await requireConfig(opts.workDir);
  if (!config) return 1;

  const client = new DiscordClient(config.bot_token);
  const devInput: Parameters<typeof formatDevUpdateEmbed>[0] = {
    commit_hash:    opts.commitHash,
    commit_message: opts.commitMessage,
    test_count:     opts.testCount,
    files_changed:  opts.filesChanged,
    summary:        opts.summary,
  };
  if (opts.issueIds) devInput.issue_ids = opts.issueIds;

  const embed = formatDevUpdateEmbed(devInput);

  // Resolve dev-log channel by name from guild config
  const devLogChannel = config.dev_log_channel ?? "dev-log";
  let channelId: string | undefined;

  if (config.guild_id) {
    channelId = await client.resolveChannelId(config.guild_id, devLogChannel);
  }
  if (!channelId) channelId = config.default_channel_id;
  if (!channelId) {
    process.stderr.write(`Could not resolve channel "${devLogChannel}" — set guild_id in module config\n`);
    return 1;
  }

  const msg = await client.sendMessage(channelId, {
    embeds: [embed as Parameters<DiscordClient["sendMessage"]>[1]["embeds"] extends (infer E)[] | undefined ? E : never],
  });

  process.stdout.write(`✓ Dev update posted — message ID: ${msg.id}\n`);
  return 0;
}


export async function runDiscordAnnounce(opts: {
  workDir:      string;
  channelId:    string;
  message:      string;
  mentionRole?: string;
}): Promise<number> {
  const config = await requireConfig(opts.workDir);
  if (!config) return 1;

  const client  = new DiscordClient(config.bot_token);
  const content = opts.mentionRole
    ? `<@&${opts.mentionRole}> ${opts.message}`
    : opts.message;

  const msg = await client.sendMessage(opts.channelId, { content });
  process.stdout.write(`✓ Announcement posted — message ID: ${msg.id}\n`);
  return 0;
}


export async function runDiscordListenStart(opts: { workDir: string }): Promise<number> {
  // 1. Validate module is installed + configured
  const config = await requireConfig(opts.workDir);
  if (!config) return 1;

  const status = await getModuleStatus(opts.workDir, MODULE_ID);
  const installPath = status.installPath;
  if (!installPath) {
    process.stderr.write("Discord module install path not found.\n");
    return 1;
  }

  // 2. Write service file
  const serviceFile = "/etc/systemd/system/sidjua-discord.service";
  const tmpService  = join(installPath, "sidjua-discord.service");
  writeFileSync(tmpService, DISCORD_SERVICE_FILE, "utf8");

  process.stdout.write(`Service file written to: ${tmpService}\n`);
  process.stdout.write(`\nTo install the systemd service, run:\n`);
  process.stdout.write(`  sudo cp ${tmpService} ${serviceFile}\n`);
  process.stdout.write(`  sudo systemctl daemon-reload\n`);
  process.stdout.write(`  sudo systemctl enable sidjua-discord\n`);
  process.stdout.write(`  sudo systemctl start sidjua-discord\n`);
  process.stdout.write(`\nOr run this helper (requires sudo):\n`);
  process.stdout.write(`  sudo bash -c 'cp ${tmpService} ${serviceFile} && systemctl daemon-reload && systemctl enable sidjua-discord && systemctl start sidjua-discord'\n`);
  process.stdout.write(`\nIMPORTANT: MESSAGE_CONTENT intent must be enabled in Discord Developer Portal.\n`);
  process.stdout.write(`  https://discord.com/developers/applications → Bot → Privileged Gateway Intents\n`);

  return 0;
}


export async function runDiscordListenStop(): Promise<number> {
  process.stdout.write("To stop the Discord Gateway daemon, run:\n");
  process.stdout.write("  sudo systemctl stop sidjua-discord\n");
  return 0;
}


export async function runDiscordListenStatus(opts: { workDir: string }): Promise<number> {
  const status = await getModuleStatus(opts.workDir, MODULE_ID);
  if (!status.installed || !status.installPath) {
    process.stdout.write("Discord module is not installed.\n");
    return 1;
  }

  const pidFile = join(status.installPath, "gateway.pid");
  const pidInfo = readPidFile(pidFile);

  process.stdout.write("Discord Gateway Daemon\n");
  process.stdout.write("─────────────────────────────────────────\n");

  if (pidInfo === null) {
    process.stdout.write("  Status:  stopped (no PID file)\n");
    process.stdout.write("  Start:   sidjua discord listen start\n");
    return 1;
  }

  // Check if process is running
  const running = isProcessAlive(pidInfo.pid);

  const uptimeMs = Date.now() - pidInfo.startMs;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const uptimeStr = uptimeSec < 60
    ? `${uptimeSec}s`
    : uptimeSec < 3600
    ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
    : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  process.stdout.write(`  Status:  ${running ? "running" : "stopped (stale PID)"}\n`);
  process.stdout.write(`  PID:     ${pidInfo.pid}\n`);
  process.stdout.write(`  Uptime:  ${uptimeStr}\n`);

  return running ? 0 : 1;
}


export async function runDiscordListenLogs(): Promise<number> {
  process.stdout.write("To view Discord Gateway daemon logs, run:\n");
  process.stdout.write("  journalctl -u sidjua-discord -f\n");
  process.stdout.write("\nOr for recent logs:\n");
  process.stdout.write("  journalctl -u sidjua-discord -n 50\n");
  return 0;
}


async function resolveConfig(workDir: string): Promise<DiscordModuleConfig | null> {
  try {
    const status = await getModuleStatus(workDir, MODULE_ID);
    if (!status.installed || !status.installPath) return null;

    const secrets = await loadModuleSecrets(status.installPath);
    const conf    = await loadModuleConfig(status.installPath);

    const token = secrets["DISCORD_BOT_TOKEN"];
    if (!token) return null;

    const discordConfig: DiscordModuleConfig = { bot_token: token };
    if (conf["guild_id"])              discordConfig.guild_id              = conf["guild_id"];
    if (conf["dev_log_channel"])       discordConfig.dev_log_channel       = conf["dev_log_channel"];
    if (conf["announcements_channel"]) discordConfig.announcements_channel = conf["announcements_channel"];
    if (conf["default_channel_id"])    discordConfig.default_channel_id    = conf["default_channel_id"];
    return discordConfig;
  } catch (err: unknown) {
    logger.warn("resolve_config", "Discord config load failed unexpectedly", { metadata: { error: String(err) } });
    return null;
  }
}

async function requireConfig(workDir: string): Promise<DiscordModuleConfig | null> {
  const status = await getModuleStatus(workDir, MODULE_ID);

  if (!status.installed) {
    process.stderr.write("Discord module is not installed. Run: sidjua module install discord\n");
    return null;
  }

  if (!status.secretsSet) {
    process.stderr.write(
      `Discord bot token not set. Missing: ${status.missingSecrets.join(", ")}\n` +
      `Add to: ${status.installPath}/.env\n`,
    );
    return null;
  }

  const config = await resolveConfig(workDir);
  if (!config) {
    process.stderr.write("Failed to load Discord configuration.\n");
    return null;
  }

  return config;
}
