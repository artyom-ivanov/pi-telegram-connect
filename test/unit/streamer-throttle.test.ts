import { describe, it, expect, beforeEach, vi } from "vitest";
import { Streamer } from "../../src/bot/Streamer.js";
import { MockTelegramClient } from "../helpers/mock-telegram.js";

describe("Streamer throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("trailing-edge throttle: 20 deltas in 6s with 3000ms throttle → ≤ 3 edit/send calls", async () => {
    const client = new MockTelegramClient();
    const s = new Streamer({ client, chatId: 1, threadId: 0, throttleMs: 3000, ageResetMs: 60_000 });
    s.beginTurn();
    for (let i = 0; i < 20; i++) {
      s.appendDelta(`token${i} `);
      await vi.advanceTimersByTimeAsync(300);
    }
    await s.flush();
    await s.finalize();
    const writes = client.calls.filter(
      (c) => c.method === "sendMessage" || c.method === "editMessageText",
    );
    expect(writes.length).toBeLessThanOrEqual(3);
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it("flush() awaits in-flight and forces a final edit so terminal text always lands", async () => {
    const client = new MockTelegramClient();
    const s = new Streamer({ client, chatId: 1, threadId: 0, throttleMs: 3000, ageResetMs: 60_000 });
    s.beginTurn();
    s.appendDelta("hello world final");
    await s.flush();
    await s.finalize();
    const writes = client.calls.filter(
      (c) => c.method === "sendMessage" || c.method === "editMessageText",
    );
    expect(writes.length).toBeGreaterThan(0);
    const last = writes[writes.length - 1];
    expect(String(last!.args.text)).toContain("hello world final");
  });

  it("tool indicator triggers an immediate edit (not throttled)", async () => {
    const client = new MockTelegramClient();
    const s = new Streamer({ client, chatId: 1, threadId: 0, throttleMs: 3000, ageResetMs: 60_000 });
    s.beginTurn();
    s.appendDelta("starting work");
    await vi.advanceTimersByTimeAsync(100);
    expect(client.calls.length).toBe(0);
    s.toolStart("bash", "ls -la");
    await vi.advanceTimersByTimeAsync(50);
    expect(client.calls.length).toBeGreaterThan(0);
    expect(String(client.calls[client.calls.length - 1]!.args.text)).toContain("running: bash");
    await s.flush();
    await s.finalize();
  });
});
