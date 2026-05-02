import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigStore } from "./config/ConfigStore.js";
import { TelegramBot } from "./bot/TelegramBot.js";
import { StickerCache } from "./bot/StickerCache.js";
import { GroupAccess } from "./bot/GroupAccess.js";
import { PiAgentHost, type PiSdkBindings } from "./agent/PiAgentHost.js";
import { buildVisionFn, type VisionSdkBindings } from "./agent/VisionBinding.js";
import { buildCliCommands, type CliRegistration } from "./commands/cli.js";

/**
 * Pi extension factory.
 *
 * The pi-CLI passes us an ExtensionContext with already-initialized AuthStorage,
 * ModelRegistry, plus helpers for SessionManager. We treat ExtensionContext loosely
 * (its exact shape lives in pi-coding-agent's extension/types.ts). Any shape mismatches
 * will show up at integration time — this is the only place in the codebase that touches
 * pi-CLI internals directly.
 */
export interface ExtensionContextLoose {
  authStorage: unknown;
  modelRegistry: unknown;
  sessionManagerForPath: (absPath: string) => unknown;
  createAgentSession: PiSdkBindings["createAgentSession"];
  pickVisionModel: VisionSdkBindings["pickVisionModel"];
  completeSimple: VisionSdkBindings["completeSimple"];
  registerCommand: (cmd: CliRegistration) => void;
  log: (msg: string) => void;
}

export default function piTelegramConnect(
  ctx: ExtensionContextLoose,
): { name: string; version: string } {
  const home = homedir();
  const configPath = join(home, ".pi", "agent", "telegram-connect.json");
  const stickerPath = join(home, ".pi", "agent", "telegram-connect-stickers.json");
  const sessionsDir = join(home, ".pi", "agent", "telegram-sessions");
  const tmpDir = join(home, ".pi", "agent", "tmp", "telegram");

  const configStore = new ConfigStore(configPath);

  const visionFn = buildVisionFn({
    pickVisionModel: ctx.pickVisionModel,
    completeSimple: ctx.completeSimple,
  });

  const stickerCache = new StickerCache({
    cachePath: stickerPath,
    maxEntries: 5000,
    ttlMs: 90 * 24 * 60 * 60 * 1000,
    maxVisionCallsPerDay: 100,
    visionFn,
  });

  const cliLog = (msg: string) => ctx.log(`[telegram-connect] ${msg}`);

  const bindings: PiSdkBindings = {
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    createAgentSession: ctx.createAgentSession,
    sessionManagerForPath: ctx.sessionManagerForPath,
  };

  const agentHost = new PiAgentHost({
    bindings,
    configStore,
    sessionsDir,
    maxLiveSessions: 256,
    sessionIdleHours: 24,
  });

  const bot = new TelegramBot({
    configStore,
    agentHost,
    stickerCache,
    tmpDir,
    outboundAllowedRoots: [tmpDir, join(home, ".pi", "agent", "tmp")],
    cliLog,
  });

  const groupAccess = new GroupAccess({ configStore, cliLog });
  bot.onBotInit = (innerBot) => groupAccess.install(innerBot);

  const cmds = buildCliCommands({ configStore, bot, cliLog });
  for (const c of cmds) ctx.registerCommand(c);

  cliLog("Extension loaded. Use /telegram-connect <token> to start.");

  return { name: "pi-telegram-connect", version: "0.1.0" };
}

export { ConfigStore } from "./config/ConfigStore.js";
export { TelegramBot } from "./bot/TelegramBot.js";
export { PiAgentHost } from "./agent/PiAgentHost.js";
export { StickerCache } from "./bot/StickerCache.js";
export type { Config } from "./config/schema.js";
export type { CliRegistration } from "./commands/cli.js";
export type { PiSdkBindings, PiSdkSession } from "./agent/PiAgentHost.js";
export type { VisionSdkBindings } from "./agent/VisionBinding.js";
export type { AgentHost, AgentSessionRef, ToolDefinitionLike } from "./agent/AgentHost.js";
