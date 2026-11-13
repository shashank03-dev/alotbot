# Connection fixes — 2026-11-12

The screenshot exposed a real provider outage and two incorrect local assumptions. A missing OAuth token does not mean a public connector needs sign-in. An installed plugin is not necessarily a working connection. Both the native screen and bot discovery now distinguish these states.

## Verified fixes

- Public connectors can discover and execute tools without an OAuth token. A regression test failed before the fix and passes afterward.
- The reported 21st failure was reproduced through Grok and by initializing its published `https://21st.dev/api/mcp` endpoint without credentials. Both returned 503 with "The deployment is currently unavailable". The app keeps the connection and offers a read-only check instead of presenting it as a sign-in failure.
- Status, sign-in, tool-list and bot-discovery errors now use short, actionable messages for outages, authentication, restrictions, rate limits and network failures. An error stays with its server; failed sign-in is not displayed in a second global banner.
- The 21st catalog entry and GetPlugin response omit setup variables, while `.cursor-plugin/plugin.json` at the exact published Git revision requires `API_KEY_21ST`. The manager recovers missing setup schemas lazily from that pinned manifest. Only public JSON metadata is read, bounded to 256 KiB and five seconds, with no Grok credentials, redirects or code execution. Recovered secrets use secure inputs and the existing merge-with-stored configuration path. Mock services verify required-field validation and preservation across refresh.
- The screen has Added / All apps, readable categories, one Connect action for a new app, verified health, and collapsed account, permission and app-management controls. Search and filter selection stay in sync. Ready, unavailable and new-app states were rendered and visually inspected.
- Status checks do not start OAuth or execute app tools. Completed sign-in is followed by a health check; it does not by itself mark a provider ready.

## Proof and limitations

`node-tests.txt` records 481 passing tests with the repository's 100% line, branch and function coverage thresholds. `swift-tests.txt` records the native and core suites; existing opt-in browser and voice adapters remain skipped. Type checking, diff whitespace checks, release build and signature verification passed.

`live-read-only.txt` records the real app checks and recovered key-field metadata. 21st remained unavailable; Render required consent. T3 Code timed out in the final pass (Vercel timed out in an earlier pass and recovered). Those results are not presented as successful connections. These checks did not submit real provider credentials, mutate connected accounts or execute live tools. Provider OAuth consent and 21st's key entry still belong to the user; the provider deployment itself cannot be repaired in Grok Call.

The release was installed at `~/Applications/Grok Call.app` and reopened; backend startup was checked after launch.

Sources:

- https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.4
- https://help.21st.dev/ai/mcp
- https://github.com/21st-dev/magic-mcp/blob/6b5299e8a83ceffa73d4fc4e148905bb3eeeeb55/.cursor-plugin/plugin.json
