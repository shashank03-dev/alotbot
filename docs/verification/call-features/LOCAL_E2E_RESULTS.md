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
