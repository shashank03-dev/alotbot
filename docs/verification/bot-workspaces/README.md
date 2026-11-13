# Bot workspace build verification

The current build keeps Swift/Node, the existing Grok account, group calls and provider permission decisions. This record distinguishes working controls from remaining parity limitations.

Implemented and tested:

- Per-bot Computer, Activity, Routines, Knowledge, Files and Apps windows, accessible from the call surfaces, roster, settings and action history.
- Real provider Linux desktop transport, view-only input enforcement, explicit control/release, monitor selection, scoped viewer capabilities and fresh access checks. Fragmented revoked input cannot become a new key press when control returns; extended held keys and HTTP backpressure listeners are handled correctly.
- Account routine management with distinct account IDs and bot-tool IDs. Create/edit receipts remain pending until provider reconciliation; run/enable/delete use the account APIs. Explicit timezone display and daylight-saving conversion tests.
- Enabled/available skills, editing and activation, memory inspection/team sharing, library results and pins, per-bot apps, teaching controls, scoped file transfer and Quick Look previews. Normal quit/sign-out asks whether to save or discard an owned recording before closing; failed stops prevent exit. Authentication loss closes access and explains how to recover a still-recording lesson. Partial resource outages retain the last successful sections for that bot.
- Activity and exact-request decisions, multi-select questions, supported forms, secure secret submissions, credential/site consent, connector grants, reviewed email sender/recipient/subject/body editing, verified Slack/meeting routes, server-held attachment checks and draft send/discard, phone controls and gated payment verification. Sensitive contents are excluded from action history and logs.
- Isolated result views and MCP app documents. A real native WebKit test verifies the MCP initialization/context exchange, opaque origin and rejection of direct iframe execution through the native bridge. Tool calls require explicit native confirmation.
- Authenticated account event invalidation, bounded fallback reads, retained activity cursors and private read-only metadata recovery. Unfinished cloud work remains watched after a day.

Live evidence:

- `live-routine.jsonl`: disposable disabled routine created, edited, manually run, exact temporary marker read, two run-history records found and routine deleted. Earlier failures and their fixes remain in the separate regression logs.
- `live-desktop-interaction.jsonl` and `native-webkit.txt`: native WebKit displays a real Linux desktop. An OCR-identified disposable local page stays unchanged in view-only mode, then shows the exact marker after a controlled pointer click. Control is released, the viewer closes, and the bot confirms cleanup of its owned temporary page. No external site or private document was used. `live-computer.jsonl` preserves the earlier handshake-only check.
- `live-call.jsonl` and `call-native-webkit.txt`: two real bots remain in the group call while the native Linux viewer opens and control is enabled/released. The call then receives the requested verification response and nine generated audio frames. No microphone capture, speaker playback or connected-app action was performed.
- A repeat initially timed out at provider roster discovery; `live-computer-last-attempt.txt` preserves that failure. The bounded repeat passed. This was not a successful run until the repeat completed.
- `native-mcp-webkit.txt`: real WebKit app initialization and isolation check passed.
- Native tests: 47 passed; core tests: 100 passed. `native-tests.txt` stores the final run.
- After the independent draft review fixes and the older-activity draft fix: 588 Node tests pass with 100% lines, branches and functions, typecheck is clean, and 147 Mac tests pass (47 native, 100 core). `node-tests-and-coverage.txt` records this run. All repository thresholds remain 100%; no coverage exclusions or threshold reductions were added.
- `release-build.txt` records the development release build and ad-hoc signature. `installed-build.json` records the installed executable comparison and signature verification.

Remaining acceptance limitations:

- Live speaker playback and microphone capture were not exercised. The live call check verifies provider-generated voice frames; the separate desktop interaction verifies real pointer input on the disposable page.
- Messages, 1Password, cookie/mobile native permission flows retain trusted Grok Bot setup. Unsupported cards stay unresolved with a visible native recovery action.
- Email supports reviewed To/Cc, verified sender, subject and body changes. Slack and meeting routes stay tied to the verified draft. Existing server-held attachments are checked and preserved; adding/removing attachments is not exposed by the native send protocol. iMessage and Mac Mail drafts require a fresh local sending-Mac approval in Grok Bot and are discard-only here.
- Appearance, email offers, publishing and team sharing have specialized native editors, fresh revision checks and explicit audience confirmations. Publishing/team writes were verified with controlled service tests; no real app publication or team-sharing change was performed. Grok Bot notification permission must be granted to that app’s macOS bundle; its reminder can be dismissed here. No permission decision is bypassed.
- Payments, phone calls, meetings, secret submission and general connected-app writes were tested using controlled service fixtures. The separately approved email test was sent through the real backend; no purchases, phone calls or credential disclosure were performed.

The provider/native authorization boundaries above remain explicit. This evidence does not claim that every external service action or account entitlement was exercised live. The requested Grok 4.7 research delegation failed before execution because its provider reported insufficient balance; no Grok review result is claimed.
