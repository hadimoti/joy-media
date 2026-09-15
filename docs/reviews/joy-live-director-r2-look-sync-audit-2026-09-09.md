# GAP 1a — project-save contract audit + Look Instances sync scope decision

**2026-09-09, session `joy-media-62`.** Branch `codex/joy-live-director` @ `56e9585c`.
GAP 1a **local persistence is verified** (see
`joy-live-director-r2-gap1a-architecture-2026-09-09.md` + `pnpm -w run check`
green). **Server-sync acceptance is unresolved** — this doc is the evidence for
the owner scope decision the reconciliation now owes.

## 1. The actual server-backed save/reopen contract (verified in code)

| Layer                                                                                       | What it persists                                                                                                                                                                                                                                                     | Source                                                                                                          |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `project_documents` table (`PostgresProjectDocumentStore` / `InMemoryProjectDocumentStore`) | **one document per project revision: the visual creative document** (`JoyProjectV1` — `compositions`/tracks/clips, `visualObjects`, `captionDocuments`, `assets`, `propertyAnimations`, `colorGrade`, `audio`). CAS-revisioned. Validated by `validateJoyProjectV1`. | `apps/api/src/postgres-schema.ts` L62; `apps/api/src/project-document-store.ts` `validateProjectDocumentRecord` |
| Sync (write)                                                                                | `ProjectDocumentAutosync.schedule(binding, session.visualProject, session.projectRevisionId, …)` → debounced `PUT /v1/projects/:id/document` `{ baseRevisionId, revisionId, document }`                                                                              | `apps/editor-web/src/project-document-autosync.ts`; `App.tsx` L1587                                             |
| Reopen (read)                                                                               | `bootstrap` → `hydrateProjectDocument` → `GET /v1/projects/:id/document` → `session.synchronizeVisualProject(remote.document)` replaces the local visual doc                                                                                                         | `App.tsx` L1527; `project-document-hydration.ts`                                                                |
| Gate                                                                                        | fires whenever `joySession.kind === 'ready'` (signed in via email OTP). **No feature flag.**                                                                                                                                                                         | `App.tsx` L1479, L1519, L1585                                                                                   |

**Not server-synced (local browser storage only):** the `SpikeProject` timeline
log, the Dual-Lens graph, the Dual-Lens artifacts, agent-idempotency receipts,
Joy Code threads, the operation ledger, audio state — and, as of GAP 1a, the
**Look Instances document**.

## 2. What survives each scenario

| Component                                                                        | Server reopen (same or other device) | Browser-storage loss (signed in) | Cross-device |
| -------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------- | ------------ |
| Visual creative doc — incl. **the keyframes a Look wrote**                       | ✅ restored from server              | ✅                               | ✅           |
| **Look Instance records** (reopen / adjust / `resetOverrides` / detach metadata) | ❌ local log only                    | ❌ lost                          | ❌ absent    |
| `SpikeProject` timeline log                                                      | ❌ local only                        | ❌                               | ❌           |
| Dual-Lens graph / artifacts (flag off in prod)                                   | ❌ local only                        | ❌                               | ❌           |

## 3. Concrete consequence of the Look Instances gap

1. Apply **Editorial Clean** on device A. The keyframes commit to the visual
   document **and sync to the server**. The `LookInstance` record stays in
   device A's browser only.
2. Open the same project on **device B** (or after clearing device A's site
   data). `hydrateProjectDocument` pulls the server visual doc;
   `synchronizeVisualProject` replaces the local (empty) visual doc with it —
   **keyframes and all**. The look-instances log is untouched and empty.
3. Result: the composition **looks** styled, but the Living Looks panel shows
   **no applied Look**. It cannot be reopened, adjusted, `resetOverrides`'d, or
   cleanly detached. The styling is now "ordinary editable content" — the
   _detach_ outcome, applied **silently and without consent**.
   `orphanedLookInstanceIds` does not even flag it (the record is absent, not
   dangling).

Verified: `hydrateProjectDocument` calls only `synchronizeVisualProject`;
`project-document-hydration.test.ts` explicitly exercises
`document('From another device')`.

## 4. "Saved" indicator

The **main editor has no persistent save-state indicator.** The `cloudSaved`
icon (`ui-icons.ts` L64) is defined but unreferenced; save-state chips exist
only in the `effect-studio` / `motion-studio` sub-shells. The only cloud signals
are error toasts ("Cloud document save failed; retrying… Local edits are safe in
this browser"; "Cloud document changed elsewhere").

→ There is **no false "Looks are saved to the cloud" claim**. But a signed-in
user reasonably assumes cloud backing (there is a cloud-projects system, conflict
toasts, cross-device is the stated design intent), and **nothing tells them Looks
are device-local** while the styling they produce is not.

## 5. Assessment

Server-backed reopen of the visual document is an **existing, live, unflagged,
cross-device-by-design** path that the owner uses on joyst.ir. Look **keyframes**
ride it; Look **Instance records** are omitted from it. Per the owner's standing
instruction ("include the necessary synchronization work in R2 … do not defer it
merely because the server currently lacks storage"), the sync work belongs in
R2 — **unless** the owner makes an explicit scope decision to defer it, because
the fix requires a **production Postgres schema migration** (schema 5 → 6), which
the R2 deploy runbook currently states does not happen.

## 6. Scope decision (owner)

> **Naming note (added 2026-09-09):** the two choices below are labelled
> "Scope choice 1 / 2" to avoid colliding with the separate session-document
> **approach A/B** decision (approach B — the dedicated Look Instances local log —
> stands and is unaffected). Choice 1 is now referred to elsewhere as **"the
> additive server-sync extension"**.

### Scope choice 1 — build the additive server-sync extension in R2 (recommended)

- New nullable `look_instances jsonb` column on `project_documents` (per-revision,
  so it is atomic with the visual doc's existing CAS revision) **or** a sibling
  `project_look_instances` table.
- Extend `PUT /v1/projects/:id/document` and `GET …/document` to carry an
  optional `lookInstances` document alongside `document`.
- `hydrateProjectDocument` applies it via a new
  `session.synchronizeLookInstances(remote.lookInstances)`; `ProjectDocumentAutosync`
  includes `session.lookInstances` in the queued payload (the revision id already
  moves on a Look write via `:looks=N`).
- Touches: `apps/api` (**production DB migration, schema 5 → 6**),
  `postgres-control-plane`, `InMemoryProjectDocumentStore`,
  `project-document-store` validator, `control-plane-client`,
  `project-document-hydration`, `project-document-autosync`, `App.tsx`, + tests
  across `apps/api` + `apps/editor-web`. Est. **~1–1.5 days**.
- Result: Looks are fully cross-device, same as the rest of the creative doc.

### Scope choice 2 — ship R2 with Look Instances local-first + guardrails

- A one-line indicator in the Living Looks panel: **"Looks are saved on this
  device"** (distinct from the cloud-backed visual doc).
- On hydrate, if the incoming visual doc carries keyframes that match no local
  Look Instance's compiled digest, a **non-blocking notice**: "This project was
  last edited elsewhere; applied Looks aren't available here — the styling is
  still present as editable keyframes."
- Documented limitation in the acceptance bundle + an explicit R2.1 line item.
- No production schema change; matches how the timeline / graph / artifacts logs
  already behave.

### Recommendation

**Scope choice 1 (the additive server-sync extension).** The owner ruled "finish
R2 to the approved plan — no apply-only partial release." The plan's L1 line is _"Include instances in session revision,
atomic journal, Undo **and package portability**."_ Package portability is done;
a Look that silently vanishes on the owner's second device is the class of
partial the owner rejected. The cost is a production DB migration on a live
service, so it is the owner's call — hence this doc.

**GAP 1b + 5 (the local host ops — `prepareUpdate` / `detach` / `resetOverrides`

- manual/agent parity) do not depend on this decision and proceed now.**
