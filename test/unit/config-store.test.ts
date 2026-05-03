import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/config/ConfigStore.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";

describe("ConfigStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-tg-cfg-"));
    path = join(dir, "config.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns DEFAULT_CONFIG when file is missing", async () => {
    const store = new ConfigStore(path);
    const cfg = await store.load();
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("save then load roundtrips", async () => {
    const store = new ConfigStore(path);
    const cfg = { ...DEFAULT_CONFIG, owner: 42 };
    await store.save(cfg);
    const loaded = await store.load();
    expect(loaded.owner).toBe(42);
  });

  it("writes with mode 0600", async () => {
    const store = new ConfigStore(path);
    await store.save(DEFAULT_CONFIG);
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("uses atomic write (no .tmp file remains on success)", async () => {
    const store = new ConfigStore(path);
    await store.save(DEFAULT_CONFIG);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  it("backs up corrupt JSON as .broken.<timestamp> and returns DEFAULT_CONFIG", async () => {
    await writeFile(path, "{ this is not valid json", { mode: 0o600 });
    const store = new ConfigStore(path);
    const cfg = await store.load();
    expect(cfg).toEqual(DEFAULT_CONFIG);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith("config.json.broken."))).toBe(true);
  });

  it("refuses to load unknown schema version", async () => {
    await writeFile(path, JSON.stringify({ version: 999 }), { mode: 0o600 });
    const store = new ConfigStore(path);
    await expect(store.load()).rejects.toThrow(/version/i);
  });

  it("serializes concurrent saves via in-process mutex", async () => {
    const store = new ConfigStore(path);
    const a = store.save({ ...DEFAULT_CONFIG, owner: 1 });
    const b = store.save({ ...DEFAULT_CONFIG, owner: 2 });
    await Promise.all([a, b]);
    const loaded = await store.load();
    expect([1, 2]).toContain(loaded.owner);
  });

  it("migrates v1 config to v2: preserves botToken/owner/pendingPairCode, drops dead fields", async () => {
    const v1 = {
      version: 1,
      botToken: "123:ABC",
      owner: 42,
      pendingPairCode: { code: "abcDEF", expiresAt: Date.now() + 60000, attempts: 0 },
      // v1-only fields that should be dropped after migration:
      policies: { dm: "allowlist", group: "open" },
      allowedUsers: [42],
      allowedGroups: [],
      groupSettings: {},
      sessions: {},
    };
    await writeFile(path, JSON.stringify(v1), { mode: 0o600 });
    const store = new ConfigStore(path);
    const cfg = await store.load();
    expect(cfg.version).toBe(2);
    expect(cfg.botToken).toBe("123:ABC");
    expect(cfg.owner).toBe(42);
    expect(cfg.pendingPairCode?.code).toBe("abcDEF");
    expect(cfg.limits.maxIncomingFileMb).toBe(20);
    expect(cfg.limits.maxOutgoingFileMb).toBe(50);
    expect(cfg.showToolFooter).toBe(false);
    expect((cfg as any).policies).toBeUndefined();
    expect((cfg as any).allowedUsers).toBeUndefined();
    // The migrated form is persisted to disk so the next load is direct.
    const reloaded = JSON.parse(await readFile(path, "utf8"));
    expect(reloaded.version).toBe(2);
    expect(reloaded.policies).toBeUndefined();
  });

  it("forward-compat: v2 config missing newly-added fields is filled with defaults (not backed up)", async () => {
    // Simulate an older v2 install that doesn't yet have `showToolFooter` and `maxOutgoingFileMb`.
    const partial = {
      version: 2,
      botToken: "tok",
      owner: 7,
      pendingPairCode: null,
      limits: { maxIncomingFileMb: 20, maxQueueDepth: 32 },
    };
    await writeFile(path, JSON.stringify(partial), { mode: 0o600 });
    const store = new ConfigStore(path);
    const cfg = await store.load();
    expect(cfg.botToken).toBe("tok");
    expect(cfg.owner).toBe(7);
    expect(cfg.showToolFooter).toBe(false);
    expect(cfg.limits.maxOutgoingFileMb).toBe(50);
    // No `.broken.*` backup should have been created — partial v2 is recoverable, not corrupt.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    expect(files.some((f) => f.includes(".broken."))).toBe(false);
  });
});
