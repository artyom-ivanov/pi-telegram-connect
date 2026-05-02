import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeFilename, expandHome, assertInsideRoot } from "../util/paths.js";

export interface ResolveDestArgs {
  tmpDir: string;
  chatId: number;
  threadId: number;
  msgId: number;
  remoteFilename: string | undefined | null;
  fileUniqueId: string;
}

/** Returns absolute destination path, ensuring it is inside tmpDir. Creates parent dirs. */
export async function resolveDestPath(args: ResolveDestArgs): Promise<string> {
  const root = resolve(expandHome(args.tmpDir));
  const subdir = join(root, String(args.chatId), String(args.threadId));
  await mkdir(subdir, { recursive: true });
  const fallback = `${args.fileUniqueId}.bin`;
  const sanitized = sanitizeFilename(args.remoteFilename, fallback);
  const filename = `${args.msgId}-${sanitized}`;
  const abs = join(subdir, filename);
  await assertInsideRoot(abs, root, false);
  return abs;
}

export interface DownloadArgs {
  url: string;
  destPath: string;
  maxBytes: number;
  signal: AbortSignal;
}

/** Stream-download with size cap; throws "file_too_large" if exceeded. */
export async function downloadToPath(args: DownloadArgs): Promise<void> {
  const res = await fetch(args.url, { signal: args.signal });
  if (!res.ok || !res.body) {
    throw new Error(`download_failed:${res.status}`);
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > args.maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new Error("file_too_large");
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((u) => Buffer.from(u)));
  await writeFile(args.destPath, buf, { mode: 0o644 });
}

export async function unlinkSafe(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
