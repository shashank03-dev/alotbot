# Local end-to-end results

Run on a Mac against the real Grok account, following `LOCAL_E2E_PROMPT.md`.

- Machine: Apple Silicon, macOS 27.0 (Darwin 27.0.0), Command Line Tools only (no Xcode), Swift 6.4, Node 26.11.1
- Started from `e147b67` on `main`, 2026-11-18

Status: **pass**, **fail**, **fixed** (with the commit), or **not possible** (with the reason).

## Phase 0: build

| Check | Status | Evidence |
| --- | --- | --- |
| `npm ci` | pass | 0 vulnerabilities |
| `npm run typecheck` | pass | `tsc --noEmit` prints nothing |
| `npm test` (100% lines, branches, functions) | pass | 688 tests, 688 pass; `all files 100.00 / 100.00 / 100.00`. The IPv6 and desktop Chrome tests that failed in the Linux container pass here. |
| `swift build` of the new Mac files | fixed in `01dae01` | `GrokCallCore/MorphData.swift:6: invalid redeclaration of 'Ring'`: the new incoming-call `Ring` struct clashed with the avatar geometry `typealias Ring = [Point2]`. Renamed the new one `IncomingRing`. Then `MenuBarView.swift:134: reference to member 'animation' cannot be resolved`: the meeting and sharing labels were inserted between the avatar row and its `.animation` modifier. Moved them below it. No other compile errors; no `@unchecked Sendable` or `nonisolated(unsafe)` added. |
| `bash mac/test.sh` | fixed in `01dae01` | `CallSetupTests.joinRunsPermissionSetupBeforeMicrophoneAndDoesNotRepeatAfterRelaunch` failed (6 issues); it passes on `bae854b`. Cause: the new `startCall` added a `!inCall` guard, so `join()` did nothing whenever a call view was showing (always, in demo mode). The guard was redundant: the backend rejects a second join with "already in a call", the Library disables Continue during a call, and `answer()` shows "Leave this call first." Removed it. After: 64 + 122 tests pass. |
| `bash mac/test.sh` flake | open (not caused by the new code) | `BackgroundObservationTests.capturesBackgroundWindowWithoutChangingFocus` failed once in the full run (front app changed during the run) and passed alone and in the next full run. It checks the frontmost app while other suites run at the same time. |
| `bash mac/build-app.sh` | pass | `Built: mac/build/Grok Call.app`. `Info.plist` has the microphone, screen capture and speech recognition usage strings. One pre-existing warning in `WorkspaceFiles.swift:100` (`@preconcurrency` has no effect), untouched. |

## Phase 1: baseline call

| Check | Status | Evidence |
| --- | --- | --- |
| Signed in, permissions granted | pass | `app.log`: `permissions on at launch: ["microphone", "screen", "accessibility"]`, `backend connected` |
| Join with two bots, both heard | pass | `app.log`: `join: Satya, Jensen`; call file has replies from both (`Jensen: Done. Beta ships Friday, code word pineapple.`, `Satya: Pineapple it is. Friday's the drop.`). You confirmed both were heard and shown on the pill. |
| One transcript line per thing said | fixed in `a63397f` | `call-2026-11-18T18-11-02Z.md` kept 5 host lines for one sentence ("Okay, let's decide", "... to ship the", ...). The per-call log shows why: since this update of the voice server, `input_audio_transcription.completed` arrives up to 5 times per `item_id` while you are still talking (the Nov 16 call: once per item, after `input_audio_buffer.committed`). Each partial was recorded, sent to the other bots as a new host line, and routed. Fix in `public/core.js`: a transcript for an item that has started but is not committed yet is partial and skipped, and a repeat of the last final one is skipped. New test fails before the fix and passes after. |
| Leave saves with a summary and Decisions | pass | `calls/call-2026-11-18T18-11-02Z.md` has `## Summary` and `## Decisions` ("The beta will ship on Friday with the code word pineapple..."), plus action items and a task. `app.log`: `left: saved call-2026-11-18T18-11-02Z.md` |
| `leave` returned an `id` | pass | `server.ts` `leave()` returns `id: callIdOf(file)` = `call-2026-11-18T18-11-02Z`; `call-library.sqlite` has that id with kind `call`, bots `["Satya","Jensen"]`, 11 lines. The app only logs the file, not the raw response. |

## Phase 2: call history

| Check | Status | Evidence |
| --- | --- | --- |
| New call indexed | pass | `call-library.sqlite` `calls`: `call-2026-11-18T18-11-02Z`, kind `call`, bots `["Satya","Jensen"]`, `line_count` 11, decisions saved; `lines` has 11 rows for it; `docs MATCH '"pineapple"*'` gives 6 hits |
| Older calls backfilled | pass | First launch made `call-library.sqlite` with 30 rows in `calls`, one per `calls/*.md` (30 files, all kind `call`) |
| Search finds a word said, with highlight | pass | You searched "pineapple": today's call showed with the word highlighted |
| Search with no match says so | pass | You searched "zzqxv": the list said nothing matched; the same query on the index gives 0 hits |
| All/Calls/Meetings filter and Show more | pass | You checked the filters and paging |
| FTS operators never error | pass | You searched `"pineapple`, `pine*`, `AND`, `(beta`: no error. The app's `ftsQuery` run on the real index turns each into quoted terms (`"pineapple"*`, `"pine"*`, `"and"*`, `"beta"*`; also `NEAR(`, `-`, `a OR`) and none errors. No errors in `app.log`. |
| Recall in a new call | pass | `logs/call-2026-11-18T18-17-26Z.jsonl`: Satya called `recall_calls` with `{"query":"last call discussion beta pineapple ship Friday","limit":5}`, event `Satya searched earlier calls`, then said "Last time, you decided the beta ships Friday with the code word pineapple, and Jensen and I both confirmed it." Correct. |
| Transcript fix on the live server | pass | Same log: the server sent `completed` 4 times and 2 times for your two items; `call-2026-11-18T18-17-54Z.md` has exactly one host line for each. |
| Note: recap call repeats an old decision | observation | `call-2026-11-18T18-17-54Z.md` lists the Nov 18 decision again under `## Decisions` although nothing new was decided. Harmless, but a search for decisions will show it twice. Not changed. |
| Continue the call with one bot | pass | First try joined both bots: the Continue chips start with the earlier call's bots selected (`LibraryView.swift:153`), and my instructions did not say to turn Satya off; by design, not a bug. Second try: `logs/call-2026-11-18T18-20-13Z.jsonl` joins `["Jensen"]`, `app.log` has `continue call call-2026-11-18T18-11-02Z`, the instructions start with `continues an earlier call (Nov 18, 2026, 11:40 PM, id call-2026-11-18T18-11-02Z)` plus its summary, and Jensen answered "We locked in shipping the beta this Friday with the code word pineapple" with no search. |
| Delete a call | pass | Deleted `call-2026-11-18T18-20-28Z` (Jensen only) in Call history. After: `calls/call-2026-11-18T18-20-28Z.md` gone; index rows `calls` 1→0, `lines` 2→0, `docs` 5→0; `overlay-memory.json` summary was that call's and is now `""` (open task kept, as the README says). |
| Delete removes the transcript from this Mac | fixed in `95c4902` | The dialog says "Its file and transcript are removed from this Mac", but `logs/call-2026-11-18T18-20-13Z.jsonl`, the call's full log with every transcript event, was left behind. `OverlayStore.deleteCall` now also removes the log named on the call's `Full log:` line (plain log names only, so `logs/../auth.json` is ignored), log first. New test fails before and passes after. |
| Damaged index is rebuilt | pass | App quit; index backed up (33 calls, 941 lines), overwritten with 8 KB of random bytes, `-wal`/`-shm` removed. On relaunch: `call-library.sqlite.damaged-1795026218879` (the 8 KB junk) next to a new index with 33 calls and 941 lines, the same as before. Nothing lost, no restore needed. Junk file removed afterwards. |

## Found along the way

| Check | Status | Evidence |
| --- | --- | --- |
| Launch animation plays in the middle of the screen | fixed in `2594917` | You saw the opening pill in a corner. Window list during launch: the opening panel was 580 x 300 at x 0, y 656 on a 1470 x 956 screen (bottom-left). `NSHostingView` resized the full-screen panel to the SwiftUI view's own size on its first pass. Fix: `sizingOptions = []` on the hosting view and the panel set to the screen frame. After: the panel is 1470 x 956 at 0, 0. New test `coversTheWholeScreenWithThePillInTheMiddle` fails before and passes after. Came in with `3550b7a`, not the new features. |

## Phase 3: calls to you

| Check | Status | Evidence |
| --- | --- | --- |
| Standing call form rejects no bots, no days | pass | You tried each; the form refused it |
| Standing call form rejects a bad time | pass | The time can't be typed as free text in the form; the backend also refuses anything but `HH:MM` (`incoming.ts:175`, covered by `npm test`) |
| More than 20 standing calls refused | pass | Backend: `incoming.ts:624` "You can have at most 20 standing calls.", tested in `test/overlay-incoming.test.ts:449` (passing). Not tried by hand. |
| Standing call saved with an agenda | pass | `incoming.json` `schedules[0]`: bot `25839786` (Satya), agenda "Check if the beta is ready for Friday", timezone `Asia/Kolkata` |
| Quiet hours are on by default | observation | `incoming.ts:152`: 22:00 to 08:00, on. My first schedule (Wednesday 00:00, set at 23:58 Wednesday, so it pointed at the past) would not have rung tonight in any case. |
| The ring (app in the background) | pass | Standing call set for Thursday 00:07. `app.log`: `2026-11-18T18:37:00.029Z ringing: schedule hbh` (00:07:00 local, on the minute). You saw the top-right card, heard the sound and saw the notification. |
| Answer: the bot says why it called | pass | `app.log`: `answer ring a8317693-…`; `logs/call-2026-11-18T18-37-22Z.jsonl` joins `["Satya"]`, whose first line is "Agenda tonight: check if the beta is ready for Friday. Where do you want to start?" |
| `incoming.json` after answering | pass | `rings[0]`: source `schedule`, reason "Standing call. Agenda: Check if the beta is ready for Friday", state `answered`, `scheduleId` = the standing call's id |
| Ring now, then Decline | pass | `app.log` `18:38:21 ringing: schedule hbh`; `incoming.json` ring `f00c7a95` state `declined` |
| Later → 5 minutes rings again | pass | Ring `f7d32e77` (00:08:29) state `declined`, note "Snoozed for 5 min."; `app.log` `18:43:33 ringing: callback hbh is calling back`, about 5 minutes after you snoozed. Note: `app.log` records rings and answers but not declines or snoozes. |
| Notification Answer button, another app in front | pass | `app.log` `18:45:17 ringing`, `18:45:33 answer ring 8fbb4fdf-…`, call started, left at once (`saved nothing`). Ring `8fbb4fdf` state `answered`. You used the notification's Answer; the log does not say which button was used. |
| Notification Decline button | pass | `app.log` `18:45:40 ringing`; ring `22195cc6` state `declined` |
| A ring nobody answers becomes missed | pass | Ring `2058d439` (00:14:22) rang its 45 seconds and is state `missed` |
| Missed: Call back | pass | Missed ring `2058d439` listed; Call back → `app.log` `18:46:15 answer ring 2058d439-…`, call saved as `call-2026-11-18T18-46-26Z.md`; the ring is now `answered` |
| Missed: Clear | pass | First try was a no-op (Call back had already emptied the list; `incoming.json` still had 8 rings). Second try: Ring now at `18:47:20`, left to ring out (missed), then Clear → `incoming.json` `rings` is `[]` |
| Do not disturb holds Ring now | fixed in `b630165` | With do not disturb on until 08:00, three presses of Ring now rang at once (`app.log` `18:49:03`, `18:49:14`, `18:49:28 ringing: schedule hbh`; `incoming.json` `doNotDisturbUntil` 08:00). `holdReason` let any standing call ring before it looked at do not disturb; that exemption is meant for quiet hours only. Now do not disturb is checked first. A standing call that comes due during do not disturb is still missed, as the README says. New test fails before and passes after. |
| Do not disturb, retried after `b630165` | pass | Ring now during do not disturb did not ring; turning it off rang it straight away |
| Ring now presses pile up while held | fixed in `c147120` | You pressed Ring now 14 times while it showed nothing; each press queued its own held ring, and when do not disturb ended they rang one after another (`app.log` 14 × `ringing: schedule hbh`, 18:53:15 to 18:53:24; `incoming.json` 14 declined rings, 00:23:03 to 00:23:10), so it took 14 declines. Two causes, both fixed: `ringNow` always made a new ring (now it returns the one already held or ringing for that standing call), and Settings had no place for held rings (now a "Waiting to ring" list with the reason in words and a "Don't ring" button, and Ring now says "Not ringing yet. Rings when do not disturb ends."). New tests: `overlay-incoming.test.ts` (backend), `heldRingsSayWhenTheyWillRing` (Core), `ringNowDuringDoNotDisturbSaysItIsWaitingAndQueuesOneRing` (app against the real backend); the last fails before the fix with no message and 3 held rings. |
| Held ring fix on the real app | pass | `app.log`: 14 × `shown: Not ringing yet. Rings when do not disturb ends.` (19:03:06 to 19:03:08), then one `ringing: schedule hbh` at 19:03:27 when do not disturb was turned off; you saw one entry under Waiting to ring, and one decline ended it. No notification banner this time because Grok Call was in front (Settings open); by design, `willPresent` shows no banner over the card. With another app in front the banner shows (notification button checks above). |

## Code review findings

| Finding | Result | Notes |
| --- | --- | --- |
| 1. Whole-screen share sent password managers | fixed in `a550c7b` | A display share left out only Grok Call itself. It now also leaves out every app `ShareTarget.isPrivate` matches by name or bundle id. Test: `displayShareLeavesOutPasswordManagersAndThisApp`. |
| 2. Removed call's text stayed in call-library.sqlite | fixed in `c1d1a73` | Deletes only unlinked rows. Now `secure_delete`, the full-text index's `secure-delete`, a WAL checkpoint after a remove, and a one-time optimize and VACUUM for an older index. Test: "a removed call leaves no trace of its words in the library files, and an older index is wiped once". |
| 3. Later turned a standing call into a different call | fixed in `c38bb3f` | Snooze made a call back from the first bot. It now keeps a snoozed copy of the same ring that rings again at its time, survives a restart, rings through quiet hours for a standing call, and shows under Waiting to ring with Don't ring. Tests: "Later rings the same call again: ...", `snoozedRingsDecodeAndSayWhenTheyRing`. |
| 4. Call back at an impossible offset rang at once | fixed in `6445019` | `Date.parse` gave NaN for an offset like +24:00, which passed the range checks. `callbackWhen` and `addCallback` now refuse a time that is not a number. Test: "a call back at an impossible offset is refused, and a time that is not a number never rings". |
| 5. Two joins at once started two calls | fixed in `3578b84` | `join` and `answer` awaited before setting the call. A joining flag now refuses a second one. Test: "two join requests at once start one call; so do an answer and a join" (before the fix both joins succeeded). |
| 6. Paused standing call dropped on restart | fixed in `519a917` | Its bots had left, and reading the file back refused a call with no bots. A paused call may now have none when read back. Test: "a standing call paused because its bots left is still there after a restart". |
| 7. Ring now just before the time rang twice | fixed in `519a917` | The check made a second ring for a standing call already ringing or waiting. It now skips it. Test: "Ring now just before its time does not ring the same standing call twice". |
| 8. Show more skipped calls that started in the same second | fixed in `7a03999` | Paging used only the start time. The app and library now page on start time and id. Test: "paging one call at a time reaches every call once, even two that started in the same second". |
| 9. Until tomorrow morning after midnight lasted a day too long | fixed in `4bd8ab6` | It always added a day. `DoNotDisturb.morning` uses today's 8:00 when it is not 8:00 yet. Test: `doNotDisturbUntilMorningIsTheNext8am`. |
| 10. ⌥Space taken in every app at all times | fixed in `03c2854` | It was registered at launch. `TalkKeySwitch` registers it when a meeting starts and unregisters it when it ends; ⌥Esc is unchanged. Tests: `theTalkKeyIsWantedOnlyDuringAMeeting`, `theTalkKeyIsRegisteredWhileWantedAndReleasedAfter`. |
| 11. Settings promised held calls ring after quiet hours | fixed in `6556fe9` | A ring held over an hour is missed. Settings now says so. Test: `heldRingWordingMatchesTheBackendLimit`. |
| 12. Rebuilt index used save time as start time | fixed in `f0923a8` | The saved Markdown now ends with a hidden `<!-- started: ... -->` line that the rebuild reads; older files keep the file time. Test: "a rebuilt index gives a call the same start time as the live index". |
| 13. Ringing card ignored changes to its ring | fixed in `184bb2a` | The card skipped any update with the same id. It now updates the card and notification in place, without restarting the sound or moving the card. Test: `theRingCardFollowsTheRingsContent`. |
| 14. Ring kept sounding after you started a call | fixed in `e73bbda` | `join` never told the ring manager. Starting a call now holds the sounding ring ("You were in a call.") until the call ends. Tests: "a ring that is sounding when you start a call yourself waits, ...", "starting a call while a ring sounds holds the ring until the call ends". |
| 15. Hold to talk unusable with VoiceOver or keyboard | fixed in `f05db59` | It was a drag gesture only. It now has an accessibility action and takes Space or Return when focused, turning talking on or off. Test: `toggleTalkTurnsTalkingOnAndOffOnlyInAMeeting`. |

## Rename to Alotbot

| Check | Status | Evidence |
| --- | --- | --- |
| Everything renamed | pass | App, targets, bundle id `me.shashankdev.alotbot`, env vars `ALOTBOT_*`, npm name, release zip `Alotbot-macOS.zip`, meeting title, token header, signing certificate "Alotbot Local Signing" (pinned in `scripts/install.sh`, matches the build's `certificate leaf = H"220842bd…"`), GitHub repo `shashank03-dev/alotbot`. Left on purpose: the GrokCall migration code, dated history under `docs/verification`, `docs/research`, `docs/superpowers`. |
| First launch moves the data folder | fixed in `b8347e2` | First launch of Alotbot found an `Alotbot` folder already there (made by `mac/test.sh` at 22:27:52: a test wrote screenshots into the real data folder's `artifacts`), so it moved nothing and started with no calls; `GrokCall` was untouched (35 calls). In a test process the first `DataFolder` use also ran the real move. Fixes: `mac/test.sh` sets `ALOTBOT_DATA_DIR` to a temp folder, which `DataFolder` uses without moving anything (`theTestsNeverUseTheRealDataFolder`; the real folder's listing is identical before and after a full run), and an `Alotbot` folder with no sign-in and no calls is set aside as `Alotbot.unused-<time>` (never deleted) when `GrokCall` has data (`anAlotbotFolderWithNoDataIsSetAsideAndTheOldOneMovedIn`, `anAlotbotFolderWithDataIsNeverReplaced`, `settingTheEmptyFolderAsideCanFailWithoutLosingAnything`). |
| 16. Whole-screen share captured private-titled windows of other apps | fixed in `869fac3` | The display filter left out password manager apps only, so a browser tab on a vault was captured. It now leaves out, by window, every window of Alotbot or a password manager and every window whose title `isPrivate` matches. Test: `displayShareLeavesOutPrivateWindowsOfAnyApp`. |
| 17. Deleting a standing call left its snoozed ring | fixed in `136f0ec` | `deleteSchedule` kept the call's rings. Its snoozed, held and ringing rings now end with it. Test: "deleting a standing call stops its snoozed, held and ringing rings". |
| 18. A standing call due while snoozed rang twice | fixed in `136f0ec` | The duplicate check looked at held and ringing only. The due ring now takes the snoozed copy's place. Test: "a standing call that comes due while snoozed rings once". |
| 19. News for a snoozed job ring rang separately | fixed in `136f0ec` | `botRing` gathered news into ringing or held rings only; it now includes snoozed ones. Test: "news for a bot whose job ring is snoozed joins that ring". |
| 20. Sign-out allowed while a call was starting | fixed in `ec9ad36` | `logout` checked only for a call already set; it now also refuses while a join or answer is under way. Test: added to "two join requests at once start one call; so do an answer and a join". |
| 21. Switching to a long-titled window stopped the share in the app only | fixed in `b3e21dd` | The app stopped the old share before the backend refused the title (over 300 characters). The app now cuts app and title to the backend's limits and stops the old share only after the new one is accepted. Test: `screenShareArgsFitTheBackendLimits` (the order of operations has no automated test). |
