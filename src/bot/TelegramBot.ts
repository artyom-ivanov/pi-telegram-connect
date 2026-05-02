import { Bot, type Context } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import type { ConfigStore } from "../config/ConfigStore.js";
import type { AgentHost } from "../agent/AgentHost.js";
import { evaluateAccess } from "./AccessControl.js";
import { routeKey } from "./ChatRouter.js";
import { MessageQueue } from "./MessageQueue.js";
import { PairingFlow } from "./PairingFlow.js";
import { Streamer } from "./Streamer.js";
import { StickerCache } from "./StickerCache.js";
import { buildMediaTools } from "./MediaTools.js";
import { resolveDestPath, downloadToPath } from "./MediaIngest.js";
import { TelegramRateLimiter } from "../util/ratelimit.js";
import type { Config } from "../config/schema.js";
import type { ImageContent, SessionKey } from "../types.js";
import { expandHome } from "../util/paths.js";

type RunState = "starting" | "running" | "draining" | "stopped";

export interface TelegramBotOptions {
  configStore: ConfigStore;
  agentHost: AgentHost;
  stickerCache: StickerCache;
  tmpDir: string;
  outboundAllowedRoots: string[];
  cliLog: (msg: string) => void;
}

interface QueueItem {
  ctx: Context;
  promptText: string;
  images: ImageContent[];
  replyToMessageId?: number;
}

export class TelegramBot {
  private state: RunState = "stopped";
  private bot: Bot | null = null;
  private runner: RunnerHandle | null = null;
  private queue: MessageQueue<QueueItem> | null = null;
  private rateLimiter = new TelegramRateLimiter();
  private streamers = new Map<SessionKey, Streamer>();
  /** Optional hook injected by the extension entry to wire GroupAccess into the live Bot. */
  public onBotInit?: (bot: Bot) => void;

  constructor(private opts: TelegramBotOptions) {}

  isRunning(): boolean {
    return this.state === "running";
  }

  async start(token: string): Promise<void> {
    if (this.state !== "stopped") throw new Error(`bot already in state ${this.state}`);
    this.state = "starting";
    const cfg = await this.opts.configStore.load();
    cfg.botToken = token;
    await this.opts.configStore.save(cfg);

    this.bot = new Bot(token);
    if (this.onBotInit) {
      try {
        this.onBotInit(this.bot);
      } catch (e) {
        this.opts.cliLog(`onBotInit hook error: ${(e as Error).message}`);
      }
    }
    const pairing = new PairingFlow(this.opts.configStore);

    this.queue = new MessageQueue<QueueItem>({
      maxDepth: cfg.limits.maxQueueDepth,
      overflow: "drop-oldest",
      worker: (item, controller) => this.runTurn(item, controller),
    });

    this.bot.on("message", async (ctx) => {
      if (this.state !== "running") return;
      const cfgNow = await this.opts.configStore.load();
      const text = ctx.message.text ?? ctx.message.caption ?? "";
      const senderId = ctx.from?.id ?? 0;
      const chatType = ctx.chat.type as "private" | "group" | "supergroup" | "channel";
      const trimmed = text.trim();

      const isPairingCodeAttempt =
        chatType === "private" &&
        cfgNow.pendingPairCode !== null &&
        /^[A-HJ-NP-Z2-9a-hj-np-z]{6}$/.test(trimmed);

      const decision = evaluateAccess({
        config: cfgNow,
        chatType,
        chatId: ctx.chat.id,
        threadId: ctx.message.message_thread_id ?? 0,
        senderId,
        isReplyToBot: ctx.message.reply_to_message?.from?.id === ctx.me.id,
        hasMentionOfBot: detectMention(ctx, ctx.me.username),
        isPairingCodeAttempt,
        draining: this.state !== "running",
      });

      if (decision.decision === "drop") return;
      if (decision.decision === "pair") {
        const r = await pairing.tryPair(trimmed, senderId);
        if (r.ok) {
          this.opts.cliLog(`Pairing succeeded: owner = ${senderId}`);
          await ctx.reply("✅ You are now the owner. Use /help to see commands.");
        }
        return;
      }

      const tid = ctx.message.message_thread_id;
      const lower = trimmed.toLowerCase();
      if (lower === "/stop") {
        const k = routeKey({ chat: ctx.chat, ...(tid !== undefined ? { message_thread_id: tid } : {}) });
        await this.handleStop(k);
        return;
      }
      if (lower === "/reset") {
        const k = routeKey({ chat: ctx.chat, ...(tid !== undefined ? { message_thread_id: tid } : {}) });
        await this.opts.agentHost.resetSession(k);
        await ctx.reply("History cleared for this chat.");
        return;
      }

      const item = await this.normalizeMessage(ctx, cfgNow);
      if (!item) return;
      const k = routeKey({ chat: ctx.chat, ...(tid !== undefined ? { message_thread_id: tid } : {}) });
      this.queue!.enqueue(k, item);
    });

    this.runner = run(this.bot, {
      runner: { fetch: { allowed_updates: ["message", "my_chat_member", "callback_query"] } },
    } as any);

    this.state = "running";
    this.opts.cliLog(`Bot started.`);
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "draining";
    this.queue?.abortAll();
    if (this.runner) await this.runner.stop().catch(() => undefined);
    await this.opts.agentHost.shutdown().catch(() => undefined);
    this.runner = null;
    this.bot = null;
    this.queue = null;
    this.streamers.clear();
    this.state = "stopped";
    this.opts.cliLog(`Bot stopped.`);
  }

  private async handleStop(key: SessionKey): Promise<void> {
    this.queue?.abortAndClear(key);
    const streamer = this.streamers.get(key);
    if (streamer) await streamer.appendStopMarker().catch(() => undefined);
  }

  private async normalizeMessage(ctx: Context, cfg: Config): Promise<QueueItem | null> {
    const m = ctx.message;
    if (!m) return null;
    const parts: string[] = [];
    if (m.reply_to_message) {
      const snippet = (m.reply_to_message.text ?? m.reply_to_message.caption ?? "").slice(0, 200);
      parts.push(`[in reply to (msg ${m.reply_to_message.message_id}): ${snippet}]`);
    }
    const attached: string[] = [];
    const images: ImageContent[] = [];
    const tmpDir = expandHome(this.opts.tmpDir);
    const limit = cfg.limits.maxIncomingFileMb * 1024 * 1024;

    const downloadFile = async (
      fileId: string,
      fileUniqueId: string,
      filename: string | undefined,
    ): Promise<string | null> => {
      try {
        const file = await ctx.api.getFile(fileId);
        if (!file.file_path) return null;
        const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
        const dest = await resolveDestPath({
          tmpDir,
          chatId: ctx.chat!.id,
          threadId: m.message_thread_id ?? 0,
          msgId: m.message_id,
          remoteFilename: filename,
          fileUniqueId,
        });
        const ac = new AbortController();
        await downloadToPath({ url, destPath: dest, maxBytes: limit, signal: ac.signal });
        return dest;
      } catch (e: any) {
        if ((e?.message ?? "").startsWith("file_too_large")) {
          attached.push(`[file too large: ${filename ?? fileUniqueId}]`);
        } else {
          attached.push(`[file unavailable: ${filename ?? fileUniqueId}]`);
        }
        return null;
      }
    };

    if (m.photo && m.photo.length > 0) {
      const best = m.photo[m.photo.length - 1]!;
      const dest = await downloadFile(best.file_id, best.file_unique_id, "photo.jpg");
      if (dest) {
        try {
          const { readFile } = await import("node:fs/promises");
          const buf = await readFile(dest);
          images.push({ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" });
        } catch {
          attached.push(`[photo ingest error]`);
        }
      }
    }
    if (m.voice) {
      const dest = await downloadFile(m.voice.file_id, m.voice.file_unique_id, "voice.ogg");
      if (dest) attached.push(`- voice (${m.voice.duration}s): ${dest}`);
    }
    if (m.audio) {
      const dest = await downloadFile(m.audio.file_id, m.audio.file_unique_id, m.audio.file_name ?? "audio");
      if (dest) attached.push(`- audio (${m.audio.duration}s): ${dest}`);
    }
    if (m.video) {
      const dest = await downloadFile(m.video.file_id, m.video.file_unique_id, m.video.file_name ?? "video.mp4");
      if (dest) attached.push(`- video (${m.video.duration}s): ${dest}`);
    }
    if (m.document) {
      const dest = await downloadFile(m.document.file_id, m.document.file_unique_id, m.document.file_name ?? "file");
      if (dest) attached.push(`- document: ${dest}`);
    }
    if (m.sticker) {
      const sk = m.sticker;
      const kind: "static" | "video" | "lottie" =
        sk.is_animated ? "lottie" : sk.is_video ? "video" : "static";
      const dest =
        kind === "lottie"
          ? null
          : await downloadFile(sk.file_id, sk.file_unique_id, kind === "video" ? "sticker.webm" : "sticker.webp");
      const text = await this.opts.stickerCache.describe({
        fileUniqueId: sk.file_unique_id,
        emoji: sk.emoji ?? "🎴",
        kind,
        ...(dest !== null ? { filePath: dest } : {}),
      });
      attached.push(text);
    }

    if (attached.length > 0) {
      parts.push(`[user attached files]\n${attached.join("\n")}\n[/files]`);
    }
    const userText = m.text ?? m.caption ?? "";
    if (userText) parts.push(userText);
    if (parts.length === 0 && images.length === 0) return null;

    return {
      ctx,
      promptText: parts.join("\n\n"),
      images,
      replyToMessageId: m.message_id,
    };
  }

  private async runTurn(item: QueueItem, controller: AbortController): Promise<void> {
    const ctx = item.ctx;
    const tid = ctx.message?.message_thread_id;
    const k = routeKey({ chat: ctx.chat!, ...(tid !== undefined ? { message_thread_id: tid } : {}) });
    const cfg = await this.opts.configStore.load();
    const tools = buildMediaTools({
      chatId: ctx.chat!.id,
      threadId: ctx.message?.message_thread_id ?? 0,
      outboundAllowedRoots: cfg.limits.outboundAllowedRoots,
      client: ctx.api as any,
    });
    const session = await this.opts.agentHost.getOrCreateSession(k, { customTools: tools });

    const streamer = new Streamer({
      client: rateLimited(ctx.api as any, this.rateLimiter, ctx.chat!.id),
      chatId: ctx.chat!.id,
      threadId: ctx.message?.message_thread_id ?? 0,
      throttleMs: 3000,
      ageResetMs: 60_000,
      ...(item.replyToMessageId !== undefined ? { replyToOnFirst: item.replyToMessageId } : {}),
    });
    this.streamers.set(k, streamer);
    streamer.beginTurn();

    const off = session.subscribe((e) => {
      if (controller.signal.aborted) return;
      if (e.type === "message_update") {
        if (e.delta.text) streamer.appendDelta(e.delta.text);
      } else if (e.type === "tool_execution_start") {
        streamer.toolStart(e.toolName, e.argsSummary);
      } else if (e.type === "tool_execution_end") {
        streamer.toolEnd(e.toolName);
      }
    });

    const stopHandler = () => {
      streamer.appendStopMarker().catch(() => undefined);
    };
    if (!controller.signal.aborted) {
      controller.signal.addEventListener("abort", stopHandler);
    }

    try {
      const promptOpts = item.images.length > 0 ? { images: item.images } : undefined;
      await session.prompt(item.promptText, promptOpts);
      await streamer.flush();
      await streamer.finalize();
    } catch (err) {
      this.opts.cliLog(`runTurn error in ${k}: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      off();
      controller.signal.removeEventListener("abort", stopHandler);
      this.streamers.delete(k);
    }
  }
}

function detectMention(ctx: Context, botUsername: string | undefined): boolean {
  if (!botUsername) return false;
  const m = ctx.message;
  if (!m) return false;
  const text = m.text ?? m.caption ?? "";
  const entities = m.entities ?? m.caption_entities ?? [];
  for (const ent of entities) {
    if (ent.type === "mention") {
      const name = text.slice(ent.offset, ent.offset + ent.length);
      if (name.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
    }
    if (ent.type === "text_mention" && (ent as any).user?.id === ctx.me.id) return true;
  }
  return false;
}

function rateLimited(api: any, limiter: TelegramRateLimiter, chatId: number) {
  return {
    async sendMessage(args: any) {
      await limiter.wait(chatId);
      const { chat_id, text, ...rest } = args;
      return api.sendMessage(chat_id, text, rest);
    },
    async editMessageText(args: any) {
      await limiter.wait(chatId);
      const { chat_id, message_id, text, ...rest } = args;
      return api.editMessageText(chat_id, message_id, text, rest);
    },
  };
}
