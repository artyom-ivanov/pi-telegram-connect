import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
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
});
