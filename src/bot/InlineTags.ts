import type { InlineTagsParse, MessageId } from "../types.js";

const REPLY_TO_RE = /\[\[reply_to:(\d+)\]\]/g;
const REPLY_TO_CURRENT_RE = /\[\[reply_to_current\]\]/g;
const SKIP_RE = /\[\[skip\]\]/;

export function parseInlineTags(input: string): InlineTagsParse {
  let replyTo: MessageId | null = null;
  let replyToCurrent = false;

  const m1 = REPLY_TO_RE.exec(input);
  if (m1) {
    const n = Number(m1[1]);
    if (Number.isInteger(n) && n > 0) replyTo = n;
  }
  REPLY_TO_RE.lastIndex = 0;

  if (REPLY_TO_CURRENT_RE.test(input)) {
    replyToCurrent = true;
  }
  REPLY_TO_CURRENT_RE.lastIndex = 0;

  const stripped = input
    .replace(REPLY_TO_RE, "")
    .replace(REPLY_TO_CURRENT_RE, "")
    .replace(SKIP_RE, "")
    .trim();

  const skip = /^\[\[skip\]\]\s*$/.test(input.trim());

  return { text: stripped, replyToMessageId: replyTo, replyToCurrent, skip };
}

/**
 * Detect whether a streaming buffer should be classified as `[[skip]]`.
 *
 * Returns:
 *   - "skip": confirmed skip — stream is exactly `[[skip]]` followed by EOF or whitespace
 *   - "not-skip": buffer no longer prefix-matches `[[skip]` — proceed normally
 *   - "undecided": need more bytes
 */
export function classifySkip(buffer: string, streamEnded: boolean): "skip" | "not-skip" | "undecided" {
  const trimmed = buffer.replace(/^\s+/, "");
  if (trimmed.length === 0) {
    return streamEnded ? "not-skip" : "undecided";
  }
  if (trimmed.startsWith("[[skip]]")) {
    const rest = trimmed.slice("[[skip]]".length);
    if (rest.trim().length === 0) return "skip";
    return "not-skip";
  }
  if ("[[skip]]".startsWith(trimmed) && trimmed.length < "[[skip]]".length) {
    return streamEnded ? "not-skip" : "undecided";
  }
  return "not-skip";
}
