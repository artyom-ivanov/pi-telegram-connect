import type { SessionKey } from "../types.js";

export interface QueueOptions<T> {
  maxDepth: number;
  /** When the queue is full, choose how to make room (or reject). */
  overflow: "drop-oldest" | "coalesce-newest" | "reject";
  worker: (item: T, controller: AbortController) => Promise<void>;
}

interface Lane<T> {
  items: T[];
  running: boolean;
  abort: AbortController;
}

export class MessageQueue<T> {
  private lanes = new Map<SessionKey, Lane<T>>();

  constructor(private opts: QueueOptions<T>) {}

  enqueue(key: SessionKey, item: T): { ok: true } | { ok: false; reason: "rejected" } {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { items: [], running: false, abort: new AbortController() };
      this.lanes.set(key, lane);
    }
    if (lane.items.length >= this.opts.maxDepth) {
      if (this.opts.overflow === "drop-oldest") {
        lane.items.shift();
        lane.items.push(item);
      } else if (this.opts.overflow === "coalesce-newest") {
        lane.items = [item];
      } else {
        return { ok: false, reason: "rejected" };
      }
    } else {
      lane.items.push(item);
    }
    if (!lane.running) void this.runLane(key);
    return { ok: true };
  }

  private async runLane(key: SessionKey): Promise<void> {
    const lane = this.lanes.get(key);
    if (!lane || lane.running) return;
    lane.running = true;
    try {
      while (lane.items.length > 0 && !lane.abort.signal.aborted) {
        const item = lane.items.shift()!;
        try {
          await this.opts.worker(item, lane.abort);
        } catch (err) {
          // worker is responsible for surfacing per-message errors;
          // we keep the lane alive to drain remaining items
          // eslint-disable-next-line no-console
          console.error(`[MessageQueue ${key}] worker error:`, err);
        }
      }
    } finally {
      lane.running = false;
    }
  }

  /** Abort the current turn and clear the queue for this key. */
  abortAndClear(key: SessionKey): void {
    const lane = this.lanes.get(key);
    if (!lane) return;
    lane.abort.abort();
    lane.items.length = 0;
    lane.abort = new AbortController();
  }

  /** Abort everything and drop all queues. Used by drain state. */
  abortAll(): void {
    for (const [, lane] of this.lanes) {
      lane.abort.abort();
      lane.items.length = 0;
    }
  }

  /** Pending items count for the given key. */
  size(key: SessionKey): number {
    return this.lanes.get(key)?.items.length ?? 0;
  }
}
