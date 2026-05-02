import { describe, it, expect } from "vitest";
import { evaluateAccess, type AccessInput } from "../../src/bot/AccessControl.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";

const baseInput = (overrides: Partial<AccessInput>): AccessInput => ({
  config: structuredClone(DEFAULT_CONFIG),
  chatType: "private",
  chatId: 12345,
  threadId: 0,
  senderId: 12345,
  isReplyToBot: false,
  hasMentionOfBot: false,
  isPairingCodeAttempt: false,
  ...overrides,
});

describe("AccessControl.evaluateAccess", () => {
  describe("dm policy=pairing", () => {
    it("allows pairing-code attempt regardless of sender", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.dm = "pairing";
      cfg.pendingPairCode = { code: "abc123", expiresAt: Date.now() + 60000, attempts: 0 };
      const input = baseInput({ config: cfg, isPairingCodeAttempt: true });
      expect(evaluateAccess(input).decision).toBe("pair");
    });
    it("drops non-pairing-code text from anyone", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.dm = "pairing";
      const input = baseInput({ config: cfg, isPairingCodeAttempt: false });
      expect(evaluateAccess(input).decision).toBe("drop");
    });
  });

  describe("dm policy=allowlist", () => {
    it("allows user in allowedUsers", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.dm = "allowlist";
      cfg.allowedUsers = [12345];
      expect(evaluateAccess(baseInput({ config: cfg })).decision).toBe("allow");
    });
    it("drops user not in allowedUsers", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.dm = "allowlist";
      cfg.allowedUsers = [];
      expect(evaluateAccess(baseInput({ config: cfg, senderId: 99999 })).decision).toBe("drop");
    });
  });

  describe("dm policy=open", () => {
    it("allows everyone", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.dm = "open";
      expect(evaluateAccess(baseInput({ config: cfg, senderId: 99999 })).decision).toBe("allow");
    });
  });

  describe("dm policy=disabled", () => {
    it("drops everyone, including owner", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.dm = "disabled";
      cfg.owner = 12345;
      cfg.allowedUsers = [12345];
      expect(evaluateAccess(baseInput({ config: cfg })).decision).toBe("drop");
    });
  });

  describe("group policy=allowlist", () => {
    it("drops if group not in allowedGroups", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.group = "allowlist";
      cfg.allowedGroups = [];
      const input = baseInput({ config: cfg, chatType: "supergroup", chatId: -100123 });
      expect(evaluateAccess(input).decision).toBe("drop");
    });
    it("allows if group in allowedGroups + replyMode satisfied", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.group = "allowlist";
      cfg.allowedGroups = [-100123];
      cfg.groupSettings = { "-100123": { replyMode: "all", replyFrequency: "medium" } };
      const input = baseInput({ config: cfg, chatType: "supergroup", chatId: -100123 });
      expect(evaluateAccess(input).decision).toBe("allow");
    });
  });

  describe("group replyMode=owner", () => {
    it("allows only owner's messages", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.group = "open";
      cfg.owner = 12345;
      cfg.groupSettings = { "-100123": { replyMode: "owner", replyFrequency: "medium" } };
      const ownerInput = baseInput({ config: cfg, chatType: "supergroup", chatId: -100123, senderId: 12345 });
      const otherInput = baseInput({ config: cfg, chatType: "supergroup", chatId: -100123, senderId: 99999 });
      expect(evaluateAccess(ownerInput).decision).toBe("allow");
      expect(evaluateAccess(otherInput).decision).toBe("drop");
    });
  });

  describe("group replyMode=mention", () => {
    it("requires explicit mention or reply-to-bot", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.group = "open";
      cfg.groupSettings = { "-100123": { replyMode: "mention", replyFrequency: "medium" } };
      const noMention = baseInput({ config: cfg, chatType: "supergroup", chatId: -100123 });
      const withMention = baseInput({ config: cfg, chatType: "supergroup", chatId: -100123, hasMentionOfBot: true });
      const withReply = baseInput({ config: cfg, chatType: "supergroup", chatId: -100123, isReplyToBot: true });
      expect(evaluateAccess(noMention).decision).toBe("drop");
      expect(evaluateAccess(withMention).decision).toBe("allow");
      expect(evaluateAccess(withReply).decision).toBe("allow");
    });
  });

  describe("group replyMode=all", () => {
    it("allows everything", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.group = "open";
      cfg.groupSettings = { "-100123": { replyMode: "all", replyFrequency: "rare" } };
      const input = baseInput({ config: cfg, chatType: "supergroup", chatId: -100123 });
      expect(evaluateAccess(input).decision).toBe("allow");
    });
  });

  describe("draining state", () => {
    it("drops everything regardless of policy", () => {
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.policies.dm = "open";
      const input = baseInput({ config: cfg, draining: true });
      expect(evaluateAccess(input).decision).toBe("drop");
    });
  });
});
