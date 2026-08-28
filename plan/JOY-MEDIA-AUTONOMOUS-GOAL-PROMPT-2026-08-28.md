# JOY Media autonomous implementation goal prompt

Copy the text below as the goal. It is intentionally outcome-based and pre-authorizes the normal
in-scope actions needed while the user is asleep.

---

Finish the standalone `C:\Users\HadiMoti\joy-media` repository and the JOY Studio application at
`https://joyst.ir/` / `https://www.joyst.ir/` by executing
`plan/JOY-MEDIA-FINISH-PLAN-2026-08-28.md` and
`plan/JOY-MEDIA-RECONCILIATION-MATRIX-2026-08-28.md` completely.

Continue autonomously until the measurable completion contract in the finish plan is satisfied.
Do not wait for my confirmation, approvals, or ordinary implementation decisions. Diagnose and fix
failures, cross-review changes, retry safe transient operations, and keep progressing. Existing
authorization covers scoped code/document/test changes, commits, branch reconciliation, a
non-force merge to `main`, pushes to the `github` and `vps` remotes only after verifying both URLs
belong to this standalone JOY Media repository, rehearsed additive database migrations, immutable
JOY Media deployment, restart of `joy-media@api` only when required, Nginx reload only after
`nginx -t`, production canary, and automatic scripted rollback if a post-deploy gate fails. Never
weaken a release, security, or data-safety gate; force-push; destroy user data; expose secrets; or
touch the `joy-vps` repository or unrelated VPS services.

Before infrastructure work, query the local Gbrain page `joy-vps-agent-brief` and read the redacted
`C:\Users\HadiMoti\Desktop\VPS-AGENT-BRIEF.md`. Store only confirmed non-secret facts. Preserve
credentials, cookies, OTPs, tokens, private object references, customer data, and secret-bearing
logs outside Git and reports. Verify the origin with the brief-mandated
`curl --noproxy '*' --resolve ...` route, keeping private values out of Git, and write confirmed
non-secret outcomes back to Gbrain after completed VPS changes.

Use this execution team and have agents challenge one another’s diffs and evidence:

- Kilo CLI with the free route `kilo/kilo-auto/free` for bounded backend/source implementation;
- Hermes CLI with `openrouter/free` for bounded adversarial/security/release review;
- Codex in-app Luna sub-agents for bounded UI/source/test work;
- Codex in-app GPT-5.4 sub-agents for bounded integration/backend/release review.

Use those routes when available. If any named route/model is unavailable, continue with the nearest
same-scope non-browser substitute, record the substitution, and cross-review its output instead of
waiting for approval.

No sub-agent may use a browser, Playwright, Chrome, OpenCLI, or the authenticated browser profile.
The primary Codex orchestrator alone performs every local, staging, authenticated, and live browser
test because it is the reliable browser operator here. Use the Codex in-app browser by default; if
OpenCLI is necessary, profile `cefd9k77` is orchestrator-only. Never inspect or copy session
storage/credentials.

Treat the current production state as NO-GO. Close every P0/P1 item in the finish plan, keep
non-GA surfaces hidden unless their full gates pass, reconcile from the reviewed main-native line
rather than blindly merging the divergent candidate, and preserve the proven Effects registration,
V2 document-head, sync-backoff, transition-preview, trusted-proxy, Worker-attempt and browser-safe
projection fixes. Add regression coverage for every confirmed defect.

Do not mark the goal complete until the same immutable SHA passes two clean release gates, real
PostgreSQL migration/rollback, source-bound orchestrator-only authenticated browser journeys, real
media playback, Effects/Transitions stability and soak, save/reopen/recovery, Motion and Joy Code
round-trips, real Worker verified delivery with passed retained inspection, security/performance/
static-MIME gates, main push, immutable live deployment, origin plus both-domain verification, a
30-minute production canary, numeric observation budgets, and rehearsed
`deploy/joy-media-rollback.sh` proof. Any readiness, source/hash/MIME, authenticated journey,
Worker/inspection, console/page-error, request/query-budget, or canary-5xx failure must immediately
run that rollback script without user input and verify the restored release. Report the exact main
SHA, archive/hash, migration, inspection, canary, public checks and rollback target.

If a genuinely external human-only condition becomes impossible to satisfy, continue every
independent task and exhaust safe alternatives. Mark blocked only after the same blocker persists
across three consecutive goal turns/runs, counting the original occurrence, after all independent
work and safe retries are exhausted. Do not spin indefinitely. Never claim completion from mocked
evidence or because the budget is low.

---
