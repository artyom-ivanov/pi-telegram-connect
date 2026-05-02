import type { ChatId, ThreadId, MessageId } from "../types.js";
import { mdToHtml, htmlToPlain } from "./Formatter.js";
import { classifySkip } from "./InlineTags.js";

export interface TelegramSendCalls {
  sendMessage(args: {
    chat_id: number;
    message_thread_id?: number;
    text: string;
    parse_mode?: "HTML";
    reply_parameters?: { message_id: number };
  }): Promise<{ message_id: number }>;
  editMessageText(args: {
    chat_id: number;
    message_id: number;
    text: string;
    parse_mode?: "HTML";
  }): Promise<true>;
}

export interface StreamerOptions {
  client: TelegramSendCalls;
  chatId: ChatId;
  threadId: ThreadId;
  throttleMs: number;
  ageResetMs: number;
  maxTextLen?: number;
  replyToOnFirst?: MessageId;
}

type StreamerState = "IDLE" | "DECIDING_SKIP" | "BUFFERING" | "FINALIZING" | "DONE";

export class Streamer {
  private state: StreamerState = "IDLE";
  private bodyBuffer = "";
  private toolActive: { name: string; argsSummary: string } | null = null;
  private previewMessageId: MessageId | null = null;
  private previewCreatedAt = 0;
  private pendingEditTimer: NodeJS.Timeout | null = null;
  private inFlightEdit: Promise<unknown> | null = null;
  private skipDecisionBuffer = "";
  private skipResolved = false;
  private skipConfirmed = false;
  private opts: Required<StreamerOptions>;

  constructor(opts: StreamerOptions) {
    this.opts = {
      maxTextLen: 4000,
      replyToOnFirst: 0,
      ...opts,
    } as Required<StreamerOptions>;
  }

  beginTurn(): void {
    this.state = "DECIDING_SKIP";
    this.bodyBuffer = "";
    this.toolActive = null;
    this.previewMessageId = null;
    this.previewCreatedAt = 0;
    this.pendingEditTimer = null;
    this.inFlightEdit = null;
    this.skipDecisionBuffer = "";
    this.skipResolved = false;
    this.skipConfirmed = false;
  }

  appendDelta(delta: string): void {
    if (this.state === "DONE") return;
    if (!this.skipResolved) {
      this.skipDecisionBuffer += delta;
      const verdict = classifySkip(this.skipDecisionBuffer, false);
      if (verdict === "skip") {
        this.skipConfirmed = true;
        this.skipResolved = true;
        return;
      }
      if (verdict === "not-skip") {
        this.skipResolved = true;
        this.bodyBuffer += this.skipDecisionBuffer;
        this.skipDecisionBuffer = "";
        this.scheduleEdit();
        return;
      }
      return;
    }
    this.bodyBuffer += delta;
    this.scheduleEdit();
  }

  toolStart(name: string, argsSummary: string): void {
    this.toolActive = { name, argsSummary };
    if (this.skipResolved && !this.skipConfirmed) this.scheduleEdit(true);
  }

  toolEnd(_name: string): void {
    this.toolActive = null;
    if (this.skipResolved && !this.skipConfirmed) this.scheduleEdit(true);
  }

  private renderBody(): string {
    let s = this.bodyBuffer;
    if (this.toolActive) {
      s += `\n\n_⚙️ running: ${this.toolActive.name}(${this.toolActive.argsSummary})_`;
    }
    return s;
  }

  private scheduleEdit(immediate = false): void {
    if (this.skipConfirmed) return;
    if (this.pendingEditTimer) clearTimeout(this.pendingEditTimer);
    if (immediate) {
      this.pendingEditTimer = null;
      void this.fireEdit();
      return;
    }
    this.pendingEditTimer = setTimeout(() => {
      this.pendingEditTimer = null;
      void this.fireEdit();
    }, this.opts.throttleMs);
  }

  private async fireEdit(): Promise<void> {
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);
    const text = this.renderBody();
    if (text.length === 0) return;
    let html: string;
    try {
      html = mdToHtml(text);
    } catch {
      html = text;
    }
    if (this.previewMessageId === null) {
      const args: Parameters<TelegramSendCalls["sendMessage"]>[0] = {
        chat_id: this.opts.chatId,
        text: html,
        parse_mode: "HTML",
      };
      if (this.opts.threadId > 0) args.message_thread_id = this.opts.threadId;
      if (this.opts.replyToOnFirst > 0) args.reply_parameters = { message_id: this.opts.replyToOnFirst };
      this.inFlightEdit = this.opts.client.sendMessage(args).then((r) => {
        this.previewMessageId = r.message_id;
        this.previewCreatedAt = Date.now();
      }).catch((err) => this.tryHtmlFallback(text, err));
    } else {
      const messageId = this.previewMessageId;
      this.inFlightEdit = this.opts.client.editMessageText({
        chat_id: this.opts.chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
      }).catch((err) => this.tryHtmlFallback(text, err, messageId));
    }
    await this.inFlightEdit;
  }

  private async tryHtmlFallback(text: string, err: unknown, editMessageId?: number): Promise<void> {
    const msg = (err as { description?: string } | undefined)?.description ?? "";
    if (/can't parse entities/i.test(msg)) {
      const plain = htmlToPlain(text);
      if (editMessageId) {
        await this.opts.client.editMessageText({
          chat_id: this.opts.chatId,
          message_id: editMessageId,
          text: plain,
        }).catch(() => undefined);
      } else {
        const args: Parameters<TelegramSendCalls["sendMessage"]>[0] = {
          chat_id: this.opts.chatId,
          text: plain,
        };
        if (this.opts.threadId > 0) args.message_thread_id = this.opts.threadId;
        const r = await this.opts.client.sendMessage(args).catch(() => null);
        if (r) {
          this.previewMessageId = r.message_id;
          this.previewCreatedAt = Date.now();
        }
      }
      return;
    }
    if (/message is not modified/i.test(msg)) return;
  }

  async flush(): Promise<void> {
    if (this.skipConfirmed) return;
    if (this.pendingEditTimer) {
      clearTimeout(this.pendingEditTimer);
      this.pendingEditTimer = null;
    }
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);
    if (!this.skipResolved && this.skipDecisionBuffer.length > 0) {
      const verdict = classifySkip(this.skipDecisionBuffer, true);
      if (verdict === "skip") {
        this.skipConfirmed = true;
        this.skipResolved = true;
        return;
      }
      this.bodyBuffer += this.skipDecisionBuffer;
      this.skipDecisionBuffer = "";
      this.skipResolved = true;
    }
    if (this.bodyBuffer.trim().length === 0 && !this.toolActive) return;
    await this.fireEdit();
  }

  async finalize(): Promise<void> {
    if (this.state === "DONE") return;
    this.state = "FINALIZING";
    if (this.skipConfirmed) {
      this.state = "DONE";
      return;
    }
    await this.flush();
    this.state = "DONE";
  }

  async appendStopMarker(): Promise<void> {
    if (this.skipConfirmed) {
      this.state = "DONE";
      return;
    }
    this.toolActive = null;
    this.bodyBuffer += "\n\n_⏹ stopped_";
    await this.flush();
    this.state = "DONE";
  }
}
