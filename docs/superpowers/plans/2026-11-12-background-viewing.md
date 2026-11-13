# Background viewing implementation plan

Goal: evidence-based app viewing without focus changes.
Architecture: existing local tool bridge; native read-only window discovery/capture and OCR, agent image interpretation when supported.
Stack: Swift ScreenCaptureKit/Vision, TypeScript, existing Grok account.
Spec: docs/superpowers/specs/2026-11-12-background-viewing-design.md

- [x] Add failing tests for deterministic window matching, app aliases, title filtering, ambiguity and stale IDs.
- [x] Implement bounded matching and protocol fields in GrokCallCore; run core tests.
- [x] Add native discovery/capture/OCR with explicit enablement and lock/permission checks; prove disabled and real capture cases.
- [x] Expose mac_observe through local dispatch and voice instructions; test routing/schema and truthful capability instructions.
- [ ] Verify existing Grok agent can interpret a synthetic local image, then verify the capture-to-agent path.
- [x] Resolve inaccessible pages through the user-approved guided fallback: ask them to select the page, wait for readiness, then take a fresh read. No extensions or automatic tab activation.
- [ ] Run full Node and Swift suites, typecheck, build, inspect diff, and report measured limits.


Current blocker: the plan has no implemented inactive-tab browser integration. The live running Zen session has no verified native read path. Production extension distribution/signing and live Chrome/Safari/Zen inactive-tab acceptance tests remain outstanding. Do not mark complete based on window tests.


Release checks for the narrowed, approved scope: 446 Node tests and enforced coverage pass; Swift core/native fixtures pass; live voice fallback with synthetic tool results passes; the rebuilt app is installed with backup and its backend connected. Full native UI/audio call acceptance remains for user testing. Browser-specific inactive-tab integrations are out of this release's agreed scope.
