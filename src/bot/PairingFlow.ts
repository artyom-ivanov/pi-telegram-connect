import { randomInt, timingSafeEqual } from "node:crypto";
import type { ConfigStore } from "../config/ConfigStore.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const CODE_LEN = 6;
const VALID_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export type TryPairResult =
  | { ok: true; ownerUserId: number }
  | { ok: false; reason: "no-pending" | "expired" | "mismatch" };

export class PairingFlow {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: ConfigStore) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async startPairing(): Promise<string> {
    return this.serialize(async () => {
      const code = Array.from({ length: CODE_LEN }, () =>
        ALPHABET[randomInt(0, ALPHABET.length)],
      ).join("");
      const cfg = await this.store.load();
      cfg.pendingPairCode = { code, expiresAt: Date.now() + VALID_MS, attempts: 0 };
      await this.store.save(cfg);
      return code;
    });
  }

  async tryPair(input: string, senderUserId: number): Promise<TryPairResult> {
    return this.serialize(async () => {
      const cfg = await this.store.load();
      const pending = cfg.pendingPairCode;
      if (!pending) return { ok: false, reason: "no-pending" };
      if (Date.now() > pending.expiresAt) {
        cfg.pendingPairCode = null;
        await this.store.save(cfg);
        return { ok: false, reason: "expired" };
      }
      if (input.length !== pending.code.length) {
        pending.attempts += 1;
        if (pending.attempts >= MAX_ATTEMPTS) cfg.pendingPairCode = null;
        await this.store.save(cfg);
        return { ok: false, reason: "mismatch" };
      }
      const a = Buffer.from(input);
      const b = Buffer.from(pending.code);
      if (!timingSafeEqual(a, b)) {
        pending.attempts += 1;
        if (pending.attempts >= MAX_ATTEMPTS) cfg.pendingPairCode = null;
        await this.store.save(cfg);
        return { ok: false, reason: "mismatch" };
      }
      cfg.owner = senderUserId;
      cfg.pendingPairCode = null;
      await this.store.save(cfg);
      return { ok: true, ownerUserId: senderUserId };
    });
  }

  async setExplicitOwner(userId: number): Promise<void> {
    return this.serialize(async () => {
      const cfg = await this.store.load();
      cfg.owner = userId;
      cfg.pendingPairCode = null;
      await this.store.save(cfg);
    });
  }
}
