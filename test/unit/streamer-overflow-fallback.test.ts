import { describe, it, expect, beforeEach, vi } from "vitest";
import { Streamer } from "../../src/bot/Streamer.js";
import { MockTelegramClient } from "../helpers/mock-telegram.js";

describe("Streamer 4096-overflow split", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("splits a long body into multiple messages at safe boundaries", async () => {
    const client = new MockTelegramClient();
    const s = new Streamer({ client, chatId: 1, threadId: 0, throttleMs: 0, maxTextLen: 200 });
    s.beginTurn();
    const segment = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ";
    s.appendDelta(segment.repeat(8) + "\n\n" + segment.repeat(8));
    await vi.advanceTimersByTimeAsync(10);
    await s.flush();
    await s.finalize();

    const writes = client.calls.filter(
      (c) => c.method === "sendMessage" || c.method === "editMessageText",
    );
    const sends = writes.filter((c) => c.method === "sendMessage");
    expect(sends.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) {
      expect(String(w.args.text).length).toBeLessThanOrEqual(220);
    }
  });
});

describe("Streamer HTML fallback on parse error", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("retries with plain text when Telegram rejects HTML, and stops re-fallbacking on the next edit", async () => {
    const client = new MockTelegramClient();
    let sendCallCount = 0;
    client.on("sendMessage", (args) => {
      sendCallCount++;
      if (sendCallCount === 1 && args.parse_mode === "HTML") {
        const err: any = new Error("Bad Request: can't parse entities");
        err.description = "Bad Request: can't parse entities at byte 0";
        throw err;
      }
      return { message_id: 100 };
    });
    const s = new Streamer({ client, chatId: 1, threadId: 0, throttleMs: 0 });
    s.beginTurn();
    s.appendDelta("Hello with maybe-broken markdown _x_");
    await vi.advanceTimersByTimeAsync(10);
    await s.flush();
    await s.finalize();
    const sends = client.calls.filter((c) => c.method === "sendMessage");
    expect(sends.length).toBe(2);
    expect(sends[0]?.args.parse_mode).toBe("HTML");
    expect(sends[1]?.args.parse_mode).toBeUndefined();
  });
});
