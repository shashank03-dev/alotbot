# Meeting features: verification

Agenda with time boxes, votes among the bots, the decision log, the past-call search and "Who talked".

## Automated tests (`npm test`, Linux container, Node 22.23.5)

- 637 tests: 624 pass. The 13 failures are the same tests that fail on the unchanged code in this container, for
  reasons outside this change: it has no IPv6 loopback (`::1`, needed by the Connections sign-in listener, 12 tests)
  and no Google Chrome or Microsoft Edge (the dedicated-browser test).
- Coverage of every file this change touches is 100% lines, branches and functions: `public/core.js`,
  `src/past-calls.ts`, `src/memory.ts`, `src/server.ts`, `src/overlay/call.ts`, `src/overlay/store.ts`.
  `src/overlay/server.ts` is at its earlier figure (99.71% branches, the Chrome-only line).
- `npm run typecheck` passes.

## Browser version, end to end (`scripts/verify-meeting-page.ts`)

The real page and call engine in headless Chromium, with stubbed account routes and fake voice sessions whose bots
vote when asked, tell the result and save a summary. No account traffic. 10 of 10 checks passed:

1. The lobby agenda box takes one topic per line.
2. Each bot's instructions carry the agenda, the earlier calls' decisions and the past-call search.
3. The Meeting panel lists the topics and marks the current one with its time.
4. A vote started from the panel: every bot voted in turn, the tally is shown, and a bot tells the result.
5. A decision recorded from the panel is told to every bot and pinned in their instructions.
6. *Next topic* closes the topic with its outcome and opens the next.
7. A duplicate decision is refused with the reason.
8. The panel fits at 375 px and 320 px wide with no sideways scroll.
9. The saved call has the agenda, decisions, votes and who talked, and memory keeps the decisions.
10. No page errors.

`saved-call.md` is the call that run saved; the screenshots are from the same run.

## Not verified

- The Swift Mac app was not built or run (this was checked on Linux). The Mac app's bots get every new voice tool
  and the past-call search through the shared call engine and its backend, and its saved calls include the new
  sections (covered by the Node tests above), but the Mac call window has no Meeting panel yet: there, the agenda,
  votes and decisions are used by voice and appear in saved calls.
- Real Grok voice sessions: how well each model follows the meeting rules (for example, voting only in its turn)
  was not measured against the live service.
