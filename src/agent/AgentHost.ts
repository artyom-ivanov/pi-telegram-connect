import type { ImageContent, SessionEvent, SessionKey } from "../types.js";

/** Tool definition shape compatible with @mariozechner/pi-coding-agent's defineTool output. */
export type ToolDefinitionLike = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (params: any) => Promise<unknown>;
};

export interface AgentSessionRef {
  prompt(text: string, opts?: { images?: ImageContent[] }): Promise<void>;
  subscribe(listener: (e: SessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentHost {
  getOrCreateSession(key: SessionKey, opts: { customTools: ToolDefinitionLike[] }): Promise<AgentSessionRef>;
  resetSession(key: SessionKey): Promise<void>;
  shutdown(): Promise<void>;
}
