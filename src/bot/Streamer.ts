import type { ChatId, ThreadId, MessageId } from "../types.js";
import { mdToHtml, htmlToPlain } from "./Formatter.js";

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
  /** Cut threshold for splitting overlong messages. Telegram hard limit is 4096; we leave headroom for HTML expansion. */
  maxTextLen?: number;
  replyToOnFirst?: MessageId;
}

type StreamerState = "IDLE" | "DECIDING_SKIP" | "BUFFERING" | "FINALIZING" | "DONE";

const SKIP_LITERAL = "[[skip]]";

/**
 * Classify a streaming text buffer for early `[[skip]]` detection.
 *
 * Returns:
 *   - "skip": confirmed skip — buffer is exactly `[[skip]]` followed by EOF or whitespace
 *   - "not-skip": buffer no longer prefix-matches `[[skip]` — proceed normally
 *   - "undecided": need more bytes
 */
function classifySkip(buffer: string, streamEnded: boolean): "skip" | "not-skip" | "undecided" {
  const trimmed = buffer.replace(/^\s+/, "");
  if (trimmed.length === 0) {
    return streamEnded ? "not-skip" : "undecided";
  }
  if (trimmed.startsWith(SKIP_LITERAL)) {
    const rest = trimmed.slice(SKIP_LITERAL.length);
    if (rest.trim().length === 0) return "skip";
    return "not-skip";
  }
  if (SKIP_LITERAL.startsWith(trimmed) && trimmed.length < SKIP_LITERAL.length) {
    return streamEnded ? "not-skip" : "undecided";
  }
  return "not-skip";
}

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
  /** Last text successfully sent to the current preview message. Used for short-circuiting identical re-sends. */
  private lastSentText = "";
  /**
   * Number of chars at the start of `bodyBuffer` that have already been "committed" to a previous
   * (now finalized) Telegram message via the 4096-overflow split path. The current message's text
   * is `bodyBuffer.slice(committedOffset)`. Each successful split increments this and resets
   * previewMessageId so the next fireEdit creates a new continuation message.
   */
  private committedOffset = 0;
  private opts: Required<StreamerOptions>;

  constructor(opts: StreamerOptions) {
    this.opts = {
      maxTextLen: 3800,
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
    this.lastSentText = "";
    this.committedOffset = 0;
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

  /** Render the current message text — what the active preview should show right now. */
  private renderCurrent(): string {
    let s = this.bodyBuffer.slice(this.committedOffset);
    if (this.toolActive) {
      s += `\n\n_⚙️ running: ${this.toolActive.name}(${this.toolActive.argsSummary})_`;
    }
    return s;
  }

  private scheduleEdit(immediate = false): void {
    if (this.skipConfirmed) return;
    if (immediate) {
      if (this.pendingEditTimer) {
        clearTimeout(this.pendingEditTimer);
        this.pendingEditTimer = null;
      }
      void this.fireEdit();
      return;
    }
    // Periodic throttle: first delta schedules an edit; subsequent deltas accumulate
    // in bodyBuffer and ride the same scheduled edit. After it fires, the next delta
    // schedules again.
    if (this.pendingEditTimer) return;
    this.pendingEditTimer = setTimeout(() => {
      this.pendingEditTimer = null;
      void this.fireEdit();
    }, this.opts.throttleMs);
  }

  /**
   * Pick a split point for the current message text so the segment ≤ maxTextLen.
   * Prefer (in order): paragraph break, sentence end, single newline, hard cut.
   */
  private findSplitIndex(text: string): number {
    const max = this.opts.maxTextLen;
    if (text.length <= max) return text.length;
    // Search backward from max for a clean break.
    const slice = text.slice(0, max);
    const paragraph = slice.lastIndexOf("\n\n");
    if (paragraph > max * 0.5) return paragraph + 2;
    const sentence = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
    if (sentence > max * 0.5) return sentence + 2;
    const newline = slice.lastIndexOf("\n");
    if (newline > max * 0.5) return newline + 1;
    const space = slice.lastIndexOf(" ");
    if (space > max * 0.5) return space + 1;
    return max;
  }

  private async fireEdit(): Promise<void> {
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);
    let text = this.renderCurrent();
    if (text.length === 0) return;

    // Overflow split: if the current segment exceeds maxTextLen, finalize it at a safe
    // boundary (no tool indicator on the finalized chunk), bump committedOffset, reset
    // previewMessageId so the remainder goes into a new continuation message, then loop.
    if (text.length > this.opts.maxTextLen) {
      const bodySegment = this.bodyBuffer.slice(this.committedOffset);
      const splitInBody = this.findSplitIndex(bodySegment);
      const finalChunk = bodySegment.slice(0, splitInBody);
      await this.sendOrEdit(finalChunk);
      this.committedOffset += splitInBody;
      this.previewMessageId = null;
      this.lastSentText = "";
      // Continue with the remainder if any.
      const remainder = this.renderCurrent();
      if (remainder.length === 0) return;
      text = remainder;
    }

    if (text === this.lastSentText) return;
    await this.sendOrEdit(text);
  }

  private async sendOrEdit(text: string): Promise<void> {
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
      this.inFlightEdit = this.opts.client
        .sendMessage(args)
        .then((r) => {
          this.previewMessageId = r.message_id;
          this.previewCreatedAt = Date.now();
          this.lastSentText = text;
        })
        .catch((err) => this.tryHtmlFallback(text, err));
    } else {
      const messageId = this.previewMessageId;
      this.inFlightEdit = this.opts.client
        .editMessageText({
          chat_id: this.opts.chatId,
          message_id: messageId,
          text: html,
          parse_mode: "HTML",
        })
        .then(() => {
          this.lastSentText = text;
        })
        .catch((err) => this.tryHtmlFallback(text, err, messageId));
    }
    await this.inFlightEdit;
  }

  private async tryHtmlFallback(text: string, err: unknown, editMessageId?: number): Promise<void> {
    const msg = (err as { description?: string } | undefined)?.description ?? "";
    if (/can't parse entities/i.test(msg)) {
      const plain = htmlToPlain(text);
      if (editMessageId) {
        await this.opts.client
          .editMessageText({
            chat_id: this.opts.chatId,
            message_id: editMessageId,
            text: plain,
          })
          .catch(() => undefined);
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
    if (this.bodyBuffer.slice(this.committedOffset).trim().length === 0 && !this.toolActive) return;
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

  /** Append an error marker and finalize. Used when the agent errors out mid-turn. */
  async appendErrorMarker(message: string): Promise<void> {
    if (this.skipConfirmed) {
      this.state = "DONE";
      return;
    }
    this.toolActive = null;
    const safe = message.replace(/[\r\n]+/g, " ").slice(0, 200);
    this.bodyBuffer += `\n\n_⚠️ error: ${safe}_`;
    await this.flush();
    this.state = "DONE";
  }
}
