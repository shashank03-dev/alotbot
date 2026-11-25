# Call history, calls to you, meetings and screen sharing: verification

## What was tested, and how

Backend (Node, run in this repository's test suite, 100% line/branch/function coverage required):

- `test/overlay-library.test.ts`: indexing, re-indexing, rollback on a failed write, search (every word, then any word, prefix, accents, FTS syntax never reaching SQLite), paging, filters, backfill from Markdown (new, gone and unreadable files), a damaged or other-version index.
- `test/overlay-zoned.test.ts`: wall-clock times across the New York and Lord Howe daylight-saving changes, Kolkata, leap days, windows past midnight.
- `test/overlay-incoming.test.ts`: on a fake clock: standing calls ringing, missed, next week; calls due while closed (recent and old); clock set back a little and by days; quiet hours and do not disturb (holding, then ringing the moment they end); one ring at a time; snooze, decline, answer, call back a missed call, a failed answer; call backs by time and by jobs (results, failures, jobs finished while their call is live); job and approval rings, gathering per bot, cooldown after decline; damaged saved files; bounded memory.
- `test/overlay-call.test.ts`: recall tools, continuing a call, an answered call's opening (and a stand-in when the caller can't join), meeting lines, echo and rate limits, no bot rounds or suggestions in a meeting, whispers, screen notes and `look_at_screen`.
- `test/core.test.ts`: decisions in the summary; text-only replies (output text, audio dropped).
- `test/overlay-server.test.ts`: every new app request against a fake Grok Bot, including a job that finishes after its call ringing the bot, a call back on jobs, answering, deleted bots, disk failures, password-manager refusals, and screen text kept out of the call log.

Mac app logic without a screen (`mac/Tests/AlotbotCoreTests/FeatureCoreTests.swift`, Swift Testing): the transcript segmenter, meeting app ranking, mic routing, the screen text gate, incoming and library message decoding, standing call drafts, snippets. These were run with Swift 6.1.2 on Linux, together with the existing Protocol, Observation, Motion and CallPermission suites (52 tests passed).

## Not verified here

The first build was written in a Linux container without macOS or Xcode. Everything below was then built, tested and run live on a Mac (macOS 27, Apple Silicon) against a real Grok account, 18 to 25 Nov 2026; every check, fix and commit is in `LOCAL_E2E_RESULTS.md`:

- `bash mac/test.sh`, `bash mac/build-app.sh`, `npm test` (100%) and `npm run typecheck` pass on a Mac.
- Verified live: a Google Meet meeting heard and transcribed on device, both sides; ⌥Space and the Hold to talk button while the meeting app has focus, with Alotbot Mic silent to the meeting while held; ⌥Esc; the meeting app quitting; a standing call ringing with the app in the background, and its notification actions; sharing a window while it changes, is renamed and closes; a whole-display share leaving out Alotbot; Screen Recording turned off mid-share.

Still not verified:

- Zoom and Teams (not installed on the test Mac); only Google Meet in a browser was used.
- Whispers aloud on real headphones (the live run used the speakers; there, after the fix in `LOCAL_E2E_RESULTS.md` row 45, the meeting no longer hears the bot).
- A shared window turning into a password manager: not possible with a window share (it follows one window); covered by tests only.
- 1Password (not installed); Passwords.app was checked.
