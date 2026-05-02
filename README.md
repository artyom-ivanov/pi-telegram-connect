# pi-telegram-connect

Telegram connector for the [Pi coding agent](https://github.com/badlogic/pi-mono). Registers as a `pi`-CLI extension and lets you talk to your agent through Telegram with rich media, real-time streaming, and policy-based access control.

## Features

- Real-time streaming via `editMessageText` (with tool-progress indicators).
- Markdown formatting (bold, italic, code, links, blockquotes, spoilers).
- Multi-chat with per-chat session isolation, including forum topics.
- Owner pairing via 6-character code.
- DM/group whitelists with `pairing/allowlist/open/disabled` policies.
- Per-group reply behavior: `owner | mention | all`, with frequency hints.
- Media in: voice, audio, video, files, photos, stickers (static + video).
- Media out: `telegram_send_photo/voice/audio/video/sticker/document` (sandboxed paths).
- Sticker description cache (vision-derived, persisted across restarts).
- `/stop` to abort the current turn; `/reset` to clear chat history.

## Install

```bash
npm install -g @artyom-ivanov/pi-telegram-connect
```

## Quick start

```
$ pi
> /telegram-connect 123:ABC...
Bot started. Send this code to the bot in DM to claim ownership: aB7xK3 (valid 5 min)
```

DM the bot with `aB7xK3`. The bot replies `✅ You are now the owner.`

## Commands

CLI (inside `pi`):

| Command | Description |
|---|---|
| `/telegram-connect <token> [--owner <id>]` | Start the bot; prints pairing code (or skips if --owner) |
| `/telegram-disconnect` | Stop the bot |
| `/telegram-status` | Show run state, owner, policies, allowlists |
| `/telegram-allow <user_id>` | Allow a user |
| `/telegram-revoke <user_id>` | Revoke a user |
| `/telegram-allow-group <chat_id>` | Allow a group |
| `/telegram-revoke-group <chat_id>` | Revoke a group |
| `/telegram-policy dm <pairing\|allowlist\|open\|disabled>` | Set DM policy |
| `/telegram-policy group <allowlist\|open\|disabled>` | Set group policy |
| `/telegram-group-mode [<chat_id>] <owner\|mention\|all>` | Set per-group reply mode (or default) |
| `/telegram-group-frequency [<chat_id>] <rare\|medium\|often>` | Set frequency hint |

Bot (DM, owner only):

| Command | Description |
|---|---|
| `/reset` | Clear current chat history |
| `/stop` | Abort current turn in this chat |

## Configuration

Stored at `~/.pi/agent/telegram-connect.json` (mode `0600`).

## Limitations

- **Bot API cloud:** inbound files are capped at 20 MB (`getFile` limit).
- **Outbound paths:** restricted to `~/.pi/agent/tmp/` by default. The agent must save files there before calling `telegram_send_*`.
- **`@username` resolution:** only works for users who have contacted the bot at least once. Numeric `user_id` always works.
- **`replyMode: all`** widens the prompt-injection surface to all group members. Prefer `mention` or `owner` for sensitive groups.
- **Lottie `.tgs` animated stickers** are not described (emoji-only injection) — Roadmap.
- **Optional dependency:** `ffmpeg` in `PATH` enables description of video stickers (`.webm`).

## Roadmap

- Reactions (bot → user, user → bot).
- Standalone daemon mode (no `pi`-CLI required).
- Webhook mode.
- Hard rate-limit on `replyMode: all`.
- Inline keyboards for interactive tools.
- Lottie `.tgs` rendering.
- Audit log for shared-machine deployments.
- Bot token rotation command.

## License

MIT.
