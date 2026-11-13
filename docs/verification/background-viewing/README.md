# Background reading and requested app actions

The updated local app is installed at ~/Applications/Grok Call.app and its backend connected after launch. Backup: ~/Applications/.GrokCall-backups/20261112-155015. Nothing has been committed or pushed.

## What changed

- The voice tool now offers read and read_all, not metadata-only list. A viewing request must attempt a real capture or return a selection/failure result.
- Background windows are attempted regardless of onScreen. An inactive browser tab remains a separate limitation; the bot asks the user to select it, waits, then makes a fresh read.
- read_all captures up to five content windows, bounds per-window OCR, reports individual failures and remaining windows, and excludes toolbar strips and tiny helper surfaces. Those extra surfaces explained the misleading eight-window Zen result in the user's call.
- Explicit app launch/navigation requests route through the existing Grok agent on the user's Mac. No special “local executor” wording is required. A job receipt is not proof of completion.
- Observation never launches a browser, creates a profile, copies cookies, navigates, or substitutes another browser session. Requested app actions are separate and preserve existing app/browser sessions.

## Verification

- 446 Node tests pass, with the project's enforced 100% line, branch and function coverage. See node-tests.txt. Tests include rejecting list-only viewing, fresh reads after readiness, schema rejection and dispatch/history behavior.
- 96 Swift core tests pass. The native suite passes with the existing-browser opt-in enabled; only the live-call adapter is skipped in the normal run. That adapter is exercised separately by the live test. See swift-tests.txt.
- The existing-browser native check ran against already-running browser windows without opening browsers or tabs, copying cookies, or navigating. It checks window identity, foreground and process preservation. Live titles may update independently after a snapshot; the test records title changes instead of attributing them to capture.
- The real multi-window test passed using the actual backend WebSocket, live voice endpoint, existing Grok agent and production MacTools/AppObservation through a native test adapter. The agent opened a fresh disposable app on the Mac and pressed Show details. The fixture independently wrote its navigation proof. A later read_all captured BOTH actual app windows and the voice endpoint spoke the two different phrases found there. Zen was the foreground app before and after capture. Audio frames were generated. See live-native-call.json. The disposable app was closed after the test.
- The live fallback test passed: a blocked synthetic page caused a request to select YouTube in the existing Zen window; after readiness, a new read returned the verification phrase and the bot spoke it. No browser or agent fallback was attempted. See live-voice-fallback.json. One repeat failed to connect to Grok's server (UND_ERR_CONNECT_TIMEOUT); its retry passed. Page results in this fallback-specific check are synthetic.
- TypeScript app/test and live-script checks, release build, diff whitespace check, and installed code-signature verification pass. Signing is ad hoc for this Mac.

Reproduce the real-call check after building Swift tests: node scripts/verify-native-call.ts. It creates a disposable fixture but does not launch or navigate any browser. The real agent performs the fixture launch/navigation. The test requires account sign-in, the Grok Bot Mac agent online with local app access, Screen Recording permission for native capture, and any local Accessibility/Automation permissions required by that agent. Missing permissions must be reported, not bypassed.

## Limits

- This verifies the real call/backend/agent/native-capture path using a native test adapter instead of automating the installed menu UI and microphone/speaker hardware. Speaker playback and live microphone recognition were not automated.
- It does not prove every third-party app is controllable, every hidden/minimized window is capturable, or every spoken variation works. Protected content and inaccessible controls require an honest failure/next step. Chrome was not live-tested here.
- Inactive browser tabs are not silently read or selected. The guided fallback is the agreed behavior.
- Native OS-error and batch-failure paths do not have 100% measured coverage. See swift-coverage.txt; do not interpret Node coverage as native coverage.
- macOS may request permissions again after an ad hoc rebuild. The app must respect revoked access. Stable permission retention across upgrades is not established without stable signing.
