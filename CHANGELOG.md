# Changelog

All notable changes to `@artyom-ivanov/pi-telegram-connect`.

## [0.1.0] — first release

Initial public release. Single-user, DM-only Telegram bridge for the Pi coding agent (`@mariozechner/pi-coding-agent`).

### Features
- Real-time streaming of agent replies via `editMessageText` (3 s periodic throttle).
- "Thinking…" header shown above the streamed message during the pre-reply phase, listing tool calls (`⚙️` running → `✅` done / `🚫` error). Header disappears once the agent emits text. Optional `showToolFooter` config flag keeps the call list as a footer in the final message.
- Markdown reply body rendered as Telegram HTML (with plaintext fallback on parse errors).
- Long-message split at safe boundaries (4096-char Telegram limit).
- Owner pairing via 6-character alphanumeric code (5-attempt cap, constant-time compare, 5-min validity).
- Token validation via `getMe` before pairing — bad tokens fail loudly instead of printing a phantom code.
- Inbound media: photos, voice messages, audio files, video, documents, static stickers (cached). Voice and audio are explicitly distinguished in the prompt. Video/Lottie stickers are emoji-only.
- Outbound delivery via three agent tools:
  - `telegram_attach({paths})` — auto-classified by extension (photo/voice/audio/video/document)
  - `telegram_send_sticker({stickerId})` — re-send a sticker the user previously sent
  - `telegram_react({emoji, messageId?})` — set/clear an emoji reaction
- Sticker cache (`~/.pi/agent/telegram-connect-stickers.json`) — file_id reuse, per-token invalidation on token change, `/telegram-reset-stickers-cache` CLI command.
- Inbound user-reaction events surfaced as synthetic prompts (`[user reacted to message N with 👀]`); agent defaults to `[[skip]]` (silent).
- `/stop` command in Telegram aborts the agent loop in pi.
- Forward-compatible config schema with v1 → v2 migration.

### Configuration
- File: `~/.pi/agent/telegram-connect.json` (mode 0600).
- Per-user limits: `maxIncomingFileMb` (default 20), `maxOutgoingFileMb` (default 50), `maxQueueDepth` (default 32).
- Opt-in `showToolFooter: false` flag.
- Outbound file sandbox: pi-CLI `cwd` and `~/.pi/agent/tmp/` only.

### Limitations (intentional, not bugs)
- Single-user, DM-only — non-private chats are silently dropped.
- No voice transcription (paths handed to the agent; agent reads them itself).
- Lottie `.tgs` and video `.webm` stickers don't reach the agent's vision; only their emoji.
- No webhook mode (long-poll only).
- All system prompts are English (replies follow the user's language).
