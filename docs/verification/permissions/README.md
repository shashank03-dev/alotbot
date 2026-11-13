# First-call permission setup

The latest user call (2026-11-12T12-40-31Z) attempted two real WhatsApp reads. Both returned the native Screen Recording permission error before capture. The bot's suggestion to toggle permission repeatedly was not supported by the tool result.

Changes:

- Join runs first-call setup for Grok Call's Screen Recording and Accessibility permissions before starting audio and the backend call. Microphone retains Apple's authorization-status handling: request only when not determined, guide to Settings after denial.
- Viewing defaults on at first setup only if the user has not previously chosen a setting. An explicit off choice is preserved.
- Request attempts persist in UserDefaults. Automatic setup does not ask again on later joins or recreated app instances, including after denial or revocation. Explicit Settings actions can request again.
- OS access is checked fresh. Saved viewing preference/request flags never represent a grant. A later grant through Settings is recognized without another automatic prompt. Denied Screen Recording does not disable the user's saved viewing preference, avoiding a second app toggle after granting access.
- Native picker controls no longer issue repeated Accessibility prompts on each denied tool call. Errors guide the user to Settings.
- Grok Call cannot grant Grok Bot's own OS permissions or permanently approve its agent actions.

Validation:

- 446 Node tests pass with the existing enforced 100% line/branch/function coverage.
- 99 Swift core tests and 9 native tests pass; two live-browser/capture-adapter tests are opt-in and skipped in this suite.
- The new CallPermissionSetup has 100% measured line, region and function coverage. LLVM reports no Swift branch counts; branch coverage is not claimed.
- Tests exercise first setup, subsequent joins, recreated setup/app instances with persisted preferences, denial, revocation, already-authorized access, later Settings grants, explicit off choice, manual Settings requests, no-bot joins and setup order before microphone/audio startup.
- Native call-flow tests use isolated preferences and injected OS responses so testing never clicks protected consent dialogs or modifies real OS permission grants. Actual macOS consent must be provided by the user.
- TypeScript typecheck, release build, whitespace check and installed-app signature verification pass.

Installed locally with backup at ~/Applications/.GrokCall-backups/20261112-182540. Nothing was committed or pushed.

macOS owns permission persistence. Ad hoc code signatures are tied to a specific build and can cause reapproval after rebuilding; the app cannot promise permanent OS grants across updates. See Apple's TN3127: https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements/
