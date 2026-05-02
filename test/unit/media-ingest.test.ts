import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolveDestPath } from "../../src/bot/MediaIngest.js";

describe("MediaIngest path safety", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-tg-mi-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sanitizes traversal-like filenames", async () => {
    const p = await resolveDestPath({
      tmpDir: dir,
      chatId: 100,
      threadId: 0,
      msgId: 5,
      remoteFilename: "../../../etc/passwd",
      fileUniqueId: "abc",
    });
    expect(p.startsWith(dir + sep)).toBe(true);
    expect(p).not.toContain(".." + sep);
  });

  it("strips control chars and spaces", async () => {
    const p = await resolveDestPath({
      tmpDir: dir,
      chatId: 100,
      threadId: 0,
      msgId: 5,
      remoteFilename: "ev il/\x00\x01name with spaces?.ogg",
      fileUniqueId: "abc",
    });
    expect(p.startsWith(dir + sep)).toBe(true);
    const parts = p.split(sep);
    const last = parts[parts.length - 1]!;
    expect(last).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("falls back to <file_unique_id>.bin for empty/dotfile names", async () => {
    const p = await resolveDestPath({
      tmpDir: dir,
      chatId: 100,
      threadId: 0,
      msgId: 5,
      remoteFilename: "..",
      fileUniqueId: "uniq42",
    });
    expect(p).toMatch(/uniq42\.bin$/);
  });

  it("creates parent directories on write", async () => {
    const p = await resolveDestPath({
      tmpDir: dir,
      chatId: 100,
      threadId: 7,
      msgId: 5,
      remoteFilename: "ok.jpg",
      fileUniqueId: "abc",
    });
    const parent = p.substring(0, p.lastIndexOf(sep));
    const st = await stat(parent);
    expect(st.isDirectory()).toBe(true);
  });

  it("absolute path filename is reduced to basename", async () => {
    const p = await resolveDestPath({
      tmpDir: dir,
      chatId: 100,
      threadId: 0,
      msgId: 5,
      remoteFilename: "/etc/passwd",
      fileUniqueId: "abc",
    });
    expect(p.startsWith(dir + sep)).toBe(true);
    expect(p.includes("passwd")).toBe(true);
  });
});
