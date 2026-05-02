import { Type, type Static } from "@sinclair/typebox";

export const PolicyDm = Type.Union([
  Type.Literal("pairing"),
  Type.Literal("allowlist"),
  Type.Literal("open"),
  Type.Literal("disabled"),
]);

export const PolicyGroup = Type.Union([
  Type.Literal("allowlist"),
  Type.Literal("open"),
  Type.Literal("disabled"),
]);

export const ReplyMode = Type.Union([
  Type.Literal("owner"),
  Type.Literal("mention"),
  Type.Literal("all"),
]);

export const ReplyFrequency = Type.Union([
  Type.Literal("rare"),
  Type.Literal("medium"),
  Type.Literal("often"),
]);

export const PendingPairCodeSchema = Type.Object({
  code: Type.String({ minLength: 6, maxLength: 6 }),
  expiresAt: Type.Number(),
  attempts: Type.Number({ minimum: 0 }),
});

export const ConfigSchema = Type.Object({
  version: Type.Literal(1),
  botToken: Type.Union([Type.String(), Type.Null()]),
  owner: Type.Union([Type.Number(), Type.Null()]),
  pendingPairCode: Type.Union([PendingPairCodeSchema, Type.Null()]),
  policies: Type.Object({ dm: PolicyDm, group: PolicyGroup }),
  allowedUsers: Type.Array(Type.Number()),
  allowedGroups: Type.Array(Type.Number()),
  groupDefaults: Type.Object({ replyMode: ReplyMode, replyFrequency: ReplyFrequency }),
  groupSettings: Type.Record(
    Type.String(),
    Type.Object({ replyMode: ReplyMode, replyFrequency: ReplyFrequency }),
  ),
  sessions: Type.Record(Type.String(), Type.String()),
  pendingGroupAccess: Type.Record(
    Type.String(),
    Type.Object({ nonce: Type.String(), expiresAt: Type.Number() }),
  ),
  limits: Type.Object({
    maxIncomingFileMb: Type.Number(),
    tmpDir: Type.String(),
    tmpTtlHours: Type.Number(),
    maxQueueDepth: Type.Number(),
    maxLiveSessions: Type.Number(),
    sessionIdleHours: Type.Number(),
    maxVisionCallsPerDay: Type.Number(),
    outboundAllowedRoots: Type.Array(Type.String()),
  }),
});

export type Config = Static<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  version: 1,
  botToken: null,
  owner: null,
  pendingPairCode: null,
  policies: { dm: "pairing", group: "allowlist" },
  allowedUsers: [],
  allowedGroups: [],
  groupDefaults: { replyMode: "mention", replyFrequency: "medium" },
  groupSettings: {},
  sessions: {},
  pendingGroupAccess: {},
  limits: {
    maxIncomingFileMb: 20,
    tmpDir: "~/.pi/agent/tmp/telegram",
    tmpTtlHours: 168,
    maxQueueDepth: 32,
    maxLiveSessions: 256,
    sessionIdleHours: 24,
    maxVisionCallsPerDay: 100,
    outboundAllowedRoots: ["~/.pi/agent/tmp"],
  },
};

export const StickerCacheSchema = Type.Object({
  version: Type.Literal(1),
  entries: Type.Record(
    Type.String(),
    Type.Object({
      emoji: Type.String(),
      description: Type.String(),
      describedAt: Type.Number(),
    }),
  ),
  visionCallsToday: Type.Object({
    date: Type.String(), // YYYY-MM-DD UTC
    count: Type.Number(),
  }),
});

export type StickerCache = Static<typeof StickerCacheSchema>;

export const DEFAULT_STICKER_CACHE: StickerCache = {
  version: 1,
  entries: {},
  visionCallsToday: { date: "1970-01-01", count: 0 },
};
