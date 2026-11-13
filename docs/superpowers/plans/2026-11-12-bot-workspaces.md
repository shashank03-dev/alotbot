# Bot Workspaces Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. The user explicitly requested implementation in this session and prohibits subagents unless asked.

**Goal:** Make each bot's real computer, routines, resources, results and decisions usable from group calls.
**Architecture:** Preserve SwiftUI/Node/Grok identity. A typed runtime adapter validates bot ownership, authenticates provider gateway operations and serves scoped computer sessions; native per-bot work windows reuse the existing backend transport and call lifecycle.
**Tech Stack:** SwiftUI, AppKit/WebKit, TypeScript, existing fetch/ws/Ajv.
**Spec:** docs/superpowers/specs/2026-11-12-group-call-bot-capability-parity-design.md (user approved).

## Global Constraints
- Preserve uncommitted work and current call behavior. No subagents, extra account, separate VM, local duplicate routines or notepad.
- User controls and bot tool identities must remain scoped to real accessible agent ids.
- Do not log provider credentials, signed desktop URLs, clipboard/input, secrets or attachment bodies.
- Reads may reconnect; side effects never automatically retry after uncertain dispatch.
- Live checks use metadata and disposable computer pages; no real outbound messages, calls, meetings or purchases.

## Review Focus
- Bot rename/same-name, session changes and access revocation cannot change an action target.
- Desktop disconnect/focus loss cannot replay input or retain control.
- Unknown/stale cards and action timeouts cannot become successful approvals.
- Routines preserve provider fields, IANA timezone and allowed actions.
- Large files and remote HTML cannot bypass byte/path/origin limits or access the native command bridge.

## Task 1: Authenticated runtime and structured work resources
Files: src/bot-runtime.ts, src/grokbot.ts, test/bot-runtime.test.ts.
Interfaces: BotRuntime.command(botId, action, args), close(); RPC callback and identity resolver are injected. Typed summaries retain original ids, permissions, references and request status.
- [ ] Write failing identity, provider transport, sleeping/no-wake, structured routine/skill/file, malformed/forbidden and uncertain-write tests.
- [ ] Implement narrow provider gateway/unary operations; validate arguments; keep credentials in memory.
- [ ] Run focused tests, then type checking.

## Task 2: Computer sessions
Files: src/computer-viewer.ts, src/overlay/server.ts, test/computer-viewer.test.ts.
Interfaces: scoped session URLs, HTTP/WebSocket forwarding and view-only/control/close operations tied to bot/generation.
- [ ] Test upstream origins, capability lifetime, no-secret logs, reconnect and exact handoff identity before implementing.
- [ ] Implement provider-served viewer transport and cleanup; prove real Linux desktop handshake without importing proprietary UI.
- [ ] Verify sleeping/wake/status, two bot identities and manual-control boundaries.

## Task 3: Native bot work windows and app-wide navigation
Files: mac/Sources/GrokCall/BotWorkspace*.swift, AppModel.swift, Trays.swift, StageView.swift, MenuBarView.swift, SettingsView.swift; native tests.
Interfaces: shared window manager opens/focuses per-bot window/tab, keeping the same AppModel/Backend/audio.
- [ ] Add typed decoding/model tests and computer lifecycle tests before UI implementation.
- [ ] Build Computer, Activity, Routines, Knowledge, Files and Apps tabs with proper loading/empty/error/permission states.
- [ ] Reuse the same navigation from cards, People, stage, Settings and history; verify call continuity and multiple windows.

## Task 4: Routines, knowledge and resources
Files: runtime adapter, workspace views/models and focused tests.
- [ ] Cover actual routine ids, specs, permissions, create/edit/enable/delete/run-now/history, timezone and uncertain writes.
- [ ] Cover skills, memory, plugin selections, gated teaching, paginated library/files and safe upload/download/preview.
- [ ] Wire controls to real APIs/gateway methods; no JSON dumping or invented endpoints.

## Task 5: Rich activity and decisions
Files: src/work-cards.ts, runtime adapter, src/jobs.ts, native activity views and tests.
- [ ] Build typed registry for audited card families and exact pending-request actions, including forms, drafts, secure inputs, handoffs, grants and gated meeting/phone/spending operations.
- [ ] Test stale/cross-bot/duplicate requests, side-effect uncertainty and complete secret redaction.
- [ ] Route results into the call plus persistent inspectable activity; unknown cards remain unresolved and visible.

## Task 6: Verification and release
- [ ] Run repository type checks and 100% Node coverage gate, Swift/core/native tests and controlled integration checks.
- [ ] Exercise live read-only account resources and actual cloud computer transport; distinguish verified actions, provider gates and external blocks.
- [ ] Render and inspect native states, self-review identity/privacy/lifecycle boundaries, complete capability/card evidence matrix.
- [ ] Build/sign/install and report exact remaining limitations; do not call partial parity complete.
