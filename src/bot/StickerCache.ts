import { readFile, writeFile, rename, chmod, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Value } from "@sinclair/typebox/value";
import {
  StickerCacheSchema,
  DEFAULT_STICKER_CACHE,
  type StickerCache as CacheShape,
} from "../config/schema.js";

export interface VisionRequest {
  imageBase64: string;
  mimeType: "image/webp" | "image/jpeg" | "image/png";
  prompt: string;
}

export type VisionFn = (req: VisionRequest) => Promise<{ description: string } | null>;

export interface StickerCacheOptions {
  cachePath: string;
  maxEntries: number;
  ttlMs: number;
  maxVisionCallsPerDay: number;
  visionFn: VisionFn;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export class StickerCache {
  private cache: CacheShape | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private opts: StickerCacheOptions) {}

  private async load(): Promise<CacheShape> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.opts.cachePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Value.Check(StickerCacheSchema, parsed)) {
        this.cache = structuredClone(DEFAULT_STICKER_CACHE);
      } else {
        this.cache = parsed as CacheShape;
      }
    } catch {
      this.cache = structuredClone(DEFAULT_STICKER_CACHE);
    }
    return this.cache!;
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flushNow();
    }, 1000);
  }

  async flushNow(): Promise<void> {
    if (!this.dirty || !this.cache) return;
    this.dirty = false;
    const tmp = `${this.opts.cachePath}.tmp.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, this.opts.cachePath);
  }

  private evictIfNeeded(c: CacheShape): void {
    const now = Date.now();
    for (const [k, v] of Object.entries(c.entries)) {
      if (now - v.describedAt > this.opts.ttlMs) delete c.entries[k];
    }
    const keys = Object.keys(c.entries);
    if (keys.length <= this.opts.maxEntries) return;
    const sorted = keys
      .map((k) => [k, c.entries[k]!.describedAt] as const)
      .sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.length - this.opts.maxEntries;
    for (let i = 0; i < toRemove; i++) {
      delete c.entries[sorted[i]![0]];
    }
  }

  /**
   * Describe a sticker by file_unique_id; returns text to inject into the prompt.
   */
  async describe(args: {
    fileUniqueId: string;
    emoji: string;
    kind: "static" | "video" | "lottie";
    filePath?: string;
  }): Promise<string> {
    if (args.kind === "lottie") {
      return `[user sent animated sticker (emoji: ${args.emoji})]`;
    }
    const c = await this.load();
    const hit = c.entries[args.fileUniqueId];
    if (hit) {
      return `[user sent sticker: ${hit.description} (emoji: ${args.emoji})]`;
    }
    if (c.visionCallsToday.date !== todayUtc()) {
      c.visionCallsToday = { date: todayUtc(), count: 0 };
      this.scheduleSave();
    }
    if (c.visionCallsToday.count >= this.opts.maxVisionCallsPerDay) {
      return `[user sent sticker (emoji: ${args.emoji})]`;
    }
    let imagePath = args.filePath;
    let mimeType: "image/webp" | "image/jpeg" = "image/webp";
    if (args.kind === "video" && args.filePath) {
      const out = await extractFirstFrame(args.filePath).catch(() => null);
      if (!out) return `[user sent video sticker (emoji: ${args.emoji})]`;
      imagePath = out;
      mimeType = "image/jpeg";
    }
    if (!imagePath) return `[user sent sticker (emoji: ${args.emoji})]`;
    let dataB64: string;
    try {
      const buf = await readFile(imagePath);
      dataB64 = buf.toString("base64");
    } catch {
      return `[user sent sticker (emoji: ${args.emoji})]`;
    }
    const result = await this.opts
      .visionFn({ imageBase64: dataB64, mimeType, prompt: "Describe this sticker in one short phrase." })
      .catch(() => null);
    c.visionCallsToday.count += 1;
    if (!result) {
      this.scheduleSave();
      return `[user sent sticker (emoji: ${args.emoji})]`;
    }
    c.entries[args.fileUniqueId] = {
      emoji: args.emoji,
      description: result.description,
      describedAt: Date.now(),
    };
    this.evictIfNeeded(c);
    this.scheduleSave();
    return `[user sent sticker: ${result.description} (emoji: ${args.emoji})]`;
  }
}

async function extractFirstFrame(srcPath: string): Promise<string | null> {
  const dst = `${srcPath}.frame0.jpg`;
  return new Promise<string | null>((res) => {
    const proc = spawn(
      "ffmpeg",
      ["-nostdin", "-loglevel", "error", "-y", "-i", srcPath, "-frames:v", "1", "-an", "-f", "image2", dst],
      { stdio: "ignore" },
    );
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      res(null);
    }, 10_000);
    proc.on("error", () => {
      clearTimeout(t);
      res(null);
    });
    proc.on("exit", async (code) => {
      clearTimeout(t);
      if (code === 0) {
        try {
          const st = await stat(dst);
          if (st.size > 0) return res(dst);
        } catch {
          /* ignore */
        }
      }
      res(null);
    });
  });
}
