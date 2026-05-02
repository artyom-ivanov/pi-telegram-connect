import { sessionKey, type SessionKey } from "../types.js";

export interface RoutableUpdate {
  chat: { id: number };
  message_thread_id?: number;
}

/**
 * Derive the session key for a chat:thread.
 *
 * Invariant: Telegram DM chat.id is positive (user_id); group/supergroup chat.id is negative
 * (often -100*); these ranges never overlap, so collision is impossible.
 */
export function routeKey(update: RoutableUpdate): SessionKey {
  return sessionKey(update.chat.id, update.message_thread_id);
}
