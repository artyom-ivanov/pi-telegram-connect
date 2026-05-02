import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentHost, AgentSessionRef, ToolDefinitionLike } from "./AgentHost.js";
import type { SessionEvent, SessionKey } from "../types.js";
import { expandHome } from "../util/paths.js";
import type { ConfigStore } from "../config/ConfigStore.js";

/**
 * Subset of the @mariozechner/pi-coding-agent SDK we depend on.
 * We declare it loosely to avoid hard-coding the pi-coding-agent type imports;
 * the real binding plugs the actual SDK objects in.
 */
export interface PiSdkBindings {
  authStorage: unknown;
  modelRegistry: unknown;
  /** createAgentSession({ sessionManager, authStorage, modelRegistry, customTools }) */
  createAgentSession(args: {
    sessionManager: unknown;
    authStorage: unknown;
    modelRegistry: unknown;
    customTools: ToolDefinitionLike[];
  }): Promise<{ session: PiSdkSession }>;
  /** SessionManager.create / .open path-keyed factory. */
  sessionManagerForPath(absPath: string): unknown;
}

export interface PiSdkSession {
  prompt(text: string, opts?: { images?: any[] }): Promise<void>;
  subscribe(listener: (e: any) => void): () => void;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiAgentHostOptions {
  bindings: PiSdkBindings;
  configStore: ConfigStore;
  sessionsDir: string;
  maxLiveSessions: number;
  sessionIdleHours: number;
}

interface LiveSession {
  ref: AgentSessionRef;
  lastUsedAt: number;
}

function eventFromSdk(e: any): SessionEvent | null {
  if (!e || typeof e.type !== "string") return null;
  switch (e.type) {
    case "message_update": {
      const delta: { text?: string; thinking?: string } = {};
      if (typeof e.delta?.text === "string") delta.text = e.delta.text;
      if (typeof e.delta?.thinking === "string") delta.thinking = e.delta.thinking;
      return { type: "message_update", delta };
    }
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolName: String(e.toolName ?? e.tool ?? "tool"),
        argsSummary: String(e.argsSummary ?? ""),
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolName: String(e.toolName ?? "tool"),
        output: String(e.output ?? ""),
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolName: String(e.toolName ?? "tool"),
        ok: Boolean(e.ok ?? true),
      };
    case "message_end":
      return { type: "message_end" };
    case "turn_end":
      return { type: "turn_end" };
    default:
      return null;
  }
}

export class PiAgentHost implements AgentHost {
  private live = new Map<SessionKey, LiveSession>();

  constructor(private opts: PiAgentHostOptions) {}

  private async sessionPath(key: SessionKey): Promise<string> {
    const cfg = await this.opts.configStore.load();
    const stored = cfg.sessions[key];
    if (stored) return resolve(expandHome(stored));
    const [chat, thread] = key.split(":");
    const root = resolve(expandHome(this.opts.sessionsDir));
    const path = join(root, chat!, `${thread!}.jsonl`);
    cfg.sessions[key] = path;
    await mkdir(dirname(path), { recursive: true });
    await this.opts.configStore.save(cfg);
    return path;
  }

  private evictIfFull(): void {
    if (this.live.size <= this.opts.maxLiveSessions) return;
    const sorted = [...this.live.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const toEvict = this.live.size - this.opts.maxLiveSessions;
    for (let i = 0; i < toEvict; i++) {
      const [key, val] = sorted[i]!;
      this.live.delete(key);
      void val.ref.dispose().catch(() => undefined);
    }
  }

  async getOrCreateSession(
    key: SessionKey,
    opts: { customTools: ToolDefinitionLike[] },
  ): Promise<AgentSessionRef> {
    const existing = this.live.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.ref;
    }
    const sessPath = await this.sessionPath(key);
    const sm = this.opts.bindings.sessionManagerForPath(sessPath);
    const { session } = await this.opts.bindings.createAgentSession({
      sessionManager: sm,
      authStorage: this.opts.bindings.authStorage,
      modelRegistry: this.opts.bindings.modelRegistry,
      customTools: opts.customTools,
    });
    const listeners = new Set<(e: SessionEvent) => void>();
    const off = session.subscribe((raw) => {
      const ev = eventFromSdk(raw);
      if (!ev) return;
      for (const l of listeners) l(ev);
    });
    const ref: AgentSessionRef = {
      prompt: (text, o) => session.prompt(text, o),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      abort: () => session.abort(),
      dispose: async () => {
        off();
        listeners.clear();
        await session.dispose();
      },
    };
    this.live.set(key, { ref, lastUsedAt: Date.now() });
    this.evictIfFull();
    return ref;
  }

  async resetSession(key: SessionKey): Promise<void> {
    const existing = this.live.get(key);
    if (existing) {
      this.live.delete(key);
      await existing.ref.dispose().catch(() => undefined);
    }
    const cfg = await this.opts.configStore.load();
    const path = cfg.sessions[key];
    if (path) {
      delete cfg.sessions[key];
      await this.opts.configStore.save(cfg);
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(resolve(expandHome(path)));
      } catch {
        // ignore
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const [, val] of this.live) {
      await val.ref.dispose().catch(() => undefined);
    }
    this.live.clear();
  }
}
