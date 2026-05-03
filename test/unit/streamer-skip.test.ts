import { describe, it, expect, beforeEach, vi } from "vitest";
import { Streamer } from "../../src/bot/Streamer.js";
import { MockTelegramClient } from "../helpers/mock-telegram.js";

describe("Streamer [[skip]] handling", () => {
  let mockClient: MockTelegramClient;
  let streamer: Streamer;

  beforeEach(() => {
    vi.useFakeTimers();
    mockClient = new MockTelegramClient();
    streamer = new Streamer({
      client: mockClient,
      chatId: 100,
      threadId: 0,
      throttleMs: 3000,

    });
  });

  it("complete [[skip]] in single delta → zero API calls", async () => {
    streamer.beginTurn();
    streamer.appendDelta("[[skip]]");
    await streamer.flush();
    await streamer.finalize();
    expect(mockClient.calls).toHaveLength(0);
  });

  it("fragmented [[skip]] across deltas → still suppresses", async () => {
    streamer.beginTurn();
    streamer.appendDelta("[[");
    streamer.appendDelta("sk");
    streamer.appendDelta("ip]]");
    await streamer.flush();
    await streamer.finalize();
    expect(mockClient.calls).toHaveLength(0);
  });

  it("[[skip]] with trailing whitespace → suppresses", async () => {
    streamer.beginTurn();
    streamer.appendDelta("[[skip]]");
    streamer.appendDelta("   \n  ");
    await streamer.flush();
    await streamer.finalize();
    expect(mockClient.calls).toHaveLength(0);
  });

  it("text that begins with [[ski but continues differently → does NOT suppress", async () => {
    streamer.beginTurn();
    streamer.appendDelta("[[ski");
    streamer.appendDelta("pper]]");
    await streamer.flush();
    await streamer.finalize();
    expect(mockClient.calls.length).toBeGreaterThan(0);
  });

  it("[[skip]] followed by other text → does NOT suppress (treats as normal text)", async () => {
    streamer.beginTurn();
    streamer.appendDelta("[[skip]] not really skipping");
    await streamer.flush();
    await streamer.finalize();
    const sends = mockClient.calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText");
    expect(sends.length).toBeGreaterThan(0);
  });

  it("only whitespace before EOF → no API call (empty content)", async () => {
    streamer.beginTurn();
    streamer.appendDelta("   ");
    await streamer.flush();
    await streamer.finalize();
    expect(mockClient.calls).toHaveLength(0);
  });
});
