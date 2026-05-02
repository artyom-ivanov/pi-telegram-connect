import { readFile, writeFile, rename, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import * as lockfile from "proper-lockfile";
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  type Config,
} from "./schema.js";

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.chain;
    this.chain = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class ConfigStore {
  private mutex = new AsyncMutex();

  constructor(private readonly path: string) {}

  async load(): Promise<Config> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const backup = `${this.path}.broken.${Date.now()}`;
      await rename(this.path, backup).catch(() => undefined);
      return structuredClone(DEFAULT_CONFIG);
    }
    const versionField = (parsed as { version?: unknown })?.version;
    if (versionField !== 1) {
      throw new Error(
        `pi-telegram-connect: unknown config schema version ${String(versionField)} in ${this.path}; expected 1`,
      );
    }
    if (!Value.Check(ConfigSchema, parsed)) {
      const backup = `${this.path}.broken.${Date.now()}`;
      await rename(this.path, backup).catch(() => undefined);
      return structuredClone(DEFAULT_CONFIG);
    }
    return parsed as Config;
  }

  async save(cfg: Config): Promise<void> {
    if (!Value.Check(ConfigSchema, cfg)) {
      throw new Error("pi-telegram-connect: refusing to save invalid config");
    }
    await this.mutex.run(async () => {
      let release: (() => Promise<void>) | null = null;
      try {
        release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 5, minTimeout: 50 } });
      } catch {
        // lock already held; let mutex serialize within this process; cross-process best-effort
      }
      try {
        const tmp = `${this.path}.tmp.${randomBytes(4).toString("hex")}`;
        await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        try {
          await chmod(tmp, 0o600);
        } catch {
          // ignore
        }
        await rename(tmp, this.path);
      } finally {
        if (release) await release().catch(() => undefined);
      }
    });
  }
}
