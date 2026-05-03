import { stat } from "node:fs/promises";
import { Bot, type Context, InputFile } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import type { ConfigStore } from "../config/ConfigStore.js";
import { evaluateAccess } from "./AccessControl.js";
import { MessageQueue } from "./MessageQueue.js";
import { PairingFlow } from "./PairingFlow.js";
import { Streamer } from "./Streamer.js";
import type { StickerCache } from "./StickerCache.js";
import { resolveDestPath, downloadToPath } from "./MediaIngest.js";
import { TelegramRateLimiter } from "../util/ratelimit.js";
import type { Config } from "../config/schema.js";
import { promptFragments, streamerMarkers, userMessages } from "../config/prompts.js";
import type { ImageContent, SessionKey } from "../types.js";
import { expandHome } from "../util/paths.js";

type RunState = "starting" | "running" | "draining" | "stopped";

export type UserMessageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PiBridge {
  sendUserMessage: (content: string | UserMessageContent[]) => void;
  onMessageDelta: (cb: (text: string) => void) => () => void;
  onToolStart: (cb: (toolName: string, argsSummary: string) => void) => () => void;
  onToolEnd: (cb: (toolName: string, ok: boolean) => void) => () => void;
  /**
   * Fires when pi finishes processing one user message (i.e., the whole
   * agent_start..agent_end span). NOT per turn_end inside that span — pi
   * may run multiple turns (assistant text + tool calls + tool results) for
   * a single user message, and we need the agent's later tool calls to
   * still see activeTurn set.
   */
  onTurnEnd: (cb: () => void) => () => void;
  onAgentStart: (cb: (abort: () => void) => void) => () => void;
  onAgentError: (cb: (message: string) => void) => () => void;
}

export interface TelegramBotOptions {
  configStore: ConfigStore;
  stickerCache: StickerCache;
  tmpDir: string;
  cliLog: (msg: string) => void;
  pi: PiBridge;
}

export type Attachment =
  | { kind: "file"; absPath: string }
  | { kind: "sticker"; fileId: string };

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
  private activeStreamer: Streamer | null = null;
  private turnEndResolver: (() => void) | null = null;
  private currentTurnAttachments: Attachment[] = [];
  private activeTurn: { chatId: number; threadId: number; replyToMessageId?: number } | null = null;
  private currentAgentAbort: (() => void) | null = null;
  private shutdownAbort: AbortController = new AbortController();

  private static readonly GLOBAL_KEY: SessionKey = "0:0";

  private piUnsubs: Array<() => void> = [];

  constructor(private opts: TelegramBotOptions) {}

  isRunning(): boolean {
    return this.state === "running";
  }

  isInTurn(): boolean {
    return this.activeTurn !== null;
  }

  queueAttachment(absPath: string): void {
    if (!this.activeTurn) {
      throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
    }
    if (this.currentTurnAttachments.length >= 10) {
      throw new Error("attachment limit reached (10 per turn)");
    }
    this.currentTurnAttachments.push({ kind: "file", absPath });
  }

  queueSticker(fileId: string): void {
    if (!this.activeTurn) {
      throw new Error("telegram_send_sticker can only be used while replying to an active Telegram turn");
    }
    if (this.currentTurnAttachments.length >= 10) {
      throw new Error("attachment limit reached (10 per turn)");
    }
    this.currentTurnAttachments.push({ kind: "sticker", fileId });
  }

  async setReaction(emoji: string, messageId?: number): Promise<void> {
    if (!this.activeTurn || !this.bot) {
      throw new Error("telegram_react can only be used while replying to an active Telegram turn");
    }
    const target = messageId ?? this.activeTurn.replyToMessageId;
    if (target === undefined) {
      throw new Error("no target message — current turn has no replyToMessageId and none was provided");
    }
    // Strip variation selector U+FE0F. Telegram's reaction palette uses bare codepoints
    // (e.g. "❤" not "❤️"); the VS-16 form Bot API rejects with 400. The agent and most
    // input methods produce the VS-16 form by default, so normalize here.
    const normalized = emoji.replace(/️/g, "");
    const reaction = (normalized ? [{ type: "emoji", emoji: normalized }] : []) as any;
    await this.bot.api.setMessageReaction(this.activeTurn.chatId, target, reaction);
  }

  async start(token: string): Promise<void> {
    if (this.state !== "stopped") throw new Error(`bot already in state ${this.state}`);
    this.state = "starting";
    this.shutdownAbort = new AbortController();
    const cfg = await this.opts.configStore.load();
    const previousToken = cfg.botToken;
    cfg.botToken = token;
    await this.opts.configStore.save(cfg);

    this.bot = new Bot(token);

    // Validate the token via getMe BEFORE the runner spins up. A bad token here means
    // we surface a clear error to the CLI instead of silently printing a pairing code
    // for a bot that will never receive a single message.
    try {
      await this.bot.api.getMe();
    } catch (err) {
      this.state = "stopped";
      this.bot = null;
      const msg = (err as Error)?.message ?? String(err);
      throw new Error(`Telegram rejected the bot token: ${msg}`);
    }

    // Token rotated → cached sticker file_ids belong to a different bot identity and
    // would 400 on sendSticker. Wipe the cache so it self-rebuilds on first use.
    if (previousToken !== null && previousToken !== token) {
      this.opts.cliLog("bot token changed — clearing sticker cache");
      await this.opts.stickerCache.reset().catch(() => undefined);
    }

    this.bot.catch((err) => {
      this.opts.cliLog(`grammy error: ${(err.error as Error)?.message ?? String(err.error)}`);
    });

    const pairing = new PairingFlow(this.opts.configStore);

    this.queue = new MessageQueue<QueueItem>({
      maxDepth: cfg.limits.maxQueueDepth,
      overflow: "drop-oldest",
      worker: (item, controller) => this.runTurn(item, controller),
    });

    this.piUnsubs.push(
      this.opts.pi.onMessageDelta((text) => {
        if (this.activeStreamer && text) this.activeStreamer.appendDelta(text);
      }),
    );
    this.piUnsubs.push(
      this.opts.pi.onToolStart((name, args) => {
        this.activeStreamer?.toolStart(name, args);
      }),
    );
    this.piUnsubs.push(
      this.opts.pi.onToolEnd((name, ok) => {
        this.activeStreamer?.toolEnd(name, ok);
      }),
    );
    this.piUnsubs.push(
      this.opts.pi.onTurnEnd(() => {
        this.currentAgentAbort = null;
        const r = this.turnEndResolver;
        this.turnEndResolver = null;
        if (r) r();
      }),
    );
    this.piUnsubs.push(
      this.opts.pi.onAgentStart((abort) => {
        this.currentAgentAbort = abort;
      }),
    );
    this.piUnsubs.push(
      this.opts.pi.onAgentError((message) => {
        if (this.activeStreamer) {
          void this.activeStreamer.appendErrorMarker(message).catch(() => undefined);
        }
      }),
    );

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
        senderId,
        isPairingCodeAttempt,
        draining: this.state !== "running",
      });

      if (decision.decision === "drop") return;
      if (decision.decision === "pair") {
        const r = await pairing.tryPair(trimmed, senderId);
        if (r.ok) {
          this.opts.cliLog(`Pairing succeeded: owner = ${senderId}`);
          await ctx.reply(userMessages.pairSucceeded);
        }
        return;
      }

      const lower = trimmed.toLowerCase();
      if (lower === "/stop") {
        this.handleStop();
        return;
      }
      if (lower === "/reset") {
        await ctx.reply(userMessages.resetUnsupported);
        return;
      }

      const item = await this.normalizeMessage(ctx, cfgNow);
      if (!item) return;
      this.queue!.enqueue(TelegramBot.GLOBAL_KEY, item);
    });

    this.bot.on("message_reaction", async (ctx) => {
      if (this.state !== "running") return;
      const upd = ctx.update.message_reaction;
      const senderId = upd.user?.id;
      if (senderId === undefined) return;
      if (senderId === ctx.me.id) return;
      const cfgNow = await this.opts.configStore.load();
      if (cfgNow.owner === null || senderId !== cfgNow.owner) return;
      if (upd.chat.type !== "private") return;

      const fmtReactions = (arr: ReadonlyArray<{ type: string; emoji?: string }> | undefined): string =>
        (arr ?? [])
          .map((r) => (r.type === "emoji" && r.emoji ? r.emoji : "?"))
          .join("");
      const oldR = fmtReactions(upd.old_reaction as any);
      const newR = fmtReactions(upd.new_reaction as any);
      let body: string;
      if (newR && !oldR) body = promptFragments.reactionAdded(upd.message_id, newR);
      else if (!newR && oldR) body = promptFragments.reactionRemoved(upd.message_id, oldR);
      else body = promptFragments.reactionChanged(upd.message_id, oldR, newR);

      const promptText = `${promptFragments.header(upd.chat.id, undefined, senderId)}\n\n${body}`;
      this.queue!.enqueue(TelegramBot.GLOBAL_KEY, {
        ctx,
        promptText,
        images: [],
      });
    });

    this.runner = run(this.bot, {
      runner: { fetch: { allowed_updates: ["message", "message_reaction"] } },
    } as any);

    this.state = "running";
    this.opts.cliLog(`Bot started.`);
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "draining";
    this.queue?.abortAll();
    if (this.runner) await this.runner.stop().catch(() => undefined);
    for (const off of this.piUnsubs) off();
    this.piUnsubs = [];
    this.shutdownAbort.abort();
    // Flush any pending sticker-cache writes so a process exit / disconnect doesn't lose
    // the last 500 ms of cache updates (debounced writer otherwise drops them).
    await this.opts.stickerCache.flush().catch(() => undefined);
    this.runner = null;
    this.bot = null;
    this.queue = null;
    this.activeStreamer = null;
    this.state = "stopped";
    this.opts.cliLog(`Bot stopped.`);
  }

  private handleStop(): void {
    this.queue?.abortAndClear(TelegramBot.GLOBAL_KEY);
    if (this.currentAgentAbort) {
      try {
        this.currentAgentAbort();
      } catch (e) {
        this.opts.cliLog(`agent abort failed: ${(e as Error).message}`);
      }
    }
    if (this.activeStreamer) {
      void this.activeStreamer.appendStopMarker().catch(() => undefined);
    }
  }

  private async normalizeMessage(ctx: Context, cfg: Config): Promise<QueueItem | null> {
    const m = ctx.message;
    if (!m) return null;
    const parts: string[] = [];
    parts.push(
      promptFragments.header(ctx.chat!.id, m.message_thread_id, ctx.from?.id ?? "?"),
    );
    if (m.reply_to_message) {
      const snippet = (m.reply_to_message.text ?? m.reply_to_message.caption ?? "").slice(0, 200);
      parts.push(promptFragments.inReplyTo(m.reply_to_message.message_id, snippet));
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
        await downloadToPath({ url, destPath: dest, maxBytes: limit, signal: this.shutdownAbort.signal });
        return dest;
      } catch (e: any) {
        const label = filename ?? fileUniqueId;
        if ((e?.message ?? "").startsWith("file_too_large")) {
          attached.push(promptFragments.fileTooLarge(label));
        } else {
          attached.push(promptFragments.fileUnavailable(label));
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
          attached.push(promptFragments.photoIngestError);
        }
      }
    }
    if (m.voice) {
      const dest = await downloadFile(m.voice.file_id, m.voice.file_unique_id, "voice.ogg");
      if (dest) attached.push(promptFragments.voiceMessage(m.voice.duration, dest));
    }
    if (m.audio) {
      const name = m.audio.file_name ?? "audio";
      const dest = await downloadFile(m.audio.file_id, m.audio.file_unique_id, name);
      if (dest) {
        attached.push(promptFragments.audioFile(dest, m.audio.duration, m.audio.title, m.audio.performer));
      }
    }
    if (m.video) {
      const dest = await downloadFile(m.video.file_id, m.video.file_unique_id, m.video.file_name ?? "video.mp4");
      if (dest) attached.push(promptFragments.video(m.video.duration, dest));
    }
    if (m.document) {
      const dest = await downloadFile(m.document.file_id, m.document.file_unique_id, m.document.file_name ?? "file");
      if (dest) attached.push(promptFragments.document(dest));
    }
    if (m.sticker) {
      const sk = m.sticker;
      const kind: "static" | "video" | "lottie" =
        sk.is_animated ? "lottie" : sk.is_video ? "video" : "static";
      if (kind === "static") {
        const cached = await this.opts.stickerCache.get(sk.file_unique_id);
        if (cached) {
          attached.push(promptFragments.stickerSeenBefore(sk.emoji ?? null, sk.file_unique_id));
        } else {
          const dest = await downloadFile(sk.file_id, sk.file_unique_id, "sticker.webp");
          let injected = false;
          if (dest) {
            try {
              const { readFile } = await import("node:fs/promises");
              const buf = await readFile(dest);
              images.push({ type: "image", data: buf.toString("base64"), mimeType: "image/webp" });
              attached.push(promptFragments.stickerFirstTime(sk.emoji ?? null, sk.file_unique_id));
              await this.opts.stickerCache.set(sk.file_unique_id, {
                fileId: sk.file_id,
                emoji: sk.emoji ?? null,
                seenAt: Date.now(),
              });
              injected = true;
            } catch {
              void 0;
            }
          }
          if (!injected) {
            attached.push(promptFragments.stickerNoIngest(sk.emoji ?? null, sk.file_unique_id));
          }
        }
      } else if (kind === "video") {
        attached.push(promptFragments.videoSticker(sk.emoji ?? null));
      } else {
        attached.push(promptFragments.animatedSticker(sk.emoji ?? null));
      }
    }

    if (attached.length > 0) {
      parts.push(
        `${promptFragments.attachedHeader}\n${attached.join("\n")}\n${promptFragments.attachedFooter}`,
      );
    }
    const userText = m.text ?? m.caption ?? "";
    if (userText) parts.push(userText);
    if (parts.length === 1 && images.length === 0) {
      return null;
    }

    return {
      ctx,
      promptText: parts.join("\n\n"),
      images,
      replyToMessageId: m.message_id,
    };
  }

  private async runTurn(item: QueueItem, controller: AbortController): Promise<void> {
    const ctx = item.ctx;
    const chatId = ctx.chat!.id;
    const threadId = ctx.message?.message_thread_id;

    this.activeTurn = {
      chatId,
      threadId: threadId ?? 0,
      ...(item.replyToMessageId !== undefined ? { replyToMessageId: item.replyToMessageId } : {}),
    };
    this.currentTurnAttachments = [];

    const cfg = await this.opts.configStore.load();
    const streamer = new Streamer({
      client: rateLimited(ctx.api as any, this.rateLimiter, chatId),
      chatId,
      threadId: threadId ?? 0,
      throttleMs: 3000,

      showToolFooter: cfg.showToolFooter,
      ...(item.replyToMessageId !== undefined ? { replyToOnFirst: item.replyToMessageId } : {}),
    });
    this.activeStreamer = streamer;
    streamer.beginTurn();

    const sendTyping = async (): Promise<void> => {
      try {
        const opts: { message_thread_id?: number } = {};
        if (threadId !== undefined && threadId > 0) opts.message_thread_id = threadId;
        await (ctx.api as any).sendChatAction(chatId, "typing", opts);
      } catch {
        void 0;
      }
    };
    void sendTyping();
    const typingTimer = setInterval(() => {
      void sendTyping();
    }, 4000);

    const turnEnded = new Promise<void>((resolve) => {
      this.turnEndResolver = resolve;
    });

    const stopHandler = () => {
      streamer.appendStopMarker().catch(() => undefined);
    };
    if (!controller.signal.aborted) {
      controller.signal.addEventListener("abort", stopHandler);
    }

    try {
      if (item.images.length > 0) {
        const content: UserMessageContent[] = [
          { type: "text", text: item.promptText },
          ...item.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
        ];
        this.opts.pi.sendUserMessage(content);
      } else {
        this.opts.pi.sendUserMessage(item.promptText);
      }
      const timeout = new Promise<void>((res) => setTimeout(res, 10 * 60_000));
      await Promise.race([turnEnded, timeout]);
      // Stop the typing-indicator pings BEFORE flushing the final reply — otherwise the
      // 4s tick can fire concurrently with sendMessage and the user briefly sees
      // "typing…" overlap with the just-arrived message.
      clearInterval(typingTimer);
      await streamer.flush();
      await streamer.finalize();
      if (this.currentTurnAttachments.length > 0) {
        await this.sendQueuedAttachments(ctx, chatId, threadId);
      }
    } catch (err) {
      this.opts.cliLog(`runTurn error: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      clearInterval(typingTimer);
      controller.signal.removeEventListener("abort", stopHandler);
      this.activeStreamer = null;
      this.activeTurn = null;
      this.currentTurnAttachments = [];
      this.turnEndResolver = null;
    }
  }

  private async sendQueuedAttachments(
    ctx: Context,
    chatId: number,
    threadId: number | undefined,
  ): Promise<void> {
    const api = ctx.api as any;
    const threadOpt =
      threadId !== undefined && threadId > 0 ? { message_thread_id: threadId } : {};
    const cfg = await this.opts.configStore.load();
    const maxOutBytes = cfg.limits.maxOutgoingFileMb * 1024 * 1024;
    for (const att of this.currentTurnAttachments) {
      try {
        await this.rateLimiter.wait(chatId);
        if (att.kind === "sticker") {
          await api.sendSticker(chatId, att.fileId, { ...threadOpt });
          continue;
        }
        const st = await stat(att.absPath);
        if (st.size > maxOutBytes) {
          throw new Error(
            `file_too_large: ${(st.size / 1024 / 1024).toFixed(1)} MB exceeds maxOutgoingFileMb=${cfg.limits.maxOutgoingFileMb}`,
          );
        }
        const lower = att.absPath.toLowerCase();
        const isImage = /\.(jpe?g|png|webp|gif)$/i.test(lower);
        const isVideo = /\.(mp4|mov|m4v)$/i.test(lower);
        const isVoice = /\.ogg$/i.test(lower);
        const isAudio = /\.(mp3|m4a|flac|wav)$/i.test(lower);
        const file = new InputFile(att.absPath);
        if (isImage) {
          await api.sendPhoto(chatId, file, { ...threadOpt });
        } else if (isVideo) {
          await api.sendVideo(chatId, file, { ...threadOpt });
        } else if (isVoice) {
          await api.sendVoice(chatId, file, { ...threadOpt });
        } else if (isAudio) {
          await api.sendAudio(chatId, file, { ...threadOpt });
        } else {
          await api.sendDocument(chatId, file, { ...threadOpt });
        }
      } catch (err) {
        const label =
          att.kind === "sticker"
            ? `sticker ${att.fileId.slice(0, 12)}…`
            : att.absPath.split("/").pop() ?? "file";
        const errMsg = (err as Error)?.message ?? String(err);
        this.opts.cliLog(`failed to send ${label}: ${errMsg}`);
        try {
          await api.sendMessage(
            chatId,
            streamerMarkers.attachmentSendFailureSuffix(label, errMsg),
            { parse_mode: "HTML", ...threadOpt },
          );
        } catch {
          void 0;
        }
      }
    }
  }
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
