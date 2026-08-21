# P18 — JOY Media Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan. Use
> superpowers:test-driven-development for each product-code task and
> superpowers:verification-before-completion before closing any gate.

**Goal:** Finalize JOY Media as an honest, durable production editor: every visible 1.0 feature
works end to end, real media reaches verified delivery, production workflows survive restart,
provider/privacy/cost choices are auditable, and unfinished expansion surfaces are either completed
for 1.1 or explicitly gated.

**Architecture:** Preserve JOY's existing editor, `EditorSession`, command bus, workflow runtime,
provider SDK, API control plane, outbound Worker, render IR, and Pixi renderer as the canonical
system. Add a shared frame planner, typed Worker delivery, durable production-run records, quality
reports, provider decisions, and evidence-linked intelligence around those contracts. OpenMontage
is clean-room product inspiration only; no OpenMontage code or assets enter the repository.

**Tech Stack:** TypeScript, React 19, Vite, pnpm workspaces, Vitest, browser/webapp testing,
PostgreSQL, FFmpeg/ffprobe, pinned Chromium, Three.js, `ag-psd`, and the existing
`@joy-media/*` packages.

**Spec:** `docs/JOY-MEDIA-FINALIZATION-DESIGN-2026-08-21.md`

## Global constraints

- Preserve the existing dirty worktree. At plan creation it includes a user-deleted logo, untracked
  semantic S1/S2 files, S3 notes, a provider/admin handoff, and `test-output/`. Never reset, clean,
  stash, delete, or overwrite those items as a convenience.
- No OpenMontage source, assets, prompts, schemas, tests, or styling may be copied. Implement the
  approved ideas independently against JOY interfaces.
- A visible production action may not return fixture success. Fixture libraries remain available
  only through explicit test/demo construction.
- Human, agent, workflow, template, PSD, and 3D edits use the existing command/document boundary.
  Cross-domain changes must be crash-consistent and undo as one logical operation.
- Production-run state is operational state outside the undoable project document. Outputs link to
  `CreativeArtifactV2`/asset ids; undoing a project edit does not erase the audit trail.
- The API stores bounded metadata, authorization, hashes, checkpoints, and opaque references. Heavy
  media decoding, inference, rendering, and inspection stay on the local/GPU Worker.
- Never place filesystem paths, original media bytes, provider secrets, OTPs, or unrestricted model
  transcripts in API records, logs, docs, tests, or chat.
- Use tests first. Every task below starts with a failing test or contract assertion, implements the
  minimum production behavior, then runs its focused and dependent suites.
- Commit only the files named by the current task. Suggested commit messages are included for a
  future execution session; this plan-only session does not commit.
- No SSH, VPS mutation, service restart, deploy, or Gbrain write is authorized until Task 38 receives
  explicit owner approval. At that point use the `sweden-vps-ops` skill and the desktop VPS brief.

## Release boundaries and gates

### JOY Studio 1.0 — production editor

1.0 includes Tasks 0–30. It ships only when all of these gates pass:

| Gate               | Required outcome                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 — Evidence      | Root and package tests use one reliable config; accepted S1/S2 files are green; docs distinguish production/demo/experimental.                                  |
| G1 — Real media    | An arbitrary local MP4 can be imported into a blank project, reopened, previewed with real audio/pixels, and supplied to delivery without `/media/reference/*`. |
| G2 — Delivery      | A capability-matched Worker renders the actual project through the shared frame plan; deep inspection proves the declared delivery promise.                     |
| G3 — Production OS | A workflow can park, survive editor/API restart, appear on the Production Board, resume once, and link outputs/decisions/QA.                                    |
| G4 — Intelligence  | Provider decisions, privacy approval, budget, usage, reference findings, B-roll results, and Joy Code critique are evidence-backed and durable.                 |
| G5 — Product       | Always-visible controls work; Motion Studio's visible capabilities are verified; dialogs/keyboard/RTL/design-system checks and auth/security gates pass.        |

The release-blocking 1.0 browser journey is:

```text
new project -> import arbitrary MP4 -> timeline -> Monitor -> run reference-driven workflow
-> park/reload/approve -> apply one compound edit -> Worker render -> deep QA -> Deliver
```

### JOY Studio 1.1 — creative expansion

1.1 includes Tasks 31–37: atomic Templates, PSD import, asset-backed 3D, durable 3D scenes,
approved structured tools, PNG-to-3D, and rendering a 3D scene back into the normal asset/timeline
path. If these tasks are not executed for the 1.0 release, their incomplete controls must be behind
named Experimental flags.

Marketplace payments/transport, realtime collaboration, mobile editing, multi-region operation,
and a general cloud GPU pool remain evidence-gated and are handled by Task 29, not silently promoted
to GA.

## Dependency order

```text
Baseline
  -> real asset loop
  -> shared frame plan
  -> typed Worker render
  -> delivery QA
  -> durable runs/board
  -> provider + job governance
  -> reference/B-roll/workflow packs
  -> 1.0 product/security/release
  -> Templates/PSD/3D 1.1
  -> authorized deployment
```

Do not parallelize tasks that change the same schema or persistence boundary. Safe parallel groups
are called out at the start of each phase.

---

## Phase 0 — Evidence baseline and truthful scope

Tasks 0–2 are sequential. Do not start product changes before G0 is reproducible.

### Task 0 — Repair the monorepo test entrypoints

**Files**

- Modify: `vitest.config.ts`
- Modify: `package.json`
- Modify: `apps/editor-web/package.json`, `apps/api/package.json`, `apps/worker/package.json`,
  `packages/project-schema/package.json`, `packages/workflow-engine/package.json`,
  `packages/provider-sdk/package.json`, `packages/agent-tools/package.json`,
  `packages/export-core/package.json`, and `packages/job-protocol/package.json`

**Red**

1. Run `pnpm --filter @joy-media/project-schema test` and preserve the output showing that package
   cwd/config discovery can collect zero tests.
2. Add a gate that fails if a critical package `test` command exits successfully after collecting
   zero files.

**Green**

1. Give `vitest.config.ts` an explicit monorepo root.
2. Make each critical package script invoke root Vitest with its exact repo-relative source path;
   do not make one package run the entire monorepo.
3. Add root scripts `test:unit`, `test:editor`, `test:api`, `test:worker`, and `test:release` as
   composition points, not alternate configs.

**Verify**

```powershell
pnpm --filter @joy-media/project-schema test
pnpm --filter @joy-media/workflow-engine test
pnpm --filter @joy-media/provider-sdk test
pnpm test
```

**Commit:** `test: make workspace test entrypoints collect intended suites`

### Task 1 — Accept and finish semantic S1/S2

**Files**

- Review/modify: `packages/project-schema/src/semantic-snapshot.ts`
- Review/modify: `packages/project-schema/src/semantic-snapshot.test.ts`
- Review/modify: `packages/project-schema/src/semantic-intelligence.ts`
- Review/modify: `packages/project-schema/src/semantic-intelligence.test.ts`
- Modify: `packages/project-schema/src/index.ts`

**Red**

Reproduce the `getFindingsByEvidence` failure. Add a project-derived snapshot test containing an
asset, clip, caption range, audio facts, and a broken reference, plus JSON round-trip and unknown
evidence-reference tests.

**Green**

1. Fix the test fixture so cloned findings explicitly override `evidenceIds`; do not change correct
   filtering behavior to satisfy a bad fixture.
2. Validate bounded ids/ranges and preserve the distinction between deterministic evidence and
   findings.
3. Export the accepted public types/builders from `packages/project-schema/src/index.ts`.

**Verify**

```powershell
pnpm exec vitest run packages/project-schema/src/semantic-snapshot.test.ts packages/project-schema/src/semantic-intelligence.test.ts
pnpm --filter @joy-media/project-schema build
```

**Commit:** `feat(schema): accept semantic snapshot and intelligence foundations`

### Task 2 — Establish one feature-truth matrix

**Files**

- Modify: `STATE.md`, `DESIGN.md`, `packages/agent-tools/README.md`,
  `packages/workflow-engine/README.md`, `apps/worker/README.md`,
  `docs/JOY-STUDIO-EXPANSION-BRIEF.md`,
  `docs/adr/0023-creative-artifact-and-workflow-schema.md`, and
  `plan/P17-motion-studio-phase-2-7.md`
- Create: `docs/product/FEATURE-STATUS.md`

**Red**

Collect `planned`, `fixture`, `deferred`, `TODO`, `not implemented`, and stale Motion claims from
visible docs/components. Add a docs check that every feature in `FEATURE-STATUS.md` has exactly one
status: `production`, `demo-only`, `experimental`, or `hidden`.

**Green**

1. Record current facts, release boundary, feature flag, and exit gate in the matrix.
2. Mark the expansion brief as a dated snapshot: Three.js, `ag-psd`, Templates, and significant
   Motion work now exist.
3. Mark P17 as historical requirements, not an executable checklist. Current source already has
   resize/rotate, guides, marquee, canvas text editing, grouping, capability-driven inspection,
   keyframe evaluation, basic keyframe rows, and trim controls.
4. Correct ADR claims that artifact/graph commands or `EditorSession` integration are absent.
5. Move operational connection metadata out of product status and refer to secure ops records.

**Verify**

```powershell
pnpm format:check
rg -n "production|demo-only|experimental|hidden" docs/product/FEATURE-STATUS.md
```

**Commit:** `docs: establish audited feature truth for finalization`

---

## Phase 1 — Real media and editor-loop closure

Tasks 3 and 4 may run in parallel after Task 2; Tasks 5 and 6 depend on both.

### Task 3 — Define a first-class playable asset resolver

**Files**

- Modify: `apps/editor-web/src/asset-resolver.ts`
- Modify: `apps/editor-web/src/asset-resolver.test.ts`
- Modify: `apps/editor-web/src/opfs-original-asset-cache.ts`
- Modify: `apps/editor-web/src/opfs-asset-cache.ts`
- Create: `apps/editor-web/src/playable-asset-resolver.test.ts`
- Modify only if a shared DTO is required: `packages/media-core/src/assets.ts` and
  `packages/media-core/src/index.ts`

**Red**

Add tests for OPFS original, verified derivative, authorized private fallback, pending proxy,
revoked authority, missing asset, object-URL release, and a fixture resolver constructible only by
tests/demo bootstrap.

**Green**

1. Add `PlayableAssetRequest` and discriminated `PlayableAssetResolution` (`ready`, `pending`,
   `unavailable`, `revoked`) by extending the existing authorized resolver.
2. Return explicit handles whose object URLs are released on source change/unmount.
3. Keep physical Worker paths private; requests use project/asset/derivative ids only.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/asset-resolver.test.ts apps/editor-web/src/playable-asset-resolver.test.ts
```

**Commit:** `feat(editor): resolve playable originals and derivatives by asset id`

### Task 4 — Repair timeline intake and dead editor controls

**Files**

- Modify: `apps/editor-web/src/TimelinePanel.tsx`
- Modify: `apps/editor-web/src/TimelineEmptyState.tsx`
- Modify: `apps/editor-web/src/AssetLibraryPanel.tsx`
- Modify: `apps/editor-web/src/App.tsx`
- Create: `apps/editor-web/src/timeline-media-intake.test.tsx`
- Create: `apps/editor-web/src/asset-sticker-action.test.tsx`

**Red**

Prove import never dispatches `trackId: ''`, drop consumes the file, Add from library focuses/opens
Assets, ruler-context Add marker creates an undoable marker, Enter/Space activates the empty state,
and Add as sticker calls `onAddSticker`.

**Green**

1. Select/create a compatible track by kind/order; never assume ids are literally `audio`/`video`.
2. Register each file once and insert exactly one clip at the playhead.
3. Route toolbar/context marker actions through one command function.
4. Expose Add as sticker on supported images and retain alpha-preserving binding.
5. Remove the Jobs fixture-thumbnail button from production UI.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/timeline-media-intake.test.tsx apps/editor-web/src/asset-sticker-action.test.tsx apps/editor-web/src/jobs-panel-state.test.ts
```

**Commit:** `fix(editor): close media intake sticker and marker actions`

### Task 5 — Replace reference-fixture playback with real asset handles

**Files**

- Modify: `apps/editor-web/src/App.tsx`
- Modify: `apps/editor-web/src/media-session.ts`
- Modify: `apps/editor-web/src/asset-card-preview.ts`
- Create: `apps/editor-web/src/monitor-media-source.ts`
- Create: `apps/editor-web/src/monitor-media-source.test.ts`
- Modify: `apps/editor-web/src/editor-web-live-gate.test.ts`

**Red**

Test an arbitrary asset id with an OPFS blob and no committed reference filename; Monitor must
receive its blob URL. Add fixture-in-production rejection and stale element/handle cleanup tests.

**Green**

1. Remove `/media/reference/${assetId}.mp4` as production source resolution.
2. Inject the playable resolver into Monitor and export preparation.
3. Keep reference media behind an explicit test-fixture adapter only.
4. Show actionable pending/unavailable/revoked states rather than a blank Monitor.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/monitor-media-source.test.ts apps/editor-web/src/editor-web-live-gate.test.ts
pnpm --filter @joy-media/editor-web build
```

**Commit:** `feat(editor): preview imported media through authorized asset handles`

### Task 6 — Prove the reopened real-media loop in a browser

**Files**

- Create: `apps/editor-web/e2e/real-media-loop.spec.ts`
- Create: `tooling/browser-smoke/package.json`, `tooling/browser-smoke/tsconfig.json`, and
  `tooling/browser-smoke/src/run.ts`
- Add a redistributable MP4 with visual timecode/audible tone under `packages/test-fixtures/media/`
  only if an equivalent fixture is absent

**Red / Green**

Write the journey first: blank project -> import -> exactly one clip -> nonblank changing frames and
audio readiness -> save/reload -> seek -> reopen Assets. Fix only defects exposed by this journey;
never substitute reference URLs.

**Verify**

```powershell
pnpm --filter @joy-media/editor-web build
# Run the repo-local browser command established by this task and capture console output.
```

**Commit:** `test(editor): gate the real media reopen journey`

---

## Phase 2 — Shared render planning, Worker delivery, and QA

Tasks 7–8 are sequential. Tasks 9–10 can then run in parallel; Tasks 11–13 join them.

### Task 7 — Close source-time and determinism semantics

**Files**

- Modify: `packages/evaluator/src/evaluate.ts` and `evaluate.test.ts`
- Modify: `packages/renderer-headless/src/index.ts`
- Create: `packages/renderer-headless/src/determinism.test.ts`
- Review/modify: `packages/timeline-engine/src/index.ts`

**Red**

Add boundary tables for playback rates `0`, `0.5`, `1`, `2`, source in/out, transition overlap,
final frame, and freeze. Add repeated-render tests for seeded noise/grain.

**Green**

1. Make `evaluateFrame` honor `sourceInUs + localTime * playbackRate`.
2. Use one source-time helper across evaluator and frame planning.
3. Replace render-affecting `Math.random()` with a project/frame/effect seed, or reject that effect
   under deterministic delivery.

**Verify**

```powershell
pnpm exec vitest run packages/evaluator/src/evaluate.test.ts packages/renderer-headless/src/determinism.test.ts packages/timeline-engine/src/index.test.ts
```

**Commit:** `fix(render): unify playback rate and seeded determinism`

### Task 8 — Extract the shared render-frame planner

**Files**

- Create: `packages/render-planner/package.json`, `packages/render-planner/tsconfig.json`,
  `packages/render-planner/src/types.ts`, `packages/render-planner/src/plan-frame.ts`,
  `packages/render-planner/src/render-bundle.ts`, `packages/render-planner/src/index.ts`, and
  `packages/render-planner/src/plan-frame.test.ts`
- Modify: `tsconfig.json`, `vitest.config.ts`, dependent package references, and
  `apps/editor-web/src/App.tsx`

**Red**

Test video, still, sticker, HTML scene, caption, effect, transition dual inputs, audio samples,
playback rate/freeze, missing media, and output preset. Each plan must contain `RenderFrameIR`,
required opaque assets, exact source samples, capture requirements, and deterministic findings.

**Green**

1. Define bounded `RenderBundleV1`: timeline/visual snapshots, composition/preset, opaque asset
   descriptors, and seed—never local paths.
2. Extract orchestration from `App.tsx` into pure `planRenderFrame`.
3. Inject bitmap/media acquisition ports; the planner touches no DOM/network/OPFS/filesystem.
4. Make Monitor and browser export request requirements through the planner.

**Verify**

```powershell
pnpm exec vitest run packages/render-planner/src/plan-frame.test.ts apps/editor-web/src/editor-web-live-gate.test.ts
pnpm --filter @joy-media/editor-web build
```

**Commit:** `feat(render): share one frame plan across preview and export`

**Follow-up runtime naming fix — 2026-08-21**

- Restored the `App.tsx` html-scene capture binding by exporting
  `htmlSceneCaptureTargetsForRequirements` as the exact alias of
  `plannedHtmlSceneCaptureTargets` and importing it where preview/export capture paths call it.
- Added a focused regression in `render-plan-capture-targets.test.ts` so the App-facing helper
  name stays wired to the shared planner implementation.
- Verified with:
  `pnpm exec vitest run apps/editor-web/src/render-plan-capture-targets.test.ts`,
  `pnpm exec vitest run packages/render-planner/src/plan-frame.test.ts apps/editor-web/src/editor-web-live-gate.test.ts`,
  and `pnpm --filter @joy-media/editor-web build`.

### Task 9 — Make HTML scenes and transitions delivery-grade

**Files**

- Modify: `apps/editor-web/src/html-scene-surfaces.ts`
- Modify: `packages/html-scene-runtime/src/headless.ts`
- Modify: `packages/visual-object-renderer/src/index.ts`
- Modify: `packages/renderer-headless/src/index.ts`
- Create: `apps/editor-web/src/html-scene-surfaces.test.ts`
- Modify: `packages/html-scene-runtime/src/headless.test.ts` and
  `packages/visual-object-renderer/src/index.test.ts`
- Create: `packages/renderer-headless/src/delivery-transition.test.ts`
- Modify: `tooling/golden-render/src/first-party-scenes.test.ts`

**Red / Green**

Prove delivery never reuses quarter-resolution Monitor captures, dual-texture transitions use both
real inputs, and dimensions come from the preset rather than hard-coded 1080x1920. Use `captureFull`
or render-host full resolution, preserve both transition bitmaps/progress, and bound separate
preview/delivery caches.

**Verify**

```powershell
pnpm exec vitest run packages/html-scene-runtime/src/headless.test.ts packages/renderer-pixi/src/dual-texture.test.ts tooling/golden-render/src/first-party-scenes.test.ts
```

**Commit:** `fix(render): preserve full-resolution scenes and transitions`

**Implementer note — 2026-08-21**

- Reviewer follow-up fixed the release-blocking export retention bug in `App.tsx`: browser export no longer precomputes and retains `totalFrames × sceneCount` full-resolution HTML-scene bitmaps. Delivery scene capture now happens lazily inside `paintFrame`, one requested frame at a time, through `createDeliverySceneFrameSource(...)`.
- `HtmlSceneSurfaceCache` keeps Monitor captures quarter-scale and preview-only, while delivery capture still uses full scene viewport dimensions and destroys each temporary export host after capture.
- Regression proof: `apps/editor-web/src/html-scene-surfaces.test.ts` now asserts delivery capture is lazy and per-request rather than preloaded across the whole export.
- Focused verification completed on 2026-08-21:
  `pnpm exec vitest run apps/editor-web/src/html-scene-surfaces.test.ts packages/html-scene-runtime/src/headless.test.ts packages/renderer-pixi/src/dual-texture.test.ts packages/renderer-headless/src/delivery-transition.test.ts packages/visual-object-renderer/src/index.test.ts tooling/golden-render/src/first-party-scenes.test.ts`
- `pnpm exec prettier --check apps/editor-web/src/App.tsx apps/editor-web/src/html-scene-surfaces.ts apps/editor-web/src/html-scene-surfaces.test.ts` and `git diff --check` passed.
- Root/editor `tsc -b` remains blocked by pre-existing non-Task-9 errors in `AssetLibraryPanel.tsx`, `monitor-media-source*.test.ts`, `render-plan-capture-targets.test.ts`, `timeline-media-intake.test.tsx`, and `TimelinePanel.tsx`; no remaining type errors point at the Task 9 fix files.

### Task 10 — Make Worker jobs a closed typed protocol

**Files**

- Modify: `packages/job-protocol/src/protocol.ts` and `packages/job-protocol/src/index.ts`
- Create: `packages/job-protocol/src/render-jobs.ts` and
  `packages/job-protocol/src/media-analysis-jobs.ts`
- Modify/create: `packages/job-protocol/src/protocol.test.ts`
- Modify: `apps/api/src/control-plane.ts`, `postgres-control-plane.ts`, `http-server.ts`
- Modify: `apps/worker/src/control-plane-client.ts` and `runtime.ts`

**Red**

Prove unknown types cannot enqueue/lease; capability mismatch cannot lease; payloads reject paths,
oversize, and unknown fields; completion requires a type-matched receipt; all Worker-advertised
receipt variants are accepted consistently; idempotent enqueue returns the original job.

**Green**

1. Add versioned `WorkerJobV1` discriminated union and validator.
2. Add first-class `render.export`/`render.inspect` capabilities, payloads, receipts, report refs.
3. Persist bounded payload/requirements/result JSON.
4. Remove broad unknown-job leasing and preserve outbound-only Worker sessions.

**Verify**

```powershell
pnpm exec vitest run packages/job-protocol/src/protocol.test.ts apps/api/src/control-plane.test.ts apps/api/src/postgres-control-plane.test.ts apps/api/src/http-server.test.ts apps/worker/src/runtime.test.ts
```

**Commit:** `feat(jobs): enforce typed capability-matched work and receipts`

### Task 11 — Render the actual project on the Worker

**Files**

- Modify: `apps/worker/src/export-job.ts`, `export-job.test.ts`, and `runtime.ts`
- Create: `apps/worker/src/worker-media-resolver.ts` and
  `apps/worker/src/worker-media-resolver.test.ts`
- Create: `apps/render-host/package.json`, `apps/render-host/tsconfig.json`,
  `apps/render-host/src/protocol.ts`, `apps/render-host/src/render-page.ts`, and
  `apps/render-host/src/index.ts`
- Modify: `apps/render-host/README.md`, `packages/export-core/src/index.ts`, and root
  `tsconfig.json`

**Red**

Use a `RenderBundleV1` with moving video/timecode, sticker, HTML scene, caption, effect, transition,
and audio. Assert Worker export never calls `renderFixture` and refuses missing required assets.

**Green**

1. Activate `apps/render-host` as a pinned offline Chromium page driven locally by Worker; consume
   shared frame plans and existing Pixi/browser rendering.
2. Resolve originals only through Worker-private opaque mappings.
3. Stream frames/audio to FFmpeg rather than buffering a whole project.
4. Return `RenderExportReceiptV1` with opaque result, hash, bytes, manifest, tool versions, no path.
5. Retain `renderFixture` only as an explicitly named test helper.

**Verify**

```powershell
pnpm exec vitest run apps/worker/src/export-job.test.ts apps/worker/src/worker-media-resolver.test.ts apps/worker/src/reference-e2e.test.ts
pnpm --filter @joy-media/render-host build
```

**Commit:** `feat(worker): render real JOY bundles through shared render host`

### Task 12 — Add delivery promises and deep inspection

**Files**

- Create: `packages/production-quality/package.json`, `packages/production-quality/tsconfig.json`,
  `packages/production-quality/src/types.ts`, `packages/production-quality/src/preflight.ts`,
  `packages/production-quality/src/render-inspection.ts`,
  `packages/production-quality/src/index.ts`, `packages/production-quality/src/types.test.ts`,
  `packages/production-quality/src/preflight.test.ts`, and
  `packages/production-quality/src/render-inspection.test.ts`
- Modify: `packages/export-core/src/index.ts`, `apps/worker/src/runtime.ts`, root `tsconfig.json`,
  and `vitest.config.ts`

**Red**

Add good/bad fixtures for wrong duration/frame count/fps/dimensions, missing audio,
silence/clipping, sample rate/channels, black/blank/duplicate spans, missing caption promise, and
invalid deterministic-effect policy.

**Green**

1. Define `DeliveryPromiseV1` and `RenderReportV1` with evidence findings.
2. Implement pure preflight for assets/ranges/overlaps/bindings/captions/audio/dimensions/workflow
   inputs/approval.
3. Add bounded FFmpeg/ffprobe frame/audio/subtitle inspection with sampled and strict modes.
4. Store report facts/hashes/opaque refs only across API.

**Verify**

```powershell
pnpm exec vitest run packages/production-quality/src packages/export-core/src/index.test.ts apps/worker/src/export-job.test.ts
```

**Commit:** `feat(quality): verify project and rendered delivery promises`

### Task 13 — Gate Deliver and show the render report

**Files**

- Modify: `apps/editor-web/src/export-history.ts`, `App.tsx`, `JobsPanel.tsx`, and
  `control-plane-client.ts`
- Create: `apps/editor-web/src/DeliveryReportPanel.tsx` and `delivery-gate.test.tsx`

**Red / Green**

Test pass, warning, blocking failure, authorized waiver with actor/reason, canceled inspection, and
legacy uninspected export. Separate Quick browser export from Verified delivery, link export/inspect
jobs and reports, block Deliver on errors without a recorded waiver, and never label MediaRecorder
output verified by default.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/delivery-gate.test.tsx apps/editor-web/src/export-history.test.ts
```

**Commit:** `feat(editor): gate delivery on evidence-based reports`

---

## Phase 3 — Durable production runs and Production Board

Task 14 defines the contract. Browser and API halves of Task 15 may then be delegated in parallel;
Tasks 16–18 are sequential.

### Task 14 — Add production-run contracts without forking workflow semantics

**Files**

- Create: `packages/workflow-engine/src/production-run.ts`
- Create: `packages/workflow-engine/src/production-run.test.ts`
- Modify: `packages/workflow-engine/src/operations.ts`, `runtime.ts`, and `index.ts`

**Red**

Test queued/running/parked/failed/canceled/succeeded records, monotonic event sequences, bounded
logs/artifacts, JSON round-trip, compare-and-swap checkpoint updates, duplicate approval response,
and projection into a board snapshot.

**Green**

1. Add versioned `ProductionRunRecordV1`, `ProductionRunEventV1`,
   `ProductionApprovalV1`, `ProductionRunAuthority`, and `ProductionRunStore` port.
2. Reuse `RunCheckpoint`, `RunRecorder`, and `RunDashboard`; do not add another executor.
3. Link job/provider/report/artifact ids without embedding private payloads.

**Verify**

```powershell
pnpm exec vitest run packages/workflow-engine/src/production-run.test.ts packages/workflow-engine/src/runtime.test.ts packages/workflow-engine/src/operations.test.ts
```

**Commit:** `feat(workflows): define durable production run records and projections`

### Task 15 — Implement local and PostgreSQL run stores

**Files**

- Create: `apps/editor-web/src/browser-production-run-store.ts` and
  `apps/editor-web/src/browser-production-run-store.test.ts`
- Modify: `apps/api/src/postgres-schema.ts`
- Create: `apps/api/src/production-runs.ts` and `apps/api/src/production-runs.test.ts`
- Modify: `apps/api/src/http-server.ts` and `postgres-control-plane.ts`
- Modify: `apps/editor-web/src/control-plane-client.ts`

**Red**

Test browser reopen, API restart, list pagination, actor/project isolation, event order, revision
conflict, duplicate run key, expired/wrong approval, cancellation, and rejection of paths/raw media/
oversized logs.

**Green**

1. Implement versioned browser persistence for explicitly local/offline runs.
2. Add additive `production_runs`, `production_run_events`, and `production_approvals` tables and
   indexes.
3. Add authenticated create/list/get/respond/cancel routes with optimistic revision checks.
4. Make authority explicit at run creation; never silently merge browser/API histories.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/browser-production-run-store.test.ts apps/api/src/production-runs.test.ts apps/api/src/http-server.test.ts
```

**Commit:** `feat(runs): persist local and control-plane production histories`

### Task 16 — Make workflow park/reload/resume durable

**Files**

- Modify: `apps/editor-web/src/workflow-runner.ts`, `workflow-runner.test.ts`,
  `first-party-handlers.ts`, `WorkflowsPanel.tsx`, and `wp17-first-party-live-gate.test.ts`

**Red**

Test park -> serialize -> new runner -> respond -> resume; completed deterministic nodes do not
rerun; two tabs create one revision conflict; canceled/expired requests cannot resume; playhead
defaults survive; fixture production library cannot be constructed accidentally.

**Green**

1. Replace the in-memory parked-run map with injected `ProductionRunStore`.
2. Persist checkpoint/events before returning a parked result.
3. Split fixture/production node libraries by explicit constructors.
4. Use selected clip and `playheadUs` in workflow input defaults.
5. Unsupported production ports park as unavailable or fail clearly; no synthetic success.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/workflow-runner.test.ts apps/editor-web/src/wp17-first-party-live-gate.test.ts packages/workflow-engine/src/runtime.test.ts
```

**Commit:** `feat(editor): resume parked workflows from durable checkpoints`

### Task 17 — Build the read-oriented Production Board

**Files**

- Create: `apps/editor-web/src/ProductionBoardPanel.tsx` and its component test
- Create: `apps/editor-web/src/production-board-model.ts` and its unit test
- Modify: `apps/editor-web/src/workspace.ts`, `dock-layout.ts`, `App.tsx`, and `app.css`

**Red**

Test empty/loading/error, status groups, sequenced events, approval/retry/cancel availability, stale
revision conflict, artifact/provider/report links, authority badge, and keyboard navigation.

**Green**

1. Render Brief/Input, Scenes/Candidates, Assets/B-roll, Jobs/Providers/Cost, Approvals,
   QA/Delivery, and Events as projections of existing records.
2. Route actions through store/API methods; the panel never executes nodes itself.
3. Link outputs to Assets, `CreativeArtifactV2`, and data-lane views.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/production-board-model.test.ts apps/editor-web/src/ProductionBoardPanel.test.tsx
pnpm --filter @joy-media/editor-web build
```

**Commit:** `feat(editor): add the durable JOY Production Board`

### Task 18 — Add visual contact-sheet approvals

**Files**

- Create: `apps/editor-web/src/ContactSheetApproval.tsx` and
  `apps/editor-web/src/ContactSheetApproval.test.tsx`
- Modify: `apps/editor-web/src/WorkflowsPanel.tsx`, `ProductionBoardPanel.tsx`, and
  `packages/workflow-engine/src/human-input.test.ts`

**Red**

Test thumbnails/time ranges, selection counts, keyboard selection, compare, rejection reason,
approve-none validation, approve-render diff, reload persistence, and response-id binding.

**Green**

1. Render `choose-candidates`/`approve-render` with real asset/thumbnail refs, not title-only
   checkboxes or generic text.
2. Persist exact response and rejection reason in `ProductionApprovalV1`.
3. Keep accepted responses immutable; revision creates a new request.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/ContactSheetApproval.test.tsx packages/workflow-engine/src/human-input.test.ts
```

**Commit:** `feat(workflows): add durable visual candidate approvals`

---

## Phase 4 — Provider, Worker, and approval governance

Tasks 19–20 can run in parallel; Task 21 depends on both.

### Task 19 — Extend provider resolution into an auditable decision ledger

**Files**

- Modify: `packages/provider-sdk/src/types.ts`, `packages/provider-sdk/src/resolution.ts`,
  `packages/provider-sdk/src/provenance.ts`, and `packages/provider-sdk/src/index.ts`
- Create: `packages/provider-sdk/src/decision.ts`, `decision.test.ts`, `budget.ts`, and
  `budget.test.ts`
- Modify: `packages/agent-tools/src/context.ts` and `estimation.ts`
- Create: `packages/agent-tools/src/estimation.test.ts`

**Red**

Test seven-dimension candidate breakdown, hard privacy/capability gates, local-vs-remote choice,
manual-choice tie, unavailable/denied outcomes, reservation cap, partial/final reconciliation,
currency mismatch, and idempotent replay.

**Green**

1. Add `ProviderScoreBreakdownV1`, `ProviderCandidateDecisionV1`, `ProviderDecisionV1`, and budget
   helpers around—without breaking—`resolveProvider`.
2. Record normalized candidate scores/explanations after hard policy gates.
3. Connect agent planning context to configured providers/capabilities/prices instead of an empty
   local-only view.
4. Link decisions to production runs and provider usage.

**Verify**

```powershell
pnpm exec vitest run packages/provider-sdk/src/resolution.test.ts packages/provider-sdk/src/decision.test.ts packages/provider-sdk/src/budget.test.ts packages/agent-tools/src/estimation.test.ts
```

**Commit:** `feat(providers): persist explained decisions and budget reconciliation`

### Task 20 — Fail closed for unfinished adapters and align receipts

**Files**

- Modify: `packages/adapter-voice-isolation/src/index.ts` and
  `packages/adapter-voice-isolation/src/index.test.ts`
- Modify: `packages/adapter-tts/src/index.ts`
- Create: `packages/adapter-tts/src/production-mode.test.ts`
- Modify: `apps/worker/src/local-gpu.ts`, `runtime.ts`, and `apps/api/src/http-server.ts`

**Red**

Prove copy-through voice isolation, sine TTS, identity Comfy, solid PNG fallback, and mismatched
text/image/video receipts all fail outside an explicit fixture constructor.

**Green**

1. Separate fixture adapters from production adapters at construction/registration.
2. Return typed unavailable for unwired engines/unsupported outputs.
3. Carry caller idempotency/decision ids through provenance.
4. Ensure every Worker-advertised AI type has matching API payload/lease/receipt validation.

**Verify**

```powershell
pnpm exec vitest run packages/adapter-voice-isolation/src packages/adapter-tts/src apps/worker/src/runtime.test.ts apps/api/src/http-server.test.ts
```

**Commit:** `fix(providers): remove fixture success from production adapters`

### Task 21 — Apply one approval/preflight contract to every remote/spend route

**Files**

- Modify: `packages/provider-sdk/src/privacy.ts`, `packages/agent-tools/src/approval.ts`,
  `apps/api/src/mistral-provider.ts`, `speech-synthesize.ts`, `spectral-denoise.ts`, and
  `http-server.ts`
- Create: `apps/api/src/provider-approval.ts` and `apps/api/src/provider-approval.test.ts`

**Red**

Test no-egress denial; approval bound to actor/request digest/provider/capability/expiry/cost cap;
cross-prompt/provider replay rejection; expired grant; denied audit row; idempotent approved retry;
and Edge TTS requiring remote approval.

**Green**

1. Generalize Mistral's preflight into a shared API service.
2. Reserve budget before egress and reconcile afterward.
3. Persist denied/unavailable/failed/succeeded decisions without raw prompts/secrets.
4. Surface approval-required state to workflows, Joy Code, and Board.

**Verify**

```powershell
pnpm exec vitest run apps/api/src/provider-approval.test.ts apps/api/src/speech-synthesize.test.ts apps/api/src/http-server.test.ts packages/provider-sdk/src/privacy.test.ts
```

**Commit:** `feat(api): enforce shared provider privacy spend approvals`

---

## Phase 5 — Evidence-linked intelligence and real pipeline packs

Tasks 22–23 can run in parallel. Task 24 depends on both; Tasks 25–26 use their results.

### Task 22 — Implement bounded S3 creative briefs

**Files**

- Review notes: `packages/agent-tools/src/S3-IMPLEMENTATION-NOTE.md` and
  `S3-IMPLEMENTATION-SUMMARY.md`
- Create: `packages/agent-tools/src/creative-brief.ts`, `creative-brief.test.ts`,
  `model-adapter.ts`, and `model-adapter.test.ts`
- Modify: `packages/agent-tools/src/index.ts`

**Red**

Test valid brief, unresolved evidence, missing snapshot, malformed/oversized model output,
deterministic fake modes, fact/inference separation, Persian/RTL preservation, and no command/
project mutation surface.

**Green**

1. Define `CreativeBriefRequestV1`, `CreativeBriefV1`, and a narrow structured model port.
2. Require every recommendation to cite S1 evidence and bounded ranges.
3. Keep it read-only; edit conversion later uses plan/dry-run/approval.

**Verify**

```powershell
pnpm exec vitest run packages/agent-tools/src/creative-brief.test.ts packages/agent-tools/src/model-adapter.test.ts
```

**Commit:** `feat(agent): create evidence-bounded read-only creative briefs`

### Task 23 — Add reference-video evidence jobs

**Files**

- Extend: `packages/job-protocol/src/media-analysis-jobs.ts`
- Create: `apps/worker/src/reference-analysis.ts` and
  `apps/worker/src/reference-analysis.test.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/editor-web/src/AssetLibraryPanel.tsx` and `ProductionBoardPanel.tsx`
- Create: `apps/editor-web/src/reference-analysis-model.test.ts`

**Red**

Use a redistributable video to assert shot/time ranges, cut rhythm, palette/composition samples,
text/safe-zone evidence, transcript/audio beats, cancellation, size/duration bounds, and no model
finding without evidence.

**Green**

1. Add typed `video.reference-analyze` payload/receipt and capability.
2. Produce deterministic evidence first; optional model analysis is a separate decision.
3. Persist a `CreativeArtifactV2` with source hash/provenance/evidence ids.
4. Add Mark as Reference/run/view affordances.

**Verify**

```powershell
pnpm exec vitest run apps/worker/src/reference-analysis.test.ts apps/editor-web/src/reference-analysis-model.test.ts
```

**Commit:** `feat(reference): analyze videos into bounded creative evidence`

### Task 24 — Build semantic B-roll indexing and search

**Files**

- Modify: `packages/project-schema/src/semantic-snapshot.ts` and `semantic-intelligence.ts`
- Create: `packages/agent-tools/src/broll-search.ts` and
  `packages/agent-tools/src/broll-search.test.ts`
- Extend: `packages/job-protocol/src/media-analysis-jobs.ts`
- Create: `apps/worker/src/semantic-index.ts` and `apps/worker/src/semantic-index.test.ts`
- Modify: `apps/editor-web/src/AssetLibraryPanel.tsx`

**Red**

Test asset shot/caption/audio evidence, deterministic filters, time-ranged results, unused-asset
ranking, privacy-gated reranking, missing evidence rejection, and an insertion proposal that cannot
mutate before approval.

**Green**

1. Add `media.semantic-index` job/evidence.
2. Implement metadata/text/range search first.
3. Make embeddings/rerank optional and approval-gated; preserve base evidence/explanations.
4. Convert selection to a dry-run timeline plan through agent tools.

**Verify**

```powershell
pnpm exec vitest run packages/agent-tools/src/broll-search.test.ts apps/worker/src/semantic-index.test.ts packages/project-schema/src/semantic-intelligence.test.ts
```

**Commit:** `feat(agent): search B-roll with evidence-linked ranges`

### Task 25 — Replace visible fixture workflows with production pipeline packs

**Files**

- Modify: `packages/workflow-engine/src/first-party.ts`, `first-party.test.ts`, and `library.ts`
- Modify: `apps/editor-web/src/first-party-handlers.ts`, `first-party-workflows.ts`, and
  `WorkflowsPanel.tsx`
- Create: `docs/workflows/PIPELINE-PACKS.md`

**Red**

For long-video draft reels, multilingual promo, and podcast cleanup, test version/ports/
capabilities, unavailable-port failure, cost approval, restart resume, artifacts, one compound
apply, render, and inspect. Add tests for clean-room reference-driven social cutdown and interview/
documentary assembly packs.

**Green**

1. Version packs and declare required/optional ports/capabilities.
2. Bind real API/Worker/provider ports; keep fixtures in labelled demo registry.
3. Add contact-sheet, cost confirmation, render, inspect, and delivery manifest stages.
4. Route editor outputs through shared commands/artifacts after approval.

**Verify**

```powershell
pnpm exec vitest run packages/workflow-engine/src/first-party.test.ts apps/editor-web/src/wp17-first-party-live-gate.test.ts apps/editor-web/src/workflow-runner.test.ts
```

**Commit:** `feat(workflows): ship versioned production pipeline packs`

### Task 26 — Connect bounded Mistral/Joy Code reasoning

**Files**

- Modify: `packages/adapter-mistral/src/index.ts`, `apps/api/src/mistral-provider.ts`,
  `apps/api/src/http-server.ts`, `apps/editor-web/src/AgentSettingsDialog.tsx`,
  `AgentPanel.tsx`, and `agent-panel-intents.ts`
- Create: `apps/editor-web/src/joy-code-critique.test.tsx`

**Red**

Test unconfigured/denied/approved/replayed provider requests, malformed structured output,
evidence-link validation, read-only critique with unchanged revision, and proposed edits that remain
dry-run until approval and undo as one transaction.

**Green**

1. Add a bounded API operation accepting snapshot digest/evidence, goal, settings, idempotency key.
2. Keep credentials/system prompts server-side.
3. Display provider/model/privacy/estimate/usage and link decision/brief to Board.
4. Treat free-form edit as critique/proposal; mutation stays in agent command envelopes.

**Verify**

```powershell
pnpm exec vitest run packages/adapter-mistral/src apps/api/src/http-server.test.ts apps/editor-web/src/joy-code-critique.test.tsx
```

**Commit:** `feat(joy-code): add bounded evidence-backed reasoning`

---

## Phase 6 — 1.0 product, Motion, accessibility, security, and release

Tasks 27–29 can run in parallel after core flows stabilize. Task 30 is the 1.0 gate.

### Task 27 — Certify current Motion Studio and close only remaining seams

**Files**

- Create: `apps/editor-web/src/motion-studio/MotionStudioCanvas.test.tsx`,
  `apps/editor-web/src/motion-studio/MotionStudioInspector.test.tsx`,
  `apps/editor-web/src/motion-studio/MotionStudioTimeline.test.tsx`, and
  `apps/editor-web/src/motion-studio/state/useSceneEditor.test.ts`
- Modify as failing tests require: those files and `packages/motion-core/src/evaluator.ts`
- Modify: `apps/editor-web/src/motion-studio/MotionStudioShell.tsx`,
  `apps/editor-web/src/motion-studio/state/layerFactory.ts`, and
  `apps/editor-web/src/motion-studio/state/motionCapabilities.ts`
- Modify: `packages/project-schema/src/v1.ts`, `packages/property-system/src/index.ts`,
  `packages/visual-object-renderer/src/index.ts`, and `apps/editor-web/src/App.tsx`

**Red**

1. First certify already-present resize/rotate, snap/guides, group drag, marquee, nudge, canvas text,
   context actions, scene dimensions/duration, mixed multi-select inspection, evaluator, basic
   keyframes/easing, trim, image/video/group behavior, and one undo per interaction.
2. Then add failing tests for actual residuals: inspector keyframe buttons/autokey; keyframe move,
   multi-selection, copy/paste, and snapping; real asset routing (no `/api/assets/{id}`); SVG import truth;
   read-only code placeholder, and Motion Scene main-timeline placement.

**Green**

1. Fix certification defects; do not rebuild implemented P17 interactions.
2. Wire remaining keyframe/asset controls through existing command transactions.
3. Hide code/graph/advanced placeholders or implement them with validation/tests.
4. Add `motion-scene` schema/commands/render branch and publish -> place path.
5. Preview, Worker render, save/reopen, and undo must support the placed scene.

**Verify**

```powershell
pnpm exec vitest run packages/motion-core/src apps/editor-web/src/motion-studio packages/property-system/src/index.test.ts packages/visual-object-renderer/src/e2e.test.ts
pnpm --filter @joy-media/editor-web build
```

Browser journey: create motion -> manipulate -> animate -> publish -> place -> preview -> undo/
redo -> reopen -> verified export.

**Commit:** `feat(motion): certify and close production Motion Studio seams`

### Task 28 — Finish accessibility, localization, design, and destructive-copy truth

**Files**

- Modify: `apps/editor-web/src/ProjectLibrary.tsx`, `TimelineEmptyState.tsx`,
  `AssetLibraryPanel.tsx`, `WorkflowsPanel.tsx`, `AgentPanel.tsx`, `JobsPanel.tsx`,
  `SpecialistReviewPanel.tsx`, `App.tsx`, and `app.css`
- Modify: `DESIGN.md`
- Create: `apps/editor-web/src/finalization-a11y.test.tsx`

**Red**

Test dialog initial focus/trap/Escape/return, icon labels, keyboard paths, RTL/Persian copy matrix,
contrast, empty/loading/error states, and Project Library's “Delete” action that currently removes
only a catalog entry.

**Green**

1. Add proper dialog behavior to workflow, assets, shortcuts, Monitor, and approvals.
2. Rename catalog-only removal to Remove from library, or implement a separately confirmed full
   persisted-project delete.
3. Apply the approved Persian/RTL matrix or amend contradictory docs.
4. Move component colors to tokens or revise the overly strict DESIGN rule explicitly.
5. Correct stale comments such as SpecialistReview claiming timeline apply is separate.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/finalization-a11y.test.tsx apps/editor-web/src/PanelShell.test.tsx apps/editor-web/src/graph-traversal.test.ts
pnpm lint
```

Run axe/keyboard smoke over Project Library, Assets, Timeline, Workflows, Production Board, Joy
Code, Jobs, and Specialist Review.

**Commit:** `fix(ui): close accessibility RTL and design-system gaps`

### Task 29 — Harden auth and gate non-GA platform surfaces

**Files**

- Modify: `apps/api/src/media-auth.ts`, `media-auth.test.ts`, and `postgres-schema.ts`
- Modify: `apps/editor-web/src/plugin-host.ts` and collaboration/marketplace registration points
  discovered from `workspace.ts`
- Modify: `docs/product/FEATURE-STATUS.md`
- Create: `docs/security/README.md`

**Red**

Test OTP throttle across service reconstruction/shared store, keyed OTP/session digests, key
rotation, unchanged anti-enumeration behavior, session revoke/expiry, Experimental default-off, and
no incomplete marketplace/collaboration CTA in GA layout.

**Green**

1. Move OTP throttle state to PostgreSQL/shared durable storage.
2. Use keyed hashing with rotation-aware secret ids and migration.
3. Keep plugin safety foundations, but gate non-durable commerce/collaboration transport until a
   separate evidence-backed program.
4. Document threat boundaries without operational secrets.

**Verify**

```powershell
pnpm exec vitest run apps/api/src/media-auth.test.ts packages/plugin-sdk/src packages/collaboration-core/src
```

**Commit:** `fix(security): harden auth and gate unfinished transports`

### Task 30 — Build the 1.0 release gate and prove all journeys

**Files**

- Modify: `.github/workflows/ci.yml` and root `package.json`
- Create: `tooling/release/package.json`, `tooling/release/src/gate.ts`, and
  `tooling/release/src/gate.test.ts`
- Modify: `tooling/release/README.md` and root `tsconfig.json`
- Modify: `README.md`, `apps/editor-web/README.md`, `apps/api/README.md`,
  `apps/worker/README.md`, `deploy/README.md`, and `STATE.md`
- Create: `docs/releases/JOY-STUDIO-1.0-CHECKLIST.md`

**Red**

Make the gate fail on zero tests, dirty generated artifacts, fixture handlers in production
registries, missing builds/manifest/SBOM, unverified browser journeys, or stale feature status.

**Green**

1. Add one non-deploying command for typecheck/lint/format/tests/builds/goldens/browser journeys,
   producing machine-readable results, artifact hashes, and SBOM/manifest.
2. Make CI upload reports/browser/golden evidence.
3. Document setup, Worker pairing, production/demo/experimental scope, backup, deploy prerequisites,
   and rollback.

**Verify**

```powershell
pnpm check
pnpm --filter @joy-media/editor-web build
pnpm --filter @joy-media/api build
pnpm --filter @joy-media/worker build
pnpm test:release
```

Run the complete 1.0 browser journey. A waiver requires named owner, reason, and expiry and cannot
cover the real-media, actual-render, persistence, privacy, or auth gates.

**Commit:** `build(release): add reproducible JOY Studio 1.0 gates`

---

## Phase 7 — 1.1 Templates and PSD

Tasks 31–32 are sequential because PSD application uses the compound transaction closure.

### Task 31 — Make content templates crash-consistent and complete the surface

**Files**

- Modify: `apps/editor-web/src/content-template-transaction.ts` and
  `apps/editor-web/src/content-template-transaction.test.ts`
- Modify: `apps/editor-web/src/editor-session.ts` and `editor-session.test.ts`
- Modify: `apps/editor-web/src/TemplatesPanel.tsx`, `template-catalog.ts`, and
  `content-template-catalog.ts`
- Create: `apps/editor-web/src/TemplatesPanel.test.tsx`

**Red**

Test one history entry, total rollback on injected failure, undo/redo of clips/objects/bindings,
deterministic caller-supplied seed, list/search/filter/loading/error, duplicate/delete, and save
current selection as Mine.

**Green**

1. Extend/use `EditorSession.dispatchCompound` so all domains validate before durable write and
   commit as one logical item.
2. Remove `Date.now()` from transaction identity; UI creates an explicit operation id.
3. Complete discoverable Templates states and RTL-safe copy.
4. Keep first-party payloads grounded in existing HTML scenes until new payload types pass the same
   transaction contract.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/content-template-transaction.test.ts apps/editor-web/src/TemplatesPanel.test.tsx apps/editor-web/src/editor-session.test.ts
```

**Commit:** `feat(templates): apply and manage templates atomically`

### Task 32 — Promote PSD parsing into a bounded import workflow

**Files**

- Rename/replace: `apps/editor-web/src/psd-parser-spike.ts` -> `psd-import.ts`
- Create: `apps/editor-web/src/psd-import.test.ts`,
  `apps/editor-web/src/PsdImportDialog.tsx`, and
  `apps/editor-web/src/PsdImportDialog.test.tsx`
- Modify: `apps/editor-web/src/TemplatesPanel.tsx`, `AssetLibraryPanel.tsx`,
  `opfs-original-asset-cache.ts`, and `control-plane-client.ts`
- Add bounded redistributable fixtures under `apps/editor-web/src/fixtures/psd/`

**Red**

Test structure-first size/memory rejection, raster extraction, text/groups, unsupported adjustment/
smart-object warnings, Persian names, asset hash/registration, mapping, one compound apply/undo, and
save/reopen.

**Green**

1. Keep `ag-psd`; remove debug logs and use typed user-safe failures.
2. Register source PSD and selected rasters as opaque assets with real hashes/bytes.
3. Offer `image-object`, safe `text-object`, `flatten-group`, and `ignore` with fidelity report.
4. Apply through Task 31 compound boundary.
5. State non-goals: smart-object editing, complete layer styles/text fidelity, PSD round trip.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/psd-import.test.ts apps/editor-web/src/PsdImportDialog.test.tsx apps/editor-web/src/content-template-transaction.test.ts
```

Browser journey: import -> map -> apply -> undo/redo -> reopen.

**Commit:** `feat(psd): import bounded layered designs as JOY assets`

---

## Phase 8 — 1.1 asset-backed 3D and approved structured tools

Tasks 33–34 can run in parallel. Task 35 joins them; Tasks 36–37 are sequential.

### Task 33 — Add durable `scene3d-core`

**Files**

- Create: `packages/scene3d-core/package.json`, `packages/scene3d-core/tsconfig.json`,
  `packages/scene3d-core/src/scene.ts`, `packages/scene3d-core/src/validation.ts`,
  `packages/scene3d-core/src/commands.ts`, `packages/scene3d-core/src/index.ts`,
  `packages/scene3d-core/src/scene.test.ts`, `packages/scene3d-core/src/validation.test.ts`, and
  `packages/scene3d-core/src/commands.test.ts`
- Modify: `tsconfig.json` and `vitest.config.ts`

**Red**

Test JSON round-trip/migration, hierarchy cycles, missing model assets, invalid transforms/materials,
camera/light/environment validation, command inverses, multi-command atomicity, and deleting active
camera/parent.

**Green**

Define `Scene3DDocumentV1` with hierarchy, transforms, model/primitive/light/camera payloads,
materials, environment, active camera, duration, schema version, and opaque asset refs. Keep it
separate from 2D `MotionSceneDocument`.

**Verify**

```powershell
pnpm exec vitest run packages/scene3d-core/src
pnpm --filter @joy-media/scene3d-core build
```

**Commit:** `feat(3d): add durable scene schema validation and commands`

### Task 34 — Make the Joy Code 3D viewer asset-backed

**Files**

- Modify: `apps/editor-web/src/JoyCode3DViewer.tsx` and `AgentPanel.tsx`
- Create: `apps/editor-web/src/JoyCode3DViewer.test.tsx`
- Modify: existing API/editor asset content-type DTOs and
  `apps/editor-web/src/opfs-original-asset-cache.ts`

**Red**

Test GLB/GLTF types, asset selection, OPFS/private resolution, loading/progress/error/unsupported/
context-loss, stale load cancellation, GPU disposal, and a nonblank WebGL fixture.

**Green**

1. Load by asset id/resolver handle, not an unregistered file list.
2. Register manual GLB/GLTF through normal Assets.
3. Show Joy Code 3D only with honest asset-backed content/empty state.
4. Dispose geometry/material/control/URL/frame/observer/WebGL resources predictably.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/JoyCode3DViewer.test.tsx
```

Run nonblank-pixel and repeated open/close GPU cleanup checks.

**Commit:** `feat(joy-code): preview registered 3D assets safely`

### Task 35 — Build fullscreen 3D Studio on the scene command boundary

**Files**

- Create: `apps/editor-web/src/three-d-studio/ThreeDStudioShell.tsx`,
  `apps/editor-web/src/three-d-studio/ThreeDStudioCanvas.tsx`,
  `apps/editor-web/src/three-d-studio/ThreeDStudioHierarchy.tsx`,
  `apps/editor-web/src/three-d-studio/ThreeDStudioInspector.tsx`,
  `apps/editor-web/src/three-d-studio/ThreeDStudioChat.tsx`,
  `apps/editor-web/src/three-d-studio/state/useThreeDSceneEditor.ts`,
  `apps/editor-web/src/three-d-studio/ThreeDStudioShell.test.tsx`,
  `apps/editor-web/src/three-d-studio/ThreeDStudioCanvas.test.tsx`, and
  `apps/editor-web/src/three-d-studio/state/useThreeDSceneEditor.test.ts`
- Create: `apps/editor-web/src/scene3d-catalog.ts`
- Modify: `apps/editor-web/src/App.tsx` and `app.css`

**Red**

Test create/load/autosave/reopen, hierarchy select/reparent cycle rejection, orbit, import,
transform/material, camera/light, undo/redo, context cleanup, keyboard/dialog, and failure recovery.

**Green**

1. Mirror Motion/Effect overlay lifecycle with a separate scene persistence domain.
2. Use Three.js only for viewport; mutations use `scene3d-core` commands.
3. Keep chat a proposal surface until Task 36.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/three-d-studio
pnpm --filter @joy-media/editor-web build
```

Browser journey: create -> GLB -> orbit -> transform -> undo -> save -> close -> reopen.

**Commit:** `feat(3d): add durable fullscreen JOY 3D Studio`

### Task 36 — Expose structured 3D tools through approval, not raw authority

**Files**

- Create: `packages/scene3d-core/src/tools.ts` and its test
- Modify: `packages/agent-tools/src/registry.ts` and `types.ts`
- Create: `packages/agent-tools/src/scene3d-tools.test.ts`
- Modify: `apps/editor-web/src/three-d-studio/ThreeDStudioChat.tsx`
- Create: `apps/mcp-server/package.json`, `apps/mcp-server/tsconfig.json`,
  `apps/mcp-server/src/server.ts`, `apps/mcp-server/src/joy-tools.ts`,
  `apps/mcp-server/src/server.test.ts`, and `apps/mcp-server/src/joy-tools.test.ts`
- Modify: root `tsconfig.json`

**Red**

Test schemas for read tools (summary/assets/scene/selection) and write tools (add/transform/material/
remove/camera), dry-run diff, approval binding, atomic apply/undo, stale revision, and rejection of
filesystem/shell/env/arbitrary URL access.

**Green**

1. Implement tools as thin scene query/command adapters.
2. Route writes through agent plan, policy, approval, audit, idempotency.
3. Expose the same allow-list over a local stdio MCP server for the KiloCode host; bind every
   session to actor/project/scene and never expose an unauthenticated public HTTP route.

**Verify**

```powershell
pnpm exec vitest run packages/scene3d-core/src/tools.test.ts packages/agent-tools/src/scene3d-tools.test.ts
```

Mocked chat: propose add/move -> inspect dry run -> approve -> undo.

**Commit:** `feat(agent): add approval-bound structured 3D tools`

### Task 37 — Add gated PNG-to-3D and render 3D back into JOY media

**Files**

- Modify: `packages/provider-sdk/src/types.ts`
- Create: `packages/job-protocol/src/scene3d-jobs.ts` and
  `packages/job-protocol/src/scene3d-jobs.test.ts`
- Create: `packages/adapter-mesh-generation/package.json`,
  `packages/adapter-mesh-generation/tsconfig.json`,
  `packages/adapter-mesh-generation/src/index.ts`, and
  `packages/adapter-mesh-generation/src/index.test.ts`; its production provider is enabled only
  after the benchmark/terms/privacy gate
- Modify: `apps/worker/src/runtime.ts`
- Create: `apps/worker/src/scene3d-jobs.ts` and `apps/worker/src/scene3d-jobs.test.ts`
- Modify: `apps/api/src/http-server.ts`, `apps/editor-web/src/JobsPanel.tsx`, and
  `apps/editor-web/src/three-d-studio/ThreeDStudioChat.tsx`/`ThreeDStudioShell.tsx`

**Red**

Test provider unavailable, no-egress denial, bounded PNG, capability lease, cancellation/retry/
idempotency, GLB validation, provenance/source hash, preview, and `scene3d.render` producing an
opaque media asset accepted by ordinary timeline/delivery.

**Green**

1. Add typed `mesh.from-image` and `scene3d.render` jobs/receipts.
2. Implement and enable one `adapter-mesh-generation` provider only after documented quality,
   commercial-use, network, latency, and cost thresholds; otherwise its production constructor
   returns honestly unavailable and 1.1 cannot claim PNG-to-3D complete.
3. Require provider/spend approval and attach bounded provenance.
4. Validate GLB before registration.
5. Render scene to media, register output, and use normal 2D asset/timeline/render/QA.

**Verify**

```powershell
pnpm exec vitest run packages/job-protocol/src/scene3d-jobs.test.ts apps/worker/src/scene3d-jobs.test.ts packages/provider-sdk/src
```

Browser journey: PNG -> approval -> GLB -> scene -> approved edit -> render -> timeline -> verified
export. Also prove honest no-provider behavior.

**Commit:** `feat(3d): generate and render provenance-linked 3D assets`

---

## Phase 9 — Final verification, authorized deployment, and rollback

### Task 38 — Verify locally, then deploy only with explicit authorization

**Files**

- Modify only if verification finds doc/config drift: release checklists, `deploy/*`, and `STATE.md`
- Do not edit product source during deploy; return failures to their owning task

**Local verification**

1. Invoke `superpowers:verification-before-completion`.
2. Run Task 30's full command from a clean execution worktree/checkout while preserving the owner's
   dirty tree.
3. Run the 1.0 journey; if 1.1 is included, run PSD/3D journeys.
4. Review manifest/SBOM, fixture-registry scan, security report, browser console, render reports,
   and rollback rehearsal.

**Authorized deployment**

Only after explicit owner approval:

1. Invoke `sweden-vps-ops` and read the current VPS brief.
2. Confirm canonical source, branch, exact commit, clean deploy target, backups, rollback.
3. Build once locally and promote the same verified artifacts.
4. Apply additive DB schema before switching API/web artifacts.
5. Run service health and authoritative production-origin checks.
6. Run `nginx -t` before reload if Nginx changes.
7. Roll back on any blocking origin/journey failure.
8. Record paths, commit/artifact hashes, evidence, and rollback in approved ops memory without
   secrets.

**Verify**

- API service healthy; app/API origin routes pass.
- OTP login, project load, Worker heartbeat, one safe job, and report listing pass.
- Prior release remains recoverable by rehearsed rollback.

**Commit:** Deployment creates no extra source commit; deploy the already verified candidate.

---

## Completion definition

P18 is complete only when:

- test entrypoints cannot pass after collecting zero tests;
- arbitrary imported media completes real preview/reopen/Worker-delivery/QA;
- shared planning prevents preview/delivery timing or media divergence;
- Worker jobs are closed typed contracts;
- runs, approvals, jobs, provider decisions, budgets, artifacts, and reports survive restart and are
  visible on the Production Board;
- reference analysis, B-roll, and Joy Code cite bounded evidence;
- production registries cannot return fixture success;
- all visible 1.0 controls—including current Motion Studio—work or are explicitly gated;
- auth, egress, spend, accessibility, RTL, performance, and release gates pass;
- Templates/PSD/3D either pass 1.1 journeys or remain honestly gated from 1.0; and
- any live deployment was separately authorized, verified at origin, documented, and rollback-safe.
