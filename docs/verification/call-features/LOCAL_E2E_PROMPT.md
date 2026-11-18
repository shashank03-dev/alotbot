# Local end-to-end test prompt

Paste everything below the line into Claude Code, started on your Mac from the repository root (`claude` in the `grok-call` folder).

---

You are testing and fixing **Grok Call** end to end on this Mac, against my real Grok account. Work on the `main` branch of this repository. Your job is to:

1. Get it building.
2. Prove every feature works for real.
3. Fix whatever doesn't, with a test for each fix.
4. Push the fixes to `main` as my commits.

## Ground rules

- **Branch and pull.** Run `git checkout main && git pull` first.
- **Commits.** Commit with my own git identity: the `user.name`/`user.email` already set here. Check them with `git config user.name` and `git config user.email` before the first commit, and stop and ask me if they're empty.
  - Add no `Co-Authored-By` lines, no AI attribution and no model names in commit messages or code.
  - Write commit messages in the style of `git log`: a plain imperative subject, with an optional short body.
- **Pushing.** Push to `origin main` after each fix that is green (tests pass at 100% coverage). Never force-push. Never rewrite pushed history.
- **This is my real account.** Read `README.md` → "Not affiliated with xAI" so you know the risk.
  - Keep usage modest: short calls, a few bots, and leave each call when its check is done.
  - Never start a background `send_task` job that changes anything outside this Mac (it must not send email, post, buy or delete). Read-only jobs, and jobs that only write inside the app's artifacts folder, are fine.
- **I am your hands and ears.** You can't speak into the mic, hear the speakers, click permission dialogs or join a meeting.
  - When a check needs that, tell me exactly what to do and say, one step at a time, then wait.
  - Verify the result yourself from logs, saved files and the backend's state. Don't just take my word for it.
- **Never weaken a test to make it pass.** Never lower the coverage limits. Never skip a failing check. If something can't be fixed, record it honestly.
- **Keep a running log** in `docs/verification/call-features/LOCAL_E2E_RESULTS.md`. For each check, record pass, fail, or fixed in a given commit, plus the evidence (a log line, a file path, a query result). Commit this file along with the fixes.

## Where to look

- **App log:** `~/Library/Application Support/GrokCall/logs/app.log`. The backend's per-call logs are next to it.
- **Backend data:** the folder `OVERLAY_DATA_DIR` points to (see `src/overlay/main.ts`), or the app's Application Support folder for the built app. Find out which one the running app uses before you begin. It holds:
  - `call-library.sqlite`: the call history index. Query it with `sqlite3`.
  - `incoming.json`: standing calls, call backs and missed calls.
  - The saved call Markdown files.
- **Feature design and edge cases:** `docs/verification/call-features/README.md` and the tests in `test/overlay-*.test.ts`.

## Phase 0: build

1. Install dependencies with `npm ci`, then run `npm run typecheck` and `npm test`.
   - `npm test` must pass with 100% line, branch and function coverage.
   - Tests that failed in a Linux container because it has no IPv6 or no desktop Chrome should pass here. If they fail, investigate.
2. Run `bash mac/test.sh`.
3. Run `bash mac/build-app.sh`.
   - These Mac files were written in a container with **no macOS or Xcode** and have **never been compiled**: `Meeting.swift`, `ScreenShare.swift`, `IncomingCall.swift`, `CallsSettings.swift`, `LibraryView.swift`, `MeetingStartView.swift`, and the `AppModel.swift` / `Trays.swift` / `OverlayView.swift` / `AppDelegate.swift` / `SettingsView.swift` / `MenuBarView.swift` changes.
   - Expect compile errors. Fix each one properly: keep Swift 6 concurrency correct, and don't sprinkle `@unchecked Sendable` or `nonisolated(unsafe)` to silence errors.
   - Commit the fixes once `mac/test.sh` passes and the app builds.
4. Quit any running copy of Grok Call. Open `mac/build/Grok Call.app`, and tail `app.log` in the background for the whole session.

## Phase 1: baseline call (regression)

1. Sign in, if needed. I'll do the browser part.
2. Grant Microphone, Screen Recording and Accessibility when asked.
3. Join a call with two bots. I'll say a sentence, and both bots should be heard and shown on the pill.
4. Leave the call. Check that it saved, with a summary and a **Decisions** section. Also check that `leave` returned an `id`.

## Phase 2: call history (feature 2)

1. **Indexing.** Look up the call you just made in `call-library.sqlite` (the `calls`, `lines` and `docs` tables). Also confirm that calls saved before this update were backfilled.
2. **Settings › Call history.**
   - Search for a word I said: it should find the call and highlight the snippet.
   - Search for a word that matches nothing: the list should say so.
   - The All/Calls/Meetings filter and "Show more" (paging) should work.
   - Searching with FTS operators such as `"`, `*`, `AND` and `(` must not show an error.
3. **Recall.** Start a new call and I'll ask: "What did we talk about last time?" The log should show `recall_calls` or `open_past_call`, and the answer should be right.
4. **Continue.** Use "Continue the call" with one bot. The bot should start from the earlier summary and decisions.
5. **Delete.** Delete a call. Its file and index rows should be gone. A search should no longer find it, and the next call must not start from its summary.
6. **Damaged index.** With the app quit, back up `call-library.sqlite`, then overwrite it with junk bytes. Relaunch: the damaged file should be renamed `.damaged-<ts>` and the index rebuilt from the Markdown files. Afterwards, restore the backup if anything is lost.

## Phase 3: calls to you (feature 1)

1. **Standing call.** In Settings › Calls to you, create a standing call for 2 minutes from now with an agenda.
   - Check that the form rejects bad input: no bots, no days, a bad time, and more than 20 schedules.
2. **The ring.**
   - With the app in the background, a card should appear top right with a sound, and a notification should be posted.
   - Answer it. The calling bot should open by saying why it called.
   - Check `incoming.json` afterwards.
3. **Decline.** Use "Ring now" and decline. Ring again and choose Later → 5 minutes; it should ring again about 5 minutes later.
4. **Notification buttons.** Answer one ring from the notification's **Answer** button and another from its **Decline** button, while another app is in front.
5. **Missed.** Let a ring go unanswered. It should show under missed calls with a working "Call back", and "Clear" should empty the list.
6. **Do not disturb and quiet hours.**
   - Turn on do not disturb and use "Ring now": nothing should ring. Turn do not disturb off: it should ring straight away.
   - Repeat with quiet hours ending a minute from now.
   - A ring due during a live call should wait until the call ends.
7. **Bot call back.** In a call, I'll ask a bot: "Call me back in 2 minutes about X." The log should show `call_back_later`. Leave the call; it should ring about 2 minutes later, with the reason. Check that cancelling a pending call back works.
8. **Job finished.** In a call, ask a bot for a short **read-only** background job, then leave. When the job finishes, the bot should ring to report it.
9. **Persistence.** Quit and reopen the app. Schedules, pending call backs and missed calls should still be there. A call that came due while the app was closed should be handled as designed: rung if it is recent, otherwise marked missed.

## Phase 4: meetings (feature 3)

1. Start a FaceTime call or a Google Meet with myself or a second device. Use Zoom or Teams if they're installed.
2. Start a meeting from the pill.
   - The consent confirmation must be required.
   - Speech Recognition permission should be asked for.
   - If on-device recognition isn't installed, the message should say how to install it.
3. **Transcription.** Speech from the meeting should arrive as `meeting` lines and mine as `host` lines.
   - Check timing and quality in the log. The log must show sizes only, never the transcript text.
   - Confirm that no bot audio is played into the meeting.
4. **Whisper.** I'll ask a bot something out loud in the meeting. Its reply should come back as **text only** under the pill. Bots must not take turns or suggest things on their own.
5. **Hold to talk.**
   - Hold ⌥Space while the meeting app is in front. My mic should go to the bots, not the meeting, and the meeting must not hear it.
   - Check that ⌥Esc still stops the bots, and that ⌥Space doesn't.
   - If ⌥Space is taken, the "Hold to talk" button must still work.
6. **Speaking aloud.** Turn on speaking aloud, with headphones on, and check that the replies are audible.
7. **Ending.** Quit the meeting app mid-meeting. The app should say that it stopped hearing the meeting, with no crash and no endless retry.
8. **Saving.** End the meeting. It should be saved as a **meeting** (with `Kind: meeting`, a summary and decisions) and appear under the Meetings filter.

## Phase 5: screen sharing (feature 5)

1. **The share list.**
   - It should show windows and displays.
   - It must not include Grok Call's own windows or any password manager. Test with Keychain Access, Passwords.app, and 1Password if it's installed.
2. **Sharing a window.**
   - Share a text window, such as TextEdit. Type something new into it, then ask a bot what is on screen. It should know.
   - Check that `look_at_screen` works, and that the screenshots in the artifacts folder are mode 600 with only the newest 5 kept.
   - Check that the log never contains the screen text.
3. **Edge cases.**
   - Change the window's title.
   - Close the shared window: sharing should stop, with a message.
   - Switch the shared app to a password manager window, if possible: sharing should stop.
   - Turn off Screen Recording: sharing should stop, with a message.
4. **Whole display.** Share the whole display: Grok Call's own pill and trays must not appear in the captured text.

## Phase 6: wrap up

1. Run the full suites again: `npm test`, `npm run typecheck` and `bash mac/test.sh`, then a fresh `bash mac/build-app.sh`.
2. Finish `LOCAL_E2E_RESULTS.md` with a table of every check above: pass, fail, fixed (with the commit), or not possible (with the reason). Add a list of any bugs left open.
3. Update the "Not verified here" section of `docs/verification/call-features/README.md` to reflect what is now verified.
4. Commit, then push to `origin main`. Show me `git log --oneline origin/main -15` and a short summary: what you fixed, and what is still open.
