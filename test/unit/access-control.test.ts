import { describe, it, expect } from "vitest";
import { evaluateAccess, type AccessInput } from "../../src/bot/AccessControl.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";

const baseInput = (overrides: Partial<AccessInput>): AccessInput => ({
  config: structuredClone(DEFAULT_CONFIG),
  chatType: "private",
  senderId: 12345,
  isPairingCodeAttempt: false,
  ...overrides,
});

describe("AccessControl.evaluateAccess (single-user, DM-only)", () => {
  it("drops everything when draining", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.owner = 12345;
    expect(evaluateAccess(baseInput({ config: cfg, draining: true })).decision).toBe("drop");
  });

  it("non-private chats are silently dropped (group, supergroup, channel)", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.owner = 12345;
    expect(evaluateAccess(baseInput({ config: cfg, chatType: "group" })).decision).toBe("drop");
    expect(evaluateAccess(baseInput({ config: cfg, chatType: "supergroup" })).decision).toBe("drop");
    expect(evaluateAccess(baseInput({ config: cfg, chatType: "channel" })).decision).toBe("drop");
  });

  it("DM from owner → allow", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.owner = 12345;
    expect(evaluateAccess(baseInput({ config: cfg, senderId: 12345 })).decision).toBe("allow");
  });

  it("DM from non-owner → drop", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.owner = 12345;
    expect(evaluateAccess(baseInput({ config: cfg, senderId: 99999 })).decision).toBe("drop");
  });

  it("DM with pending pair code + this looks like a code attempt → pair (regardless of sender)", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.pendingPairCode = { code: "abcDEF", expiresAt: Date.now() + 60000, attempts: 0 };
    const input = baseInput({ config: cfg, senderId: 99999, isPairingCodeAttempt: true });
    expect(evaluateAccess(input).decision).toBe("pair");
  });

  it("DM with pending pair code but not a code attempt → drop", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.pendingPairCode = { code: "abcDEF", expiresAt: Date.now() + 60000, attempts: 0 };
    const input = baseInput({ config: cfg, senderId: 99999, isPairingCodeAttempt: false });
    expect(evaluateAccess(input).decision).toBe("drop");
  });

  it("DM before any pairing AND no pending code → drop", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    expect(evaluateAccess(baseInput({ config: cfg })).decision).toBe("drop");
  });
});
