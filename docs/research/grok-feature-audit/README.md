# Grok Bot capability audit — 2026-11-12

## Confirmed scope

Grok Call remains a group-call application. Each participating bot must retain the capabilities it has individually in Grok Bot, and the user must be able to see, inspect and operate that bot's work from Grok Call. The earlier request for a full standalone replacement was explicitly corrected by the user. Do not build a separate replacement chat client, account administration product or notepad.

The latest explicit requirements include the actual Linux computer view, Take Control / hand-back, routines and access to the rest of a bot's resources throughout the app. Account-scoped settings, provider permissions and previously approved native setup handoffs remain authoritative.

## Evidence and what it establishes

- Installed app: `/Applications/Grok Bot.app`, package `sand`, version `1.0.1`. ASAR SHA-256: `171d607e9faf339ca9a66c0c0113c23c390ac577ca39a72df23b0fdf74dcd2e9`.
- The archive contains 886 file entries. Initial extraction inspected 640 main/renderer JavaScript bundles; coordinator and VNC preload bundles were also read. Extracted code stays under `/tmp/grok-feature-audit`; no proprietary UI bundle is proposed for redistribution.
- A local `protocol-inventory.json` (kept out of this repo because it lists Grok Bot's internal service declarations) records: 457 GrokBotService methods, including 76 beginning with Admin, and 93 DashboardService methods. These are contracts, NOT 550 user-facing features, and are NOT evidence that the signed-in user may invoke every method. Admin/internal methods must not be exposed.
- `card-inventory.json` records 50 distinct source card families found in the installed renderer, including events, normal messages and bot-generated work. It labels current local support. It is evidence of client handling, not a claim that all families are enabled for this account.
- Official documentation says the account owns one persistent cloud computer. Individual bots use separate screens on it; files, browser sessions and credentials are shared. Separate screens are not separate security boundaries.
- The installed client uses authenticated cloud gateway commands for computer status, connecting/waking, hand-back, skills and routine management; RFB/VNC is a separate viewer transport. A list of registered user Macs is not the cloud computer.
- Live read-only checks found 3 bots. One has 4 skills; another has 2 routines and 2 corresponding automation records. The cloud computer was hibernated. Seven returned runtime capability booleans were enabled. No computer was woken, no routine was created/run/changed, and no task, message, purchase or approval was sent.
- These checks did not view the user's remote screen or open/download private files. Counts and field names, not personal content or credentials, are saved in `live-metadata.txt`.

## Baseline gaps recorded before the workspace build

The list and capability table below describe the initial audit, not the current release. Current implementation and live-test limits are recorded in [workspace verification](../../verification/bot-workspaces/README.md); specialized setup-card contracts are recorded in [setup-controls.md](setup-controls.md).

1. `src/grokbot.ts:computers` calls ListGrokBotUserComputers and returns label/last-seen data. It does not connect to the Linux sandbox or a bot's screen.
2. `src/grokbot.ts:routines` reduces routine records to name/trigger/enabled/next-run and loses the identifiers, policy and editable automation record needed for management.
3. `src/overlay/server.ts:botResources` returns skills/routines/files as one JSON string. Settings renders it as text; it is not a resource UI.
4. `src/grokbot.ts:landedText` recognizes text, auto-review notices, connector notices and questions. Other card types become a sentence telling the user to open Grok Bot.
5. `src/jobs.ts:approvalOf` recognizes local-tool, auto-review and connector requests only. Secret forms, credential requests, drafts, meeting consent, spending approvals and computer handoffs need their actual typed flows.
6. The agent can already receive real background jobs through its voice harness and return text results. Therefore the main gap is not replacing its intelligence; it is exposing the agent's existing work, resources, computer and input/approval flows without losing identity or context.
7. The current direct-app inventory is account-scoped. Per-bot enabled skills/plugins, team policies and runtime capabilities must also be respected; having an account connection does not authorize enabling it for every bot.

## Capability map

Status is based on current source inspection, not a new end-to-end test of every existing feature. The build acceptance checks are in the design document.

| Capability | Current Grok Call | Required result | Contract / evidence |
| --- | --- | --- | --- |
| Group voice, handoffs, interruption, participant changes | Present | Preserve while workspaces are open | Voice harness and existing call engine |
| Bot identity, voice and role context | Partial | One consistent bot identity across call, job, screen and resources | ListGrokBotAgents; botMeta; VoiceCallHarnessSession |
| Full background agent work | Present, text-focused | Every bot dispatches real agent work; actual results and questions return to that bot/call | VoiceCallHarnessTool; transcript watcher |
| Cloud Linux computer | Missing | Actual persistent cloud computer, correct bot screen, asleep/starting/ready/offline states | EnsureSandBox; GetSandBoxRunState; getForeverBoxStatus; ensureForeverBox |
| Take Control and hand-back | Missing | Real keyboard/mouse control, explicit agent handoff, safe release and reconnect | VNC viewer; handBackForeverBox; EndGrokBotBoxHandoff |
| Multiple bot screens and helper monitors | Missing | Switch by bot/monitor without changing another bot's control target | Status windows/subagent metadata |
| Cloud terminal/browser work | Agent-side only | Observe and take control of the same Linux session; preserve cloud state | Persistent cloud desktop documentation |
| Local Mac observation/files/browser | Present with limits | Keep separate from cloud desktop and retain user-granted scopes | MacTools; observation; local-tools |
| Registered local computers | Metadata only | Distinct user-computer status/selection and clear offline failures | ListGrokBotUserComputers |
| Scheduled routines | Metadata only | Inspect/create/edit/enable/pause/delete/run-now with correct bot and timezone | Agent automation gateway commands; ListGrokBotAgentAutomations |
| Event routines and webhooks | Missing UI | Inspect trigger source, workspace/account, filters, permissions, run history and failure | Automation spec; provider event integrations |
| Skills/private skills | Names/descriptions only | Read content, enable per bot, edit/save/remove and honor shared/team scope | Agent skill methods; agent plugin settings |
| Teach by demonstration | Missing | Record/review/save a draft only when runtime supports it | startTeachRecording; stopTeachRecording; getTeachRecordingStatus |
| Memory/context | Agent-side only | Inspect supported bot memory, edit through supported agent/settings paths | ListGrokBotUserBotMemories; bot runtime |
| Connected apps and tools | Account management and execution present | Per-bot availability, scope and policy; contextual reconnect/setup | GetGrokBotAgentPlugins; SetGrokBotAgentPlugins; existing Connections |
| Custom MCP and MCP interactive apps | Partial / missing viewer | Correct tool/resource access plus isolated interactive app UI | Get/UpdateGrokBotAgentCustomMcp; ReadGrokBotMcpAppDocument; CallGrokBotMcpAppTool |
| Files and attachments | Remote file metadata only; local text reading | Upload/download/preview actual attachments and bot output; progress and bounded streams | Begin/Complete/Abort attachment uploads; ReadAttachmentChunk; agent/store file methods |
| Library, generated pages and visualizations | Missing | Inspect saved pages/results/media, pin/find/open and edit through bot work | ListGrokBotLibraryDocs; library pins; visualization/card/document contracts |
| Images, video and voice memos | Not rendered as complete results | View/play/save actual results with captions and provenance | Attachment/media cards; files/results docs |
| Forms and questions | Questions spoken only | Submit the exact widget/form response to the right pending request | RespondGrokBotWidget; Submit/DismissGrokBotUserForm |
| Auto Review and local permissions | Partial UI exists | Preserve backend decision, expiry, pending request identity and explicit scope | ResolveGrokBotAutoReviewApproval; ResolveGrokBotLocalToolPermission |
| Connector grants/cookie-origin permissions | Missing specific card controls | Review exact service/account/origin and allow/deny through real APIs | ResolveGrokBotConnectorGrant; cookie-origin card |
| Secrets, Vault and credential handoffs | Existing native setup handoff only | Secure entry and decisions without speaking/logging credentials | SubmitGrokBotSecret; ResolveGrokBotCredentialRequest; trusted native setup |
| Email/Slack/iMessage/meeting drafts | Agent can produce them; UI incomplete | Preview/edit supported drafts and explicitly send/discard | SendGrokBotDraft; DiscardGrokBotDraft; typed draft cards |
| Meetings and phone tasks | Agent/runtime dependent; no complete call UI | Show consent, progress, transfers/recordings/results where entitled | Meeting consent/phone cards; outbound-call methods |
| Purchases/spending/card approvals | Agent/runtime dependent; UI missing | Show exact proposal and secure explicit approval; never infer consent from group conversation | Virtual-card approval; BeginSpendApproval; provider policy |
| Coding agent delegation | Dispatch may work; result renderer missing | Show task progress, artifacts and repository/PR links | Cursor-agent card; cloud-agent watcher contracts |
| Proactive work and notifications | Local action history only | Route relevant updates to owner bot/call, persist cursors and reconcile on relaunch | Transcript/status events; notification capabilities |
| Team/shared bots | Roster access only | Respect access, installed skills, shared resources and action permissions | Team/agent access and runtime capabilities |
| Bot profile/template sharing | Create/basic identity only | Expose applicable bot controls without silently publishing or cloning | UpdateGrokBotAgent; templates and export policy |
| Failures and cancellation | Some existing guards | Honest states, read retries only, no repeated side effects or fake success | Existing actions journal plus new work managers |

All card families are tracked separately in the machine-readable card inventory; the table groups product capabilities and is not a substitute for card-by-card acceptance tests.

## Verified transport details

- Grok Bot coordinator sends cloud commands to `POST <gatewayBaseUrl>/api/<method>` with JSON bodies and provider-issued credentials. It watches `<gatewayBaseUrl>/events` as an authenticated event stream.
- Computer command arguments include a bot `id`; getForeverBoxStatus returns a per-bot status with vncUrl, windows, phase/handoff metadata. ensureForeverBox is the explicit wake/connect path.
- EnsureSandBox accepts optional wake and supportsAsleepBox. Its reply includes gatewayUrl, gatewayToken, gatewayPortToken, networkToken, vncUrl, forkVncBaseUrl and related scoped credentials. These are secret material, not UI/debug fields.
- The viewer uses `/vnc.html` and a websockify path; monitor/fork URLs can have scoped port/network credentials. The coordinator rewrites internal host routes to provider proxy routes. Do not guess a desktop URL or send these URLs/tokens to the voice model.
- handBackForeverBox takes id, requestId and a trigger. Native triggers include button, viewer-closed and dismissed. The durable-agent path calls EndGrokBotBoxHandoff with the exact request identity.
- Routine gateway commands include createAgentAutomation(id,spec), updateAgentAutomation(id,automationId,spec), deleteAgentAutomation, setAgentAutomationEnabled and runAgentAutomationNow, with typed trigger specs. Direct ListGrokBotAgentAutomations returns records and permissions needed for display.
- SendGrokBotUserMessage has session/task identity and supported rendered-card-kind fields. The client must advertise only the input/card capabilities it actually implements.

## Sources

- https://docs.x.ai/grok-bot/computer-and-apps
- https://docs.x.ai/grok-bot/chat-and-collaboration
- https://docs.x.ai/grok-bot/skills-routines-and-automations
- https://docs.x.ai/grok-bot/files-and-results
- https://docs.x.ai/grok-bot/approvals-security-and-privacy
- https://docs.x.ai/grok-bot/vault
- https://docs.x.ai/grok-bot/team-bots
- https://docs.x.ai/grok-bot/settings-and-notifications
- Installed bundle evidence above, especially proto.cjs, main-app.cjs, node-agent-coordinator/main.cjs, chunk-box-desktop-modal-7UONmb_J.js and the card bundle names in card-inventory.json.

## Remaining proof required

The read-only audit confirms contracts and current metadata. It does not prove a live VNC handshake, takeover/hand-back, routine CRUD, uploads, teaching, purchases, meetings, credential submission or every feature gate. These must be validated as part of implementation, with controlled fixtures and explicit user-driven live operations where an action affects real accounts. Computer recreation and admin/internal RPCs were not invoked.
