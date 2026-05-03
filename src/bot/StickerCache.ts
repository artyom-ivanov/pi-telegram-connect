import { readFile, writeFile, rename, chmod, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export interface StickerCacheEntry {
  fileId: string;
  emoji: string | null;
  seenAt: number;
}

interface CacheShape {
  version: 1;
  entries: Record<string, StickerCacheEntry>;
}

const EMPTY: CacheShape = { version: 1, entries: {} };

export class StickerCache {
  private cache: CacheShape | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private mutexChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<CacheShape> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.version === 1 &&
        parsed.entries &&
        typeof parsed.entries === "object"
      ) {
        this.cache = parsed as CacheShape;
      } else {
        this.cache = structuredClone(EMPTY);
      }
    } catch {
      this.cache = structuredClone(EMPTY);
    }
    return this.cache;
  }

  async get(fileUniqueId: string): Promise<StickerCacheEntry | null> {
    const c = await this.load();
    return c.entries[fileUniqueId] ?? null;
  }

  async set(fileUniqueId: string, entry: StickerCacheEntry): Promise<void> {
    const c = await this.load();
    c.entries[fileUniqueId] = entry;
    this.scheduleSave();
  }

  async reset(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.dirty = false;
    this.cache = structuredClone(EMPTY);
    await this.serialize(async () => {
      try {
        await unlink(this.path);
      } catch {
        void 0;
      }
    });
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.dirty) await this.persist();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.persist();
    }, 500);
  }

  private async persist(): Promise<void> {
    if (!this.cache || !this.dirty) return;
    this.dirty = false;
    const snapshot = JSON.stringify(this.cache, null, 2);
    await this.serialize(async () => {
      const tmp = `${this.path}.tmp.${randomBytes(4).toString("hex")}`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      try {
        await chmod(tmp, 0o600);
      } catch {
        void 0;
      }
      await rename(tmp, this.path);
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}
