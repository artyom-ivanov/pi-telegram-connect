import type { ConfigStore } from "../config/ConfigStore.js";
import type { TelegramBot } from "../bot/TelegramBot.js";
import type { StickerCache } from "../bot/StickerCache.js";
import { PairingFlow } from "../bot/PairingFlow.js";
import { userMessages } from "../config/prompts.js";

export interface CommandCtx {
  ui: { notify: (msg: string) => void };
}

export interface CliRegistration {
  name: string;
  description: string;
  handler: (args: string, ctx: CommandCtx) => Promise<void>;
}

export interface CliDeps {
  configStore: ConfigStore;
  bot: TelegramBot;
  stickerCache: StickerCache;
}

const splitArgs = (s: string): string[] =>
  s
    .trim()
    .split(/\s+/)
    .filter((x) => x.length > 0);

export function buildCliCommands(deps: CliDeps): CliRegistration[] {
  const { configStore, bot, stickerCache } = deps;

  return [
    {
      name: "telegram-connect",
      description: "Start the Telegram bot. Without args, reuses stored token and owner.",
      handler: async (raw, ctx) => {
        if (bot.isRunning()) {
          ctx.ui.notify(userMessages.alreadyRunning);
          return;
        }
        const args = splitArgs(raw);
        const ownerIdx = args.indexOf("--owner");
        const explicitOwner = ownerIdx >= 0 ? Number(args[ownerIdx + 1]) : null;
        let token = args[0];
        if (token === "--owner") token = undefined as unknown as string;
        const cfgBefore = await configStore.load();
        if (!token) {
          if (cfgBefore.botToken) {
            token = cfgBefore.botToken;
          } else {
            ctx.ui.notify(userMessages.noStoredToken);
            return;
          }
        }
        await bot.start(token);
        const cfgAfterStart = await configStore.load();
        if (cfgAfterStart.owner !== null && explicitOwner === null) {
          ctx.ui.notify(userMessages.reconnected(cfgAfterStart.owner));
          return;
        }
        const pairing = new PairingFlow(configStore);
        if (explicitOwner !== null && Number.isInteger(explicitOwner)) {
          await pairing.setExplicitOwner(explicitOwner);
          ctx.ui.notify(userMessages.startedExplicitOwner(explicitOwner));
          return;
        }
        const code = await pairing.startPairing();
        ctx.ui.notify(userMessages.startedPairing(code));
      },
    },
    {
      name: "telegram-disconnect",
      description: "Stop the Telegram bot. Config is preserved.",
      handler: async (_raw, ctx) => {
        await bot.stop();
        ctx.ui.notify(userMessages.stopped);
      },
    },
    {
      name: "telegram-status",
      description: "Show bot status (running, owner).",
      handler: async (_raw, ctx) => {
        const cfg = await configStore.load();
        ctx.ui.notify(userMessages.status(bot.isRunning(), cfg.owner));
      },
    },
    {
      name: "telegram-reset-stickers-cache",
      description: "Wipe the cached sticker_id → file_id map (re-learns next time user sends each sticker).",
      handler: async (_raw, ctx) => {
        await stickerCache.reset();
        ctx.ui.notify(userMessages.stickerCacheCleared);
      },
    },
  ];
}
