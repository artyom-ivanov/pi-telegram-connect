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
    // v1 → v2 migration: keep botToken, owner, pendingPairCode; drop everything else
    // (allowlists, policies, group settings, sessions, pendingGroupAccess, dead limits).
    if (versionField === 1) {
      const v1 = parsed as { botToken?: unknown; owner?: unknown; pendingPairCode?: unknown };
      const migrated: Config = {
        ...structuredClone(DEFAULT_CONFIG),
        botToken: typeof v1.botToken === "string" ? v1.botToken : null,
        owner: typeof v1.owner === "number" ? v1.owner : null,
        pendingPairCode:
          v1.pendingPairCode && typeof v1.pendingPairCode === "object"
            ? (v1.pendingPairCode as Config["pendingPairCode"])
            : null,
      };
      // Persist migrated form so subsequent loads are direct.
      await this.persist(migrated);
      return migrated;
    }
    if (versionField !== 2) {
      throw new Error(
        `pi-telegram-connect: unknown config schema version ${String(versionField)} in ${this.path}; expected 2`,
      );
    }
    // Forward-compat fill-in: when we add new optional limits in later patches,
    // existing v2 configs lack them. Rather than backup-and-reset (losing botToken
    // and owner), fill in defaults for any missing limits before validation.
    const p = parsed as { limits?: Record<string, unknown> };
    if (p.limits && typeof p.limits === "object") {
      const defaults = DEFAULT_CONFIG.limits as unknown as Record<string, unknown>;
      for (const k of Object.keys(defaults)) {
        if (typeof p.limits[k] !== "number") p.limits[k] = defaults[k];
      }
    } else {
      (parsed as { limits: unknown }).limits = structuredClone(DEFAULT_CONFIG.limits);
    }
    if (!Value.Check(ConfigSchema, parsed)) {
      const backup = `${this.path}.broken.${Date.now()}`;
      await rename(this.path, backup).catch(() => undefined);
      return structuredClone(DEFAULT_CONFIG);
    }
    return parsed as Config;
  }

  /** Internal: write without re-validating (used by migration). Same atomic write semantics. */
  private async persist(cfg: Config): Promise<void> {
    await this.mutex.run(async () => {
      let release: (() => Promise<void>) | null = null;
      try {
        release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 5, minTimeout: 50 } });
      } catch {
        // ignore
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
