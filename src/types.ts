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
