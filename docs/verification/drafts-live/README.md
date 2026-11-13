# Workspace drafts: live verification (2026-11-13)

Sanitized record of the user-approved live checks for draft review, edit, send and discard. Personal addresses are redacted. No message bodies are stored here.

## Setup

- Real signed-in account, real backend (`src/overlay/main.ts`) on a private port, driven over the same `/ws` workspace commands the Mac app uses.
- Bot: "My Bot". Email route: the connected Gmail plugin (`draftRoute.platform=email`, `providerIdentifier=user-Gmail`, `restMcp=true`).
- Each draft was created by sending the bot one chat message that asked for a Gmail draft to `*@example.invalid` and said "Do NOT send".

## Live transcript shape (field names and types only)

```
kind, id, message{type, draft{from, to[], subject, body}}, timestampMs, requestId,
draftRoute{platform, providerIdentifier, mailbox, restMcp},
draftRouteVerified{platform, sendingAddress, senderSource},
draftProposedRule{rule, source}
```

- `draftRoute` and `draftRouteVerified` are top-level entry fields, as projected.
- The verified route has a single `sendingAddress` and no `sendingAddresses` list. The projection uses that address.
- The entry has **no `sessionId`**. The runtime now omits an empty session ID, as Grok Bot does (`eo()` in `main-app.cjs`). Regression test: `live transcript drafts without a session omit it, exactly like the native app`.

## Results

| Check | Result |
|---|---|
| Activity load, 3 bots, every page | OK, no errors |
| Draft card projection | `email-draft`, `editable`, actions `sendDraft`/`discardDraft`, sender = verified address, 0 attachments, 32-hex revision |
| Outdated revision | refused: "This draft changed since you reviewed it…" |
| Edit without `reviewed:true` | refused: "…must be confirmed in the draft editor." |
| Reviewed edit with a different revision | refused (stale) |
| `bcc` field in review | refused: "…destination can’t be changed here." |
| Sender that isn't verified | refused: "Choose one of this bot’s verified sending addresses." |
| Invalid recipient / empty recipient list | refused: valid recipient required |
| Empty body | refused: body required |
| Wrong session | refused: no longer editable |
| Different bot, same entry ID | refused: no longer editable |
| Draft state after all refusals | still `editable` (nothing reached the provider) |
| Reviewed send: To changed to the user-approved address, subject and body edited | `{accepted:true}`, card became `sent` with no actions, provider stored the edited To and subject |
| Second send of the same draft | refused by the dedupe: "already submitted…" |
| Second draft, Discard | `{accepted:true}`, card became `discarded` with no actions |
| Saved action records | input `{"action":"draftSend","entryId":"t31s1"}` only; no body, subject or address in `actions.sqlite` (incl. WAL) or `logs/` |
| Activity cache | `saveWorkspaceCards` stores `draft:null`, `text:''`: no draft contents persisted |

Exactly one real email was sent (user-approved recipient). No other sends.

## Not covered live

- Drafts with attachments, Slack drafts, meeting-chat drafts, iMessage drafts and Mac Mail-routed drafts: none exist in this account. They are covered by provider simulations in `test/workspace-drafts.test.ts`.
- The SwiftUI editor was compiled but not driven by UI automation in this run.
