# JOY Media Finalization Design

Date: 2026-08-21
Status: approved direction for execution planning
Scope: local repository planning only; no VPS mutation, no source code change, no provider credentials.

## Decision

Finalize JOY Media by converging on the systems already present in the repo:

- The typed timeline, visual-object document, command bus, `EditorSession`, workflow engine, provider SDK, API, and Worker remain canonical.
- OpenMontage is used only as clean-room product inspiration. Do not copy AGPL code, assets, text, schemas, or tests.
- The best OpenMontage-inspired ideas to bring into JOY Media are a durable production board, quality gates before and after render, reference-video analysis, semantic B-roll search, provider decision/cost visibility, and workflow packs.
- Templates, PSD import, and 3D are real JOY Studio expansion tracks, but they should not block a professional 1.0 unless explicitly visible in the product.

## What "finalized" means

JOY Media is finalized when every visible, in-scope surface is either:

1. End-to-end functional with durable state, undo/retry/approval behavior where expected, tests, and release documentation.
2. Hidden behind an explicit experimental flag with honest copy and no fake success path.
3. Removed from the visible UI if it is only a placeholder.

No demo fixture, deferred stub, localStorage-only critical run state, or README promise should appear to be a production feature.

## Architecture shape

The final architecture is a production OS layered on the current editor:

```text
Editor UI
  -> EditorSession command boundaries
  -> Project schema, artifacts, workflow graph
  -> Workflow runtime and production run records
  -> Provider SDK and cost/decision ledger
  -> API control plane
  -> Local/GPU Worker for heavy media jobs
  -> Render/export and QA reports
```

The browser editor stays the main product. The VPS API remains a control plane. Heavy inference, render inspection, B-roll indexing, reference analysis, image generation, audio denoise, and future image-to-3D jobs stay on the Worker or approved provider adapters, not inside the VPS API process.

## Current strengths to preserve

- `apps/editor-web/src/editor-session.ts` already coordinates timeline, visual-object, graph, artifact, and compound edits with undo/redo.
- `packages/workflow-engine/src/runtime.ts` already supports checkpoints, deterministic run keys, resume, cancellation, and human input parking.
- `packages/workflow-engine/src/operations.ts` already has run logs, artifacts, and dashboard JSON.
- `packages/provider-sdk/src/*` already has capability contracts, privacy preflight, lifecycle, provenance, cost aggregation, and provider resolution.
- `packages/adapter-mistral/src/index.ts` and `apps/api/src/mistral-provider.ts` provide a first remote LLM adapter with idempotency, privacy mode checks, and a server ledger.
- `apps/editor-web/src/TemplatesPanel.tsx`, `content-template-*`, `psd-parser-spike.ts`, and `JoyCode3DViewer.tsx` show that Templates, PSD, and 3D are already started.
- Motion Studio source already contains considerably more than its historical P17 checklist:
  resize/rotate, snapping guides, marquee and multi-selection, canvas text editing, context actions,
  grouping, a capability registry, editable scene dimensions/duration, keyframe evaluation, basic
  keyframe rows/easing, trim controls, and image/video/group layer foundations.

## Primary gaps

1. Evidence baseline and hygiene:
   - Root tests work, but package-filter test scripts can fail with "No test files found".
   - One untracked semantic intelligence test fixture is inconsistent with its expected result.
   - Some docs and READMEs still describe implemented code as planned, while `STATE.md` mixes historical notes and operational metadata.

2. Real media and core editor closure:
   - Assets can register arbitrary originals and derivatives, but Monitor and browser export still
     resolve timeline video through `/media/reference/<assetId>.mp4` fixtures.
   - Timeline file import can dispatch an empty track id, assumes literal track ids, and a file drop
     does not consume the dropped file.
   - `apps/editor-web/src/AssetLibraryPanel.tsx` accepts `onAddSticker` but renames it to `_onAddSticker` and never calls it.
   - `apps/editor-web/src/JobsPanel.tsx` exposes a fixture thumbnail enqueue as a visible action.
   - `apps/editor-web/src/TimelinePanel.tsx` still has a media modal TODO and a marker context TODO even though marker commands exist through `App.tsx`.
   - Playback-rate behavior is partly implemented in `apps/editor-web/src/App.tsx`; finalization needs browser/export proof rather than relying on historical notes.

3. Deterministic delivery:
   - `render.export` is not a first-class Worker capability or typed job/receipt.
   - Worker export calls `renderFixture`, producing black synthetic media instead of the project.
   - Browser and Worker delivery do not share one frame planner, HTML delivery can reuse
     quarter-resolution captures, evaluator playback rate is incomplete, and headless noise uses
     unseeded randomness.
   - Export verification checks codecs and dimensions only, not timing, frames, audio, captions,
     black/duplicate spans, or a declared delivery promise.

4. Motion Studio:
   - The historical P17 plan is stale as an execution checklist; existing behavior needs focused
     certification tests before changes.
   - Real asset routing, remaining inspector/autokey and advanced keyframe controls, truthful
     code/graph controls, SVG fidelity, and published Motion Scene placement/rendering on the main
     timeline remain open seams.

5. Workflow and production runs:
   - Browser workflow handlers in `apps/editor-web/src/first-party-handlers.ts` still return fixture analyses and deferred endpoint markers.
   - `apps/editor-web/src/workflow-runner.ts` parks approval state in memory, so reload loses the run.
   - `RunDashboard` is a good JSON contract but not yet a durable Production Board UI.

6. Quality gates:
   - There is no shared deterministic pre-compose QA package.
   - There is no post-render inspection job that verifies black frames, duration, audio peaks, missing captions, or output metadata before delivery.

7. Provider, Worker contracts, and Joy Code:
   - Mistral is configured as a provider endpoint, but Joy Code still mostly routes deterministic intents and does not yet use a real free-form reasoning bridge for bounded creative critique and plan generation.
   - Provider decisions are not exposed as a durable, user-readable ledger with score breakdowns and budget reserve/reconcile behavior.

   - Worker/API AI payloads and receipts are misaligned, and unknown job types can lease too
     broadly.
   - Several unfinished adapters can return copy-through, sine, identity, or solid-image success
     outside a sufficiently explicit production boundary.

8. Semantic intelligence:
   - S1/S2 snapshot/intelligence files exist untracked and need ownership, tests, exports, and integration.
   - S3 is documented in untracked notes, but the claimed implementation files are not present.

9. Templates and PSD:
   - Templates are partially implemented as content-template cards and catalog entries.
   - PSD parsing exists as a spike, but import does not yet register extracted bitmaps, map layers, or apply a single durable transaction.

10. 3D:

- `JoyCode3DViewer.tsx` is a standalone GLB/GLTF viewer with Three.js.
- There is no durable 3D scene schema, 3D Studio shell, 3D asset integration, MCP tool boundary, image-to-3D job, or timeline/export bridge.

11. Security and evidence-gated promises:

- OTP throttling is process-local and OTP/session digests need keyed hashing with rotation.

- Marketplace transport, realtime collaboration, cloud GPU pool, multi-region deployment, mobile, and deep PSD/3D round-trip should remain explicitly outside 1.0 unless owner separately approves and funds those tracks.

## Release scope

### GA 1.0

GA 1.0 should ship the professional video-production system:

- Core editor closure and visible placeholder removal.
- The real asset-to-Monitor loop and a Worker delivery path that renders the actual project.
- Shared render planning, deterministic source-time behavior, and verified delivery reports.
- Certification of the current Motion Studio plus closure of its real asset, keyframe-control, and
  main-timeline placement seams.
- Durable production runs and Production Board.
- Preflight QA and post-render QA.
- Reference video analysis and B-roll search.
- Provider decision/cost ledger.
- First-party workflow packs backed by real API/Worker handlers or hidden as demo mode.
- S1/S2/S3 read-only creative critique with evidence references.
- Local verification, deploy plan, rollback plan, and Gbrain ops record after authorized deployment.

### GA 1.1

GA 1.1 should ship the creative expansion:

- Templates as a complete product surface.
- PSD import MVP.
- 3D scene schema and fullscreen 3D Studio.
- Joy Code 3D preview tab.
- MCP-style structured tool boundary for 3D tools.
- Image-to-3D job behind an explicit provider/cost gate.
- Rendering a 3D scene into a normal JOY asset so it can reach timeline, export, and QA.

### Experimental or deferred

Keep these hidden, experimental, or separately planned:

- Marketplace transport beyond local/signed packages.
- Realtime multiplayer collaboration.
- Cloud GPU pool and multi-region scheduling.
- Full Photoshop/After Effects/Premiere round-trip.
- Mobile editor.
- Auto-applying LLM/MCP writes without approval.

## Target contracts

### Playable assets and shared frame planning

Monitor, browser quick export, Worker delivery, thumbnails, and golden tests must stop inventing
their own media/source-time rules. Extend the current authorized asset resolver with a
`PlayableAssetResolver` that returns explicit ready/pending/unavailable/revoked states and
releasable object-URL handles. A fixture resolver is available only to tests and labelled demo
bootstrap.

Extract a pure `@joy-media/render-planner` layer:

```ts
interface RenderBundleV1 {
  readonly timeline: SpikeProject;
  readonly visual: JoyProjectV1;
  readonly compositionId: string;
  readonly preset: ExportPresetV1;
  readonly requiredAssets: readonly OpaqueAssetRequirementV1[];
  readonly seed: string;
}

interface RenderFramePlanV1 {
  readonly frame: RenderFrameIR;
  readonly sourceSamples: readonly MediaSourceSampleV1[];
  readonly requiredBitmaps: readonly OpaqueAssetRequirementV1[];
  readonly sceneCaptures: readonly HtmlSceneCaptureRequirementV1[];
  readonly deterministicFindings: readonly QualityFindingV1[];
}
```

The planner is data-only and imports no DOM, OPFS, network, FFmpeg, or filesystem API. The editor
and Worker inject their media/capture implementations. `apps/render-host` becomes a pinned offline
Chromium/Pixi surface driven by Worker so delivery uses the same render semantics as preview.

### Closed Worker jobs and delivery promises

Replace arbitrary job interpretation with a validated `WorkerJobV1` discriminated union. Required
first-class types include `render.export`, `render.inspect`, `video.reference-analyze`,
`media.semantic-index`, and later `mesh.from-image`/`scene3d.render`. Every job has a bounded
versioned payload, capabilities, privacy, idempotency, attempts, and a type-matched receipt. Unknown
types or mismatched receipts are rejected before lease/completion.

`DeliveryPromiseV1` declares container/codecs, dimensions, fps/duration/frame tolerances, audio
presence/sample rate/channels/loudness, caption mode, and deterministic-effect policy.
`RenderReportV1` records evidence-based pass/warn/fail findings. Browser MediaRecorder remains a
convenience export; it is not labelled verified delivery without Worker inspection.

### Production runs

Add a durable production run layer above the workflow runtime:

```ts
interface ProductionRunRecordV1 {
  readonly id: string;
  readonly projectId: string;
  readonly projectRevision: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly status: 'draft' | 'running' | 'waiting_for_input' | 'failed' | 'canceled' | 'succeeded';
  readonly checkpoint: RunCheckpoint;
  readonly dashboard: RunDashboard;
  readonly artifacts: readonly RunArtifact[];
  readonly approvals: readonly ProductionApprovalRecordV1[];
  readonly providerDecisions: readonly ProviderDecisionRecordV1[];
  readonly qualityReports: readonly ProductionQualityReportV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Storage should be local in browser for offline/dev and API-backed for production. Run state must not be part of undoable project history; only accepted output artifacts and project mutations go through `EditorSession`.

### Quality gates

Create a pure deterministic package for pre-compose quality checks and a Worker job for post-render inspection:

- Pre-compose checks: missing assets, empty ranges, overlaps, invalid durations, muted audio by accident, caption coverage, unsafe output dimensions, missing approval, unresolved workflow inputs.
- Post-render checks: duration tolerance, black/silent output, audio peak/loudness bounds, caption burn-in or sidecar presence, codec/container metadata, frame count, file size sanity.

### Provider decision ledger

Extend provider resolution rather than replacing it:

```ts
interface ProviderDecisionRecordV1 {
  readonly id: string;
  readonly requestId: string;
  readonly capability: CapabilityId;
  readonly selectedProviderId?: string;
  readonly selectedModelId?: string;
  readonly candidates: readonly ProviderCandidateScoreV1[];
  readonly policy: ProviderPolicy;
  readonly budget: ProviderBudgetRecordV1;
  readonly privacy: PrivacyPreflight;
  readonly createdAt: string;
}
```

The UI should show why a provider was selected, what it may cost, what data leaves the device, and how final usage reconciled.

### Semantic creative critique

S1 and S2 stay deterministic in `@joy-media/project-schema`. S3 belongs in `@joy-media/agent-tools` as a read-only model boundary:

- Input: bounded snapshot, deterministic findings, user goal, budget/privacy mode.
- Output: structured brief with factual findings separated from model inferences.
- Every recommendation must reference known S1 evidence IDs.
- No commands, no writes, no project mutation.

### Templates and PSD

Finish the existing content-template path before adding more concepts:

- `ContentTemplateV1` remains the v1 manifest.
- Applying a template must use one compound transaction.
- PSD import registers source PSD and layer bitmaps as assets, displays a layer mapping UI, then applies the chosen mapping as a single undoable operation.

### 3D

3D should be a new durable scene domain, not an overload of Motion Studio:

- Add a `Scene3DDocumentV1` in a new `packages/scene3d-core` package or a clearly named sibling package.
- Use Three.js for browser preview.
- Reference GLB/GLTF assets by asset id.
- Expose 3D changes through command-style reducers with undo records.
- Keep MCP tools as structured adapters over the same command/approval model.

## Test strategy

Each phase must include:

- Unit tests for contracts and reducers.
- Integration tests for `EditorSession`, workflow runner, provider resolution, and API route validation.
- Browser tests for visible editor workflows using Playwright or the existing `webapp-testing` skill.
- Golden or fixture-based media tests only where deterministic.
- A final root baseline: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test`.

## Deployment posture

This design does not authorize deployment. During later execution:

- Use `sweden-vps-ops` before any VPS inspection, deployment, service restart, rollback, or Gbrain update.
- Keep secrets, SSH paths, host internals, and environment values out of chat and source.
- Build and verify locally first.
- Confirm production routes through origin checks, not only browser/proxy checks.
- Record completed VPS changes in Gbrain through the configured MCP.
