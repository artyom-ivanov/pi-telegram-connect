# Manual E2E Checklist for pi-telegram-connect

Use this for a final smoke test against a real Telegram bot before publishing.

## Setup

1. Create a test bot via @BotFather and save the token.
2. `export PI_TG_TEST_TOKEN=<token>`
3. In a fresh terminal: `npm run build && pi`
4. Inside `pi`-CLI: `/telegram-connect $PI_TG_TEST_TOKEN`

## Pairing

- [ ] CLI prints a 6-character code.
- [ ] DM the bot with random non-code text before pairing -> bot stays silent.
- [ ] DM the bot with a wrong 6-character code -> bot stays silent.
- [ ] DM the bot with the printed code -> bot replies `✅ Ownership confirmed. Use /help to see commands.`
- [ ] CLI `/telegram-status` shows `Running: true` and the owner user ID.
- [ ] Fresh pairing cycle: 5 wrong code attempts invalidate the pending code; the correct code no longer pairs afterward.

## Access Policy

- [ ] After pairing, DM from the owner account works.
- [ ] DM from a different account stays silent.
- [ ] Add the bot to a group or supergroup and send messages -> bot stays silent.
- [ ] Start with explicit owner: `/telegram-connect $PI_TG_TEST_TOKEN --owner <user_id>` skips pairing and owner DM works.
- [ ] Restart `pi`, run `/telegram-connect` with no args -> stored token and owner are reused.

## Streaming

- [ ] Ask for a long answer -> message edits live with about a 3-second throttle.
- [ ] Ask for a task that uses tools before replying -> `_Working..._` header appears with tool status.
- [ ] Final message omits tool history by default.
- [ ] Set `"showToolFooter": true` in `~/.pi/agent/telegram-connect.json`, reconnect, and verify final message includes completed tool history.
- [ ] Reply longer than Telegram's message limit continues in a new message.
- [ ] Markdown with code blocks, links, lists, and bold/italic renders acceptably; malformed HTML falls back to plain text.

## Stop and Reset

- [ ] DM a long-running task, then send `/stop` -> current answer ends with a stopped marker and queued Telegram messages are cleared.
- [ ] Verify the pi agent loop is actually aborted, not only Telegram output.
- [ ] DM `/reset` -> bot replies that reset is not supported from Telegram.

## Inbound Media

- [ ] Send a photo -> agent receives image content and can describe it.
- [ ] Send a voice message -> prompt includes `voice (...s): <local path>`.
- [ ] Send an uploaded audio/music file -> prompt includes `audio ...: <local path>`, distinct from voice.
- [ ] Send a video -> prompt includes `video (...s): <local path>`.
- [ ] Send a document -> prompt includes `document: <local path>`.
- [ ] Send a static sticker first time -> prompt includes a new sticker marker and image content.
- [ ] Send the same static sticker again -> prompt includes a seen sticker marker and does not re-ingest image content.
- [ ] Send a video sticker -> prompt includes only a video sticker emoji marker.
- [ ] Send a Lottie sticker -> prompt includes only an animated sticker emoji marker.
- [ ] Send a file larger than `maxIncomingFileMb` -> prompt includes a file-too-large marker.

## Outbound Media

- [ ] Ask the agent to create and send a file under the current working directory -> `telegram_attach` queues and sends it.
- [ ] Verify extension-based classification: photo, video, voice `.ogg`, audio, and document.
- [ ] Ask the agent to send a file under `~/.pi/agent/tmp/` -> allowed.
- [ ] Ask the agent to send a path outside allowed roots, such as `/etc/passwd` -> tool refuses it.
- [ ] Ask the agent to send more than 10 files in one turn -> tool enforces the per-turn limit.
- [ ] Ask the agent to send a previously seen sticker by `sticker_id` -> bot sends the cached sticker.
- [ ] Run `/telegram-reset-stickers-cache`; sending the same sticker again should re-learn it.

## Reactions

- [ ] Ask a long-running question where acknowledgement is natural -> agent can call `telegram_react` before text arrives.
- [ ] React to a bot message with a neutral reaction -> agent should usually emit `[[skip]]`, producing no Telegram reply.
- [ ] React with a disagreement or clarification reaction, such as `🤔` or `👎` -> agent may send a follow-up.

## Disconnect and Token Rotation

- [ ] CLI `/telegram-disconnect` mid-stream -> in-flight turn aborts and queues drop.
- [ ] Reconnect with the same token -> owner and sticker cache are preserved.
- [ ] Reconnect with a different valid token -> sticker cache is cleared.
- [ ] Start with an invalid token -> `/telegram-connect` fails before printing a pairing code.

## Release Gate

- [ ] `npm run prepublishOnly`
- [ ] `npm pack --dry-run`
