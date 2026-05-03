# pi-telegram-connect

A `pi`-CLI extension that bridges the [Pi coding agent](https://github.com/badlogic/pi-mono) to Telegram. Personal-use, single-owner: pair once, then chat with your local agent from Telegram.

## Features

- **Single-owner Telegram DM bridge** for one local `pi` session. Groups, supergroups, and channels are intentionally ignored.
- **Real-time streaming** via `editMessageText` with a periodic throttle (about 3 seconds), plus a final flush at turn end.
- **Typing indicator** while the agent is working.
- **Tool progress preview**: before the first text delta, Telegram shows a `_Working..._` header with running/completed tool calls. The final tool footer is optional via `showToolFooter`.
- **Markdown formatting** rendered as Telegram HTML (bold, italic, code, pre, links, blockquote, spoilers where supported); plaintext fallback if Telegram rejects the HTML.
- **Long-message split**: replies over Telegram's message limit continue in new messages at safe boundaries.
- **Silent reaction handling**: user reactions are forwarded to the agent as synthetic prompts; the prompt instructs the agent to answer with `[[skip]]` unless the reaction clearly asks for follow-up.
- **Owner pairing** via 6-character alphanumeric code with 5-minute validity, 5-attempt lockout, and constant-time compare.
- **Token validation** with Telegram `getMe` before pairing, so bad bot tokens fail immediately.
- **Inbound media**: photos, voice messages, audio files, video, documents, and static stickers are downloaded to a sandboxed temp dir. Photos and first-time static stickers are also passed to the agent as image content.
- **Voice vs audio distinction**: voice means a Telegram mic recording (Ogg/Opus); audio means an uploaded audio/music file. The agent is told they are different.
- **Outbound media** via `telegram_attach`, auto-classified by extension as photo, video, voice, audio, or document.
- **Sticker echo** via `telegram_send_sticker` for stickers the owner previously sent.
- **Sticker cache** at `~/.pi/agent/telegram-connect-stickers.json`; it is cleared automatically when the bot token changes and can be reset manually.
- **Reactions** via `telegram_react`, useful for lightweight acknowledgement while a long reply is still running.
- **`/stop`** aborts the current Telegram turn and calls `ctx.abort()` on the pi side. **`/reset`** is informational only; pi-CLI owns conversation history.

## Install

```bash
git clone https://github.com/artyom-ivanov/pi-telegram-connect
cd pi-telegram-connect
npm install
npm run build

pi install /absolute/path/to/pi-telegram-connect
```

`pi` discovers extensions through its own settings (`~/.pi/agent/settings.json#packages`), not via npm globals. Use `pi install <path>` to register a local checkout, or `pi install npm:@artyomspace/pi-telegram-connect` once the package is published.

## Quick Start

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy its token.
2. In `pi`, start the bridge:

   ```text
   > /telegram-connect 123:ABC...
   Bot started. DM this code to claim ownership: aB7xK3 (expires in 5 min).
   ```

3. DM the bot with the printed code. The bot replies: `✅ Ownership confirmed. Use /help to see commands.`
4. Chat with it like you would in pi-CLI. The agent keeps its normal pi tools and, during Telegram-originated turns, also gets Telegram-specific tools.

After a `pi` restart, run `/telegram-connect` with no args. It reuses the stored token and owner.

To skip pairing when you already know your numeric Telegram user ID:

```text
> /telegram-connect 123:ABC... --owner 840273
```

## Commands

CLI commands inside `pi`:

| Command | Description |
| --- | --- |
| `/telegram-connect [<token>] [--owner <user_id>]` | Start the bot. With no token, reuses stored config. With `--owner`, skips pairing. |
| `/telegram-disconnect` | Stop the bot. Config and sticker cache are preserved. |
| `/telegram-status` | Show whether the bot is running and the current owner. |
| `/telegram-reset-stickers-cache` | Wipe the sticker cache; stickers are re-learned next time the owner sends them. |

Bot DM commands, owner only:

| Command | Description |
| --- | --- |
| `/stop` | Abort the active turn and clear queued Telegram messages. |
| `/reset` | Informational only: reset is not supported from Telegram in the single-session model. |

## Agent Tools

These tools are registered with `pi.registerTool`, but they only work while the current turn came from Telegram:

- **`telegram_attach({ paths: string[] })`**: queue up to 10 local files for delivery after the assistant's text reply finalizes. Paths must resolve under the current `pi` working directory or `~/.pi/agent/tmp/`. Type is inferred from extension: `.jpg`/`.jpeg`/`.png`/`.webp`/`.gif` as photo, `.mp4`/`.mov`/`.m4v` as video, `.ogg` as voice, `.mp3`/`.m4a`/`.flac`/`.wav` as audio, everything else as document.
- **`telegram_send_sticker({ stickerId })`**: queue a previously seen sticker by `file_unique_id`. The ID appears in sticker markers injected into earlier Telegram prompts.
- **`telegram_react({ emoji, messageId? })`**: set or clear one reaction. Omitting `messageId` targets the owner message that triggered the current turn. Pass `""` to clear.

Plain-text file paths in the assistant reply do not send files. The agent must save the artifact under an allowed root and call `telegram_attach`.

## Configuration

Main config is stored at `~/.pi/agent/telegram-connect.json` with mode `0600`.

```jsonc
{
  "version": 2,
  "botToken": "123:ABC...",
  "owner": 840273,
  "pendingPairCode": null,
  "showToolFooter": false,
  "limits": {
    "maxIncomingFileMb": 20, // Telegram cloud Bot API getFile cap
    "maxOutgoingFileMb": 50, // sendDocument cap used as the package-level upload limit
    "maxQueueDepth": 32 // single global FIFO queue depth
  }
}
```

Sticker cache is stored separately at `~/.pi/agent/telegram-connect-stickers.json`.

Inbound temp files land under:

```text
~/.pi/agent/tmp/telegram/<chat_id>/<thread_id>/<msg_id>-<filename>
```

Filenames are sanitized to `[A-Za-z0-9._-]`, reduced to a basename, capped at 80 characters, and verified to stay inside the temp root.

A v1 to v2 migration runs automatically on first load. It preserves `botToken`, `owner`, and `pendingPairCode`, then drops old allowlist, group, session, and dead limit fields. Existing v2 configs missing new fields are filled from defaults.

## Runtime Flow

```text
Telegram message
  -> AccessControl (private chat + owner or pairing)
  -> MessageQueue (single global FIFO)
  -> MediaIngest (download to ~/.pi/agent/tmp/telegram/...)
  -> StickerCache (lookup or insert static stickers)
  -> pi.sendUserMessage(text or text + images)
  -> pi message/tool events
  -> Streamer (typing, working header, throttled edits, final flush)
  -> queued attachments/stickers
```

The extension injects a Telegram-specific system-prompt suffix only when processing a Telegram-originated turn. Plain pi-CLI prompts do not get Telegram tool instructions.

## Limitations

- **Personal-use only:** one bot, one owner, one local `pi` session.
- **No group support:** groups, supergroups, and channels are silently dropped.
- **Long polling only:** no webhook mode.
- **No built-in transcription:** voice/audio/video files are saved locally and described in the prompt; the agent must inspect or transcribe them with its normal tools.
- **Cloud Bot API file limits:** inbound files above `maxIncomingFileMb` are skipped; outbound files above `maxOutgoingFileMb` are refused before upload.
- **Telegram-specific media limits still apply:** for example, photos have stricter limits than documents.
- **Outbound path sandbox:** files must be under `process.cwd()` or `~/.pi/agent/tmp/`.
- **Video and Lottie stickers:** emoji-only hints; they are not downloaded or passed as image content.
- **Reactions:** Telegram accepts only its supported reaction emoji palette. Unsupported emoji produce a Telegram API error surfaced to the agent.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run prepublishOnly` runs the release gate: typecheck, lint, tests, and build.

For manual bot testing, see `scripts/e2e-manual.md`.

## Release Checklist

1. Update `CHANGELOG.md` and `package.json` version.
2. Run `npm run prepublishOnly`.
3. Inspect the packed artifact:

   ```bash
   npm pack --dry-run
   ```

4. Publish when the artifact contains only `dist`, `README.md`, `LICENSE`, `CHANGELOG.md`, and package metadata.

## License

MIT.
