import { sessionKey, type SessionKey } from "../types.js";

export interface RoutableUpdate {
  chat: { id: number };
  message_thread_id?: number;
}

export function routeKey(update: RoutableUpdate): SessionKey {
  return sessionKey(update.chat.id, update.message_thread_id);
}
