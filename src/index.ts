import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { ConfigStore } from "./config/ConfigStore.js";
import { TelegramBot, type PiBridge, type UserMessageContent } from "./bot/TelegramBot.js";
import { StickerCache } from "./bot/StickerCache.js";
import { buildCliCommands, type CommandCtx } from "./commands/cli.js";
import { assertInsideRoot, expandHome } from "./util/paths.js";
import {
  SYSTEM_PROMPT_SUFFIX,
  TELEGRAM_PREFIX,
  toolResults,
  tools as toolPrompts,
  userMessages,
} from "./config/prompts.js";

/**
 * Loose subset of @mariozechner/pi-coding-agent's ExtensionAPI that we use.
 * This avoids a hard import dependency at type-check time on the extension's exact shape.
 * The real type is `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"`.
 */
export interface ExtensionAPILoose {
  on(event: string, handler: (e: any, ctx?: any) => any | Promise<any>): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: CommandCtx) => Promise<void>;
    },
  ): void;
  /**
   * Real signature: `content: string | (TextContent | ImageContent)[]`. We keep it loose
   * here to avoid a hard pi-ai type import; UserMessageContent matches structurally.
   */
  sendUserMessage(
    content: string | UserMessageContent[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: any;
    execute: (
      toolCallId: string,
      params: any,
      signal?: AbortSignal,
      onUpdate?: any,
      ctx?: any,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
  }): void;
}

export default function piTelegramConnect(pi: ExtensionAPILoose): { name: string; version: string } {
  const home = homedir();
  const configPath = join(home, ".pi", "agent", "telegram-connect.json");
  const stickerCachePath = join(home, ".pi", "agent", "telegram-connect-stickers.json");
  const tmpDir = join(home, ".pi", "agent", "tmp", "telegram");

  const configStore = new ConfigStore(configPath);
  const stickerCache = new StickerCache(stickerCachePath);

  const cliLog = (msg: string) => {
    process.stderr.write(`[telegram-connect] ${msg}\n`);
  };

  type Cb<T extends any[]> = (...a: T) => void;
  const deltaCbs = new Set<Cb<[string]>>();
  const toolStartCbs = new Set<Cb<[string, string]>>();
  const toolEndCbs = new Set<Cb<[string, boolean]>>();
  const turnEndCbs = new Set<Cb<[]>>();
  const agentStartCbs = new Set<Cb<[() => void]>>();
  const agentErrorCbs = new Set<Cb<[string]>>();

  pi.on("message_update", (e: any) => {
    const ev = e?.assistantMessageEvent;
    if (ev?.type === "text_delta" && typeof ev.delta === "string" && ev.delta.length > 0) {
      for (const cb of deltaCbs) cb(ev.delta);
    } else if (ev?.type === "error") {
      const errMsg =
        typeof ev?.error?.errorMessage === "string"
          ? ev.error.errorMessage
          : `agent stream error (reason=${String(ev?.reason ?? "unknown")})`;
      for (const cb of agentErrorCbs) cb(errMsg);
    }
  });
  pi.on("tool_execution_start", (e: any) => {
    const name = String(e?.toolName ?? "tool");
    let argsSummary = "";
    try {
      argsSummary = JSON.stringify(e?.args ?? {}).slice(0, 80);
    } catch {
      argsSummary = "";
    }
    for (const cb of toolStartCbs) cb(name, argsSummary);
  });
  pi.on("tool_execution_end", (e: any) => {
    const name = String(e?.toolName ?? "tool");
    const ok = e?.isError !== true;
    for (const cb of toolEndCbs) cb(name, ok);
  });
  // Note: do NOT fire turnEndCbs on `turn_end`. In pi's model, one user message
  // produces one agent_start..agent_end span containing MULTIPLE turn_start..turn_end
  // pairs (one per assistant message + tool calls round). Treating the first turn_end
  // as end-of-everything was a bug — the agent's later tool calls (e.g., telegram_attach
  // after a bash tool) would arrive after we'd already torn down activeTurn.
  // agent_end is the canonical end-of-processing signal.
  pi.on("agent_end", (e: any) => {
    const messages = Array.isArray(e?.messages) ? e.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "assistant") {
        if (m.stopReason === "error") {
          const errMsg =
            typeof m.errorMessage === "string" && m.errorMessage.length > 0
              ? m.errorMessage
              : "agent failed";
          for (const cb of agentErrorCbs) cb(errMsg);
        }
        break;
      }
    }
    for (const cb of turnEndCbs) cb();
  });
  pi.on("agent_start", (_event: any, ctx: any) => {
    if (typeof ctx?.abort === "function") {
      const abort = (): void => {
        try {
          ctx.abort();
        } catch {
          void 0;
        }
      };
      for (const cb of agentStartCbs) cb(abort);
    }
  });

  const bridge: PiBridge = {
    sendUserMessage: (content) => pi.sendUserMessage(content),
    onMessageDelta: (cb) => {
      deltaCbs.add(cb);
      return () => deltaCbs.delete(cb);
    },
    onToolStart: (cb) => {
      toolStartCbs.add(cb);
      return () => toolStartCbs.delete(cb);
    },
    onToolEnd: (cb) => {
      toolEndCbs.add(cb);
      return () => toolEndCbs.delete(cb);
    },
    onTurnEnd: (cb) => {
      turnEndCbs.add(cb);
      return () => turnEndCbs.delete(cb);
    },
    onAgentStart: (cb) => {
      agentStartCbs.add(cb);
      return () => agentStartCbs.delete(cb);
    },
    onAgentError: (cb) => {
      agentErrorCbs.add(cb);
      return () => agentErrorCbs.delete(cb);
    },
  };

  const bot = new TelegramBot({
    configStore,
    stickerCache,
    tmpDir,
    cliLog,
    pi: bridge,
  });

  // Inject Telegram bridge instructions ONLY when this turn was initiated by a
  // Telegram message. For prompts typed directly into pi-CLI, the agent should
  // not be told about telegram_attach — otherwise it calls the tool spuriously.
  pi.on("before_agent_start", (event: any) => {
    if (!bot.isInTurn()) return undefined;
    const prompt = String(event?.prompt ?? "");
    const isTelegram = prompt.trimStart().startsWith(TELEGRAM_PREFIX);
    const suffix = isTelegram
      ? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
      : SYSTEM_PROMPT_SUFFIX;
    return { systemPrompt: String(event?.systemPrompt ?? "") + suffix };
  });

  const cmds = buildCliCommands({ configStore, bot, stickerCache });
  for (const c of cmds) {
    pi.registerCommand(c.name, { description: c.description, handler: c.handler });
  }

  const outboundRoots: string[] = [resolve(expandHome(tmpDir)), resolve(process.cwd())];

  pi.registerTool({
    name: "telegram_attach",
    label: "Telegram Attach",
    description: toolPrompts.attach.description,
    promptSnippet: toolPrompts.attach.promptSnippet,
    promptGuidelines: toolPrompts.attach.promptGuidelines,
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Absolute local file path" }), {
        minItems: 1,
        maxItems: 10,
      }),
    }),
    async execute(_toolCallId: string, params: { paths: string[] }) {
      if (!bot.isInTurn()) {
        return {
          content: [{ type: "text" as const, text: toolResults.attachNotInTurn }],
          details: { added: [], errors: ["not in telegram turn"] },
        };
      }
      const added: string[] = [];
      const errors: string[] = [];
      for (const inputPath of params.paths) {
        let abs: string;
        try {
          abs = resolve(expandHome(inputPath));
          let inSandbox = false;
          for (const root of outboundRoots) {
            try {
              await assertInsideRoot(abs, root, true);
              inSandbox = true;
              break;
            } catch {
              void 0;
            }
          }
          if (!inSandbox) {
            // Don't echo the actual outboundRoots paths back to the agent — those leak
            // the user's home/cwd into the agent transcript (and from there potentially
            // back to the chat via prompt-injection). The agent is told the rule in the
            // tool description; a generic refusal is enough.
            errors.push(`${inputPath}: outside allowed roots`);
            continue;
          }
          const st = await stat(abs);
          if (!st.isFile()) {
            errors.push(`${inputPath}: not a regular file`);
            continue;
          }
          bot.queueAttachment(abs);
          added.push(abs);
        } catch (e) {
          errors.push(`${inputPath}: ${(e as Error).message}`);
        }
      }
      const lines: string[] = [];
      if (added.length > 0) lines.push(toolResults.attachQueued(added.length));
      if (errors.length > 0) lines.push(toolResults.attachFailures(errors));
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { added, errors },
      };
    },
  });

  pi.registerTool({
    name: "telegram_send_sticker",
    label: "Telegram Send Sticker",
    description: toolPrompts.sendSticker.description,
    promptSnippet: toolPrompts.sendSticker.promptSnippet,
    promptGuidelines: toolPrompts.sendSticker.promptGuidelines,
    parameters: Type.Object({
      stickerId: Type.String({
        description: "The sticker_id from a prior [user sent sticker ... sticker_id=<id> ...] marker.",
      }),
    }),
    async execute(_toolCallId: string, params: { stickerId: string }) {
      if (!bot.isInTurn()) {
        return {
          content: [{ type: "text" as const, text: toolResults.stickerNotInTurn }],
          details: { ok: false, reason: "not-in-telegram-turn" },
        };
      }
      const cached = await stickerCache.get(params.stickerId);
      if (!cached) {
        return {
          content: [{ type: "text" as const, text: toolResults.stickerNotInCache(params.stickerId) }],
          details: { ok: false, reason: "not-in-cache" },
        };
      }
      bot.queueSticker(cached.fileId);
      return {
        content: [{ type: "text" as const, text: toolResults.stickerQueued(cached.emoji) }],
        details: { ok: true, fileId: cached.fileId, emoji: cached.emoji },
      };
    },
  });

  pi.registerTool({
    name: "telegram_react",
    label: "Telegram React",
    description: toolPrompts.react.description,
    promptSnippet: toolPrompts.react.promptSnippet,
    promptGuidelines: toolPrompts.react.promptGuidelines,
    parameters: Type.Object({
      emoji: Type.String({
        description:
          "The emoji to react with (e.g., '👀', '👍', '❤️'). Pass empty string '' to clear any existing reaction.",
      }),
      messageId: Type.Optional(
        Type.Number({
          description:
            "Optional — defaults to the user's incoming message in the current turn. Pass a different message_id to react to an earlier message.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: { emoji: string; messageId?: number }) {
      if (!bot.isInTurn()) {
        return {
          content: [{ type: "text" as const, text: toolResults.reactNotInTurn }],
          details: { ok: false, reason: "not-in-telegram-turn" },
        };
      }
      try {
        await bot.setReaction(params.emoji, params.messageId);
        return {
          content: [
            {
              type: "text" as const,
              text: params.emoji ? toolResults.reactedWith(params.emoji) : toolResults.reactionCleared,
            },
          ],
          details: { ok: true, emoji: params.emoji },
        };
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        return {
          content: [{ type: "text" as const, text: toolResults.reactionFailed(msg) }],
          details: { ok: false, error: msg },
        };
      }
    },
  });

  cliLog(userMessages.extensionLoaded);

  return { name: "pi-telegram-connect", version: "0.1.0" };
}

export { ConfigStore } from "./config/ConfigStore.js";
export { TelegramBot } from "./bot/TelegramBot.js";
export type { Config } from "./config/schema.js";
export type { CliRegistration, CommandCtx } from "./commands/cli.js";
export type { PiBridge } from "./bot/TelegramBot.js";
