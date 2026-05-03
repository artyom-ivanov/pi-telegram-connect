export type ChatId = number;
export type UserId = number;
export type MessageId = number;
export type ThreadId = number;
export type SessionKey = `${ChatId}:${ThreadId}`;

export const sessionKey = (chatId: ChatId, threadId: ThreadId | undefined): SessionKey =>
  `${chatId}:${threadId ?? 0}`;

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}
