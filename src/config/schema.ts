import { Type, type Static } from "@sinclair/typebox";

export const PendingPairCodeSchema = Type.Object({
  code: Type.String({ minLength: 6, maxLength: 6 }),
  expiresAt: Type.Number(),
  attempts: Type.Number({ minimum: 0 }),
});

export const ConfigSchema = Type.Object({
  version: Type.Literal(2),
  botToken: Type.Union([Type.String(), Type.Null()]),
  owner: Type.Union([Type.Number(), Type.Null()]),
  pendingPairCode: Type.Union([PendingPairCodeSchema, Type.Null()]),
  showToolFooter: Type.Boolean(),
  limits: Type.Object({
    maxIncomingFileMb: Type.Number(),
    maxOutgoingFileMb: Type.Number(),
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
