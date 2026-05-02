import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/config/ConfigStore.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { PairingFlow } from "../../src/bot/PairingFlow.js";

async function freshStore(dir: string): Promise<{ store: ConfigStore; path: string }> {
  const path = join(dir, "config.json");
  const store = new ConfigStore(path);
  await store.save({ ...DEFAULT_CONFIG });
  return { store, path };
}

describe("PairingFlow", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-tg-pair-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a 6-char alphanumeric code (excluding 0/O/I/l/1) and stores it", async () => {
    const { store } = await freshStore(dir);
    const flow = new PairingFlow(store);
    const code = await flow.startPairing();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9a-hj-np-z]{6}$/);
    const cfg = await store.load();
    expect(cfg.pendingPairCode?.code).toBe(code);
    expect(cfg.pendingPairCode?.attempts).toBe(0);
  });

  it("matches correct code → sets owner, flips dm policy to allowlist, clears pending code", async () => {
    const { store } = await freshStore(dir);
    const flow = new PairingFlow(store);
    const code = await flow.startPairing();
    const result = await flow.tryPair(code, 12345);
    expect(result).toEqual({ ok: true, ownerUserId: 12345 });
    const cfg = await store.load();
    expect(cfg.owner).toBe(12345);
    expect(cfg.policies.dm).toBe("allowlist");
    expect(cfg.allowedUsers).toContain(12345);
    expect(cfg.pendingPairCode).toBeNull();
  });

  it("rejects wrong code, increments attempts, does not pair", async () => {
    const { store } = await freshStore(dir);
    const flow = new PairingFlow(store);
    await flow.startPairing();
    const result = await flow.tryPair("WRONG1", 12345);
    expect(result).toEqual({ ok: false, reason: "mismatch" });
    const cfg = await store.load();
    expect(cfg.owner).toBeNull();
    expect(cfg.pendingPairCode?.attempts).toBe(1);
  });

  it("invalidates code after 5 wrong attempts", async () => {
    const { store } = await freshStore(dir);
    const flow = new PairingFlow(store);
    await flow.startPairing();
    for (let i = 0; i < 5; i++) {
      await flow.tryPair("WRONG1", 12345);
    }
    const cfg = await store.load();
    expect(cfg.pendingPairCode).toBeNull();
    const result = await flow.tryPair("WRONG1", 12345);
    expect(result).toEqual({ ok: false, reason: "no-pending" });
  });

  it("rejects expired code", async () => {
    const { store } = await freshStore(dir);
    const flow = new PairingFlow(store);
    const code = await flow.startPairing();
    const cfg = await store.load();
    cfg.pendingPairCode!.expiresAt = Date.now() - 1000;
    await store.save(cfg);
    const result = await flow.tryPair(code, 12345);
    expect(result).toEqual({ ok: false, reason: "expired" });
    const after = await store.load();
    expect(after.pendingPairCode).toBeNull();
  });

  it("explicitOwner skips pairing entirely, flips dm to allowlist, no code generated", async () => {
    const { store } = await freshStore(dir);
    const flow = new PairingFlow(store);
    await flow.setExplicitOwner(98765);
    const cfg = await store.load();
    expect(cfg.owner).toBe(98765);
    expect(cfg.policies.dm).toBe("allowlist");
    expect(cfg.allowedUsers).toContain(98765);
    expect(cfg.pendingPairCode).toBeNull();
  });

  it("startPairing clears any stale pendingPairCode unconditionally", async () => {
    const { store } = await freshStore(dir);
    const flow = new PairingFlow(store);
    const oldCode = await flow.startPairing();
    const newCode = await flow.startPairing();
    expect(newCode).not.toBe(oldCode);
    const cfg = await store.load();
    expect(cfg.pendingPairCode?.code).toBe(newCode);
    expect(cfg.pendingPairCode?.attempts).toBe(0);
  });

  it("rejects input of different length without crashing", async () => {
    const { store } = await freshStore(dir);
    const flow = new PairingFlow(store);
    await flow.startPairing();
    const result = await flow.tryPair("X", 12345);
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });
});
