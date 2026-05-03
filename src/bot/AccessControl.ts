import type { Config } from "../config/schema.js";

export interface AccessInput {
  config: Config;
  chatType: "private" | "group" | "supergroup" | "channel";
  senderId: number;
  isPairingCodeAttempt: boolean;
  draining?: boolean;
}

export type AccessDecision = { decision: "allow" } | { decision: "drop" } | { decision: "pair" };

/**
 * Single-user, DM-only policy.
 *
 * - Non-private chats (groups, supergroups, channels): silently drop.
 * - DM with `pendingPairCode` set AND the message looks like a pair attempt: route to pairing.
 * - DM from owner: allow.
 * - Anything else (DM from non-owner before/after pairing): silently drop.
 */
export function evaluateAccess(input: AccessInput): AccessDecision {
  if (input.draining) return { decision: "drop" };
  if (input.chatType !== "private") return { decision: "drop" };
  if (input.config.pendingPairCode !== null && input.isPairingCodeAttempt) {
    return { decision: "pair" };
  }
  if (input.config.owner !== null && input.senderId === input.config.owner) {
    return { decision: "allow" };
  }
  return { decision: "drop" };
}
