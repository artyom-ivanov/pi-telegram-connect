# pi-telegram-connect

A `pi`-CLI extension that bridges the [Pi coding agent](https://github.com/badlogic/pi-mono) to Telegram. Personal-use, single-owner: pair once, then chat with your agent from your phone.

## Features

- **Real-time streaming** of the agent's reply via `editMessageText` with a periodic throttle (≈3s).
- **Typing indicator** while the agent is working.
- **Markdown formatting** rendered as Telegram HTML (bold, italic, code, pre, links, blockquote, spoilers); plaintext fallback if Telegram rejects.
- **Long-message split** — replies > 4000 chars continue in a new message at a safe boundary.
- **Owner pairing** via 6-char alphanumeric code with a 5-attempt lockout, constant-time compare.
- **Inbound media**: photos, voice messages, audio files, video, documents, static stickers — all auto-downloaded to a sandboxed temp dir; photos & static stickers go to the agent as `image` content for vision.
- **Outbound media** via the `telegram_attach` tool (auto-classified by extension: photo/video/voice/audio/document).
- **Sticker echo** via `telegram_send_sticker` — re-send any sticker the user previously sent (no re-upload).
- **Sticker cache** at `~/.pi/agent/telegram-connect-stickers.json`: first time the user sends a sticker, we pass the image to the agent and store its `file_id`; subsequent times we skip re-processing and the agent recalls it from the conversation.
- **Reactions** via `telegram_react` (👀 to acknowledge a long-awaited message, 👍/❤️/etc. for non-verbal replies).
- **`/stop`** to abort the current turn (cancels the agent loop in pi too); **`/reset`** is informational only — single-session model means pi-CLI owns the history.
- **Voice vs audio distinction**: voice = recorded mic message (Ogg/Opus), audio = uploaded music/audio file. The agent is told they're different.

## Install

```bash
# build the package
git clone https://github.com/artyom-ivanov/pi-telegram-connect
cd pi-telegram-connect
npm install
npm run build

# register with pi
pi install /absolute/path/to/pi-telegram-connect
```

`pi` discovers extensions through its own settings (`~/.pi/agent/settings.json#packages`), not via npm globals. Use `pi install <path>` to register the local package, or `pi install npm:@artyom-ivanov/pi-telegram-connect` once published.

## Quick start

1. Create a bot via [@BotFather](https://t.me/BotFather), grab its token.
2. In `pi`:
   ```
   > /telegram-connect 123:ABC...
   Bot started. Send this code to the bot in DM to claim ownership: aB7xK3 (valid 5 min)
   ```
3. DM the bot with `aB7xK3`. Bot replies `✅ You are now the owner.`
4. Talk to it like you would in pi-CLI. The agent has full pi-CLI tools (bash, file edits, etc.) and three Telegram-specific tools (attach, send sticker, react).

After a `pi` restart, just run `/telegram-connect` with no args — it reuses the stored token and owner.

## Commands

CLI (inside `pi`):

| Command | Description |
|---|---|
| `/telegram-connect [<token>] [--owner <user_id>]` | Start the bot. With no args: reuses stored token + owner. With `--owner`: skips pairing. |
| `/telegram-disconnect` | Stop the bot. Config is preserved. |
| `/telegram-status` | Show whether the bot is running and the current owner. |
| `/telegram-reset-stickers-cache` | Wipe the sticker cache (re-learns next time the user sends each sticker). |

Bot DM commands (owner only):

| Command | Description |
|---|---|
| `/stop` | Abort the agent's current turn (also calls `ctx.abort()` on the pi side). |
| `/reset` | Informational — single-session bridge can't reset pi's history. Use pi-CLI to manage history. |

## Tools the agent gets

Registered via `pi.registerTool` only when the current turn is from Telegram (so the agent doesn't see them in plain pi-CLI sessions):

- **`telegram_attach({paths: string[]})`** — queue local files for delivery with the current reply. Auto-classified: `.jpg`/`.png`/`.webp`/`.gif` → photo, `.mp4`/`.mov` → video, `.ogg` → voice, `.mp3`/`.m4a`/`.flac`/`.wav` → audio, anything else → document. Sandbox: paths must resolve under `process.cwd()` (the pi working dir) or `~/.pi/agent/tmp/`.
- **`telegram_send_sticker({stickerId})`** — re-send a sticker the user previously sent. The `stickerId` comes from `[user sent sticker (... sticker_id=<id> ...)]` markers in earlier prompts.
- **`telegram_react({emoji, messageId?})`** — set an emoji reaction on a message. Default target = the user's incoming message in the current turn. Empty string clears the reaction. Telegram only accepts emojis from its standard reaction palette; obscure ones are rejected.

## Configuration

Stored at `~/.pi/agent/telegram-connect.json` (mode `0600`).

```jsonc
{
  "version": 2,
  "botToken": "123:ABC...",
  "owner": 840273,
  "pendingPairCode": null,
  "limits": {
    "maxIncomingFileMb": 20,    // cloud Bot API getFile cap is 20 MB; larger files are skipped
    "maxOutgoingFileMb": 50,    // cloud Bot API send-document cap is 50 MB; we refuse oversize uploads
    "maxQueueDepth": 32         // per-chat FIFO depth; rarely matters in single-user mode
  }
}
```

Sticker cache (separate file): `~/.pi/agent/telegram-connect-stickers.json`.

Inbound temp files land under `~/.pi/agent/tmp/telegram/<chat_id>/<thread_id>/<msg_id>-<filename>` (filenames sanitized to `[A-Za-z0-9._-]`).

A v1 → v2 migration runs automatically on first load: `botToken`, `owner`, `pendingPairCode` are preserved; everything else (allowlists, group policies, dead `limits.*` fields) is dropped.

## Architecture

Single-session bridge: one pi-CLI = one Telegram bot, one user (the owner). Non-private chats (groups, channels) are silently dropped — this connector is intentionally personal-use.

Inbound flow:

```
Telegram message → AccessControl (owner check + pairing)
                 → MessageQueue (per-chat FIFO; single global lane in practice)
                 → MediaIngest (download to ~/.pi/agent/tmp/telegram/...)
                 → StickerCache (lookup or insert)
                 → pi.sendUserMessage([text + base64 images])
                 → pi.on("message_update", ...) → Streamer.appendDelta
                 → pi.on("agent_end", ...) → Streamer.finalize
                 → sendQueuedAttachments (files + stickers from telegram_attach / telegram_send_sticker)
```

The agent is told about the bridge via a `before_agent_start` hook that injects a system-prompt suffix — but only for Telegram-originated turns, so plain pi-CLI sessions stay clean.

## Limitations

- **Cloud Bot API:** inbound files capped at 20 MB (`getFile`), outbound capped at 50 MB (`sendDocument`). Larger files are refused with an explicit error.
- **Outbound paths:** restricted to `process.cwd()` and `~/.pi/agent/tmp/`. Save artifacts there before calling `telegram_attach`.
- **`/reset` from Telegram is a no-op** in V1: pi-CLI owns the conversation history.
- **Reactions:** Telegram accepts only emojis from a fixed palette (👍 👎 ❤️ 🔥 🥰 👏 😁 🤔 🤯 😱 😢 🎉 🤩 💯 🤣 ⚡ 🤨 😐 💋 😈 😴 😭 🤓 👀 🙈 😇 😨 🤝 🫡 …). Anything else returns a 400; the tool surfaces this to the agent so it can pick a different one.
- **Video and Lottie stickers:** emoji-only — not downloaded, not passed to the agent.
- **Group / multi-user support:** intentionally not present. If you want it, fork.

## Roadmap

- Standalone daemon mode (no `pi`-CLI required) — for production deployments.
- Webhook mode (today: long-poll only).
- Inline keyboards for interactive tools.
- Voice transcription (today: voice files are saved to disk; the agent reads/transcribes them itself if needed).
- Group support behind a flag.

## License

MIT.
