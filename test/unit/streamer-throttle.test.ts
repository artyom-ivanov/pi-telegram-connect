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

  it("tool start before any text deltas → renders 'Thinking…' header with tool name", async () => {
    const client = new MockTelegramClient();
    const s = new Streamer({ client, chatId: 1, threadId: 0, throttleMs: 3000, ageResetMs: 60_000 });
    s.beginTurn();
    // No appendDelta — agent calls a tool before saying anything (the "thinking" phase).
    s.toolStart("bash", '{"command":"ls -F"}');
    await vi.advanceTimersByTimeAsync(50);
    expect(client.calls.length).toBeGreaterThan(0);
    const lastText = String(client.calls[client.calls.length - 1]!.args.text);
    expect(lastText).toContain("Thinking");
    expect(lastText).toContain("bash");
    expect(lastText).toContain("⚙️");
    await s.flush();
    await s.finalize();
  });

  it("once text streaming starts, the 'Thinking…' header is replaced by body text", async () => {
    const client = new MockTelegramClient();
    const s = new Streamer({ client, chatId: 1, threadId: 0, throttleMs: 3000, ageResetMs: 60_000 });
    s.beginTurn();
    s.toolStart("bash", '{"command":"ls"}');
    await vi.advanceTimersByTimeAsync(50);
    s.toolEnd("bash", true);
    s.appendDelta("Here is the result of running ls.");
    await s.flush();
    await s.finalize();
    const writes = client.calls.filter(
      (c) => c.method === "sendMessage" || c.method === "editMessageText",
    );
    const lastText = String(writes[writes.length - 1]!.args.text);
    // showToolFooter defaults to false → the final text contains the body but NOT the tool history.
    expect(lastText).toContain("Here is the result");
    expect(lastText).not.toContain("Thinking");
    expect(lastText).not.toContain("bash");
  });

  it("with showToolFooter=true, the final message includes the tool history below the body", async () => {
    const client = new MockTelegramClient();
    const s = new Streamer({
      client,
      chatId: 1,
      threadId: 0,
      throttleMs: 3000,
      ageResetMs: 60_000,
      showToolFooter: true,
    });
    s.beginTurn();
    s.toolStart("bash", '{"command":"ls"}');
    await vi.advanceTimersByTimeAsync(50);
    s.toolEnd("bash", true);
    s.toolStart("read_file", '{"path":"/etc/hosts"}');
    await vi.advanceTimersByTimeAsync(50);
    s.toolEnd("read_file", true);
    s.appendDelta("Done.");
    await s.flush();
    await s.finalize();
    const writes = client.calls.filter(
      (c) => c.method === "sendMessage" || c.method === "editMessageText",
    );
    const lastText = String(writes[writes.length - 1]!.args.text);
    expect(lastText).toContain("Done.");
    expect(lastText).toContain("bash");
    expect(lastText).toContain("read_file");
    expect(lastText).toContain("✅");
  });
});
