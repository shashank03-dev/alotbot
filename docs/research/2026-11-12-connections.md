# Connections manager: verified contract and implementation

The user requested every connection available in Grok Bot, presented in Grok Call's own UI, with management and sign-in initiated here. The user approved handing off Messages and 1Password to Grok Bot's native setup when required. Keep the existing SwiftUI/Node architecture and dependencies. Preserve the ongoing uncommitted viewing/permission work.

## Evidence

- Installed reference: /Applications/Grok Bot.app/Contents/Resources/app.asar, read without modifying the app. Grok Bot's DashboardService exposes ListMarketplacePlugins, ListMarketplaces, GetEffectiveUserPlugins, InstallUserPlugin, UpdateUserPluginInstall, UninstallUserPlugin, GetAvailableMcpServers, CheckHttpMcpStatus, CompleteMcpOAuth, RenameMcpOAuthAccount and DeleteMcpOAuthAccount. Permissions use GrokBotService's existing MCP permission/settings APIs.
- Live read-only catalog request returned 498 entries with excludeCloudAgentPlugins=true. Explicit pagination is supported. Team/private catalogs are loaded through ListMarketplaces and marketplace-specific queries. Installed plugins include skills-only entries; they must not be mislabeled as connected app tools.
- Plugin variables are JSON Schema, not a fixed API-key form. Examples include Front's client ID/secret and NetSuite's account-specific MCP URL. GetEffectiveUserPlugins supports excludeConfiguredVariables=true; never return stored secrets to the UI.
- Render reports requiresAuth. A sign-in initiation without opening the provider page verified CheckHttpMcpStatus with x-cursor-mcp-oauth-relayed-loopback:1 and redirect http://localhost:18787/callback. The response used that exact callback, with PKCE. No provider consent or connection was completed.
- Grok's native source uses 8787 and alternate ports 18787/28787/31787. Bind loopback before requesting authorization; reject unknown/replayed/expired state; exchange the callback through CompleteMcpOAuth; verify status afterward. Do not remove a valid account when sign-in is canceled. Multi-step continuation URLs remain an explicit pending sign-in.
- Canonical native links are grokbot://app/v1/settings?id=messages and grokbot://app/v1/plugin/native?id=onepassword (also email). Native setup remains owned by Grok Bot. Messages' Mac permission readiness cannot be inferred from an OAuth token; label it managed in Grok Bot instead of claiming it is verified connected. 1Password state can be read through GetOnePasswordState, without exposing its credential directory.

## Sources

- Native OAuth uses the external browser: https://www.rfc-editor.org/rfc/rfc8252.html
- MCP HTTP authorization, discovery and transport differences: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- 1Password's supported Grok Bot setup and consent model: https://support.1password.com/1password-grok-bot/
- Apple permission controls: https://support.apple.com/en-lk/guide/mac-help/mchl211c911f/mac
- Auth recovery/cancellation implementation reference: https://github.com/modelcontextprotocol/inspector/blob/main/specification/v2_auth_mid_session.md

## UI and execution

A Connections sheet from Settings uses the existing Theme, type and spacing. Installed/Browse selection and search sit above a list/detail layout. The detail pane contains only the applicable configuration, authentication, account and permission controls. Loading, empty, partial-catalog, canceled, expired, blocked and disconnected states are explicit. Catalog entries, including skills-only entries, come from Grok rather than a hard-coded shortlist. Native handoffs are labeled as such.

Add focused backend and Swift model/view files, and only the required integration lines in existing files. Bots receive no install/auth management tools. The user's explicit UI actions control connection changes. Tests use local HTTP OAuth providers and mocks; live verification reads catalog/status and starts no new provider consent without the user. Verify HTTP contracts, state binding, secret redaction, concurrent actions, account mutations and UI filtering/decoding, then run the full repo checks, render the native screen and rebuild.

## Built-in account services

Live discovery also returns GitHub (`cursor-github`, id -1000) and Origin (`cursor-origin`, id -1001) outside marketplace installations. They are not ordinary HTTP MCP OAuth servers. Origin is part of the signed-in account. GitHub management opens the account integrations page in the browser, then refreshes on returning. The installed native source uses the account integrations route `/dashboard?tab=integrations` and a separate source-control disconnection API. Do not pass these services into the generic MCP OAuth flow.

## Read-only verification

The implemented manager loaded 504 entries (the live marketplace plus custom/account and native entries), with no catalog warnings. Live tool discovery reported Cloudflare 4, GitHub 75, Gmail 25, Origin 34, Supabase 37, T3 Code 68, Vercel 250 and X 101 tools. Render reported `needsAuth` with zero tools. This verified discovery, not execution or new provider consent. The native decoder successfully read the complete live snapshot (about 308 KB); stored configuration values were excluded. Authentication, account mutations and permission edits were exercised against local test services, without changing the user's real connections.
