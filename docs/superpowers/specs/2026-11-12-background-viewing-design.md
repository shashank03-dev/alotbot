# Background app viewing

Shashank asks to see an app by name or content, without naming a Space, activating the app, or switching tabs. Requests such as “look at Zen”, “can you see YouTube in Zen?” and “check that browser” should use evidence rather than claim access from memory.

Use the existing Swift/ScreenCaptureKit and TypeScript tool dispatch. A read-only mac_observe tool enumerates eligible windows across Spaces and reads one unambiguous match using a desktop-independent screenshot and local OCR. Return current identity, timestamp, text and a private screenshot path; never claim OCR is visual understanding. Visual questions go to the existing Grok agent to read that exact local screenshot, with no activation or recapture. The voice endpoint silently drops input_image (live probe on 2026-11-12).

Keep existing picker-based control separate. Background viewing requires an explicit Settings toggle and macOS screen recording permission; it does not enable clicking. Resolve app names case-insensitively, support bundle IDs, return candidate windows on ambiguity, and require clarification instead of picking arbitrarily. Do not fall back to another app or cloud computer. Refuse locked sessions and report vanished or uncapturable windows. Bound image dimensions, text size, traversal, and artifact retention.

Browser limitation: a window screenshot shows its rendered tabs, not every inactive tab. True background tab lookup/capture needs a Firefox-compatible extension using tabs.query/captureTab, installed and permitted in Zen. Never switch a tab as a fallback. Discarded/unloaded tabs and protected video may not yield pixels. This capability must be reported separately, not silently claimed by window capture.

Alternatives: perpetual video adds unnecessary usage and is not requested; OCR alone cannot interpret diagrams; direct voice images were tested and dropped. An extra paid vision API would add credentials and usage. Reuse the account's agent if the image capability test succeeds.

Verification: test matching, ambiguity, malformed and empty input, disabled access, permissions, window disappearance, closed/occluded windows, OCR limits, focus preservation, and live screenshot interpretation. Node tests/typecheck, Swift tests and signed build are required. Claims about another Space or browser tabs require live proof.


## Cross-browser requirement (latest user direction)

Support installed browsers generally, including Chrome and Safari, not only Zen. One Grok Call installer handles detection and integration; no separate download or connection UI. Browser/system first-use approval is accepted; repeated per-request prompts are not wanted. Do not silently reinterpret this as support for only the currently displayed tab.

The existing mac_observe implementation is a window-capture component, not fulfillment of inactive-tab access. Distribution of production browser integrations requires browser-specific packaging and enablement; Chrome store distribution, Safari app-extension packaging, Firefox distribution, and stable macOS signing remain unresolved. No extension has been built or installed. Universal support for arbitrary browsers must not be claimed.


## Existing user session only

The user explicitly prohibits launching a new browser or a separate profile to perform observations. Read the browser already open, using that window's existing profile, cookies and sign-ins. Do not copy cookies, select a profile directory by guessing, navigate to a replacement page, or fall back to Grok Call's dedicated browser or an agent's browser. If multiple existing windows/profiles could match, return candidates and ask which one; “default profile” does not authorize choosing an arbitrary profile. Test profiles must not be presented as proof of this user-session requirement. The isolated Zen fixture launched during investigation was the wrong test for this requirement and is no longer running.


## Approved usable scope: guided fallback

The user accepted a fallback instead of universal hidden-tab access: first verify what can actually be read; when the page is inaccessible, ask them to select it in their existing browser and tell the bot when it is ready. After readiness, take a fresh observation before answering. No polling, tab switching, profile substitution, browser launch, extension install, or developer-account requirement is part of this flow. Preserve prior safety and ambiguity requirements. This supersedes the inactive-tab integration requirement for the current local release.


## Fixes after the real call review

The user's real call stopped at metadata listing and wrongly treated background visibility as an access restriction. The voice schema now requires read/read_all capture operations. read_all attempts up to five content windows with bounded text and per-window failure reporting; small toolbar/helper surfaces are filtered out. The user also explicitly requested app launch and navigation, so those actions route to the existing Mac agent through send_task, preserving app/profile identity and waiting for actual results. Observation retains its prohibition on launching or changing browser sessions. The real two-window verification app test proves agent launch/navigation and native reading while Zen remains in front; it does not replace OS permissions or promise control of every app.
