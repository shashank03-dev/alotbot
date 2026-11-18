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
