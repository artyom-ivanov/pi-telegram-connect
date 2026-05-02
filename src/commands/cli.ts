import type { ConfigStore } from "../config/ConfigStore.js";
import type { TelegramBot } from "../bot/TelegramBot.js";
import { PairingFlow } from "../bot/PairingFlow.js";
import type { Config } from "../config/schema.js";

/**
 * Loose ExtensionCommandContext — we only need `ctx.ui.notify`.
 * The real type lives in @mariozechner/pi-coding-agent.
 */
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
}

const splitArgs = (s: string): string[] => s.trim().split(/\s+/).filter((x) => x.length > 0);

export function buildCliCommands(deps: CliDeps): CliRegistration[] {
  const { configStore, bot } = deps;

  const allowedDmPolicies = ["pairing", "allowlist", "open", "disabled"] as const;
  const allowedGroupPolicies = ["allowlist", "open", "disabled"] as const;
  const allowedReplyModes = ["owner", "mention", "all"] as const;
  const allowedFreq = ["rare", "medium", "often"] as const;

  return [
    {
      name: "telegram-connect",
      description: "Start the Telegram bot. Optional --owner <user_id> skips pairing.",
      handler: async (raw, ctx) => {
        const args = splitArgs(raw);
        const token = args[0];
        if (!token) {
          ctx.ui.notify("usage: /telegram-connect <token> [--owner <user_id>]");
          return;
        }
        const ownerIdx = args.indexOf("--owner");
        const explicitOwner = ownerIdx >= 0 ? Number(args[ownerIdx + 1]) : null;
        await bot.start(token);
        const pairing = new PairingFlow(configStore);
        if (explicitOwner !== null && Number.isInteger(explicitOwner)) {
          await pairing.setExplicitOwner(explicitOwner);
          ctx.ui.notify(`Bot started. Owner set to ${explicitOwner}. No pairing required.`);
          return;
        }
        const code = await pairing.startPairing();
        ctx.ui.notify(
          `Bot started. Send this code to the bot in DM to claim ownership: ${code} (valid 5 min)`,
        );
      },
    },
    {
      name: "telegram-disconnect",
      description: "Stop the Telegram bot. Config and sessions are preserved.",
      handler: async (_raw, ctx) => {
        await bot.stop();
        ctx.ui.notify("Bot stopped.");
      },
    },
    {
      name: "telegram-status",
      description: "Show bot status and policies.",
      handler: async (_raw, ctx) => {
        const cfg = await configStore.load();
        ctx.ui.notify(
          [
            `Bot running: ${bot.isRunning()}`,
            `Owner: ${cfg.owner ?? "(not paired)"}`,
            `DM policy: ${cfg.policies.dm}`,
            `Group policy: ${cfg.policies.group}`,
            `Allowed users: ${cfg.allowedUsers.length}`,
            `Allowed groups: ${cfg.allowedGroups.length}`,
          ].join("\n"),
        );
      },
    },
    {
      name: "telegram-allow",
      description: "Add a user_id to the allowlist.",
      handler: async (raw, ctx) => {
        const args = splitArgs(raw);
        const id = Number(args[0]);
        if (!Number.isInteger(id)) {
          ctx.ui.notify("usage: /telegram-allow <user_id>");
          return;
        }
        await mutate(configStore, (cfg) => {
          if (!cfg.allowedUsers.includes(id)) cfg.allowedUsers.push(id);
        });
        ctx.ui.notify(`User ${id} added.`);
      },
    },
    {
      name: "telegram-revoke",
      description: "Remove a user_id from the allowlist.",
      handler: async (raw, ctx) => {
        const args = splitArgs(raw);
        const id = Number(args[0]);
        if (!Number.isInteger(id)) {
          ctx.ui.notify("usage: /telegram-revoke <user_id>");
          return;
        }
        await mutate(configStore, (cfg) => {
          cfg.allowedUsers = cfg.allowedUsers.filter((u) => u !== id);
        });
        ctx.ui.notify(`User ${id} revoked.`);
      },
    },
    {
      name: "telegram-allow-group",
      description: "Add a chat_id to the group allowlist.",
      handler: async (raw, ctx) => {
        const args = splitArgs(raw);
        const id = Number(args[0]);
        if (!Number.isInteger(id)) {
          ctx.ui.notify("usage: /telegram-allow-group <chat_id>");
          return;
        }
        await mutate(configStore, (cfg) => {
          if (!cfg.allowedGroups.includes(id)) cfg.allowedGroups.push(id);
        });
        ctx.ui.notify(`Group ${id} added.`);
      },
    },
    {
      name: "telegram-revoke-group",
      description: "Remove a chat_id from the group allowlist.",
      handler: async (raw, ctx) => {
        const args = splitArgs(raw);
        const id = Number(args[0]);
        if (!Number.isInteger(id)) {
          ctx.ui.notify("usage: /telegram-revoke-group <chat_id>");
          return;
        }
        await mutate(configStore, (cfg) => {
          cfg.allowedGroups = cfg.allowedGroups.filter((g) => g !== id);
          delete cfg.groupSettings[String(id)];
        });
        ctx.ui.notify(`Group ${id} revoked.`);
      },
    },
    {
      name: "telegram-policy",
      description: "Set DM or group policy.",
      handler: async (raw, ctx) => {
        const args = splitArgs(raw);
        const target = args[0];
        const value = args[1];
        if (target === "dm" && (allowedDmPolicies as readonly string[]).includes(value ?? "")) {
          await mutate(configStore, (cfg) => {
            cfg.policies.dm = value as Config["policies"]["dm"];
          });
          ctx.ui.notify(`DM policy set to ${value}.`);
          return;
        }
        if (target === "group" && (allowedGroupPolicies as readonly string[]).includes(value ?? "")) {
          await mutate(configStore, (cfg) => {
            cfg.policies.group = value as Config["policies"]["group"];
          });
          ctx.ui.notify(`Group policy set to ${value}.`);
          return;
        }
        ctx.ui.notify(
          `usage: /telegram-policy dm <${allowedDmPolicies.join("|")}> | group <${allowedGroupPolicies.join("|")}>`,
        );
      },
    },
    {
      name: "telegram-group-mode",
      description: "Set replyMode for a specific group, or for groupDefaults if no chat_id given.",
      handler: async (raw, ctx) => {
        const args = splitArgs(raw);
        if (args.length === 1 && (allowedReplyModes as readonly string[]).includes(args[0]!)) {
          await mutate(configStore, (cfg) => {
            cfg.groupDefaults.replyMode = args[0] as (typeof allowedReplyModes)[number];
          });
          ctx.ui.notify(`groupDefaults.replyMode = ${args[0]}.`);
          return;
        }
        if (args.length === 2 && (allowedReplyModes as readonly string[]).includes(args[1]!)) {
          const chatId = Number(args[0]);
          await mutate(configStore, (cfg) => {
            const cur = cfg.groupSettings[String(chatId)] ?? cfg.groupDefaults;
            cfg.groupSettings[String(chatId)] = {
              ...cur,
              replyMode: args[1] as (typeof allowedReplyModes)[number],
            };
          });
          ctx.ui.notify(`groupSettings[${chatId}].replyMode = ${args[1]}.`);
          return;
        }
        ctx.ui.notify(`usage: /telegram-group-mode [<chat_id>] <${allowedReplyModes.join("|")}>`);
      },
    },
    {
      name: "telegram-group-frequency",
      description: "Set replyFrequency for a specific group, or groupDefaults.",
      handler: async (raw, ctx) => {
        const args = splitArgs(raw);
        if (args.length === 1 && (allowedFreq as readonly string[]).includes(args[0]!)) {
          await mutate(configStore, (cfg) => {
            cfg.groupDefaults.replyFrequency = args[0] as (typeof allowedFreq)[number];
          });
          ctx.ui.notify(`groupDefaults.replyFrequency = ${args[0]}.`);
          return;
        }
        if (args.length === 2 && (allowedFreq as readonly string[]).includes(args[1]!)) {
          const chatId = Number(args[0]);
          await mutate(configStore, (cfg) => {
            const cur = cfg.groupSettings[String(chatId)] ?? cfg.groupDefaults;
            cfg.groupSettings[String(chatId)] = {
              ...cur,
              replyFrequency: args[1] as (typeof allowedFreq)[number],
            };
          });
          ctx.ui.notify(`groupSettings[${chatId}].replyFrequency = ${args[1]}.`);
          return;
        }
        ctx.ui.notify(`usage: /telegram-group-frequency [<chat_id>] <${allowedFreq.join("|")}>`);
      },
    },
  ];
}

async function mutate(store: ConfigStore, f: (cfg: Config) => void): Promise<void> {
  const cfg = await store.load();
  f(cfg);
  await store.save(cfg);
}
