import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigStore } from "./config/ConfigStore.js";
import { TelegramBot, type PiBridge } from "./bot/TelegramBot.js";
import { StickerCache } from "./bot/StickerCache.js";
import { GroupAccess } from "./bot/GroupAccess.js";
import { buildCliCommands, type CommandCtx } from "./commands/cli.js";

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
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
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
    sendUserMessage: (text) => pi.sendUserMessage(text),
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

  cliLog("Extension loaded. Use /telegram-connect <token> to start.");

  return { name: "pi-telegram-connect", version: "0.1.0" };
}

// Public re-exports (if anyone imports the package as a library)
export { ConfigStore } from "./config/ConfigStore.js";
export { TelegramBot } from "./bot/TelegramBot.js";
export { StickerCache } from "./bot/StickerCache.js";
export type { Config } from "./config/schema.js";
export type { CliRegistration, CommandCtx } from "./commands/cli.js";
export type { PiBridge } from "./bot/TelegramBot.js";
