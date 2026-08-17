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
- `timelineProject: SpikeProject` — canonical timeline state
- `visualProject: JoyProjectV1` — visual object state
- `projectRevisionId: ProjectRevisionId` — durable, opaque revision getter (line 285) encoding all component revisions via `encodeProjectRevision()`
- Selection/playhead are owned by the React state in `App.tsx` and passed as props to `AgentPanel`

## 3. S1 + S2 Creation Without Second Project Model

S1 snapshot projection lives in `packages/project-schema/src/semantic-snapshot-impl.ts`:
```ts
export function projectToSemanticSnapshot(
  project: JoyProjectV1,
  revisionId: ProjectRevisionId,
  options?: SnapshotOptions,
): SemanticProjectSnapshotV1
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
): CreativeBriefV1
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

## 8. Dependency/Architecture Blockers

**None.**  
All required contracts exist and are already wired:
- S1: `projectToSemanticSnapshot()` exported from `@joy-media/project-schema`
- S2: Deterministic intelligence functions exported from `@joy-media/project-schema`
- S3: `createCreativeBrief()`, `CreativeModelAdapter` exported from `@joy-media/agent-tools`
- Editor: `EditorSession` provides `timelineProject`, `visualProject`, `projectRevisionId`
- UI: `AgentPanel` already receives `project`, `session`, `agentContext`

No new package dependencies. No GBrain changes. No provider integrations. No UI framework changes. No persistence layer changes.
