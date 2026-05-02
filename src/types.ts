import type { Static, TSchema } from "@sinclair/typebox";

/** Telegram identifiers. */
export type ChatId = number;
export type UserId = number;
export type MessageId = number;
export type ThreadId = number; // 0 for non-forum / DM
export type SessionKey = `${ChatId}:${ThreadId}`;

export const sessionKey = (chatId: ChatId, threadId: ThreadId | undefined): SessionKey =>
  `${chatId}:${threadId ?? 0}`;

/** Image content shape compatible with @mariozechner/pi-ai. */
export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}

/** Events streamed from an AgentSession (subset of pi-coding-agent events we care about). */
export type SessionEvent =
  | { type: "message_update"; delta: { text?: string; thinking?: string } }
  | { type: "tool_execution_start"; toolName: string; argsSummary: string }
  | { type: "tool_execution_update"; toolName: string; output: string }
  | { type: "tool_execution_end"; toolName: string; ok: boolean }
  | { type: "message_end" }
  | { type: "turn_end" };

/** Tool result shape returned to the agent from telegram_send_*. */
export type ToolErrorCode =
  | "file_not_found"
  | "file_too_large"
  | "unsupported_type"
  | "path_outside_sandbox"
  | "telegram_api_error"
  | "invalid_format";

export type ToolResult =
  | { ok: true; messageId: MessageId }
  | { ok: false; error: ToolErrorCode };

/** Inline tag parse result. */
export interface InlineTagsParse {
  text: string; // input with tags stripped
  replyToMessageId: MessageId | null; // from [[reply_to:N]] or [[reply_to_current]] (resolved later)
  replyToCurrent: boolean;
  skip: boolean;
}

/** Re-export typebox helpers. */
export type Schema<T extends TSchema> = Static<T>;
