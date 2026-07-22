# M-PWI — Project and Worker Result Integration

**Status:** complete (browser/VPS gate passed 2026-07-22) · **Gate to enter:** WP-12 complete · **Master plan:** §8, §26, §27, §35–§36
**Goal:** turn the proven fixture-only Jobs panel into a project-aware editor workflow: each persisted editor project has one owner-scoped control-plane record, and Worker-derived results appear as safe typed records without exposing a local path or source bytes.

## Why this is next

WP-12 proves the security boundary, durable job lifecycle, browser entitlement,
local Worker, and rollback behavior. It intentionally stops at a fixed
`local-editor-project` plus a 14-byte receipt. The next useful vertical slice
is not another transport feature: it is binding that transport to the editor's
actual persisted project identity and making the resulting derivative state
visible to the editor without expanding into uploads, provider jobs, or VPS
rendering.

The WP-12 gate review also found one small UX distinction to preserve: an
editor project that has not yet created its control-plane record is _ready to
initialize_, not unauthenticated or offline. That scoped correction shipped in
the WP-12 closeout static release (`7bb3e93`); WP-13.1 adds its durable
project-binding test coverage.

## Work packages

- [x] **WP-13.1 — Project identity bridge.** A browser-persisted mapping now binds each local editor project ID to one opaque control-plane project ID and title. `App` passes that opaque ID to Jobs; `JobsPanel` creates the record idempotently only when initialized and renders a missing record as ready-to-initialize. Focused tests prove reopen/idempotence, distinct local projects, and malformed-storage recovery; the production browser gate then initialized and reloaded the opaque-bound Local editor project successfully.
- [x] **WP-13.2 — Safe Worker-result projection.** Worker completion still accepts only the fixture receipt (kind, SHA-256, byte count), while the control plane creates a typed `DerivativeRecord` with the job ID, server `verifiedAt`, opaque Worker/result references, and verified receipt metadata. Local and PostgreSQL control planes persist/project it; retry clears it; HTTP/browser types render it as a derivative receipt. Focused local/HTTP/PostgreSQL tests prove the durable shape and assert the response has no path, pairing, session, or browser-token field; the production Worker gate displayed the real projected receipt after API restart/reload.
- [x] **WP-13.3 — Editor job UX.** Jobs has explicit project initialization before queueing, project-scoped thumbnail-derivative labels, and distinct accessible presentation for ready/uninitialized, connected/disconnected/revoked Worker, queued/running/cancel-requested/canceled/failed/completed job, and the verified derivative receipt (hash prefix, byte count, server time). The Jobs panel remains a docked non-primary surface, so no Worker does not block editing. Production browser proof exercised each required state.
- [x] **WP-13.4 — Durable recovery and contract tests.** Focused tests cover reopen → same opaque HTTP history request, pre-initialization wording, Worker presence/revocation, all job-state labels, PostgreSQL completion → restart → receipt projection → retry clearing, and the versioned HTTP cancel/retry/revoke flow. The combined production API restart/editor-reload gate also passed.
- [x] **WP-13.5 — Browser/VPS gate.** Deployed immutable source/API/web release `fa08d29` through X01 with a fresh pre-release PostgreSQL dump. In an entitled browser, initialized the non-fixture-named **Local editor project** bound to an opaque `project-…` ID, paired a fresh outbound Windows Worker, completed a derivative, then stopped it and proved disconnected → queued → canceled → retried → completed. API restart and editor reload retained the same completed 14 B receipt (SHA-256 prefix `78bf4c43aa7a`). The temporary Worker was revoked; console had no warnings/errors; reload network used only JOY identity plus owner `/api/v1/workers` and opaque-project jobs routes. UI computed colors confirm completed green and revoked red. **Deployment correction:** the first raw API-directory copy omitted `pg` and failed before bind; API was immediately restored to `59f1cd2`, then redeployed with `pnpm deploy --legacy --prod`, health green. The retained failed release and the pre-release dump provide rollback evidence.

## Exit criteria

- [x] An editor project can be reopened and shows its own Worker/job history without a hardcoded shared project ID.
- [x] A verified Worker result is represented in editor state without a local path, media bytes, pairing secret, browser assertion, or Worker session.
- [x] Offline, uninitialized, revoked, queued, running, canceled, failed, and completed states are visually distinct and accessible.
- [x] Project/job/result state survives an API restart and the UI reloads it from the owner-scoped record.
- [x] Relevant typecheck, format, unit/HTTP/browser checks pass; known root lint/golden baseline exceptions stay explicit.

## Scope boundaries

- No original-media upload, object storage implementation, provider job, VPS render, or public sharing feature belongs here.
- Do not change JOY identity ownership, token lifetime, CORS, or Worker outbound-only direction; WP-12 has already established those boundaries.
- Do not treat the fixture receipt as a playable proxy. Actual derivative playback belongs to a later, separately scoped media-asset milestone.
