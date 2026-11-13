# Setup-card contracts checked on 2026-11-13

Source: the installed `/Applications/Grok Bot.app/Contents/Resources/app.asar`, inspected without copying its UI. The renderer chunks below define the native behavior; `dist/electron-main/proto.cjs` defines the account request/response fields.

| Card | Native contract | Grok Call behavior |
| --- | --- | --- |
| Appearance | `chunk-view-Bf1LsXJ_.js`: UpdateGrokBotAgent followed by RespondGrokBotWidget with avatarShape/avatarColor JSON | Real roster appearance choices; only selected bot updated; exact current card answered |
| Email offer | `chunk-view-Xzusr9O4.js`: email-offer:use or email-offer:not-now widget values | Explicit offered-address choice, no message sent |
| Notifications | `chunk-view-PHRD9FL6.js`: native OS permission management and widget dismissal | Open Grok Bot for its bundle permission; independently dismiss the reminder |
| Publishing | `chunk-view-CL42W4Zr.js`: confirmCloudAgentPublishProposal / dismissCloudAgentPublishProposal | Exact coding task/proposal IDs, explicit audience/slug review, future updates still require confirmation; kind=refused stays refused |
| Team access | `chunk-view-CgZEs_-W.js`: CloneGrokBotAgentToTeam / ShareGrokBotAgentInPlace / GetGrokBotAgentInPlaceShareStatus | Current-team confirmation, no personal-secret copying, started differs from completed, malformed copy identity remains outcome unknown |

RespondGrokBotWidgetResponse and DismissGrokBotWidgetResponse have `accepted` boolean and optional `refusal`. Omitted protobuf false must not be interpreted as success: these controls require accepted=true and no refusal.

Every setup action re-reads the selected bot transcript and checks card kind, session, action allowlist and a revision derived from the current projected card. These controls do not turn arbitrary text into approval values.

Publishing/team changes were exercised through controlled service fixtures. No live publication or team-sharing change was made. Actual provider policy, person authority and account entitlement may still reject those requests; the app reports rejection. This is not evidence of live account access to every action.

The native notification permission belongs to Grok Bot’s macOS bundle. Opening that application is not a claim that this app can grant its permission. Existing cookie, Messages, password-manager and mobile authorization boundaries remain intact.
