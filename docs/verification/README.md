# Verification — 2026-11-11

The updated app is installed at `/Users/shashank/Applications/Grok Call.app`. It was rebuilt and reinstalled at 17:13 UTC with the approval and restart fixes; its backend reconnected at 17:13:10 UTC. The previous idle app was backed up at `/Users/shashank/Applications/.GrokCall-backups/20261111-224309/Grok Call.app` (the older one is still at `.GrokCall-backups/20261111-215316`). Sign-in data was kept outside the app bundle. Nothing was committed, pushed, or posted publicly.

## Measured checks

| Check | Result | Evidence |
| --- | --- | --- |
| Node 26.11.1 suite | 443 passed, 0 failed; 100% lines, branches, functions | [node-tests.txt](node-tests.txt) |
| Minimum Node 22.18.0 suite | Same 443 passed, 0 failed; 100% lines, branches, functions | [node22-tests.txt](node22-tests.txt) |
| TypeScript | Pass | [typecheck.txt](typecheck.txt) |
| Swift | 85 core tests + 5 native tests passed | [swift-tests.txt](swift-tests.txt) |
| Native shared-window test | A separate AppKit process was inspected, its button pressed once, its changed label verified, stale control rejected, PNG captured, and closed window rejected | [swift-tests.txt](swift-tests.txt), `mac/Tests/GrokCallNativeTests/MacToolsTests.swift` |
| Native action UI | All five statuses and approval controls rendered and visually inspected; result details are inline with their action | `rendersActionStatesForVisualInspection`, `/tmp/grok-actions-ui.png` |
| Browser | Real Chromium navigation, snapshot, fill, click, resulting state, missing selector, bad input, disabled access, and closed tab; desktop browser also ran through the call backend | [node-tests.txt](node-tests.txt) |
| Release bundle | Built; installed bundle passed `codesign --verify --deep --strict` | [release-build.txt](release-build.txt), [installation.json](installation.json) |
| Production dependency audit | Zero reported vulnerabilities | [dependency-audit.json](dependency-audit.json) |

Node coverage covers `src/` and `public/core.js`, excluding only `src/main.ts` and `src/overlay/main.ts`. It does not cover `public/app.js` or Swift. Swift coverage is **partial**, and is separately measured in [swift-coverage.txt](swift-coverage.txt). That report includes complete existing UI files, not only newly changed lines. Swift did not emit branch coverage. The Node 100% result must not be presented as 100% coverage of the entire Mac app.

## Live account checks

- All three bots returned voice setup, greetings, receipts, connected apps and computer availability. My Bot returned 4 skills and 13 files; Shashank's Bot returned 11 files; the X bot returned 1 routine and 49 files. Each returned 9 connected apps.
- Transcript pagination read 162 unique entries from Shashank's Bot across pages without a gap. Automated tests separately cover a 600-entry backlog, replay, restart, broken paging cursors, and correct attribution of an approval after 120 unrelated entries.
- A live Grok voice session invoked the actual Swift folder reader exactly once through the call backend. The model received no nonce in its prompt. Its spoken transcript matched the random Mac-only file content, audio frames arrived, and the completed action survived reopening SQLite. This test used a Swift helper as the native transport, rather than automating the installed app's folder picker.
- Grok's existing agent independently returned a second Mac-only nonce in 25,692 ms. A terminal-specific job returned a third nonce in 20,358 ms. These used files inside the project's home-folder scope and the existing agent's Mac executor.
- The call-ended notification was verified as an actual message in the bot's live transcript, on a voice channel.
- A real pending Mac-action approval was created (this Mac was set to "ask" for the test, then restored to its original "always"), approved through Grok Call's resolver, and the agent then returned the test nonce. Before the fix, Grok rejected the request with HTTP 400 because the resolution was sent as a name instead of the protobuf enum number. Evidence: [approval-live.json](approval-live.json).
- Two concurrent identical connector write requests dispatched once and created exactly one private, unsent test Gmail draft. The test draft was deleted, then a read verified zero matching drafts remain. No email was sent.

Evidence: [live-results.json](live-results.json), [agent-job-live.json](agent-job-live.json), [agent-terminal-live.json](agent-terminal-live.json), [connector-write-live.json](connector-write-live.json).

## Regressions found and fixed

- Interrupted migration left missing call-test imports and stale polling expectations.
- Invalid connector arguments could execute; malformed catalog entries could break unrelated connectors.
- A write that remained in flight beyond 15 seconds could execute twice. In-flight and unknown writes now keep their reservation.
- A restart without a transcript cursor could discard an older job's mapping and result.
- A transcript request completing after shutdown could access a closed database.
- Updates could be consumed before a disconnected voice session could receive them.
- Deferred call-ended dispatch could lose the bot lookup before sending the notification.
- The prior ten-page catch-up limit could skip older entries. Pagination now reaches the cursor, with a strict progress guard. A repeated provider cursor preserves the previous cursor and marks unresolved work unknown.
- Approvals sent resolution names (`APPROVED`, `allow_once`) that real Grok rejects with HTTP 400. They now send the enum numbers the Grok Bot app uses (1 approve, 2 deny).
- Restarting the Mac backend could fail with "Lost the backend connection": callbacks from the old process and socket ran after the new one started. They are now ignored unless they belong to the current process/socket.
- In a one-on-one, a bot asked to brief another bot spoke to it by name, but that bot stayed silent until the host named it (call of 2026-11-11, 17:15:32 to 17:15:57 UTC). A reply that starts with another bot's name ("Bot C, ...") now hands that bot the one-on-one and it answers; a bot only mentioned, or a host cut-in, keeps the one-on-one where it was.
- A job result taken in by the voice server after the bot's reply had already started was never said (call of 2026-11-11 17:21:43: "The comment is live on 1240" landed as the host said "Thank you"; the bot said "Anytime."). The bot now gets one more turn to tell it, unless the host is talking or a reply that has it is already coming.
- A bot that could not join stayed listed as in the call: the inviter had already said "X bot's in", nobody was told it failed, and invite_bot refused it as "already in the call" (call of 2026-11-11 12:57). The others are now told, the inviter says so, the invite tool no longer prompts "it is here", and it can be invited again. hand_to a bot still joining now says so instead of "Bots in the call: nobody".
- Speech-to-text wrote "X bot" as "export" or "ex-bot", so lines meant for the X bot went to another bot (calls of 2026-11-11 11:42, 12:55, 17:15). Those forms now match the X bot, and bots are told names can be garbled.
- In the bot instructions, "and leave_call takes you out of the call" had drifted three sentences away from the tool list it belongs to.
- A bot passed without a word on a line that wanted a reply ("Hey Grok." twice, call of 2026-11-11 11:39). A question, a greeting, or "Grok" now gets one more ask to answer; acknowledgements like "Okay, I get it." can still be met with silence.
- A line naming a bot that was still joining went to another bot ("Hey Xbot", call of 2026-11-11 12:57). Nobody answers for it now; it answers once it is in, and if it fails to connect a bot in the call says so.
- When the voice server never started the summary request on Leave, the call sat out its full 20 s and saved no summary (calls of 2026-11-11 11:45 and 13:42). The next bot is asked instead, or the call ends at once.
- A named pipe could block the file reader and the UI thread. Non-regular files are rejected.
- Selecting filesystem root incorrectly rejected contained files. Root and exact size/list boundaries are covered.
- A filesystem/database-open failure could be mistaken for corruption. Only SQLite corruption/not-a-database errors trigger recovery.

Selected failing-before-fix outputs are saved in [regressions.txt](regressions.txt). The final suites above pass.

## Limits and unverified paths

- Live approval covered **approving a Mac-action ask** only. Denying live, and resolving an auto-review approval card live, were not done; both pass automated tests against a test service that now checks the same numeric values. Bot ownership, concurrent clicks, stale cards and transport failures are also covered only by automated tests.
- The shared-window executor was tested with a real ScreenCaptureKit filter and external app. The OS picker gesture and the Accessibility/screen-permission denial dialogs were not automated. Window tools require macOS 15.2 or newer.
- The native action screen was rendered and inspected, but the entire Swift UI/controller has not been driven end to end or covered at 100%. Physical microphone/speaker behavior was not newly verified; the live voice test measured WebSocket audio and transcript output.
- Skills/routines/files discovery passed live. Invoking a named skill, waiting for a scheduled routine, and downloading remote artifacts were not verified. The implemented file feature lists metadata; it does not invent a download endpoint. Direct third-party MCP connections are outside the locked design; existing Grok connectors remain the integration path.
- Live tests initially saw connection/mint timeouts. Subsequent checks passed. An agent correctly refused a file in its restricted system-temp scope; the successful test used the allowed project folder. The first draft-test harness failed to parse Connect's nested `text.text`; the write was not repeated, and the existing draft was recovered and cleaned up. That recovery is recorded in its JSON result.
- Provider endpoints remain undocumented and may change. These results prove the tested behavior at this time, not the absence of every possible bug.

## Run again

```bash
npm test
npm run typecheck
bash mac/test.sh
bash mac/build-app.sh
```

Live scripts are separate because they touch the signed-in account. `scripts/live-connector-write.ts` creates and deletes one unsent test draft. `scripts/live-agent-job.ts` requests one Mac file read; `GROK_CALL_REQUIRE_TERMINAL=1` requests its terminal executor. `scripts/live-acceptance.ts` tests catalogs, pagination, live voice/Swift transport, persistence and the call-ended message. Do not treat a failed write as safe to repeat; reconcile the outcome first.

`scripts/live-approval.ts` temporarily sets this Mac to "ask", approves one test read, and restores the original setting in `finally`.

The Swift native tests write to the real `~/Library/Application Support/GrokCall/logs/app.log`, so test runs show up there.

Final review was performed locally without subagents, as requested. This is a self-review, not an independent code review.
