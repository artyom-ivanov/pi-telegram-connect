import type { ChatId, ThreadId, MessageId } from "../types.js";
import { streamerMarkers, type ToolHistoryEntry } from "../config/prompts.js";
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
  /** Cut threshold for splitting overlong messages. Telegram hard limit is 4096; we leave headroom for HTML expansion. */
  maxTextLen?: number;
  replyToOnFirst?: MessageId;
  /** When true, append the tool-call history below the body in the final message. */
  showToolFooter?: boolean;
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
  /**
   * Running history of tool calls in the CURRENT turn. Entries are appended on
   * tool_execution_start and updated to "done"/"error" on tool_execution_end.
   * - While !hasReplyText: shown as a "Thinking…" header ABOVE the (empty) body so
   *   the user sees what the agent is doing during the pre-reply phase.
   * - Once the agent starts streaming text (hasReplyText=true): the header disappears.
   *   At finalize, if `opts.showToolFooter`, the history is rendered as a footer below
   *   the body; otherwise it's omitted from the final message.
   */
  private toolHistory: ToolHistoryEntry[] = [];
  /** Flips true on the first non-empty `appendDelta` after skip resolution. */
  private hasReplyText = false;
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
      showToolFooter: false,
      ...opts,
    } as Required<StreamerOptions>;
  }

  beginTurn(): void {
    this.state = "DECIDING_SKIP";
    this.bodyBuffer = "";
    this.toolHistory = [];
    this.hasReplyText = false;
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
        if (this.skipDecisionBuffer.length > 0 || this.bodyBuffer.length > 0) {
          this.hasReplyText = true;
        }
        this.scheduleEdit();
        return;
      }
      return;
    }
    this.bodyBuffer += delta;
    if (delta.trim().length > 0) this.hasReplyText = true;
    this.scheduleEdit();
  }

  toolStart(name: string, argsSummary: string): void {
    // A tool firing means the agent is doing real work, not silent-skipping. Force
    // skip resolution if it was still pending — this lets us render the "Thinking…"
    // header even when tools fire before any text delta.
    if (!this.skipResolved) {
      this.skipResolved = true;
      if (this.skipDecisionBuffer.length > 0) {
        this.bodyBuffer += this.skipDecisionBuffer;
        this.skipDecisionBuffer = "";
        if (this.bodyBuffer.trim().length > 0) this.hasReplyText = true;
      }
    }
    this.toolHistory.push({ name, argsSummary, status: "running" });
    this.scheduleEdit(true);
  }

  toolEnd(name: string, ok: boolean = true): void {
    // Find the most recent entry with this name still in "running" state and resolve it.
    for (let i = this.toolHistory.length - 1; i >= 0; i--) {
      const entry = this.toolHistory[i]!;
      if (entry.status === "running" && entry.name === name) {
        entry.status = ok ? "done" : "error";
        break;
      }
    }
    if (this.skipResolved && !this.skipConfirmed) this.scheduleEdit(true);
  }

  /**
   * Render the current message text — what the active preview should show right now.
   *
   * Two modes:
   *   1. Thinking phase (no reply text yet): show "Thinking…" header + tool history.
   *      The body slice is empty in this phase by definition.
   *   2. Reply phase (hasReplyText): show body. Append tool footer iff `showToolFooter`.
   */
  private renderCurrent(): string {
    const body = this.bodyBuffer.slice(this.committedOffset);
    if (!this.hasReplyText) {
      return streamerMarkers.thinkingHeader(this.toolHistory);
    }
    if (this.opts.showToolFooter) {
      return body + streamerMarkers.toolFooter(this.toolHistory);
    }
    return body;
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
        const ok = await this.opts.client
          .editMessageText({
            chat_id: this.opts.chatId,
            message_id: editMessageId,
            text: plain,
          })
          .then(() => true)
          .catch(() => false);
        // Track lastSentText after fallback so the short-circuit in fireEdit prevents
        // re-running the entire fallback path on every subsequent edit in this turn.
        if (ok) this.lastSentText = text;
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
          this.lastSentText = text;
        }
      }
      return;
    }
    // 'message is not modified' = identical content, treat as success — record lastSentText
    // so fireEdit's short-circuit prevents re-trying the same edit forever.
    if (/message is not modified/i.test(msg)) {
      this.lastSentText = text;
      return;
    }
    // Other errors (429, network, "message to edit not found", etc.) are swallowed silently
    // for now — the next delta scheduling will retry; if the message was deleted, the next
    // sendMessage path (previewMessageId === null was already set on rotation) handles it.
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
    if (this.bodyBuffer.slice(this.committedOffset).trim().length === 0 && this.toolHistory.length === 0) return;
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
    if (this.skipConfirmed || this.state === "DONE") {
      this.state = "DONE";
      return;
    }
    // Set DONE synchronously BEFORE awaiting flush. This prevents late `appendDelta`
    // calls (pi takes time to actually abort) from re-mutating bodyBuffer after the
    // stop marker is appended — they'd otherwise overwrite "_⏹ stopped_".
    this.state = "DONE";
    // Resolve any in-flight tool entries so the rendered footer stops showing spinners.
    for (const e of this.toolHistory) if (e.status === "running") e.status = "error";
    this.bodyBuffer += streamerMarkers.stopped;
    // Force render path even if no body text was produced (thinking phase): otherwise
    // renderCurrent would return only the thinking header and the stop marker would be invisible.
    this.hasReplyText = true;
    await this.flush();
  }

  /** Append an error marker and finalize. Used when the agent errors out mid-turn. */
  async appendErrorMarker(message: string): Promise<void> {
    if (this.skipConfirmed || this.state === "DONE") {
      this.state = "DONE";
      return;
    }
    this.state = "DONE";
    for (const e of this.toolHistory) if (e.status === "running") e.status = "error";
    const safe = message.replace(/[\r\n]+/g, " ").slice(0, 200);
    this.bodyBuffer += streamerMarkers.error(safe);
    this.hasReplyText = true;
    await this.flush();
  }
}
