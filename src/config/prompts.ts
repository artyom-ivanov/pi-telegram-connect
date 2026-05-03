/**
 * Centralized prompts and user-visible strings.
 *
 * Everything that goes into the agent's prompt context, into a tool description,
 * into a streamed Telegram message, or into a CLI/bot reply lives here. Behavioral
 * tweaks ("be terser", "use telegram_attach more aggressively") happen by editing
 * this file — no code changes elsewhere required.
 *
 * Sections:
 *   1. SYSTEM_PROMPT_SUFFIX — the multi-line block injected into pi's system prompt
 *      for Telegram-originated turns only.
 *   2. promptFragments — short markers we inject into the user-facing prompt to
 *      describe attachments, stickers, reactions, etc.
 *   3. tools — description / promptSnippet / promptGuidelines for each pi.registerTool.
 *   4. toolResults — text returned to the agent as a tool's result content.
 *   5. streamerMarkers — italic markers appended to the streamed Telegram reply.
 *   6. userMessages — CLI notifications and bot DM replies.
 */

export const TELEGRAM_PREFIX = "[telegram";

export const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "${TELEGRAM_PREFIX} chat=<id> from=<user_id>]" on their first line.
- Telegram messages may include local temp file paths under ~/.pi/agent/tmp/telegram/ for attached photos, audio files, voice messages, videos, and documents. Read those files when relevant.
- "voice message (recorded by user)" and "audio file" are DIFFERENT in Telegram: voice = a microphone recording (Ogg/Opus, often informal), audio = an uploaded music/audio file. The user explicitly chose one or the other; treat them differently when responding.
- To deliver a file to Telegram: call \`telegram_attach\` with the absolute local path. Auto-classified by extension: .jpg/.png/.webp/.gif → photo, .mp4/.mov → video, .ogg → voice message, .mp3/.m4a/.flac/.wav → audio file, anything else → document. Save artifacts to the current working directory or ~/.pi/agent/tmp/ before attaching (those are the allowed roots).
- DO NOT assume mentioning a local file path in plain text will send it. Only \`telegram_attach\` actually delivers files.
- Static stickers (.webp) sent by users arrive as image content you can see directly the FIRST time. Subsequent times the same sticker arrives, the image is omitted (you've already seen it) and only a stable \`sticker_id=<id>\` is shown — recall what it looked like from earlier in the conversation.
- Video stickers and animated (Lottie) stickers arrive as emoji-only hints (you don't see the actual content).
- DEFAULT REPLY TO A STICKER IS PLAIN TEXT. Do NOT echo stickers back automatically. \`telegram_send_sticker\` is reserved for the rare case the user EXPLICITLY asks you to send a sticker (e.g., "send me back the same sticker", "react with the sticker I just sent"). The presence of \`sticker_id=<id>\` in the prompt is informational — it does NOT mean you should re-send it.
- You can react to the user's message with an emoji via \`telegram_react\` (e.g., 👀 to acknowledge a long-awaited message, 👍 for agreement, ❤️ for warmth). Use sparingly — a reaction is a non-verbal acknowledgement, NOT a substitute for a reply. Reactions fire immediately on tool-call. Pass an empty string to clear. Telegram only accepts emojis from its standard palette (👍 👎 ❤️ 🔥 🥰 👏 😁 🤔 🤯 😱 😢 🎉 🤩 💯 🤣 ⚡ 🤨 😐 💋 😈 😴 😭 🤓 👀 🙈 😇 😨 🤝 🫡); obscure or custom emojis are rejected.
- The user can also react to YOUR messages — those arrive as a synthetic prompt like \`[user reacted to message <id> with 👀]\` or \`[user removed reaction from message <id> (was 👀)]\`. These are non-verbal signals (👀 = "noticed", 👍 = "ack", ❤️ = "thanks", 🤣 = "funny", etc.) — they are NOT a request for a reply.
- DEFAULT BEHAVIOR FOR INCOMING REACTIONS IS SILENCE. Output EXACTLY \`[[skip]]\` (and nothing else) to stay silent — that suppresses any text reply. Reply with actual text ONLY when the reaction unambiguously invites one (e.g., 🤔 = confusion, 👎 = disagreement). When in doubt, prefer \`[[skip]]\` — over-replying to reactions is annoying.`;

const STICKER_FALLBACK_EMOJI = "🎴";

/**
 * Markers we inject into the agent's prompt to describe inbound metadata.
 * Functions return the formatted string.
 */
export const promptFragments = {
  /** First line of every Telegram-originated prompt. `threadId` is null for non-forum chats. */
  header: (chatId: number, threadId: number | undefined, fromId: number | string): string =>
    `[telegram chat=${chatId}${threadId ? `:${threadId}` : ""} from=${fromId ?? "?"}]`,

  inReplyTo: (msgId: number, snippet: string): string =>
    `[in reply to (msg ${msgId}): ${snippet}]`,

  attachedHeader: "[user attached files]",
  attachedFooter: "[/files]",

  voiceMessage: (durationS: number, path: string): string =>
    `- voice message (recorded by user, ${durationS}s): ${path}`,

  audioFile: (path: string, durationS: number, title?: string, performer?: string): string => {
    const t = title ? ` "${title}"` : "";
    const p = performer ? ` by ${performer}` : "";
    return `- audio file${t}${p} (${durationS}s): ${path}`;
  },

  video: (durationS: number, path: string): string => `- video (${durationS}s): ${path}`,
  document: (path: string): string => `- document: ${path}`,

  stickerSeenBefore: (emoji: string | null, stickerId: string): string =>
    `[user sent sticker (emoji: ${emoji ?? STICKER_FALLBACK_EMOJI}, sticker_id=${stickerId}, seen-before)]`,
  stickerFirstTime: (emoji: string | null, stickerId: string): string =>
    `[user sent sticker (emoji: ${emoji ?? STICKER_FALLBACK_EMOJI}, sticker_id=${stickerId}, first-time)]`,
  stickerNoIngest: (emoji: string | null, stickerId: string): string =>
    `[user sent sticker (emoji: ${emoji ?? STICKER_FALLBACK_EMOJI}, sticker_id=${stickerId})]`,
  videoSticker: (emoji: string | null): string =>
    `[user sent a video sticker (emoji: ${emoji ?? STICKER_FALLBACK_EMOJI})]`,
  animatedSticker: (emoji: string | null): string =>
    `[user sent an animated sticker (emoji: ${emoji ?? STICKER_FALLBACK_EMOJI})]`,

  fileTooLarge: (name: string): string => `[file too large: ${name}]`,
  fileUnavailable: (name: string): string => `[file unavailable: ${name}]`,
  photoIngestError: "[photo ingest error]",

  reactionAdded: (msgId: number, emoji: string): string =>
    `[user reacted to message ${msgId} with ${emoji}]`,
  reactionRemoved: (msgId: number, was: string): string =>
    `[user removed reaction from message ${msgId} (was ${was})]`,
  reactionChanged: (msgId: number, was: string, now: string): string =>
    `[user changed reaction on message ${msgId}: ${was || "—"} → ${now || "—"}]`,
};

/**
 * Tool metadata exposed to pi.registerTool. Edit these to retune the agent's
 * understanding of what each tool does and when to use it.
 */
export const tools = {
  attach: {
    description:
      "Queue one or more local files to be sent with the current Telegram reply. " +
      "Files are auto-classified by extension: .jpg/.png/.webp/.gif → photo, " +
      ".mp4/.mov → video, .ogg → voice, .mp3/.m4a/.flac/.wav → audio, anything else → document. " +
      "Use this when the user asked for a file or you generated an artifact (image, audio, video, document) " +
      "instead of just mentioning the path in text.",
    promptSnippet: "Queue files to be sent with the current Telegram reply.",
    promptGuidelines: [
      "When handling a [telegram] message and the user asked for or you produced a file/image/audio/video, call telegram_attach with the absolute local path.",
      "Send files explicitly via this tool — mentioning a path in plain text does NOT deliver the file to Telegram.",
      "Allowed roots are the pi working directory and ~/.pi/agent/tmp/. Save artifacts there before attaching.",
    ],
  },
  sendSticker: {
    description:
      "RARE-USE: send a sticker to the current Telegram chat. ONLY use this tool when the user " +
      "EXPLICITLY asks for a sticker reply (e.g., 'send me that sticker back', 'reply with the same sticker'). " +
      "Default reply to any message — including a sticker — is plain text. Do NOT auto-echo stickers. " +
      "The sticker must have been previously sent by the user (so it lives in our cache); " +
      "pass the `sticker_id=<id>` from a prior `[user sent sticker (...)]` marker.",
    promptSnippet: "Send a sticker — only when the user explicitly asks for one.",
    promptGuidelines: [
      "Default reply to a sticker message is normal text. Do NOT echo the sticker back unless the user explicitly asks.",
      "Pass the `sticker_id` shown in earlier `[user sent sticker (...)]` markers, NOT the emoji.",
      "Only stickers from the cache work — you can't make up new sticker_ids.",
      "Sticker is queued and sent after your text reply (same flow as telegram_attach).",
    ],
  },
  react: {
    description:
      "Set an emoji reaction on a Telegram message. Common uses: 👀 to acknowledge you've seen " +
      "a long-awaited message, 👍 for agreement, ❤️ for warmth. Fires immediately (not queued). " +
      "Pass empty string to clear any prior reaction. Telegram only accepts emojis from its " +
      "standard reaction palette (e.g., 👍 👎 ❤️ 🔥 🥰 👏 😁 🤔 🤯 😱 😢 🎉 🤩 💯 🤣 👀 🤝 🫡); " +
      "obscure or custom emojis are rejected with a 400.",
    promptSnippet: "Set an emoji reaction on the user's message.",
    promptGuidelines: [
      "Default target is the user's incoming message that triggered the current turn — usually you don't need to pass messageId.",
      "Use sparingly: a reaction is a non-verbal acknowledgement, not a substitute for a reply.",
      "If a reaction is rejected (invalid emoji), the tool returns an error in `details`; pick another emoji from the palette and retry.",
    ],
  },
};

/** Strings returned to the agent as tool-result `content[].text`. */
export const toolResults = {
  attachNotInTurn:
    "telegram_attach is only available while replying to a Telegram message. The current turn is not from Telegram, so no file was queued. Continue normally.",
  attachQueued: (n: number): string => `Queued ${n} attachment(s) for delivery.`,
  attachFailures: (errors: string[]): string => `Failed: ${errors.join("; ")}`,

  stickerNotInTurn:
    "telegram_send_sticker is only available while replying to a Telegram message.",
  stickerNotInCache: (id: string): string =>
    `No sticker cached with sticker_id="${id}". The user must have sent that sticker earlier for it to be available.`,
  stickerQueued: (emoji: string | null): string =>
    `Queued sticker (emoji: ${emoji ?? "?"}) for delivery.`,

  reactNotInTurn: "telegram_react is only available while replying to a Telegram message.",
  reactedWith: (emoji: string): string => `Reacted with ${emoji}.`,
  reactionCleared: "Cleared reaction.",
  reactionFailed: (msg: string): string => `Reaction failed: ${msg}`,
};

/**
 * Italic markers appended to the streamed Telegram reply (visible to the user).
 * These run through the formatter, so leading `\n\n` separates them from prior content.
 */
export const streamerMarkers = {
  toolIndicator: (name: string, argsSummary: string): string =>
    `\n\n_⚙️ running: ${name}(${argsSummary})_`,
  stopped: "\n\n_⏹ stopped_",
  error: (msg: string): string => `\n\n_⚠️ error: ${msg}_`,
  attachmentSendFailureSuffix: (label: string, error: string): string =>
    `_⚠️ failed to send ${label}: ${error}_`,
};

/** CLI / bot replies (user-facing). */
export const userMessages = {
  // /telegram-connect
  alreadyRunning: "Bot is already running. Use /telegram-disconnect first.",
  noStoredToken: "No stored token. Usage: /telegram-connect <token> [--owner <user_id>]",
  reconnected: (owner: number): string => `Bot reconnected. Owner: ${owner} (existing).`,
  startedExplicitOwner: (owner: number): string =>
    `Bot started. Owner set to ${owner}. No pairing required.`,
  startedPairing: (code: string): string =>
    `Bot started. Send this code to the bot in DM to claim ownership: ${code} (valid 5 min)`,

  // /telegram-disconnect
  stopped: "Bot stopped.",

  // /telegram-status
  status: (running: boolean, owner: number | null): string =>
    [`Bot running: ${running}`, `Owner: ${owner ?? "(not paired)"}`].join("\n"),

  // /telegram-reset-stickers-cache
  stickerCacheCleared: "Sticker cache cleared.",

  // Bot-side replies
  pairSucceeded: "✅ You are now the owner. Use /help to see commands.",
  resetUnsupported:
    "Sorry, /reset is not supported in V1 (single-session bridge). Use pi-CLI to reset.",

  // Extension lifecycle
  extensionLoaded: "Extension loaded. Use /telegram-connect to start.",
};
