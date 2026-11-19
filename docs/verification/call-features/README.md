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

This work was done in a Linux container without macOS or Xcode:

- The AppKit/SwiftUI views and the capture code (`Meeting.swift`, `ScreenShare.swift`, `IncomingCall.swift`, `CallsSettings.swift`, `LibraryView.swift`, `MeetingStartView.swift` and the `AppModel` changes) were syntax-checked but **not compiled or run**. Run `bash mac/test.sh` and `bash mac/build-app.sh` on a Mac before release.
- Live checks still to do on a Mac: a real Zoom/Meet meeting heard and transcribed on device; ⌥Space hold-to-talk while another app has focus; a standing call ringing with the app in the background, and its notification actions; sharing a window while it changes, closes, and turns into a password manager; whispers aloud on headphones.
- The two backend tests that need IPv6 loopback or desktop Chrome (`connection-auth`, the dedicated browser) fail in this container before and after these changes; they are unrelated.
