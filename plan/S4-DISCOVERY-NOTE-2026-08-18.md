# WP-37 S4-A Discovery Note — "Improve project" Integration Path

**Date:** 2026-08-18  
**Scope:** Read-only discovery; no implementation, no UI, no tests, no new packages, no model/provider calls, no persistence, no deployment.

---

## 1. Agent/Joy Code UI Mount

The existing Agent/Joy Code UI is mounted in `apps/editor-web/src/App.tsx:5651` as a dock panel with id `agent` → `AgentPanel` component. Panel tabs are defined in `apps/editor-web/src/AgentPanel.tsx:56-60`:

```ts
const TABS: readonly PanelTabSpec[] = [
  { id: 'history', label: 'History' },
  { id: 'composer', label: 'Composer' },
  { id: '3d', label: '', iconUrl: '/assets/24_3d.png' },
];
```

## 2. Current Project/Selection/Revision Owner

`EditorSession` class in `apps/editor-web/src/editor-session.ts:160` owns:

- `timelineProject: SpikeProject` — canonical timeline state (schemaVersion 0, tracks with `kind: 'video'` only)
- `visualProject: JoyProjectV1` — full visual project state (schemaVersion 1, tracks with `kind: 'video' | 'audio' | 'caption' | 'object' | 'control'`, plus assets, visualObjects, captionDocuments, markers, audio)
- `projectRevisionId: ProjectRevisionId` — durable, opaque revision getter (line 285) encoding all component revisions via `encodeProjectRevision()`
- Selection/playhead are owned by the React state in `App.tsx` and passed as props to `AgentPanel`

`AgentPanel` in `apps/editor-web/src/AgentPanel.tsx:171-197` receives **both** `project: SpikeProject` (timeline-only) **and** `session: EditorSession` (which contains `visualProject: JoyProjectV1`).

## 3. S1 + S2 Creation Without Second Project Model

S1 snapshot projection lives in `packages/project-schema/src/semantic-snapshot-impl.ts`:

```ts
export function projectToSemanticSnapshot(
  project: JoyProjectV1,
  revisionId: ProjectRevisionId,
  options?: SnapshotOptions,
): SemanticProjectSnapshotV1;
```

S2 intelligence lives in `packages/project-schema/src/semantic-intelligence.ts`:

- `computeBrandReadiness(snapshot)` → `BrandReadinessV1`
- `computeSceneCoverages(snapshot)` → `SceneCoverageV1[]`
- `computeProjectReadiness(snapshot)` → `ProjectReadinessV1`
- `CATALOG` — deterministic rule catalog (16 rules across 6 categories)

**Integration path:** `session.timelineProject` + `session.projectRevisionId` → `projectToSemanticSnapshot()` → S2 functions. No second model needed; pure derivation from canonical state.

## 4. S3 createCreativeBrief() Without Mutation

`createCreativeBrief()` in `packages/agent-tools/src/creative-brief.ts:856` is pure/synchronous:

```ts
export function createCreativeBrief(
  input: CreativeBriefInputV1,
  adapter: CreativeModelAdapter,
  options: CreativeBriefOptions = {},
): CreativeBriefV1;
```

- Validates `input.snapshot.revisionId === input.request.snapshotRevisionId` (line 876)
- Validates `input.snapshot.projectId === input.request.projectId` (line 883)
- Calls `adapter.createBrief(adapterInput)` synchronously (line 904)
- Validates output structure, evidence, and bounds
- Returns `CreativeBriefV1` — read-only; never produces a plan, command, approval, job, or mutation

**Usage for S4:** Pass deterministic test-only adapter (from `packages/agent-tools/src/model-adapter.ts`). No real provider/model calls.

## 5. Minimal UI State Machine

```
idle → collecting (user types request) → brief-ready (S3 brief displayed) → stale/error
```

States:

- **idle**: No active brief; Composer input empty or placeholder
- **collecting**: User has entered text; waiting for brief generation
- **brief-ready**: CreativeBriefV1 available; display recommendations grouped by scene/timestamp
- **stale**: `session.projectRevisionId` changed since brief was generated; show "Project changed — regenerate brief"
- **error**: Brief generation failed; show user-facing error with retry option

State owner: `AgentPanel` component. No new Redux/React context needed; local component state suffices for read-only display.

## 6. Future S4-A Files/Tests

**New files:**

- `apps/editor-web/src/useCreativeBrief.ts` — hook: `project` + `session.projectRevisionId` → `CreativeBriefV1 | null | 'stale' | 'error'`
- `apps/editor-web/src/CreativeBriefDisplay.tsx` — read-only brief UI component
- `apps/editor-web/src/CreativeBriefDisplay.test.ts` — Vitest UI tests

**Test coverage:**

- Byte-stable brief for identical `project` + `revisionId`
- Stale detection when `revisionId` changes
- Persian/RTL request preservation in UI
- Loading/error states accessible via keyboard
- No mutation, no provider calls, no network

## 7. Accessibility, Keyboard, Persian/RTL, Stale-Revision, Loading, Error Requirements

- **Accessibility**: Brief display must be keyboard navigable (tab through recommendations, Enter to expand evidence, Escape to close)
- **Persian/RTL**: Use CSS logical properties; test with RTL project names, captions, and user requests
- **Stale-revision**: Compare `brief.snapshotRevisionId` with `session.projectRevisionId` on every render; disable "Apply" actions when stale
- **Loading**: Show spinner + "Generating brief..." in Composer while `collecting`; cancelable
- **Error**: Show inline error message in Composer; "Retry" button; never hide the input

## 8. S4 Input-Bridge Decision

**S1/S2 information sources:**

- `projectToSemanticSnapshot()` in `packages/project-schema/src/semantic-snapshot-impl.ts:532` requires `JoyProjectV1` (schemaVersion 1) because it uses:
  - `project.compositions[rootCompositionId]` → `CompositionV1` with `tracks: TrackV1[]` (multi-kind: video/audio/caption/object/control)
  - `project.captionDocuments` (line 550) for scene segmentation and caption coverage
  - `project.assets` (line 566, 592) for visual asset summaries
  - `project.markers` (line 548) for explicit scene boundaries
  - `project.variables` (line 594) for brand summary
  - `project.audio` (line 627) for audio capability detection

**Timeline/caption/audio/selection information unavailable from `SpikeProject`:**

- `SpikeProject` (schemaVersion 0) only contains `compositions` with `Track[]` where `Track.kind` is hardcoded to `'video'`
- Missing: caption tracks, audio tracks, object tracks, control tracks, assets, visualObjects, captionDocuments, markers, audio graph, color grades
- Selection/playhead are available via separate `AgentPanel` props (`selectedClipIds`, `playheadUs`)

**Existing bridge:**  
`EditorSession` in `apps/editor-web/src/editor-session.ts:160` already owns **both** `timelineProject: SpikeProject` and `visualProject: JoyProjectV1`. `AgentPanel` receives the full `session` prop, so it can access `session.visualProject` (JoyProjectV1) directly. **No new bridge needed.**

**S4 input-bridge resolution:**

- Use `session.visualProject` (JoyProjectV1) + `session.projectRevisionId` → `projectToSemanticSnapshot()` → S2 functions → S3 `createCreativeBrief()`
- Do **not** use the `project` prop (SpikeProject) for S1/S2/S3

## 9. Model Adapter Policy Decision

**Test-only fake adapter boundary:**

- Fake adapter constructors (`createValidFakeAdapter`, `createMalformedFakeAdapter`, etc.) in `packages/agent-tools/src/model-adapter.ts:782-824` are **NOT** exported from `packages/agent-tools/src/index.ts`
- Production code importing from `@joy-media/agent-tools` cannot access test-only adapters
- **Blocker:** No production `CreativeModelAdapter` implementation exists for S4
- **Decision required:** S4 UI needs either:
  1. A production synchronous/deterministic adapter that does NOT call real models/providers (for read-only brief display in development/demo mode), OR
  2. A runtime injection mechanism for adapter selection (feature flag / policy), OR
  3. Defer brief generation to a separate service with explicit policy gates
- **Current state:** The fake adapter is test-only; it cannot be bundled in production editor code

**Future S4 test-injection/runtime-policy decision:**

- Tests may continue importing fake adapters directly from `model-adapter.js`
- Production must NOT import from `model-adapter.js`; use only public `@joy-media/agent-tools` exports
- Policy decision: Who can trigger brief generation? What are the rate limits? What happens offline?

## 10. Dependency/Architecture Blockers

**Two S4 blockers identified:**

1. **Input-bridge clarification (RESOLVED):** `AgentPanel` must use `session.visualProject` (JoyProjectV1) + `session.projectRevisionId` instead of the `project` prop (SpikeProject). The required data is already available via the existing `session` prop — no code changes to `AgentPanel` interface needed.

2. **Production model adapter (BLOCKER):** No production `CreativeModelAdapter` implementation exists. The test-only fake adapters in `model-adapter.ts` are NOT exported from the package root (`index.ts`) and cannot be bundled in production. S4 requires a production-grade adapter or a runtime injection policy before brief generation can be enabled in the UI.
