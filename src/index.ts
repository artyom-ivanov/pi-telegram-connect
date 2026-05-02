import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { ConfigStore } from "./config/ConfigStore.js";
import { TelegramBot, type PiBridge, type UserMessageContent } from "./bot/TelegramBot.js";
import { StickerCache } from "./bot/StickerCache.js";
import { GroupAccess } from "./bot/GroupAccess.js";
import { buildCliCommands, type CommandCtx } from "./commands/cli.js";
import { assertInsideRoot, expandHome } from "./util/paths.js";

/**
 * Loose subset of @mariozechner/pi-coding-agent's ExtensionAPI that we use.
 * This avoids a hard import dependency at type-check time on the extension's exact shape.
 * The real type is `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"`.
 */
export interface ExtensionAPILoose {
  on(event: string, handler: (e: any) => any): void;
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
  const stickerPath = join(home, ".pi", "agent", "telegram-connect-stickers.json");
  const tmpDir = join(home, ".pi", "agent", "tmp", "telegram");

  const configStore = new ConfigStore(configPath);

  // Vision is disabled in V1 (extension API doesn't expose ModelRegistry/auth in a clean way).
  // Sticker descriptions degrade to emoji-only.
  const stickerCache = new StickerCache({
    cachePath: stickerPath,
    maxEntries: 5000,
    ttlMs: 90 * 24 * 60 * 60 * 1000,
    maxVisionCallsPerDay: 0,
    visionFn: async () => null,
  });

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

  pi.on("message_update", (e: any) => {
    // Real event shape (from @mariozechner/pi-coding-agent extensions/types.d.ts):
    //   { type: "message_update", message, assistantMessageEvent }
    // assistantMessageEvent is a discriminated union from @mariozechner/pi-ai;
    // text streaming uses { type: "text_delta", delta: string, ... }.
    const ev = e?.assistantMessageEvent;
    if (ev?.type === "text_delta" && typeof ev.delta === "string" && ev.delta.length > 0) {
      for (const cb of deltaCbs) cb(ev.delta);
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
  pi.on("turn_end", () => {
    for (const cb of turnEndCbs) cb();
  });
  pi.on("agent_end", () => {
    // Also surface as turn_end — covers the case where agent_end fires without turn_end.
    for (const cb of turnEndCbs) cb();
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
  };

  const groupAccess = new GroupAccess({ configStore, cliLog });

  const bot = new TelegramBot({
    configStore,
    stickerCache,
    tmpDir,
    cliLog,
    pi: bridge,
    onBotInit: (innerBot) => groupAccess.install(innerBot),
  });

  const cmds = buildCliCommands({ configStore, bot });
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
        throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
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

  cliLog("Extension loaded. Use /telegram-connect to start.");

  return { name: "pi-telegram-connect", version: "0.1.0" };
}

// Public re-exports (if anyone imports the package as a library)
export { ConfigStore } from "./config/ConfigStore.js";
export { TelegramBot } from "./bot/TelegramBot.js";
export { StickerCache } from "./bot/StickerCache.js";
export type { Config } from "./config/schema.js";
export type { CliRegistration, CommandCtx } from "./commands/cli.js";
export type { PiBridge } from "./bot/TelegramBot.js";
