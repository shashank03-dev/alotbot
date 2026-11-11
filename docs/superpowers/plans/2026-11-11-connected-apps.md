# Connected Apps Implementation Plan

Implement directly in this session; no subagents. The approved spec is ../specs/2026-11-11-connected-apps-design.md.

Goal: every call bot can discover and use the account's connected apps, with results returned to the call.
Architecture: keep the existing Swift/Node transport and auth; add a focused app bridge and reuse the existing function-tool execution path. No new dependencies.

- [x] Add failing HTTP regression tests in test/apps.test.ts for app discovery, paginated tool schemas, exact qualified tool execution and speaking-bot identity. Test empty/malformed responses, disabled and disconnected servers, unknown tools, blocked/approval-required tools, result failures and timeouts.
- [x] Implement src/apps.ts and integrate it through src/grokbot.ts. Route DashboardService requests through the existing refresh and timeout handling. Read saved permissions through GrokBotService, respect explicit overrides, and require Grok approval for mutations without an always-allow rule. Never automatically retry execution after a timeout.
- [x] Add failing tests for call instructions and results in test/core.test.ts and HTTP/call integration coverage. Update public/core.js so bots use direct app tools and distinguish their results from background receipts.
- [x] Run npm run typecheck, npm test (100% line/branch/function coverage), swift test, and real read-only calls for every bot. Validate voice-session tool invocation and result delivery without sending messages or changing external data.
- [x] Update README, rebuild with mac/build-app.sh, install in ~/Applications, reopen safely and confirm backend connection.

Review focus: account credentials must stay server-side; never execute an undiscovered tool; blocked or approval-required tools do not execute; empty discovery is not a claimed success; a timed-out mutation has an unknown outcome and must not be retried automatically. The bridge reports backend result variants faithfully, including authentication and permission failures.

## Verification

- 329 automated tests pass; 100% measured lines, branches and functions. Typecheck passes.
- 81 Mac tests pass with the command-line toolchain's Testing macro library loaded explicitly; the default invocation could not locate that plugin.
- All three account bots completed real voice-session discovery, a read-only Gmail get_me call, and a spoken response after receiving the actual result. No mutating app actions were used for live tests.
- Live repeated discovery exposed a bulk-tool-list timeout. App listing now uses account connection metadata, and tool discovery requests only the selected app. Regression tests assert that listing apps never loads all connector catalogs.
- Parallel and delayed expired-token responses are covered: refresh once, reuse the renewed credentials, and never restore a sign-in cleared while a request was pending.
- Multiple-account execution keeps both account and base-server permission rules. Unknown permissions require review. Actions without an explicit always-allow rule require Grok approval unless they are read-only. (Superseded 2026-11-11: no rule means auto review, which runs without asking; see the spec.)
- Release build completed and the installed app signature was verified. The app remains tied to this repository path, as before.
