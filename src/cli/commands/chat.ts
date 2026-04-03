// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

/**
 * SIDJUA — `sidjua chat` Command
 *
 * Interactive conversation with a SIDJUA agent.
 * Currently supports: sidjua chat guide
 *
 * The Guide agent uses embedded Cloudflare Workers AI — no API key needed.
 */

import { createInterface }         from "node:readline/promises";
import { stdin as input, stdout }  from "node:process";
import { readFile, access }        from "node:fs/promises";
import { join, resolve }           from "node:path";
import { existsSync }              from "node:fs";
import type { Command }            from "commander";
import { GuideChat }               from "../../guide/guide-chat.js";
import type { GuideChatOptions }   from "../../guide/guide-chat.js";
import { handleSlashCommand }      from "../../guide/commands.js";
import { GUIDE_SKILL_MD, CEO_ASSISTANT_SKILL_MD } from "./init.js";
import { createLogger }            from "../../core/logger.js";
import { openDatabase }            from "../../utils/db.js";
import { runMigrations105 }        from "../../agent-lifecycle/migration.js";
import { runSessionMigrations }    from "../../session/migration.js";
import { runCeoAssistantMigrations } from "../../ceo-assistant/migration.js";
import {
  CEO_ASSISTANT_GREETING,
  isFirstRun,
  generateBriefing,
  isDienstschluss,
  generateDienstschlussSummary,
  persistDienstschlussCheckpoint,
  formatDienstschlussOutput,
  AssistantTaskQueue,
  parseTaskIntent,
  formatTaskList,
} from "../../ceo-assistant/index.js";
import type { BriefingMessage } from "../../session/memory-briefing.js";

const logger = createLogger("chat");


/** Minimal interface for a readline-like input provider (injectable for tests). */
export interface ReadlineProvider {
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface ChatCommandOptions {
  workDir:         string;
  agent:           string;
  model?:          string;
  verbose:         boolean;
  /** When true, print welcome intro before chat loop. */
  showIntro?:      boolean;
  /** Injectable readline factory for testing. Defaults to node:readline/promises. */
  readlineFactory?: () => ReadlineProvider;
  /** Override proxy URL for testing. Pass null to disable proxy. */
  proxyUrl?:        string | null;
}


export function registerChatCommands(program: Command): void {
  program
    .command("chat [agent]")
    .description("Start an interactive conversation with an agent (default: ceo-assistant)")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--model <id>",      "Override the agent's LLM model")
    .option("--verbose",         "Show extra debug info", false)
    .action(async (agent: string | undefined, opts: { workDir: string; model?: string; verbose: boolean }) => {
      let workDir = resolve(opts.workDir);

      // Config.json fallback: if DB not found at resolved workDir, try SIDJUA_CONFIG_DIR/config.json
      if (!existsSync(join(workDir, ".system", "sidjua.db"))) {
        const cfgDir = process.env["SIDJUA_CONFIG_DIR"];
        if (cfgDir) {
          try {
            const raw = await readFile(join(cfgDir, "config.json"), "utf-8");
            const cfg = JSON.parse(raw) as { workDir?: string };
            if (typeof cfg.workDir === "string") {
              workDir = resolve(cfg.workDir);
            }
          } catch (e: unknown) { logger.debug("chat", "Config read failed — runChatCommand will handle the error", { metadata: { error: e instanceof Error ? e.message : String(e) } }); }
        }
      }

      const chatOpts: ChatCommandOptions = {
        workDir,
        agent:   agent ?? "ceo-assistant",
        verbose: opts.verbose,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      };
      const exitCode = await runChatCommand(chatOpts);
      process.exit(exitCode);
    });
}


export async function runChatCommand(opts: ChatCommandOptions): Promise<number> {
  const { workDir, agent } = opts;

  // Accepted agents: "guide" (default interactive assistant) and "ceo-assistant"
  const resolvedAgent = agent === "guide" ? "guide" : (agent === "ceo-assistant" ? "ceo-assistant" : agent);

  // Only guide and ceo-assistant are supported
  if (resolvedAgent !== "guide" && resolvedAgent !== "ceo-assistant") {
    process.stderr.write(
      `✗ Direct agent chat for "${agent}" is not supported yet.\n` +
      `Use \`sidjua chat\` (CEO Assistant) or \`sidjua chat guide\`.\n`,
    );
    return 1;
  }

  // Check workspace exists
  const dbPath = join(workDir, ".system", "sidjua.db");
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `✗ Workspace not initialized at ${workDir}\n` +
      `Run \`sidjua init\` first.\n`,
    );
    return 1;
  }

  // Open DB and run migrations for CEO Assistant
  const db = openDatabase(dbPath);
  db.pragma("foreign_keys = ON");
  runMigrations105(db);
  runSessionMigrations(db);
  runCeoAssistantMigrations(db);

  // Load skill file
  const systemPrompt = resolvedAgent === "ceo-assistant"
    ? await loadCeoAssistantSkill(workDir)
    : await loadGuideSkill(workDir);

  // Create chat engine
  const chatEngineOpts: GuideChatOptions = {
    workDir,
    systemPrompt,
    ...(opts.model    !== undefined ? { model:    opts.model    } : {}),
    ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
  };
  const chat = new GuideChat(chatEngineOpts);

  // Show session header
  if (resolvedAgent === "ceo-assistant") {
    printCeoAssistantHeader(chat.connectionMode, opts.verbose);
  } else {
    printChatHeader(chat.connectionMode, opts.verbose);
  }

  // CEO Assistant: greeting (first run) or briefing (subsequent)
  if (resolvedAgent === "ceo-assistant") {
    const firstRun = isFirstRun(db, "ceo-assistant");
    if (opts.showIntro || firstRun) {
      stdout.write(CEO_ASSISTANT_GREETING + "\n\n");
    } else {
      const briefing = generateBriefing(db, "ceo-assistant");
      stdout.write(briefing.text + "\n\n");
    }
  } else if (opts.showIntro) {
    printGuideIntro();
  }

  // Start interactive loop
  const rl = opts.readlineFactory
    ? opts.readlineFactory()
    : createInterface({ input, output: stdout });

  const messages: BriefingMessage[] = [];
  let loopResult: "start-agent-create" | undefined;
  try {
    if (resolvedAgent === "ceo-assistant") {
      loopResult = await runCeoAssistantLoop(chat, rl, workDir, db, messages, opts.verbose);
    } else {
      loopResult = await runChatLoop(chat, rl, workDir, opts.verbose);
    }
  } finally {
    rl.close();
    db.close();
  }

  if (loopResult === "start-agent-create") {
    await launchAgentCreate(workDir);
  }

  return 0;
}


async function runCeoAssistantLoop(
  chat:     GuideChat,
  rl:       ReadlineProvider,
  workDir:  string,
  db:       import("../../utils/db.js").Database,
  messages: BriefingMessage[],
  verbose:  boolean,
): Promise<"start-agent-create" | undefined> {
  const queue = new AssistantTaskQueue(db);

  while (true) {
    let userInput: string;
    try {
      userInput = await rl.question("You: ");
    } catch (e: unknown) {
      void e; // cleanup-ignore: EOF/Ctrl+D
      stdout.write("\nGoodbye!\n");
      break;
    }

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    // Dienstschluss detection
    if (isDienstschluss(trimmed)) {
      messages.push({ role: "user", content: trimmed });
      const summary = generateDienstschlussSummary(messages, db, "ceo-assistant");
      persistDienstschlussCheckpoint(db, "ceo-assistant", "chat-session", summary, messages.length);
      stdout.write(formatDienstschlussOutput(summary));
      break;
    }

    // Task intent detection (handle without LLM call for speed)
    const intent = parseTaskIntent(trimmed);
    if (intent.type !== "unknown") {
      const response = await handleTaskIntent(intent, queue, "ceo-assistant", db);
      if (response !== null) {
        stdout.write("Assistant: " + response + "\n\n");
        messages.push({ role: "user",      content: trimmed  });
        messages.push({ role: "assistant", content: response });
        continue;
      }
    }

    // Slash commands
    const slashResult = await handleSlashCommand(trimmed, workDir);
    if (slashResult !== null) {
      if (slashResult.error)  stdout.write(`\n✗ ${slashResult.error}\n`);
      if (slashResult.output) stdout.write(slashResult.output);
      if (slashResult.exit) {
        if (slashResult.action === "start-agent-create") return "start-agent-create";
        break;
      }
      continue;
    }

    // Send to LLM
    stdout.write("Assistant: ");
    try {
      const turn = await chat.send(trimmed);
      stdout.write(turn.reply + "\n\n");
      messages.push({ role: "user",      content: trimmed     });
      messages.push({ role: "assistant", content: turn.reply  });
      if (verbose && turn.toolsUsed.length > 0) {
        stdout.write(`[Tools: ${turn.toolsUsed.join(", ")}]\n\n`);
      }
    } catch (err) {
      logger.error("chat_error", "Chat turn failed", {
        error: { code: "CHAT-001", message: String(err) },
      });
      stdout.write(`(Error: ${String(err)})\n\n`);
    }
  }
}


async function handleTaskIntent(
  intent:  import("../../ceo-assistant/index.js").ParsedTaskIntent,
  queue:   AssistantTaskQueue,
  agentId: string,
  _db:     import("../../utils/db.js").Database,
): Promise<string | null> {
  switch (intent.type) {
    case "list_tasks": {
      const tasks = queue.listTasks(agentId, { status: "open" });
      if (tasks.length === 0) return "Your task list is empty.";
      return `Your open tasks:\n${formatTaskList(tasks)}`;
    }

    case "overdue_tasks": {
      const tasks = queue.getOverdueTasks(agentId);
      if (tasks.length === 0) return "No overdue tasks.";
      return `Overdue tasks:\n${formatTaskList(tasks)}`;
    }

    case "add_task": {
      if (!intent.title) return null;
      const task = queue.addTask({
        agent_id: agentId,
        title:    intent.title,
        ...(intent.priority !== undefined ? { priority: intent.priority } : {}),
        ...(intent.deadline !== undefined ? { deadline: resolveNaturalDate(intent.deadline) } : {}),
      });
      const dlNote = task.deadline ? ` (due ${task.deadline.slice(0, 10)})` : "";
      return `Got it — added "[${task.id}] ${task.title}"${dlNote} to your task list.`;
    }

    case "complete_task": {
      if (!intent.title) return null;
      const found = queue.findByTitleFuzzy(agentId, intent.title);
      if (found === null) return `I couldn't find an open task matching "${intent.title}".`;
      queue.completeTask(agentId, found.id);
      return `Done — marked "[${found.id}] ${found.title}" as complete.`;
    }

    case "cancel_task": {
      if (!intent.title) return null;
      const found = queue.findByTitleFuzzy(agentId, intent.title);
      if (found === null) return `I couldn't find an open task matching "${intent.title}".`;
      queue.cancelTask(agentId, found.id);
      return `Cancelled "[${found.id}] ${found.title}".`;
    }

    case "update_priority": {
      if (!intent.title || !intent.priority) return null;
      const found = queue.findByTitleFuzzy(agentId, intent.title);
      if (found === null) return `I couldn't find a task matching "${intent.title}".`;
      queue.updateTask(agentId, found.id, { priority: intent.priority });
      return `Updated priority of "[${found.id}] ${found.title}" to ${intent.priority}.`;
    }

    default:
      return null;
  }
}

/** Resolve natural language date fragments to ISO-8601 date strings. */
function resolveNaturalDate(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const today = new Date();

  // Handle simple relative dates
  if (lower === "today") return today.toISOString().slice(0, 10);
  if (lower === "tomorrow") {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const dayIdx = days.indexOf(lower);
  if (dayIdx !== -1) {
    const d = new Date(today);
    const diff = (dayIdx - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  // Return as-is for explicit dates (e.g. "2026-03-25", "March 25")
  return raw;
}


async function runChatLoop(
  chat:    GuideChat,
  rl:      ReadlineProvider,
  workDir: string,
  verbose: boolean,
): Promise<"start-agent-create" | undefined> {
  while (true) {
    let userInput: string;
    try {
      userInput = await rl.question("You: ");
    } catch (e: unknown) { // cleanup-ignore: readline.close() throws on EOF/Ctrl+D — this is the expected terminal signal
      void e; // cleanup-ignore
      // EOF / Ctrl+D
      stdout.write("\nGoodbye!\n");
      break;
    }

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    // Handle slash commands
    const slashResult = await handleSlashCommand(trimmed, workDir);
    if (slashResult !== null) {
      if (slashResult.error) {
        stdout.write(`\n✗ ${slashResult.error}\n`);
      }
      if (slashResult.output) {
        stdout.write(slashResult.output);
      }
      if (slashResult.exit) {
        if (slashResult.action === "start-agent-create") return "start-agent-create";
        break;
      }
      continue;
    }

    // Send to Guide
    stdout.write("Guide: ");

    try {
      const turn = await chat.send(trimmed);

      stdout.write(turn.reply + "\n\n");

      if (verbose && turn.toolsUsed.length > 0) {
        stdout.write(`[Tools used: ${turn.toolsUsed.join(", ")}]\n\n`);
      }

      if (turn.error && verbose) {
        stdout.write(`[Warning: ${turn.error}]\n\n`);
      }
    } catch (err) {
      logger.error("chat_error", "Chat turn failed", {
        error: { code: "CHAT-001", message: String(err) },
      });
      stdout.write(`(Error: ${String(err)})\n\n`);
    }
  }
}


async function loadGuideSkill(workDir: string): Promise<string> {
  const skillPath = join(workDir, "agents", "skills", "guide.md");
  try {
    await access(skillPath);
    return await readFile(skillPath, "utf-8");
  } catch (e: unknown) {
    logger.debug("chat", "Guide skill file not found — using embedded default", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    return GUIDE_SKILL_MD;
  }
}

async function loadCeoAssistantSkill(workDir: string): Promise<string> {
  const skillPath = join(workDir, "agents", "skills", "ceo-assistant.md");
  try {
    await access(skillPath);
    return await readFile(skillPath, "utf-8");
  } catch (e: unknown) {
    logger.debug("chat", "CEO Assistant skill file not found — using embedded default", { metadata: { error: e instanceof Error ? e.message : String(e) } });
    return CEO_ASSISTANT_SKILL_MD;
  }
}


function printCeoAssistantHeader(connectionMode: "direct" | "proxy" | "offline", verbose: boolean): void {
  stdout.write("\n");
  stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  stdout.write("  SIDJUA CEO Assistant — Type /help or /exit\n");

  if (connectionMode === "direct") {
    stdout.write("  ✓ Cloudflare AI connected (free tier)\n");
  } else if (connectionMode === "proxy") {
    stdout.write("  ✓ SIDJUA AI online (free tier, rate limited)\n");
  } else {
    stdout.write("  ⚠ Offline mode — responses may be limited\n");
    if (verbose) {
      stdout.write("  Set SIDJUA_CF_ACCOUNT_ID and SIDJUA_CF_TOKEN to enable.\n");
    }
  }

  stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  stdout.write("\n");
}


function printChatHeader(connectionMode: "direct" | "proxy" | "offline", verbose: boolean): void {
  stdout.write("\n");
  stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  stdout.write("  SIDJUA Guide — Type /help to see commands\n");

  if (connectionMode === "direct") {
    stdout.write("  ✓ Cloudflare AI connected (free tier, no key needed)\n");
  } else if (connectionMode === "proxy") {
    stdout.write("  ✓ SIDJUA Guide online (free tier, rate limited)\n");
  } else {
    stdout.write("  ⚠ Offline mode (no internet connection)\n");
    if (verbose) {
      stdout.write("  Set SIDJUA_CF_ACCOUNT_ID and SIDJUA_CF_TOKEN to enable.\n");
    }
  }

  stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  stdout.write("\n");

  if (connectionMode === "proxy") {
    stdout.write(
      "Tip: The free Guide has a rate limit. Add your own key for\n" +
      "unlimited access: /key groq <your-free-api-key>\n" +
      "Get a free key at https://console.groq.com\n\n",
    );
  }
}


function printGuideIntro(): void {
  stdout.write(`
Hi! I'm your built-in Guide Agent — powered by Llama 4 Scout on Cloudflare
Workers AI. No API key needed, I'm here for free.

What would you like to do?
  /zurinfo   — Quick introduction: what is Sidjua and how does it work?
  /start     — Create your first agent right now

Tip: You can always come back to me with:  sidjua chat guide

`);
}


async function launchAgentCreate(workDir: string): Promise<void> {
  const { withCliDatabaseAsync } = await import("../utils/with-cli-database.js");
  const { runMigrations105 }    = await import("../../agent-lifecycle/migration.js");
  const { AgentTemplateLoader } = await import("../../agent-lifecycle/agent-template.js");
  const { AgentRegistry }       = await import("../../agent-lifecycle/agent-registry.js");
  const { interactiveCreate }   = await import("../../agent-lifecycle/cli-agent.js");

  await withCliDatabaseAsync({ workDir }, async (db) => {
    runMigrations105(db);
    const templateLoader = new AgentTemplateLoader(join(workDir, "agents", "templates"));
    const registry = new AgentRegistry(db);

    try {
      const definition = await interactiveCreate(false, undefined, { workDir }, templateLoader);
      registry.create(definition, "user");
      stdout.write(`\n✓ Agent "${definition.id}" created!\n`);
    } catch (err) {
      stdout.write(`\n(Agent creation cancelled: ${String(err)})\n`);
    }
    return 0;
  });
}
