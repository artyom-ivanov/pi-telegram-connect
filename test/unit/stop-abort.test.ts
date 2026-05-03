import { describe, it, expect, beforeEach, vi } from "vitest";
import { Streamer } from "../../src/bot/Streamer.js";
import { MessageQueue } from "../../src/bot/MessageQueue.js";
import { MockTelegramClient } from "../helpers/mock-telegram.js";
import type { SessionKey } from "../../src/types.js";

describe("/stop semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("appendStopMarker finalizes preview with _⏹ stopped_ and prevents further edits", async () => {
    const client = new MockTelegramClient();
    const s = new Streamer({ client, chatId: 1, threadId: 0, throttleMs: 3000 });
    s.beginTurn();
    s.appendDelta("partial answer in progress");
    await vi.advanceTimersByTimeAsync(3500);
    s.appendDelta(" more content");
    await s.appendStopMarker();
    const calls = client.calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText");
    const last = calls[calls.length - 1];
    expect(String(last!.args.text)).toContain("⏹");
  });

  it("MessageQueue.abortAndClear stops worker and drops queued items", async () => {
    const order: string[] = [];
    const q = new MessageQueue<string>({
      maxDepth: 32,
      overflow: "drop-oldest",
      worker: async (item, controller) => {
        order.push(`start:${item}`);
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, 1000);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(t);
            rej(new Error("aborted"));
          });
        });
        order.push(`end:${item}`);
      },
    });
    const key: SessionKey = "1:0";
    q.enqueue(key, "A");
    q.enqueue(key, "B");
    q.enqueue(key, "C");
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(["start:A"]);
    q.abortAndClear(key);
    await vi.advanceTimersByTimeAsync(50);
    expect(q.size(key)).toBe(0);
  });
});
