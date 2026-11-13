# Full bot capabilities inside group calls

Status: approved by the user; implementation and acceptance verification are in progress.

## Product and scope

Grok Call remains a group-call application. Every bot in the call can use the same capabilities its individual Grok Bot agent has, and the user can inspect, operate and respond to that work from Grok Call. Keep the existing SwiftUI Mac app, Node backend, Grok sign-in, voice engine, permission decisions and action history. Do not build an unrelated replacement chat application or reintroduce the removed notepad.

The user's latest requirements explicitly include the real Linux computer, Take Control, routines, the rest of each bot's resources, and access throughout minimized and maximized call surfaces. The earlier full-replacement answer was superseded by the user's clarification to group-call capability parity.

Reference audit: [feature inventory](../../research/grok-feature-audit/README.md), including installed protocol declarations, 50 card families and read-only live metadata.

## Architecture choices

There is one sensible integration path for the requested behavior: expose the bots' existing Grok runtime, cloud computer and resource APIs through our existing authenticated backend. Building separate VMs or independent local schedules would fork the bots' state and is outside the request. Opening the original app for every computer or routine operation would not satisfy access inside Grok Call.

- SwiftUI remains the application UI. Add a native per-bot work window and models using the existing backend connection.
- Use macOS WebKit's WKWebView for the cloud computer's provider-served VNC viewer and isolated web results. WebKit is an OS framework; no Electron migration or new frontend framework. Do not copy Grok's packaged proprietary UI into our app.
- Node remains the authenticated control/data layer. Extend the existing Grok client with narrowly typed cloud gateway commands and event subscriptions. Continue using existing fetch/ws dependencies.
- Grok retains the Linux computer, agent execution, browser profiles, routines, provider connections and policy enforcement. The app is the group-call control surface, not a second automation engine.
- The viewer transport must use an authenticated, scoped route whose upstream derives from the signed-in provider response. Keep provider access/network/port tokens in backend memory; expose only a short-lived, single-view capability locally. No arbitrary upstream URL proxy.
- Use a single account event subscription where supported, demultiplexed by agent/session/task; retain bounded read polling as a fallback. No mutation replay after a disconnect.

If the provider's hosted viewer cannot be loaded securely in WebKit, stop that work item with the handshake evidence and propose a specific viewer alternative before changing this architecture. Do not silently substitute a screenshot, local browser or unrelated VM for the cloud desktop.

## Identity and scope

A central runtime identity maps the existing roster bot id to its durable agent UUID, active session/task, cloud screen and any helper monitor. Every command validates these against current account access. A UI-selected bot is not sufficient authorization by itself.

User controls may operate on any bot in their accessible roster; a bot's voice tools operate only with that bot's own credentials/context and the provider's allowed delegation. Renaming a bot or adding/removing it from the call must not remap existing work, pending requests or control sessions by display name.

The account owns one persistent Linux computer; each bot has a separate screen. Files, cookies and credentials remain shared as Grok defines them. Show this clearly once in Computer details. Do not label screens as isolated VMs. Registered Macs, the local dedicated browser, local file access and cloud Linux remain distinct targets.

## App surfaces

Introduce one reusable work window per bot, with the bot's identity and current call status always visible. A single window manager opens/focuses the same bot window instead of creating duplicate sessions.

Entry points use the same commands:

- Minimized pill: bot card → Open work / Computer / Routines.
- Maximized stage: the selected bot has Computer, Activity and Resources actions.
- People list: the same actions for every accessible bot, including bots not currently speaking.
- Menu bar and Settings: open the same bot/resource window outside a call.
- Call timeline/action history: result, approval and blocked-work items open that exact bot/task/request in the appropriate tab.

The window has Computer, Activity, Routines, Knowledge, Files and Apps tabs. Knowledge contains skills and supported memory; Files contains library results and uploaded/generated files. Bot profile/voice and advanced management use the existing details pattern. Accounts and advanced controls stay collapsed until needed. Do not dump raw JSON into Settings.

The call continues while windows are open, the user takes control or switches bots. Opening a workspace does not create another microphone session, change the speaking bot or steal a turn. Separate bot windows may be viewed side by side.

## Computer and Take Control

1. Load account/cloud run state and the selected bot's actual status. Opening Routines/Knowledge must not wake a sleeping computer.
2. Computer shows clear asleep, connecting, downloading/starting, ready, disconnected, restricted and failed states. Offer Wake and connect when needed, with bounded waits and a real retry.
3. Open the correct provider VNC route and monitor. Start in view-only mode; no keyboard, pointer or clipboard input before Take Control.
4. Take Control uses the provider's real handoff/control lifecycle. Bind input to agent, monitor, handoff request and connection generation. Display when the user controls the desktop and when the bot is waiting.
5. Hand back calls the correct provider operation with the current request id. Do not simulate resume by injecting a generic instruction into chat. Follow the native viewer-closed trigger when an owned handoff is active.
6. Switching targets, losing focus/control, closing, disconnecting or signing out releases held keys/buttons, disables input and invalidates the local viewer capability. Stale frames or callbacks cannot send input to a new target.
7. Reconnect read-only after transport failure. Reacquire input control explicitly; never replay keystrokes, clicks, routine runs or other side effects.
8. Support the bot's main screen and entitled helper/monitor views. Do not infer a screen id from bot order or share one mutable viewer controller across different bots.
9. Cloud browser/terminal sessions, files and sign-ins stay on the same Grok computer. Reset/recreate actions are account-wide advanced operations with explicit destructive confirmation, not per-bot convenience buttons.

Login, CAPTCHA, passkey and secure approval boundaries remain with the user/provider. Clipboard transfer happens only through an explicit copy/paste action while the appropriate viewer is controlled; opening or focusing a viewer must not read/synchronize the Mac clipboard. VNC input, clipboard contents and screen pixels are not written to call logs or spoken to other bots. Existing 1Password/Messages trusted native setup handoffs remain supported where required.

## Routines and automations

Use real routine/automation records with stable ids, enabled state, editable specification, trigger metadata, timezone, next run and viewer permissions. The existing name-only voice summary is a hint, not a management record.

Expose list/details, create, edit, enable/pause, delete, run now, run history and resulting work. Support scheduled triggers and provider-supported event/webhook triggers; show required account/workspace access and backend refusals. Use the installed gateway's automation commands and direct typed list APIs, not invented REST endpoints.

- Timezones are explicit IANA zones; show next runs in the user's selected zone and test daylight-saving boundaries.
- Creation/edit goes through the native specification validation. Preserve fields the editor does not change.
- Check allowed actions for shared/team bots. Do not offer successful edits to read-only viewers.
- Run now, delete, publish, enable and trigger changes are real actions with journal records. A transport timeout after dispatch is outcome unknown; reconcile before enabling retry.
- There is no local cron copy of a Grok routine. Closing Grok Call does not pretend to stop the provider's routines.
- Job results, forms and approvals from a routine use the same Activity pipeline and can return to its bot during a call.

## Skills, memory, apps and files

Knowledge lists enabled and available skills with content and scope, and provides supported enable/disable/create/edit/remove controls. Distinguish account-private, bot-private, packaged and team-shared resources. Read-only packaged skills are not editable copies unless the user explicitly creates one. Show supported memory/context separately; changes use provider-supported APIs or explicit agent work, not an invented local memory database.

Teach by demonstration is capability-gated. Use the native recording lifecycle, show recording status, stop/cancel, review the resulting draft and test it before automating. Do not record secretly or claim the feature exists when the account flag is off.

Apps reuses the existing Connections manager, then applies each bot's enabled plugins, variables and permissions. Full capability availability does not mean overriding an intentionally disabled app or a team restriction. Reconnect/setup from a blocked work item retains its bot/request context.

Files supports real upload, download and preview, attachment progress, user/agent/shared-store boundaries and library results. Preserve references to generated pages, images, video, documents, spreadsheets, decks and coding-agent artifacts. Use provider limits, bounded streaming, file-name/path validation and safe previews. Keep Mac paths separate from Linux paths. Our local text-reading limit does not become a limit on remote uploads or media.

Generated pages and MCP applications run in isolated web views with narrowly scoped communication. Remote HTML, tool output and webpage text are untrusted content. They receive neither the app's general RPC bridge nor arbitrary local filesystem access.

## Activity, results and user actions

Create typed work-event/card envelopes shared by live calls, bot work windows and saved history. Preserve agent/session/task/request ids, sequence/revision, type, timestamp and status. Keep enough context to open the actual work; do not flatten interactive results into a spoken sentence.

Implement the applicable card families from card-inventory.json, including:

- Text, questions/widgets, user forms and cancellation.
- Files, attachments, images/video/voice memos, pages/visualizations and MCP app documents.
- Computer/human handoff requests, local/mobile tool permissions, connector/cookie grants and Auto Review.
- Secure secret/credential requests and approved native password-manager setup.
- Email, Slack, iMessage and meeting drafts with supported preview/edit/send/discard behavior.
- Meeting-join consent, phone-call status/control/recordings and coding-agent artifacts where enabled.
- Payment/spending/virtual-card approvals, with provider-defined amounts/merchants and explicit scoped decisions.
- Resource, profile, sharing, template, event and notification cards needed to understand or unblock this bot's work.

Only advertise rendered card/input capabilities after their handlers and tests exist. An unknown or unavailable card must remain visibly unresolved, with an honest explanation and a safe recovery path; it cannot be treated as completion or generic approval. Never infer a sensitive approval from an unrelated “yes” in a group discussion.

Each card action checks current status and permissions and targets the exact request. Expired/stale/already-resolved/cross-bot requests cannot be approved. Secrets use secure forms and specialized submissions; never put values into voice text, transcripts, generic command arguments that are logged or persistent action input/result fields.

Media results never autoplay or feed playback into the host microphone/another bot as a new instruction. Speech summarizes actual work and waiting states concisely; full inspection stays in the work window. A receipt means accepted, not done. Results from one bot do not impersonate another bot or force every bot to speak.

## Continuity, errors and permissions

Persist non-secret work identity, request receipts, terminal outcomes and event cursors in the existing private data directory/action store. Reconcile unfinished work after backend/app restart. The provider continues cloud work even when local watchers stop. Existing local watcher age limits must not make long-running cloud work disappear silently.

Use bounded read retries, cancellation and backpressure; distinguish unavailable, asleep, auth-required, forbidden, rate-limited, unsupported, failed and unknown-outcome. Preserve last successful data while showing its freshness. Never clear a working login as a generic recovery step.

Extend command-log redaction before adding secure submissions. Do not log gateway credentials, signed VNC URLs, clipboard/key input, secure values, attachment bodies or unknown raw card payloads. Keep control/resource operations inaccessible to arbitrary browser origins. Sign-out closes event/viewer sessions and invalidates outstanding local capabilities.

## Build order and reviewable acceptance

Every phase is implemented and verified against the audit; staged work is not called complete parity. The existing call UI remains usable throughout.

1. **Runtime/resource foundation:** typed bot identity, cloud/gateway transport, capability gates, structured resource DTOs and event/card registry. Regression: same-name bots, UUID/session mismatch, access revoked, signed-out, malformed events and duplicate cursors.
2. **Computer:** real status/wake, provider viewer, main/helper monitor selection, view-only/control/hand-back, reconnect and cleanup. Verify two bots' screens, correct target, sleeping VM, stale handoff, viewer close and held-input release. A live manual takeover/hand-back must be verified on a disposable cloud test page; no real messages or account changes.
3. **Routines/Knowledge:** typed routine records and CRUD/run/history, skills and memory, per-bot app selection, gated teaching. Verify real existing routine metadata first; create/run/edit/delete only a clearly named disposable test routine after user authorization of that concrete action. Tests cover DST, recurring/one-shot/event triggers, permissions, rapid toggles and uncertain writes.
4. **Activity and files:** stream/reconcile background work; render cards and preview/upload/download real results. Tests cover pagination, large/empty/malformed files, cancellation, traversal, interrupted/resumable transfer, changed visibility, cross-bot access, rich results and sandbox isolation.
5. **Interactive decisions:** forms/widgets, secure credentials, grants/approvals, drafts, meeting/phone/coding outputs and gated spending flows. Use local service simulations for side effects. User-driven live tests must name exact actions and must not send real messages, join meetings, make calls or purchase anything as a generic acceptance check.
6. **App-wide integration:** reuse the same work/action routes from bot cards, pill, maximized stage, People, Settings and history. Verify voice continuity, multiple work windows, keyboard/accessibility, loading/empty/error states, sleep/relaunch/sign-out, and action routing after bots join/leave/rename.
7. **Parity sign-off/build:** record one status per capability/card family: implemented and tested, unavailable for this account, or externally blocked with evidence. Run type checks, the repository's 100% Node coverage gate, Swift tests and applicable native integration checks; inspect real UI screenshots; rebuild/sign/install. Do not claim all parity is done with missing entitled handlers or unverified computer control.

A provider feature being available in source is not proof that the current account may use it. Provider outages, trusted native partner requirements and account feature gates remain explicit constraints; never bypass them or silently replace them with different functionality.

## Boundaries retained from the conversation

- Existing Swift/Node and Grok account; no new account, API key requirement for Grok itself or separate execution service.
- Group-call identity/behavior, proper grid layout and speaking reactions remain intact.
- Bot capabilities, computers, routines and resources are visible across the app, not buried as JSON in Settings.
- Local broad file consent remains explicit and read-only; cloud computer access does not automatically expand Mac permissions.
- Existing sign-in/permission decisions and native setup handoffs remain respected.
- No notepad, no copied Grok UI, no unrelated full replacement chat/billing/admin product.
- No subagents unless the user explicitly asks. Review and implementation are performed in this workspace while preserving existing uncommitted work.
