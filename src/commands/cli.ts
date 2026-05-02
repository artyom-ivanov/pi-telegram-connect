import type { ConfigStore } from "../config/ConfigStore.js";
import type { TelegramBot } from "../bot/TelegramBot.js";
import { PairingFlow } from "../bot/PairingFlow.js";
import type { Config } from "../config/schema.js";

export interface CliRegistration {
  name: string;
  description: string;
  args?: string;
  handler: (rawArgs: string[]) => Promise<string>;
}

export interface CliDeps {
  configStore: ConfigStore;
  bot: TelegramBot;
  cliLog: (msg: string) => void;
}

export function buildCliCommands(deps: CliDeps): CliRegistration[] {
  const { configStore, bot } = deps;

  const allowedDmPolicies = ["pairing", "allowlist", "open", "disabled"] as const;
  const allowedGroupPolicies = ["allowlist", "open", "disabled"] as const;
  const allowedReplyModes = ["owner", "mention", "all"] as const;
  const allowedFreq = ["rare", "medium", "often"] as const;

  return [
    {
      name: "/telegram-connect",
      description: "Start the Telegram bot. Optional --owner <user_id> skips pairing.",
      args: "<token> [--owner <user_id>]",
      async handler(args) {
        const token = args[0];
        if (!token) return "usage: /telegram-connect <token> [--owner <user_id>]";
        const ownerIdx = args.indexOf("--owner");
        const explicitOwner = ownerIdx >= 0 ? Number(args[ownerIdx + 1]) : null;
        await bot.start(token);
        const pairing = new PairingFlow(configStore);
        if (explicitOwner !== null && Number.isInteger(explicitOwner)) {
          await pairing.setExplicitOwner(explicitOwner);
          return `Bot started. Owner set to ${explicitOwner}. No pairing required.`;
        }
        const code = await pairing.startPairing();
        return `Bot started. Send this code to the bot in DM to claim ownership: ${code} (valid 5 min)`;
      },
    },
    {
      name: "/telegram-disconnect",
      description: "Stop the Telegram bot. Config and sessions are preserved.",
      async handler() {
        await bot.stop();
        return "Bot stopped.";
      },
    },
    {
      name: "/telegram-status",
      description: "Show bot status and policies.",
      async handler() {
        const cfg = await configStore.load();
        return [
          `Bot running: ${bot.isRunning()}`,
          `Owner: ${cfg.owner ?? "(not paired)"}`,
          `DM policy: ${cfg.policies.dm}`,
          `Group policy: ${cfg.policies.group}`,
          `Allowed users: ${cfg.allowedUsers.length}`,
          `Allowed groups: ${cfg.allowedGroups.length}`,
        ].join("\n");
      },
    },
    {
      name: "/telegram-allow",
      description: "Add a user_id to the allowlist.",
      args: "<user_id>",
      async handler(args) {
        const id = Number(args[0]);
        if (!Number.isInteger(id)) return "usage: /telegram-allow <user_id>";
        return mutate(configStore, (cfg) => {
          if (!cfg.allowedUsers.includes(id)) cfg.allowedUsers.push(id);
        }).then(() => `User ${id} added.`);
      },
    },
    {
      name: "/telegram-revoke",
      description: "Remove a user_id from the allowlist.",
      args: "<user_id>",
      async handler(args) {
        const id = Number(args[0]);
        if (!Number.isInteger(id)) return "usage: /telegram-revoke <user_id>";
        return mutate(configStore, (cfg) => {
          cfg.allowedUsers = cfg.allowedUsers.filter((u) => u !== id);
        }).then(() => `User ${id} revoked.`);
      },
    },
    {
      name: "/telegram-allow-group",
      description: "Add a chat_id to the group allowlist.",
      args: "<chat_id>",
      async handler(args) {
        const id = Number(args[0]);
        if (!Number.isInteger(id)) return "usage: /telegram-allow-group <chat_id>";
        return mutate(configStore, (cfg) => {
          if (!cfg.allowedGroups.includes(id)) cfg.allowedGroups.push(id);
        }).then(() => `Group ${id} added.`);
      },
    },
    {
      name: "/telegram-revoke-group",
      description: "Remove a chat_id from the group allowlist.",
      args: "<chat_id>",
      async handler(args) {
        const id = Number(args[0]);
        if (!Number.isInteger(id)) return "usage: /telegram-revoke-group <chat_id>";
        return mutate(configStore, (cfg) => {
          cfg.allowedGroups = cfg.allowedGroups.filter((g) => g !== id);
          delete cfg.groupSettings[String(id)];
        }).then(() => `Group ${id} revoked.`);
      },
    },
    {
      name: "/telegram-policy",
      description: "Set DM or group policy.",
      args: "dm <pairing|allowlist|open|disabled> | group <allowlist|open|disabled>",
      async handler(args) {
        const target = args[0];
        const value = args[1];
        if (target === "dm" && (allowedDmPolicies as readonly string[]).includes(value ?? "")) {
          return mutate(configStore, (cfg) => {
            cfg.policies.dm = value as Config["policies"]["dm"];
          }).then(() => `DM policy set to ${value}.`);
        }
        if (target === "group" && (allowedGroupPolicies as readonly string[]).includes(value ?? "")) {
          return mutate(configStore, (cfg) => {
            cfg.policies.group = value as Config["policies"]["group"];
          }).then(() => `Group policy set to ${value}.`);
        }
        return `usage: /telegram-policy dm <${allowedDmPolicies.join("|")}> | group <${allowedGroupPolicies.join("|")}>`;
      },
    },
    {
      name: "/telegram-group-mode",
      description: "Set replyMode for a specific group, or for groupDefaults if no chat_id given.",
      args: "[<chat_id>] <owner|mention|all>",
      async handler(args) {
        if (args.length === 1 && (allowedReplyModes as readonly string[]).includes(args[0]!)) {
          return mutate(configStore, (cfg) => {
            cfg.groupDefaults.replyMode = args[0] as (typeof allowedReplyModes)[number];
          }).then(() => `groupDefaults.replyMode = ${args[0]}.`);
        }
        if (args.length === 2 && (allowedReplyModes as readonly string[]).includes(args[1]!)) {
          const chatId = Number(args[0]);
          return mutate(configStore, (cfg) => {
            const cur = cfg.groupSettings[String(chatId)] ?? cfg.groupDefaults;
            cfg.groupSettings[String(chatId)] = { ...cur, replyMode: args[1] as (typeof allowedReplyModes)[number] };
          }).then(() => `groupSettings[${chatId}].replyMode = ${args[1]}.`);
        }
        return `usage: /telegram-group-mode [<chat_id>] <${allowedReplyModes.join("|")}>`;
      },
    },
    {
      name: "/telegram-group-frequency",
      description: "Set replyFrequency for a specific group, or groupDefaults.",
      args: "[<chat_id>] <rare|medium|often>",
      async handler(args) {
        if (args.length === 1 && (allowedFreq as readonly string[]).includes(args[0]!)) {
          return mutate(configStore, (cfg) => {
            cfg.groupDefaults.replyFrequency = args[0] as (typeof allowedFreq)[number];
          }).then(() => `groupDefaults.replyFrequency = ${args[0]}.`);
        }
        if (args.length === 2 && (allowedFreq as readonly string[]).includes(args[1]!)) {
          const chatId = Number(args[0]);
          return mutate(configStore, (cfg) => {
            const cur = cfg.groupSettings[String(chatId)] ?? cfg.groupDefaults;
            cfg.groupSettings[String(chatId)] = { ...cur, replyFrequency: args[1] as (typeof allowedFreq)[number] };
          }).then(() => `groupSettings[${chatId}].replyFrequency = ${args[1]}.`);
        }
        return `usage: /telegram-group-frequency [<chat_id>] <${allowedFreq.join("|")}>`;
      },
    },
  ];
}

async function mutate(store: ConfigStore, f: (cfg: Config) => void): Promise<void> {
  const cfg = await store.load();
  f(cfg);
  await store.save(cfg);
}
