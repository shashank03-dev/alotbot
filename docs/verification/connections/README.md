# Connections verification — 2026-11-12

- `npm run typecheck`: passed.
- `npm test`: passed with the repository's 100% line, branch and function coverage thresholds. See node-tests.txt.
- Swift tests: both native and core suites passed. The existing browser-window and native voice-capture opt-in adapters remained skipped. See swift-tests.txt.
- The native decoder read the complete live account catalog. Read-only discovery loaded 504 entries with no warnings; eight app servers exposed tools, and Render correctly reported needsAuth. See live-read-only.txt. No provider consent, real account mutation or live tool execution was performed by these checks.
- Local mock services exercised installation/schema validation, preserved saved secrets, team-required restrictions, accounts, permission preservation, native handoff, OAuth state validation, denial, failure, continuation, expiry, cancellation, replay, port fallback and close/restart races.
- The existing call-log integration test confirms setup secrets are excluded from request/error logs.
- screen.png renders the actual native SwiftUI view with synthetic account labels. It was inspected for layout and readability.
- Release build completed, signature verified, installed at ~/Applications/Grok Call.app and opened. A fresh backend-connected entry was observed after launch.

Open Settings → Connections. Browse all loads the live catalog; Yours includes installed plugins, custom account services and native entries. Messages and 1Password continue through Grok Bot's trusted native setup. Standard cloud consent starts here and completes in the browser. Built-in GitHub opens account integrations; Origin uses the existing Grok sign-in.
