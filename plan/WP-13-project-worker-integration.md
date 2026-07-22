# M-PWI — Project and Worker Result Integration

**Status:** in progress (WP-13.1 locally implemented) · **Gate to enter:** WP-12 complete · **Master plan:** §8, §26, §27, §35–§36
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

- [x] **WP-13.1 — Project identity bridge.** A browser-persisted mapping now binds each local editor project ID to one opaque control-plane project ID and title. `App` passes that opaque ID to Jobs; `JobsPanel` already creates the record idempotently only when a job is submitted and renders a missing record as ready-to-initialize. Focused tests prove reopen/idempotence, distinct local projects, and malformed-storage recovery; editor production build and typecheck pass. **Not yet browser/VPS verified:** a real alternate persisted project or its remote job history; that remains WP-13.5.
- [x] **WP-13.2 — Safe Worker-result projection.** Worker completion still accepts only the fixture receipt (kind, SHA-256, byte count), while the control plane creates a typed `DerivativeRecord` with the job ID, server `verifiedAt`, opaque Worker/result references, and verified receipt metadata. Local and PostgreSQL control planes persist/project it; retry clears it; HTTP/browser types render it as a derivative receipt. Focused local/HTTP/PostgreSQL tests prove the durable shape and assert the response has no path, pairing, session, or browser-token field. **Not yet browser/VPS verified:** this new record on a live Worker; that remains WP-13.5.
- [ ] **WP-13.3 — Editor job UX.** Replace the fixture-only wording with project-scoped action/status affordances: explicit initialization, connected/disconnected/revoked Worker state, queued/progress/cancel/retry, and a visible verified derivative receipt. Maintain keyboard/accessibility labels and keep primary editor work usable when no Worker is connected.
- [ ] **WP-13.4 — Durable recovery and contract tests.** Cover project reopen, API restart, Worker disconnect/revoke, cancel/retry, and receipt projection with unit/HTTP tests. Add a regression for the pre-initialization state so it cannot regress to “offline or not signed in.”
- [ ] **WP-13.5 — Browser/VPS gate.** Deploy through X01, then use an entitled browser and a fresh local Worker to initialize a non-fixture-named test project, queue/cancel/retry one safe derivative job, reload the editor and API, and verify the same result record remains visible. Verify console/network boundaries and revoke the temporary Worker at the end.

## Exit criteria

- [ ] An editor project can be reopened and shows its own Worker/job history without a hardcoded shared project ID.
- [ ] A verified Worker result is represented in editor state without a local path, media bytes, pairing secret, browser assertion, or Worker session.
- [ ] Offline, uninitialized, revoked, queued, running, canceled, failed, and completed states are visually distinct and accessible.
- [ ] Project/job/result state survives an API restart and the UI reloads it from the owner-scoped record.
- [ ] Relevant typecheck, format, unit/HTTP/browser checks pass; known root lint/golden baseline exceptions stay explicit.

## Scope boundaries

- No original-media upload, object storage implementation, provider job, VPS render, or public sharing feature belongs here.
- Do not change JOY identity ownership, token lifetime, CORS, or Worker outbound-only direction; WP-12 has already established those boundaries.
- Do not treat the fixture receipt as a playable proxy. Actual derivative playback belongs to a later, separately scoped media-asset milestone.
