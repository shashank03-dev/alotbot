# Direct connected-app access

Approved by Shashank on 2026-11-11.

Keep Swift, Node, the existing sign-in and the existing call transport. Give every bot three tools: `list_connected_apps`, `find_app_tools`, and `use_app_tool`. Discover account apps through DashboardService/GetAvailableMcpServers and ListSandMcpTools; execute the exact discovered, qualified tool name through ExecuteSandMcpTool with the speaking bot's agent id. Return the actual result to its voice session.

Use discovery on demand instead of loading hundreds of schemas into the voice session. Validate app and tool selection, paginate schemas, refresh discovery before execution, preserve disabled tools and saved Grok permission decisions, and never retry an action automatically. Explicit permission refusals and actions needing Grok approval must not execute. Changed by Shashank on 2026-11-11: tools with no rule (Grok's default, auto review) run without asking, reads and writes alike, matching Grok Bot's permission order (tool rule, then reads or writes rule); blocked, disabled, needs-approval and unknown rules still stop a tool. Keep existing background tasks for work on the bot's computer.

Alternatives: the existing background relay accepts requests but does not supply connected-app inventory or results to this call; UI automation would depend on an open window and interfere with normal use. Direct service access is proven with read-only Gmail calls for each of the three account bots. No new libraries or separate credentials are needed.

The installed app is the protocol reference (version 0.79.3). The ten installed entries in the screenshot include nine connectors and Superpowers, which contains skills only. Render currently needs sign-in. Local-only app integrations cannot be presented as working cloud connectors.

Verify the HTTP contract, bot identity, malformed and empty inputs, stale tool selection, authentication and approval failures, and turn-taking while tools run. Measure the repo's required 100% line, branch and function coverage, run typecheck and Mac tests, perform real read-only calls through the implementation, then rebuild and install the app.
