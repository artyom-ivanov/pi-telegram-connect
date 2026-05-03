import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { ConfigStore } from "./config/ConfigStore.js";
import { TelegramBot, type PiBridge, type UserMessageContent } from "./bot/TelegramBot.js";
import { StickerCache } from "./bot/StickerCache.js";
import { buildCliCommands, type CommandCtx } from "./commands/cli.js";
import { assertInsideRoot, expandHome } from "./util/paths.js";

/**
 * Loose subset of @mariozechner/pi-coding-agent's ExtensionAPI that we use.
 * This avoids a hard import dependency at type-check time on the extension's exact shape.
 * The real type is `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"`.
 */
export interface ExtensionAPILoose {
  // pi event handlers may optionally return a result object that pi merges in
  // (e.g., before_agent_start may return { systemPrompt }). Our loose typing
  // accepts any return value; pi ignores ones it doesn't recognize.
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
  /** Register an LLM-callable tool. Loose typing — pi's TooDefinition has many optional fields. */
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
    // pi-CLI loggers vary; the safest place is process.stderr so it shows in pi's debug output.
    process.stderr.write(`[telegram-connect] ${msg}\n`);
  };

  // Build the pi-bridge that TelegramBot consumes. Every callback registration
  // returns an unsubscribe function. pi.on doesn't return one, so we keep sets
  // of "active" callbacks; on stop we just empty the sets.
  type Cb<T extends any[]> = (...a: T) => void;
  const deltaCbs = new Set<Cb<[string]>>();
  const toolStartCbs = new Set<Cb<[string, string]>>();
  const toolEndCbs = new Set<Cb<[string]>>();
  const turnEndCbs = new Set<Cb<[]>>();
  const agentStartCbs = new Set<Cb<[() => void]>>();
  const agentErrorCbs = new Set<Cb<[string]>>();

  pi.on("message_update", (e: any) => {
    // Real event shape (from @mariozechner/pi-coding-agent extensions/types.d.ts):
    //   { type: "message_update", message, assistantMessageEvent }
    // assistantMessageEvent is a discriminated union from @mariozechner/pi-ai;
    // text streaming uses { type: "text_delta", delta: string, ... }.
    // Errors during streaming arrive as { type: "error", reason, error: AssistantMessage }.
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
    // Real shape: { type, toolCallId, toolName, args }
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
    // Real shape: { type, toolCallId, toolName, result, isError }
    const name = String(e?.toolName ?? "tool");
    for (const cb of toolEndCbs) cb(name);
  });
  // Note: do NOT fire turnEndCbs on `turn_end`. In pi's model, one user message
  // produces one agent_start..agent_end span containing MULTIPLE turn_start..turn_end
  // pairs (one per assistant message + tool calls round). Treating the first turn_end
  // as end-of-everything was a bug — the agent's later tool calls (e.g., telegram_attach
  // after a bash tool) would arrive after we'd already torn down activeTurn.
  // agent_end is the canonical end-of-processing signal.
  pi.on("agent_end", (e: any) => {
    // Inspect the last assistant message; if it ended with stopReason "error",
    // surface it so the active streamer can display _⚠️ error: <msg>_.
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
  // Capture the abort thunk so /stop can really cancel the agent loop in pi.
  pi.on("agent_start", (_event: any, ctx: any) => {
    if (typeof ctx?.abort === "function") {
      const abort = (): void => {
        try {
          ctx.abort();
        } catch {
          // ignore — pi may be in a state where abort is a no-op
        }
      };
      for (const cb of agentStartCbs) cb(abort);
    }
  });

  // Inject system-prompt suffix so the agent knows about the Telegram bridge
  // and our tool. Without this, the agent only sees the tool name/description
  // in its tool list — it doesn't understand the `[telegram chat=...]` message
  // convention or that mentioning a path in plain text won't deliver the file.
  const TELEGRAM_PREFIX = "[telegram";
  const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "${TELEGRAM_PREFIX} chat=<id> from=<user_id>]" on their first line.
- Telegram messages may include local temp file paths under ~/.pi/agent/tmp/telegram/ for attached photos, audio files, voice messages, videos, and documents. Read those files when relevant.
- "voice message (recorded by user)" and "audio file" are DIFFERENT in Telegram: voice = a microphone recording (Ogg/Opus, often informal), audio = an uploaded music/audio file. The user explicitly chose one or the other; treat them differently when responding.
- To deliver a file to Telegram: call \`telegram_attach\` with the absolute local path. Auto-classified by extension: .jpg/.png/.webp/.gif → photo, .mp4/.mov → video, .ogg → voice message, .mp3/.m4a/.flac/.wav → audio file, anything else → document. Save artifacts to the current working directory or ~/.pi/agent/tmp/ before attaching (those are the allowed roots).
- DO NOT assume mentioning a local file path in plain text will send it. Only \`telegram_attach\` actually delivers files.
- Static stickers (.webp) sent by users arrive as image content you can see directly the FIRST time. Subsequent times the same sticker arrives, the image is omitted (you've already seen it) and only a stable \`sticker_id=<id>\` is shown — recall what it looked like from earlier in the conversation.
- Video stickers and animated (Lottie) stickers arrive as emoji-only hints (you don't see the actual content).
- To send a sticker the user previously sent (echo a sticker), call \`telegram_send_sticker\` with the \`sticker_id\` you saw in the prompt. This re-sends the same sticker without re-uploading.`;

  // (before_agent_start handler is registered below — it depends on `bot` being constructed.)

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

  // Outbound sandbox roots: tmpDir (where Telegram inbound files land — agent may
  // forward them) and the current working directory of the pi-CLI process (where
  // the agent typically generates artifacts).
  const outboundRoots: string[] = [resolve(expandHome(tmpDir)), resolve(process.cwd())];

  // Register the file-attach tool. Mirrors pi-telegram's pattern: the agent calls
  // telegram_attach with paths to queue them for the current Telegram reply; the
  // bot sends them after the assistant's text turn finalizes.
  pi.registerTool({
    name: "telegram_attach",
    label: "Telegram Attach",
    description:
      "Queue one or more local files to be sent with the current Telegram reply. " +
      "Files are auto-classified by extension: .jpg/.png/.webp/.gif → photo, " +
      ".mp4/.mov → video, .ogg → voice, .mp3/.m4a/.flac/.wav → audio, anything else → document. " +
      "Use this when the user asked for a file or you generated an artifact (image, audio, video, document) " +
      "instead of just mentioning the path in text.",
    promptSnippet: "Queue files to be sent with the current Telegram reply.",
    promptGuidelines: [
      "When handling a [telegram] message and the user asked for or you produced a file/image/audio/video, call telegram_attach with the absolute local path.",
      "Send files explicitly via this tool — mentioning a path in plain text does NOT deliver the file to Telegram.",
      "Allowed roots are the pi working directory and ~/.pi/agent/tmp/. Save artifacts there before attaching.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Absolute local file path" }), {
        minItems: 1,
        maxItems: 10,
      }),
    }),
    async execute(_toolCallId: string, params: { paths: string[] }) {
      if (!bot.isInTurn()) {
        // Not in a Telegram-originated turn (e.g., user is typing directly in pi-CLI).
        // Return a soft tool-result instead of throwing — the agent sees the message
        // and adapts; the user doesn't see a scary error popup.
        return {
          content: [
            {
              type: "text" as const,
              text: "telegram_attach is only available while replying to a Telegram message. The current turn is not from Telegram, so no file was queued. Continue normally.",
            },
          ],
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
              // try next root
            }
          }
          if (!inSandbox) {
            errors.push(`${inputPath}: outside allowed roots (${outboundRoots.join(", ")})`);
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
      if (added.length > 0) lines.push(`Queued ${added.length} attachment(s) for delivery.`);
      if (errors.length > 0) lines.push(`Failed: ${errors.join("; ")}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { added, errors },
      };
    },
  });

  // Register the sticker echo tool. Stickers the user has previously sent are cached
  // by their `sticker_id` (= file_unique_id). The agent recalls a sticker_id from the
  // prompt and asks us to send the cached sticker back via Bot API's sendSticker.
  pi.registerTool({
    name: "telegram_send_sticker",
    label: "Telegram Send Sticker",
    description:
      "Send a sticker to the current Telegram chat. The sticker must have been previously " +
      "sent by the user (so it lives in our cache). Look for `sticker_id=<id>` markers in " +
      "the conversation history — those are the values you pass here.",
    promptSnippet: "Echo a previously-seen sticker back to Telegram.",
    promptGuidelines: [
      "Pass the `sticker_id` shown in earlier `[user sent sticker (...)]` markers, NOT the emoji.",
      "Only stickers from the cache work — you can't make up new sticker_ids.",
      "Sticker is queued and sent after your text reply (same flow as telegram_attach).",
    ],
    parameters: Type.Object({
      stickerId: Type.String({
        description: "The sticker_id from a prior [user sent sticker ... sticker_id=<id> ...] marker.",
      }),
    }),
    async execute(_toolCallId: string, params: { stickerId: string }) {
      if (!bot.isInTurn()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "telegram_send_sticker is only available while replying to a Telegram message.",
            },
          ],
          details: { ok: false, reason: "not-in-telegram-turn" },
        };
      }
      const cached = await stickerCache.get(params.stickerId);
      if (!cached) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No sticker cached with sticker_id="${params.stickerId}". The user must have sent that sticker earlier for it to be available.`,
            },
          ],
          details: { ok: false, reason: "not-in-cache" },
        };
      }
      bot.queueSticker(cached.fileId);
      return {
        content: [
          {
            type: "text" as const,
            text: `Queued sticker (emoji: ${cached.emoji ?? "?"}) for delivery.`,
          },
        ],
        details: { ok: true, fileId: cached.fileId, emoji: cached.emoji },
      };
    },
  });

  cliLog("Extension loaded. Use /telegram-connect to start.");

  return { name: "pi-telegram-connect", version: "0.1.0" };
}

// Public re-exports (if anyone imports the package as a library)
export { ConfigStore } from "./config/ConfigStore.js";
export { TelegramBot } from "./bot/TelegramBot.js";
export type { Config } from "./config/schema.js";
export type { CliRegistration, CommandCtx } from "./commands/cli.js";
export type { PiBridge } from "./bot/TelegramBot.js";
