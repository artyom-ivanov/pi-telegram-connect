import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { ConfigStore } from "../config/ConfigStore.js";

const NONCE_TTL_MS = 24 * 60 * 60 * 1000;

export interface GroupAccessOptions {
  configStore: ConfigStore;
  cliLog: (msg: string) => void;
}

export class GroupAccess {
  constructor(private opts: GroupAccessOptions) {}

  /** Wire grammy handlers for my_chat_member + callback_query. */
  install(bot: Bot): void {
    bot.on("my_chat_member", async (ctx) => {
      const upd = ctx.update.my_chat_member;
      const status = upd.new_chat_member.status;
      if (status === "kicked" || status === "left") {
        await this.evictGroup(upd.chat.id);
        return;
      }
      if (status !== "member" && status !== "administrator") return;
      if (upd.chat.type !== "group" && upd.chat.type !== "supergroup") return;
      await this.maybeRequestAccess(ctx, upd.chat.id, upd.chat.title ?? "<no title>");
    });

    bot.callbackQuery(/^gax:(allow|deny):(-?\d+):([0-9a-f]+)$/, async (ctx) => {
      const m = /^gax:(allow|deny):(-?\d+):([0-9a-f]+)$/.exec(ctx.callbackQuery.data ?? "");
      if (!m) {
        await ctx.answerCallbackQuery({ text: "Invalid callback." });
        return;
      }
      const action = m[1] as "allow" | "deny";
      const chatId = Number(m[2]);
      const nonce = m[3]!;
      const cfg = await this.opts.configStore.load();
      const fromId = ctx.callbackQuery.from.id;
      if (cfg.owner !== fromId) {
        await ctx.answerCallbackQuery({ text: "Only the bot owner can decide." });
        return;
      }
      const pending = cfg.pendingGroupAccess[String(chatId)];
      if (!pending || pending.nonce !== nonce || pending.expiresAt < Date.now()) {
        await ctx.answerCallbackQuery({ text: "Request expired." });
        delete cfg.pendingGroupAccess[String(chatId)];
        await this.opts.configStore.save(cfg);
        return;
      }
      delete cfg.pendingGroupAccess[String(chatId)];
      if (action === "allow") {
        if (!cfg.allowedGroups.includes(chatId)) cfg.allowedGroups.push(chatId);
        await this.opts.configStore.save(cfg);
        await ctx.editMessageText(`✅ Group access granted (${chatId}).`);
        await ctx.answerCallbackQuery({ text: "Allowed." });
      } else {
        await this.opts.configStore.save(cfg);
        await ctx.editMessageText(`❌ Group access denied (${chatId}).`);
        await ctx.answerCallbackQuery({ text: "Denied." });
      }
    });
  }

  /** Called from my_chat_member OR from a first-message-from-unknown-group fallback. */
  async maybeRequestAccess(ctx: Context, chatId: number, title: string): Promise<void> {
    const cfg = await this.opts.configStore.load();
    if (cfg.policies.group === "disabled") return;
    if (cfg.allowedGroups.includes(chatId)) return;
    if (cfg.policies.group === "open") {
      cfg.allowedGroups.push(chatId);
      await this.opts.configStore.save(cfg);
      this.opts.cliLog(`Group ${chatId} (${title}) auto-allowed (policy=open).`);
      return;
    }
    if (cfg.owner === null) return;
    const nonce = randomBytes(16).toString("hex");
    cfg.pendingGroupAccess[String(chatId)] = { nonce, expiresAt: Date.now() + NONCE_TTL_MS };
    await this.opts.configStore.save(cfg);
    const kb = new InlineKeyboard()
      .text("Allow", `gax:allow:${chatId}:${nonce}`)
      .text("Deny", `gax:deny:${chatId}:${nonce}`);
    try {
      await ctx.api.sendMessage(
        cfg.owner,
        `Group "${title}" (id ${chatId}) wants access. Allow?`,
        { reply_markup: kb },
      );
    } catch (e) {
      this.opts.cliLog(`Failed to DM owner about group ${chatId}: ${(e as Error).message}`);
    }
  }

  private async evictGroup(chatId: number): Promise<void> {
    const cfg = await this.opts.configStore.load();
    cfg.allowedGroups = cfg.allowedGroups.filter((g) => g !== chatId);
    delete cfg.groupSettings[String(chatId)];
    delete cfg.pendingGroupAccess[String(chatId)];
    for (const k of Object.keys(cfg.sessions)) {
      if (k.startsWith(`${chatId}:`)) delete cfg.sessions[k];
    }
    await this.opts.configStore.save(cfg);
    this.opts.cliLog(`Group ${chatId} evicted (kicked/left).`);
  }
}
