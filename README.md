# Grok Call

A group voice call with your own Grok Bots.

- **Join and leave** the call.
- **Pick which bots are in it**: any subset, before the call and during it (People panel).
- **Hear them**: each bot speaks in its own Grok voice (the voice set in the Grok Bot app).
- **Talk with them**: your mic goes to the bot you're talking to; name a bot to talk to that one.
- **They talk to each other**: each bot hears what the others say and they keep the conversation going.
- **Bots can pull other bots in**: a bot in the call can bring any of your other Grok Bots into the call, when you ask ("My Bot, pull Shashank's X bot in") or on its own when it thinks that bot would help.

It uses your Grok Bot sign-in and plan. No API key, no extra account.

## Run it

Needs Node.js 22.18 or newer (tested on 26.11.1) and a browser with a microphone. Headphones are best; see [Echo](#echo).

```bash
npm install   # dev tools only: typescript + node types
npm start
```

Open **http://127.0.0.1:8787**.

1. **Sign in.** The first time, click *Sign in*. A tab opens with the same sign-in page the Grok Bot app uses. Log in with your Grok Bot account. The page updates by itself.
2. **Pick bots.** Tick the bots you want, then *Join call*. Allow the microphone.
3. **Talk.** Speak normally. The bot marked *Listening to you* hears you. Say a bot's name ("Shashank's X bot, what do you think?") to talk to that one.
4. **Change who's in the call** with the People button. **Mute** with the mic button. **Leave** with the red button.

Set `PORT=9000` (or `HOST=localhost`) in the environment or a `.env` file to change where it listens. It only listens on this machine.

## How the call works

- On join, each picked bot gets its own live voice session (Grok voice, `grok-voice-3.0`), with that bot's own voice-call instructions from Grok Bot plus a note that it's in a group call and who else is there.
- The first bot to connect opens the call with one short line.
- **Your mic** goes to one bot at a time: the last bot that spoke, or the bot you named. Grok voice sessions always reply to audio they hear, so sending your voice to every bot would make them all answer at once. The other bots get your words as text: `[Shashank (host)]: ...`. Every bot is told that what the host says comes before the current topic.
- **Bot to bot**: when a bot finishes, the others get its words as `[Bot name]: ...`. Then the bot it named answers, or the next bot in line. After 6 bot turns in a row they stop and wait for you.
- **Interrupting**: start talking and every bot goes quiet at once. A bot you cut off is told how much of its answer you actually heard, and the other bots get only that part, tagged `(cut off by the host)`.
- **Stuck mic**: if the call thinks you are still talking but your mic has been quiet for 8 seconds and no words came through, it stops waiting and the listening bot answers.
- Voices never overlap: all bot audio plays on one timeline.
- A bot that drops reconnects by itself with the conversation so far. A bot added mid-call also gets the conversation so far.
- **Pulling a bot in**: every bot in the call has one tool, `invite_bot`, and knows which of your bots aren't in the call yet. When a bot uses it, that bot joins (its tile appears), gets the conversation so far, is told who pulled it in, and says hello; the bot that invited it confirms out loud. Asking for a bot that doesn't exist or is already in the call is refused and the bot is told why. An invite inside a reply that got cut off is not carried out.

## Limits, stated plainly

- **Unofficial.** Grok Bot has no public API. This app signs in and calls Grok Bot the same way the Grok Bot desktop app (v0.79.3) does. xAI's Acceptable Use Policy bars access "through unauthorized bots or scripts", so using this carries a risk to your account. You chose this route knowing that.
- **May break when Grok Bot changes.** If xAI changes those endpoints, sign-in or voice may stop working until this app is updated.
- **Usage counts against your plan.** Each bot in the call is a live voice session on your account. If your plan's included usage runs out, that bot shows the reason in its tile.
- **Bots hear each other as text, not audio.** Another bot's speech reaches a bot as its exact words. Your speech reaches the listening bot as audio and the rest as text.
- **Bots with no voice set** in the Grok Bot app use Grok's default voice, so two such bots sound the same. Set a voice for each bot in the Grok Bot app to tell them apart.
- **Only one bot tool during the call: `invite_bot`.** Bots can't run their other Grok Bot tools (send tasks, search past chats, hang up) from this call. Bots can pull others in but can't remove anyone; only you can, from People.
- **Name matching is simple.** "Name a bot" works when the transcript contains the bot's name. If speech-to-text mishears it, the bot that was listening answers instead.

### Echo

With speakers, a bot's voice can come back through your mic. The app asks the browser for echo cancellation and holds back quiet mic audio while a bot is speaking, so you need to speak up to cut in. A line that mostly repeats what a bot just said is dropped as echo, but only if a bot's voice was playing when you started talking, and never if it has "no", "wait", "stop", "actually" or "wrong" in it. Headphones avoid the problem entirely.

## Sign-in and privacy

- The sign-in is saved in `.data/auth.json`, readable only by your user and ignored by git. It lasts about 60 days and refreshes itself. To sign out, delete that file.
- The server never sends your sign-in to the browser. The page only gets a short-lived voice key per bot (valid ~5 minutes to connect).
- The server only accepts requests from this machine (Host must be `127.0.0.1`, `localhost` or `::1`), and refuses POSTs from other websites.

## Tests

```bash
npm test          # 82 tests; fails below 100% line/branch/function coverage of src/ and public/core.js
npm run typecheck
```

Tests use a fake Grok Bot backend and fake voice sockets, so they never touch your account. Not covered by unit tests: `src/main.ts` (startup) and `public/app.js` (page and Web Audio glue). Both were checked with a real call in headless Chromium against the real Grok Bot service. That run used a fake mic playing a spoken line and confirmed: bots opened the call and talked among themselves, the spoken line was transcribed, the named bot answered, interrupting cut the speaking bot, adding and removing bots worked, a bot pulled another bot into the call when asked, and Leave closed every connection. Headless Chromium has no speakers, so actually *hearing* the audio was not checked there. Try it yourself.

## Files

```
src/main.ts        start-up
src/config.ts      HOST / PORT (local only)
src/auth.ts        sign-in (browser login + polling) and the saved sign-in
src/grokbot.ts     Grok Bot calls: list bots, voice session per bot, token refresh
src/server.ts      local HTTP server: page, /api/state, /api/login, /api/bots, /api/bots/:id/voice
public/index.html  the call page (styles + layout)
public/app.js      page logic: sign-in, bot picker, mic and speakers, call grid, People panel
public/core.js     call engine: voice sessions, turn-taking, bot-to-bot, interrupting, playback queue
test/              node:test suites with fake backends
```
