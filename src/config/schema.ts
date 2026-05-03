import { Type, type Static } from "@sinclair/typebox";

export const PendingPairCodeSchema = Type.Object({
  code: Type.String({ minLength: 6, maxLength: 6 }),
  expiresAt: Type.Number(),
  attempts: Type.Number({ minimum: 0 }),
});

/**
 * Single-user, DM-only config schema (v2).
 *
 * v1 had policies, allowlists, group settings, per-session paths, and a bunch of
 * limits we never wired up. v2 strips all of that to the essentials: bot token,
 * owner, pairing code, and the two limits actually consumed by the runtime.
 *
 * v1 → v2 migration is performed by ConfigStore.load(): only botToken, owner,
 * and pendingPairCode are carried over; everything else is dropped.
 */
export const ConfigSchema = Type.Object({
  version: Type.Literal(2),
  botToken: Type.Union([Type.String(), Type.Null()]),
  owner: Type.Union([Type.Number(), Type.Null()]),
  pendingPairCode: Type.Union([PendingPairCodeSchema, Type.Null()]),
  /**
   * If true, after the agent's text reply finalizes, append a footer listing
   * every tool call that ran during the turn (✅/🚫 + name + JSON args).
   * If false (default), the footer is omitted from the final message; the
   * "Thinking…" header during the pre-reply phase is shown either way.
   */
  showToolFooter: Type.Boolean(),
  limits: Type.Object({
    /** Cloud Bot API getFile is hard-capped at 20 MB. Larger inbound files are skipped. */
    maxIncomingFileMb: Type.Number(),
    /** Cloud Bot API send-document upload limit is 50 MB; photo is 10 MB; video varies. */
    maxOutgoingFileMb: Type.Number(),
    /** Per-chat FIFO depth (single-user single-chat: rarely matters). */
    maxQueueDepth: Type.Number(),
  }),
});

export type Config = Static<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  version: 2,
  botToken: null,
  owner: null,
  pendingPairCode: null,
  showToolFooter: false,
  limits: {
    maxIncomingFileMb: 20,
    maxOutgoingFileMb: 50,
    maxQueueDepth: 32,
  },
};
