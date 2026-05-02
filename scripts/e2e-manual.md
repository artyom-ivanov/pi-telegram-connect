# Manual E2E Checklist for pi-telegram-connect

## Setup

1. Create a test bot via @BotFather. Save the token.
2. `export PI_TG_TEST_TOKEN=<token>`
3. In a fresh terminal: `npm run build && pi`. Inside `pi`-CLI: `/telegram-connect $PI_TG_TEST_TOKEN`.

## Pairing

- [ ] CLI prints a 6-char code.
- [ ] DM bot with random 6-char string (wrong code) → bot stays SILENT.
- [ ] DM bot with non-pairing-code text → bot stays SILENT.
- [ ] DM bot with the printed code → bot replies "✅ You are now the owner."
- [ ] CLI: `/telegram-status` shows owner = your user_id, dm policy = allowlist.
- [ ] DM bot 5 wrong codes (in a fresh `/telegram-connect` cycle) → 6th attempt: bot stays silent and CLI logs "Pairing aborted".

## DM allowlist

- [ ] After pairing: DM bot from another account → bot stays SILENT.
- [ ] CLI: `/telegram-allow <other_user_id>` → from that account, DM works.
- [ ] CLI: `/telegram-revoke <other_user_id>` → DM goes silent again.
- [ ] CLI: `/telegram-policy dm open` → any DM works.
- [ ] CLI: `/telegram-policy dm disabled` → no DMs work, even owner's.

## Streaming

- [ ] DM "explain how grammY runner concurrency lanes work" → bot replies, message edits live (3s throttle visible).
- [ ] During a long answer with a tool call: tool indicator `_⚙️ running: <tool>(...)_` appears at end of preview, disappears when tool finishes.
- [ ] Reply > 4096 chars: continuation message appears; first message is finalized; second begins live-updating.
- [ ] Reply taking > 60 seconds: at age=60s, current preview is finalized; new continuation message starts live-updating.

## /stop and /reset

- [ ] DM long task; quickly send `/stop` → reply ends with `_⏹ stopped_`, no further edits.
- [ ] DM `/reset` → bot replies "History cleared for this chat."; following DM starts fresh context.

## Media inbound

- [ ] Send a photo → agent gets it as image input; describes correctly.
- [ ] Send a voice message → agent receives "[user attached files] - voice (Ns): /tmp/...". Agent can `read_file` it.
- [ ] Send a video → same.
- [ ] Send a document (e.g., 50KB .txt) → same.
- [ ] Send a sticker (static) → injection: "[user sent sticker: <description> (emoji: ...)]". Subsequent send of the SAME sticker uses cached description (verify by inspecting `~/.pi/agent/telegram-connect-stickers.json`).
- [ ] Send a video sticker (.webm) → first-frame description (if ffmpeg installed).
- [ ] Send an animated Lottie sticker (.tgs) → injection: "[user sent animated sticker (emoji: ...)]" — no download.
- [ ] Send a 25 MB file → bot replies with `[file too large: ..., 25MB, skipped]` block in agent's view.

## Media outbound

- [ ] Place a `.ogg` Opus file under `~/.pi/agent/tmp/`. Ask agent to send it as voice → `telegram_send_voice` invoked, file delivered.
- [ ] Same for photo (.jpg), video (.mp4), document, sticker (.webp).
- [ ] Ask agent to send `/etc/passwd` as document → tool returns `path_outside_sandbox`; preview shows `_⚠️ send failed: path_outside_sandbox_`.
- [ ] Ask agent to send a non-Ogg file as voice → tool returns `invalid_format`.

## Groups

- [ ] Add bot to a test group with `policy.group = allowlist`. Bot DMs you with Allow/Deny → tap Allow.
- [ ] In the group with `replyMode: mention`: send normal text → bot silent. Reply to a bot message → bot replies. `@bot_username hi` → bot replies.
- [ ] Set group `replyMode: all`, `replyFrequency: rare`. Send small-talk → bot stays silent (LLM emits `[[skip]]`). Send a directed question → bot replies.
- [ ] Set group `replyMode: owner`. Owner messages → bot replies; other members' messages → silent.
- [ ] Forum group with topics: `/reset` in topic A → topic A's history cleared, topic B unaffected.

## Group lifecycle

- [ ] Bot kicked from group → CLI logs "Group X evicted"; group removed from allowedGroups; subsequent re-add requires Allow flow again.

## Disconnect

- [ ] CLI `/telegram-disconnect` mid-stream → in-flight turn aborts, queues drop. Reconnect via `/telegram-connect` (same or new token) — config + sessions intact.

## Token rotation / revocation

- [ ] Revoke token in @BotFather while bot running → bot fatal-stops, CLI prints "Bot token invalid/revoked".

## Concurrency

- [ ] Fire 5 messages in quick succession to one DM → answers come back in order, FIFO.
- [ ] Fire messages from 3 different chats → all 3 progress in parallel.
