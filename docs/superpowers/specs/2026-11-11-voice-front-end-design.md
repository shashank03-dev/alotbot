# Grok Call as a voice front end for Grok Bots

Approved by Shashank on 2026-11-11 (scope "everything now", SQLite, approvals spoken and as buttons, all live tests allowed).

Keep the TypeScript backend, the Swift app and the current sign-in. Grok's agent does work that needs its computer,
identity or approvals; direct tools do what the backend can discover, validate, execute and report itself.

## Validated research (2026-11-11)

- Grok Bot is 0.79.4; the client header still said 0.79.3. It is bumped.
- Transcript paging with `beforeSeq` works (two bots: second page of 50, no overlap, all older).
- Each bot has a numeric id and a UUID (`agentId`). Routines, automations, skills and files need the UUID; with it,
  routines and files answer (the X bot has 1 routine and 1 automation; My Bot has 4 built-in skills). The account
  connector list is the same with or without a bot id.
- The released Grok Bot app gets `send_task`, `search_conversations`, `end_the_call` from the server, as we do.
- xAI accepts `async_update.add` (topic `work_landed`, `trigger_response: false`) on our sessions.
- Approval cards: `ResolveGrokBotAutoReviewApproval` {agentId, requestId, resolution APPROVED|DENIED|ALWAYS,
  approvalPlatform "desktop"}. Mac tool asks: chat entries `send-message` / type `local-tool-permission` with
  `ask.status` and `ask.requestId`, resolved by `ResolveGrokBotLocalToolPermission` {agentId, entryId, requestId,
  resolution ALLOW_ONCE|DENY|ALWAYS|NEVER}.
- Not reachable on this API (the app uses its own link to the agent's box): call presence, the agent's
  `voice-calls/` record and working notes (`work_overheard`).

## Architecture

1. **Action history** (`src/actions.ts`, node:sqlite at `<data>/actions.sqlite`, mode 0600). Every tool action is a
   row written before dispatch: call, bot, target (agent, app, mac, browser, screen), tool, input, status (running,
   waiting_approval, completed, failed, unknown), upstream request id, summary, full result, error, timestamps.
   Agent replies are events with a unique (bot, seq), so replays are dropped. Per-bot transcript cursors persist.
2. **Job watcher** (`src/jobs.ts`), in the backend, independent of voice sockets: pages the transcript back to its
   cursor (up to 10 pages), maps our job messages to their request ids, attributes replies, approval asks and cards to
   the right action, records written turns, and keeps checking while the app runs (3 s for 2 min after a job, then
   15 s, for 24 h). On relaunch it resumes open actions from SQLite. The call reads updates from the store.
3. **Grok-parity call** (`public/core.js`, `src/grokbot.ts`): description, spoken language and speed setting sent to
   the harness; Grok's current-time block; Grok's greeting after a 15 s caller-first grace; Grok's receipt on a job
   before the relay answers; real `newsOwed`/`receiptOwed`; job results and typed chat messages delivered with
   `async_update.add` (held, then spoken through the turn engine); session resumption on reconnect; a 20 s ping
   watchdog; Grok's "call ended" message (plus unrelayed host lines) sent to each bot's agent at Leave.
4. **Connectors** (`src/apps.ts`): malformed catalog entries are skipped, not fatal; arguments validated with Ajv
   against the discovered schema; an identical write by the same bot in the same call runs once; connector errors
   (failed) are kept apart from transport errors and timeouts (unknown); voice gets at most 40,000 characters and the
   full result stays in the action history.
5. **Approvals**: pending approval cards and Mac tool asks become waiting_approval actions; the bot says what is
   waiting; the Mac app shows Approve and Deny, which call Grok's own resolve endpoints.
6. **Skills, routines, files**: per-bot skills and routines (by UUID) are named in the bot's instructions; files are
   listed in the Mac app.
7. **Mac executors**, as call tools: a Swift file tool limited to a folder the user picks (list and read text,
   size-capped); a Playwright browser (`playwright-core` 1.61.1 with the cached Chromium, dedicated profile); screen
   control through Apple's window picker and the Accessibility tree of the shared window (list controls, press one).
   Each is off until the user enables it, and each records actions.
8. **Mac app**: an Actions list with status, details and Approve/Deny; settings for the file folder, browser and
   shared window.

## Acceptance tests

1. Reconnecting an app mid-call: it is listed and a read works without restarting; a malformed entry leaves the rest.
2. The same write twice in one turn runs once; invalid arguments run zero times; a timeout shows outcome unknown.
3. A bot reads a Mac-only file with a random value through the file tool; the action and result survive a relaunch.
4. More than 50 unrelated entries between a job and its approval card: the card reaches the right job once, and a
   reconnect keeps it.
5. A large tool result: the call stays responsive, voice gets the short form, the full result is in the history.
