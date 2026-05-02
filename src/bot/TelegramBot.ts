import { Bot, type Context } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import type { ConfigStore } from "../config/ConfigStore.js";
import { evaluateAccess } from "./AccessControl.js";
import { MessageQueue } from "./MessageQueue.js";
import { PairingFlow } from "./PairingFlow.js";
import { Streamer } from "./Streamer.js";
import { resolveDestPath, downloadToPath } from "./MediaIngest.js";
import { TelegramRateLimiter } from "../util/ratelimit.js";
import type { Config } from "../config/schema.js";
import type { ImageContent, SessionKey } from "../types.js";
import { expandHome } from "../util/paths.js";

type RunState = "starting" | "running" | "draining" | "stopped";

/** Multimedia message content shape compatible with pi.sendUserMessage. */
export type UserMessageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Pi-side hooks the bot needs from the extension entry. The entry wires these,
 * delegating to pi.sendUserMessage / pi.on via captured `pi: ExtensionAPI`.
 */
export interface PiBridge {
  /** Pi accepts either a plain string or an array of TextContent | ImageContent. */
  sendUserMessage: (content: string | UserMessageContent[]) => void;
  /** Subscribe to message-text deltas. The returned function unsubscribes. */
  onMessageDelta: (cb: (text: string) => void) => () => void;
  onToolStart: (cb: (toolName: string, argsSummary: string) => void) => () => void;
  onToolEnd: (cb: (toolName: string) => void) => () => void;
  /** End-of-turn signal (we treat agent_end and turn_end the same). */
  onTurnEnd: (cb: () => void) => () => void;
  /** Subscribe to agent_start; the callback receives an `abort` thunk that cancels the running pi agent. */
  onAgentStart: (cb: (abort: () => void) => void) => () => void;
  /** Subscribe to agent error events (assistant message ended with stopReason="error"). */
  onAgentError: (cb: (message: string) => void) => () => void;
}

export interface TelegramBotOptions {
  configStore: ConfigStore;
  tmpDir: string;
  cliLog: (msg: string) => void;
  pi: PiBridge;
  /** Optional hook (set by extension entry to install GroupAccess on the live grammy Bot). */
  onBotInit?: (bot: Bot) => void;
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
  /** The streamer for the chat whose message is currently in flight inside the pi session. */
  private activeStreamer: Streamer | null = null;
  /** Resolves when the active turn finishes. Set by runTurn, fulfilled by onTurnEnd. */
  private turnEndResolver: (() => void) | null = null;
  /** Files queued by the agent (via telegram_attach tool) during the current turn.
   *  Sent to the active chat after the streamer finalizes. */
  private currentTurnAttachments: string[] = [];
  /** Active turn context — set in runTurn so tools can target the right chat. */
  private activeTurn: { chatId: number; threadId: number; replyToMessageId?: number } | null = null;
  /** Abort thunk for the currently-running pi agent loop, captured via agent_start. Cleared on turn_end. */
  private currentAgentAbort: (() => void) | null = null;

  /** Single global FIFO key — single-session model. */
  private static readonly GLOBAL_KEY: SessionKey = "0:0";

  /** Pi-side event subscriptions; established on start, torn down on stop. */
  private piUnsubs: Array<() => void> = [];

  constructor(private opts: TelegramBotOptions) {}

  isRunning(): boolean {
    return this.state === "running";
  }

  /** True while a Telegram-originated turn is being processed. Used by telegram_attach tool. */
  isInTurn(): boolean {
    return this.activeTurn !== null;
  }

  /** Queue a file path to be sent to the active chat after the current turn finalizes. */
  queueAttachment(absPath: string): void {
    if (!this.activeTurn) {
      throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
    }
    if (this.currentTurnAttachments.length >= 10) {
      throw new Error("attachment limit reached (10 per turn)");
    }
    this.currentTurnAttachments.push(absPath);
  }

  async start(token: string): Promise<void> {
    if (this.state !== "stopped") throw new Error(`bot already in state ${this.state}`);
    this.state = "starting";
    const cfg = await this.opts.configStore.load();
    cfg.botToken = token;
    await this.opts.configStore.save(cfg);

    this.bot = new Bot(token);
    if (this.opts.onBotInit) {
      try {
        this.opts.onBotInit(this.bot);
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

    // Wire pi-side subscriptions. Deltas/tool/turn-end events route to the currently active streamer.
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
      this.opts.pi.onToolEnd((name) => {
        this.activeStreamer?.toolEnd(name);
      }),
    );
    this.piUnsubs.push(
      this.opts.pi.onTurnEnd(() => {
        // Pi agent has finished a turn — its abort thunk is no longer relevant.
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

      const lower = trimmed.toLowerCase();
      if (lower === "/stop") {
        this.handleStop();
        return;
      }
      if (lower === "/reset") {
        // Single-session model: /reset is informational. Real reset would require pi-CLI side.
        await ctx.reply("Sorry, /reset is not supported in V1 (single-session bridge). Use pi-CLI to reset.");
        return;
      }

      const item = await this.normalizeMessage(ctx, cfgNow);
      if (!item) return;
      this.queue!.enqueue(TelegramBot.GLOBAL_KEY, item);
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
    for (const off of this.piUnsubs) off();
    this.piUnsubs = [];
    this.runner = null;
    this.bot = null;
    this.queue = null;
    this.activeStreamer = null;
    this.state = "stopped";
    this.opts.cliLog(`Bot stopped.`);
  }

  private handleStop(): void {
    this.queue?.abortAndClear(TelegramBot.GLOBAL_KEY);
    // Cancel the pi agent loop if one is running. Without this, the agent keeps
    // working in pi-CLI even though we're done caring about its output.
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
      `[telegram chat=${ctx.chat!.id}${m.message_thread_id ? `:${m.message_thread_id}` : ""} from=${ctx.from?.id ?? "?"}]`,
    );
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
      if (kind === "static") {
        // Static stickers are .webp images. Send to the agent as image content
        // so its vision capability sees the sticker directly. Also keep an emoji
        // hint in text for context.
        const dest = await downloadFile(sk.file_id, sk.file_unique_id, "sticker.webp");
        let injected = false;
        if (dest) {
          try {
            const { readFile } = await import("node:fs/promises");
            const buf = await readFile(dest);
            images.push({ type: "image", data: buf.toString("base64"), mimeType: "image/webp" });
            attached.push(`[user sent a static sticker (emoji hint: ${sk.emoji ?? "🎴"})]`);
            injected = true;
          } catch {
            // fall through to text-only
          }
        }
        if (!injected) {
          attached.push(`[user sent sticker (emoji: ${sk.emoji ?? "🎴"})]`);
        }
      } else if (kind === "video") {
        // Video stickers: don't ship the .webm to the agent (most LLMs don't accept video).
        // We could ffmpeg-extract a frame, but that's StickerCache's job; for V1, emoji-only.
        attached.push(`[user sent a video sticker (emoji: ${sk.emoji ?? "🎴"})]`);
      } else {
        // Lottie animated sticker — emoji-only.
        attached.push(`[user sent an animated sticker (emoji: ${sk.emoji ?? "🎴"})]`);
      }
    }

    if (attached.length > 0) {
      parts.push(`[user attached files]\n${attached.join("\n")}\n[/files]`);
    }
    const userText = m.text ?? m.caption ?? "";
    if (userText) parts.push(userText);
    if (parts.length === 1 && images.length === 0) {
      // only the [telegram chat=...] header — empty input
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

    const streamer = new Streamer({
      client: rateLimited(ctx.api as any, this.rateLimiter, chatId),
      chatId,
      threadId: threadId ?? 0,
      throttleMs: 3000,
      ageResetMs: 60_000,
      ...(item.replyToMessageId !== undefined ? { replyToOnFirst: item.replyToMessageId } : {}),
    });
    this.activeStreamer = streamer;
    streamer.beginTurn();

    // Telegram "typing..." indicator lasts ~5s and must be re-pinged. Send immediately,
    // then every 4s until the turn ends. Forum-topic threads need the message_thread_id.
    const sendTyping = async (): Promise<void> => {
      try {
        const opts: { message_thread_id?: number } = {};
        if (threadId !== undefined && threadId > 0) opts.message_thread_id = threadId;
        await (ctx.api as any).sendChatAction(chatId, "typing", opts);
      } catch {
        // network or 403 (bot blocked) — swallow; the turn will surface the error elsewhere.
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
      // Push the message into the pi session. If we have images (photos, static stickers),
      // use the multimedia array form: pi.sendUserMessage accepts (TextContent | ImageContent)[].
      // Otherwise plain text is fine.
      if (item.images.length > 0) {
        const content: UserMessageContent[] = [
          { type: "text", text: item.promptText },
          ...item.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
        ];
        this.opts.pi.sendUserMessage(content);
      } else {
        this.opts.pi.sendUserMessage(item.promptText);
      }
      // Wait for turn_end. If pi never fires it (shouldn't happen), bound the wait.
      const timeout = new Promise<void>((res) => setTimeout(res, 10 * 60_000));
      await Promise.race([turnEnded, timeout]);
      await streamer.flush();
      await streamer.finalize();
      // After the assistant text is finalized, send any queued attachments.
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
    for (const absPath of this.currentTurnAttachments) {
      try {
        await this.rateLimiter.wait(chatId);
        const lower = absPath.toLowerCase();
        const isImage = /\.(jpe?g|png|webp|gif)$/i.test(lower);
        const isVideo = /\.(mp4|mov|m4v)$/i.test(lower);
        const isVoice = /\.ogg$/i.test(lower);
        const isAudio = /\.(mp3|m4a|flac|wav)$/i.test(lower);
        if (isImage) {
          await api.sendPhoto(chatId, { source: absPath }, { ...threadOpt });
        } else if (isVideo) {
          await api.sendVideo(chatId, { source: absPath }, { ...threadOpt });
        } else if (isVoice) {
          await api.sendVoice(chatId, { source: absPath }, { ...threadOpt });
        } else if (isAudio) {
          await api.sendAudio(chatId, { source: absPath }, { ...threadOpt });
        } else {
          await api.sendDocument(chatId, { source: absPath }, { ...threadOpt });
        }
      } catch (err) {
        this.opts.cliLog(`failed to send attachment ${absPath}: ${(err as Error)?.message ?? err}`);
        // Surface to user (non-blocking, fire-and-forget):
        try {
          await api.sendMessage(
            chatId,
            `_⚠️ failed to send file ${absPath.split("/").pop()}: ${(err as Error)?.message ?? "error"}_`,
            { parse_mode: "HTML", ...threadOpt },
          );
        } catch {
          // ignore
        }
      }
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
