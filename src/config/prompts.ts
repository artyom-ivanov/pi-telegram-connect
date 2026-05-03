export const TELEGRAM_PREFIX = "[telegram";

export const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge active.
- Telegram turns start with "${TELEGRAM_PREFIX} chat=<id>[:<thread>] from=<user_id>]".
- Bracketed English markers are internal metadata. Ignore them in your reply. Reply in the user's language.
- Messages may reference local files under ~/.pi/agent/tmp/telegram/. Read them when useful.
- "voice message" = user speech: transcribe and reply normally. "audio file" = uploaded audio/music: analyze it; do not assume the user is speaking.
- Send files only via \`telegram_attach(abs_path)\`. Mentioning a path does not send anything. Save artifacts under the working directory or ~/.pi/agent/tmp/ before attaching.
- Static stickers are visible only the first time; later you may see only \`sticker_id=<id>\` and must rely on earlier context. Video/Lottie stickers are emoji-only hints.
- Default sticker reply is text. Use \`telegram_send_sticker\` only if the user explicitly asks for a sticker reply.
- \`telegram_react\` sets one emoji reaction on the user's message; use it sparingly. Pass an empty string to clear.
- Reactions to your messages are usually non-requests. Default output is exactly \`[[skip]]\` as the first non-whitespace characters. Reply only when the reaction clearly invites clarification or disagreement (for example 🤔 or 👎).
`;

const STICKER_FALLBACK_EMOJI = "🎴";

export const promptFragments = {
  header: (
    chatId: number,
    threadId: number | undefined,
    fromId: number | string,
  ): string =>
    `[telegram chat=${chatId}${threadId ? `:${threadId}` : ""} from=${fromId ?? "?"}]`,

  inReplyTo: (msgId: number, snippet: string): string =>
    `[reply ${msgId}: ${snippet}]`,

  attachedHeader: "[files]",
  attachedFooter: "[/files]",

  voiceMessage: (durationS: number, path: string): string =>
    `- voice (${durationS}s): ${path}`,

  audioFile: (
    path: string,
    durationS: number,
    title?: string,
    performer?: string,
  ): string => {
    const t = title ? ` "${title}"` : "";
    const p = performer ? ` by ${performer}` : "";
    return `- audio${t}${p} (${durationS}s): ${path}`;
  },

  video: (durationS: number, path: string): string =>
    `- video (${durationS}s): ${path}`,

  document: (path: string): string => `- document: ${path}`,

  stickerSeenBefore: (emoji: string | null, stickerId: string): string =>
    `[sticker ${emoji ?? STICKER_FALLBACK_EMOJI} id=${stickerId} seen]`,

  stickerFirstTime: (emoji: string | null, stickerId: string): string =>
    `[sticker ${emoji ?? STICKER_FALLBACK_EMOJI} id=${stickerId} new]`,

  stickerNoIngest: (emoji: string | null, stickerId: string): string =>
    `[sticker ${emoji ?? STICKER_FALLBACK_EMOJI} id=${stickerId}]`,

  videoSticker: (emoji: string | null): string =>
    `[video sticker ${emoji ?? STICKER_FALLBACK_EMOJI}]`,

  animatedSticker: (emoji: string | null): string =>
    `[animated sticker ${emoji ?? STICKER_FALLBACK_EMOJI}]`,

  fileTooLarge: (name: string): string => `[file too large: ${name}]`,

  fileUnavailable: (name: string): string => `[file unavailable: ${name}]`,

  photoIngestError: "[photo ingest failed]",

  reactionAdded: (msgId: number, emoji: string): string =>
    `[user reacted ${msgId}: ${emoji}]`,

  reactionRemoved: (msgId: number, was: string): string =>
    `[user removed reaction ${msgId}: ${was}]`,

  reactionChanged: (msgId: number, was: string, now: string): string =>
    `[user changed reaction ${msgId}: ${was || "—"} -> ${now || "—"}]`,
};

export const tools = {
  attach: {
    description:
      "Queue local files for the current Telegram reply. Use when the user asked for a file or you produced one worth sending. Pass absolute paths only; plain-text paths do not send anything. Type is inferred from extension (.jpg/.png/.webp/.gif photo, .mp4/.mov video, .ogg voice, .mp3/.m4a/.flac/.wav audio, else document).",
    promptSnippet: "Queue files for the current Telegram reply.",
    promptGuidelines: [
      "Call telegram_attach only when a file should actually be delivered.",
      "Save artifacts under the working directory or ~/.pi/agent/tmp/ before attaching.",
    ],
  },

  sendSticker: {
    description:
      "Queue a cached sticker for the current Telegram reply. Use only when the user explicitly asks for a sticker reply. Pass sticker_id from an earlier sticker marker; do not infer from emoji and do not auto-echo stickers.",
    promptSnippet: "Send a cached sticker only on explicit request.",
    promptGuidelines: [
      "Normal sticker reply is text.",
      "Only previously seen sticker_ids are valid.",
    ],
  },

  react: {
    description:
      "Set or clear one emoji reaction on a Telegram message. Default target is the triggering user message unless messageId is provided. Use sparingly as a lightweight acknowledgement, not a substitute for a text reply. If Telegram rejects the emoji, retry with a common standard one.",
    promptSnippet: "React to the user's message when useful.",
    promptGuidelines: [
      "You usually do not need to pass messageId.",
      "A reaction usually complements a reply; it rarely replaces one.",
    ],
  },
};

/** Strings returned to the agent as tool-result content[].text. */
export const toolResults = {
  attachNotInTurn: "Not a Telegram turn; attachment not queued.",
  attachQueued: (n: number): string => `Queued ${n} attachment(s).`,
  attachFailures: (errors: string[]): string =>
    `Attach failed: ${errors.join("; ")}`,

  stickerNotInTurn: "Not a Telegram turn; sticker not queued.",
  stickerNotInCache: (id: string): string => `Unknown sticker_id="${id}".`,
  stickerQueued: (_emoji: string | null): string => "Queued sticker.",

  reactNotInTurn: "Not a Telegram turn; reaction not sent.",
  reactedWith: (emoji: string): string => `Reaction set: ${emoji}.`,
  reactionCleared: "Reaction cleared.",
  reactionFailed: (msg: string): string => `Reaction failed: ${msg}`,
};

export type ToolHistoryEntry = {
  status: "running" | "done" | "error";
  name: string;
  argsSummary: string;
};

const TOOL_ARGS_TRIM = 120;

const formatToolLine = (e: ToolHistoryEntry): string => {
  const args =
    e.argsSummary.length > TOOL_ARGS_TRIM
      ? e.argsSummary.slice(0, TOOL_ARGS_TRIM) + "…"
      : e.argsSummary;
  const symbol =
    e.status === "running" ? "⚙️" : e.status === "done" ? "✅" : "🚫";
  return `${symbol} ${e.name}(${args})`;
};

export const streamerMarkers = {
  thinkingHeader: (entries: ReadonlyArray<ToolHistoryEntry>): string => {
    const lines = ["_Working…_"];
    for (const e of entries) lines.push(`_${formatToolLine(e)}_`);
    return lines.join("\n");
  },

  toolFooter: (entries: ReadonlyArray<ToolHistoryEntry>): string => {
    if (entries.length === 0) return "";
    const lines = entries.map((e) => `_${formatToolLine(e)}_`);
    return `\n\n${lines.join("\n")}`;
  },

  stopped: "\n\n_⏹ stopped_",
  error: (msg: string): string => `\n\n_⚠️ error: ${msg}_`,
  attachmentSendFailureSuffix: (label: string, error: string): string =>
    `_⚠️ failed to send ${label}: ${error}_`,
};

export const userMessages = {
  alreadyRunning: "Bot is already running. Use /telegram-disconnect first.",
  noStoredToken:
    "No stored token. Usage: /telegram-connect <token> [--owner <user_id>]",
  reconnected: (owner: number): string => `Bot reconnected. Owner: ${owner}.`,
  startedExplicitOwner: (owner: number): string =>
    `Bot started. Owner: ${owner}. Pairing skipped.`,
  startedPairing: (code: string): string =>
    `Bot started. DM this code to claim ownership: ${code} (expires in 5 min).`,

  stopped: "Bot stopped.",

  status: (running: boolean, owner: number | null): string =>
    [`Running: ${running}`, `Owner: ${owner ?? "(not paired)"}`].join("\n"),

  stickerCacheCleared: "Sticker cache cleared.",

  pairSucceeded: "✅ Ownership confirmed. Use /help to see commands.",
  resetUnsupported: "/reset is not supported in v1. Reset from pi-CLI.",

  extensionLoaded: "Extension loaded. Use /telegram-connect to start.",
};
