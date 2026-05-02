import type { Config } from "../config/schema.js";

export interface AccessInput {
  config: Config;
  chatType: "private" | "group" | "supergroup" | "channel";
  chatId: number;
  threadId: number;
  senderId: number;
  isReplyToBot: boolean;
  hasMentionOfBot: boolean;
  isPairingCodeAttempt: boolean;
  draining?: boolean;
}

export type AccessDecision =
  | { decision: "allow" }
  | { decision: "drop" }
  | { decision: "pair" };

export function evaluateAccess(input: AccessInput): AccessDecision {
  if (input.draining) return { decision: "drop" };

  if (input.chatType === "private") {
    const policy = input.config.policies.dm;
    if (policy === "disabled") return { decision: "drop" };
    if (policy === "pairing") {
      if (input.isPairingCodeAttempt && input.config.pendingPairCode !== null) {
        return { decision: "pair" };
      }
      return { decision: "drop" };
    }
    if (policy === "open") return { decision: "allow" };
    if (policy === "allowlist") {
      return input.config.allowedUsers.includes(input.senderId)
        ? { decision: "allow" }
        : { decision: "drop" };
    }
    return { decision: "drop" };
  }

  if (input.chatType === "group" || input.chatType === "supergroup") {
    const groupPolicy = input.config.policies.group;
    if (groupPolicy === "disabled") return { decision: "drop" };
    if (groupPolicy === "allowlist" && !input.config.allowedGroups.includes(input.chatId)) {
      return { decision: "drop" };
    }
    const settings =
      input.config.groupSettings[String(input.chatId)] ?? input.config.groupDefaults;
    const mode = settings.replyMode;
    if (mode === "owner") {
      return input.senderId === input.config.owner
        ? { decision: "allow" }
        : { decision: "drop" };
    }
    if (mode === "mention") {
      return input.hasMentionOfBot || input.isReplyToBot
        ? { decision: "allow" }
        : { decision: "drop" };
    }
    if (mode === "all") return { decision: "allow" };
    return { decision: "drop" };
  }

  return { decision: "drop" };
}
