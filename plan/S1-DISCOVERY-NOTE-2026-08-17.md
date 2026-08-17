# S1 Discovery Note — Semantic Project Snapshot

**Status:** Discovery complete  
**Date:** 2026-08-17  
**Session:** WP-37 S1 — Semantic Project Snapshot contract  
**Agent:** Continuation from HANDOFF-JOY-MEDIA-AI-CREATIVE-OS-2026-08-17  

---

## Purpose

This document answers the S1 discovery questions (WP-37 §204-224) to determine where and how to implement the Semantic Project Snapshot V1 schema, projector, validation, and fixtures.

---

## 1. Canonical Persisted Project Source and Revision ID

### Source

**Canonical project source:** `@joy-media/project-schema` package  
**File:** `packages/project-schema/src/v1.ts`  
**Type:** `JoyProjectV1` interface (lines 34-73)

The `JoyProjectV1` is the authoritative, persisted project document. It contains:
- `schemaVersion: 1`
- `id: string` (ProjectId)
- `title: string`
- `createdAt: string` (ISO timestamp)
- `updatedAt: string` (ISO timestamp)
- `rootCompositionId: CompositionId`
- `settings: { readonly defaultLocale: string }`
- `compositions: Readonly<Record<CompositionId, CompositionV1>>`
- `assets: Readonly<Record<string, AssetRecordV1>>`
- `variables: Readonly<Record<string, JsonValue>>`
- `markers: readonly MarkerV1[]`
- `visualObjects: Readonly<Record<string, VisualObjectV1>>`
- `captionDocuments: Readonly<Record<string, CaptionDocumentV1>>`
- `pluginData: Readonly<Record<string, JsonValue>>`
- `audio?: ProjectAudioV1` (optional durable audio graph)
- `colorGrade?: ColorGradeV1 | ColorGradeV2` (optional master color grade)
- `clipColorGrades?: Readonly<Record<string, ColorGradeV2>>` (optional per-clip grades)
- `transitions?: readonly TransitionV1[]` (optional clip-junction transitions)
- `exportPreset?: ExportPresetId` (last chosen export preset)
- `propertyAnimations?: Readonly<Record<string, PropertyAnimationV2>>` (optional universal animations)
- `universalTimeline?: UniversalTimelineDocument` (versioned universal Timeline bindings)
- `timelineTrackDeck?: TimelineTrackDeckDocument` (validated projection of editor's universal row deck)

### Revision System

**Revision mechanism:** Opaque string ID computed from component revisions  
**Function:** `encodeProjectRevision()` in `apps/editor-web/src/editor-session.ts` (line 1020)

```typescript
function encodeProjectRevision(
  projectId: string,
  timelineRevision: number,
  visualObjectRevision: number,
  graphRevision: number,
  artifactRevision: number,
): ProjectRevisionId {
  return `local-revision:v1:${encodeURIComponent(projectId)}:timeline=${timelineRevision}:document=${visualObjectRevision}:graph=${graphRevision}:artifacts=${artifactRevision}`;
}
```

**Access pattern:** `EditorSession.projectRevisionId` (line 285) returns the encoded revision.

**Component tracking:**
- `EditorSession.#timelineRevision` (line 1022)
- `EditorSession.#visualObjectRevision` (line 1023)
- `EditorSession.#graphRevision` (line 1024)
- `EditorSession.#artifactRevision` (line 1025)

Each component increments independently when mutated, ensuring stale plan detection.

### Current Commit

- **Local checkout:** `0287946` (verified 2026-08-17)
- **VPS checkout:** `0287946` (verified 2026-08-17)
- **Deployed WP-36 artifact:** `733f584` at `/opt/joy-media/web-releases/editor-web-20260816T233403Z-733f584-wp36-color-render-final`

---

## 2. Package Ownership and Dependency Direction

### Dependency Graph (from package.json and tsconfig.json)

```
┌─────────────────────────────────────────────────────────────┐
│  @joy-media/project-schema (INNERMOST)                         │
│  └── Core types: JoyProjectV1, CompositionV1, TrackV1,        │
│      ClipV1, VisualObjectV1, AssetRecordV1, etc.               │
│  └── No dependencies on other JOY packages                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  @joy-media/commands                                          │
│  └── Depends on: project-schema                               │
│  └── Owns: SpikeCommand, CommandTransaction, History         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  @joy-media/timeline-engine                                    │
│  └── Depends on: project-schema, commands                     │
│  └── Owns: Timeline viewport, ruler ticks, placement logic    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  @joy-media/agent-tools                                        │
│  └── Depends on: project-schema, commands, job-protocol,       │
│      provider-sdk                                              │
│  └── Owns: AgentEditPlan, ToolRegistry, approval policies     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  apps/editor-web                                               │
│  └── Depends on: project-schema, commands, timeline-engine,    │
│      agent-tools, and many others                             │
│  └── Owns: EditorSession, AgentPanel, UI integration           │
└─────────────────────────────────────────────────────────────┘
```

### Package Ownership Decision

**Semantic Project Snapshot V1 should live in:** `@joy-media/project-schema`

**Rationale:**
1. Snapshot is a **read-only projection of persisted project state** (WP-37 §202)
2. `@joy-media/project-schema` is the **innermost package** with no dependencies on other JOY packages
3. The snapshot needs access to all canonical types (`JoyProjectV1`, `CompositionV1`, `TrackV1`, `ClipV1`, `VisualObjectV1`, `AssetRecordV1`, etc.)
4. Placing it in `project-schema` ensures:
   - Zero circular dependency risk
   - All consumers (commands, timeline-engine, agent-tools, editor-web) can import it
   - The projection logic stays close to the canonical source
   - No need to invert dependency direction

**Alternative rejected:** Creating a new `project-intelligence` package would require `project-schema` as a dependency, but the snapshot is fundamentally a projection of `project-schema` types, not a separate domain.

---

## 3. Field Mapping — Existing Canonical Fields

### Composition Data

From `CompositionV1` (v1.ts lines 224-236):
- `id: CompositionId`
- `name: string`
- `width: number`
- `height: number`
- `pixelAspectRatio: Rational`
- `frameRate: Rational`
- `durationUs: TimeUs`
- `background: string` (color)
- `tracks: readonly TrackV1[]`
- `activeCameraId?: string` (optional camera reference)

### Track Data

From `TrackV1` (v1.ts lines 238-248):
- `id: TrackId`
- `kind: 'video' | 'audio' | 'caption' | 'object' | 'control'`
- `family?: TimelineTrackFamily` (explicit compatibility family — WP-36)
- `name: string`
- `order: number`
- `enabled: boolean`
- `locked: boolean`
- `clips: readonly ClipV1[]`

**TimelineTrackFamily** (model.ts): `'visual' | 'audio'` — WP-36 universal deck

### Clip Data

From `ClipV1` (v1.ts lines 250-283): Discriminated union:
- `VideoClipV1`: `id`, `startUs`, `durationUs`, `assetId`, `sourceInUs`, `playbackRate?`, `reversed?`
- `CompositionClipV1`: `id`, `startUs`, `durationUs`, `compositionId`, `childOffsetUs`
- `CaptionClipV1`: `id`, `startUs`, `durationUs`, `captionDocumentId`, `style?`

### Asset Data

From `AssetRecordV1` (model.ts):
- `id: string`
- `kind: AssetKindV1` (`'video' | 'audio' | 'image' | 'font' | 'lutt' | 'project'`)
- `name: string`
- `durationUs?: TimeUs` (for media)
- `naturalWidth?: number`
- `naturalHeight?: number`
- `naturalFrameRate?: Rational`
- `naturalPixelAspectRatio?: Rational`
- `mimeType?: string`
- `generationProvenance?: GenerationProvenanceV1` (provider/model/version, prompt, parameters)

### Visual Object Data

From `VisualObjectV1` (v1.ts lines 187-222):
- `id: string`
- `kind: 'image' | 'text' | 'shape' | 'null' | 'camera' | 'html-scene'`
- `transform: VisualObjectTransformV1` (x, y, scaleX, scaleY, rotationDeg, opacity, positionZ?, crop)
- `animations?: Record<AnimatablePropertyV1, AnimationCurveV1>`
- `expressions?: Record<AnimatablePropertyV1, string>`
- `spatialPath?: SpatialPathV1`
- `parentId?: string` (transform inheritance)
- `motionBlur?: MotionBlurV1`
- `assetId?: string`
- `text?: string` (legacy)
- `textDocument?: TextDocumentV1` (structured)
- `textStyle?: TextStyleV1`
- `shape?: 'rectangle' | 'ellipse'`
- `camera?: CameraParamsV1` (fov)
- `scenePackageId?: string` (HTML scenes)
- `effects?: readonly EffectInstanceV1[]` (applied visual effects)

### Caption Data

From `CaptionDocumentV1` (v1.ts lines 292+):
- `id: string`
- `locale: string`
- `segments: readonly CaptionSegmentV1[]`
- `words: readonly CaptionWordV1[]`
- `speakers: readonly CaptionSpeakerV1[]`

### Audio Data

From `ProjectAudioV1` (audio.ts):
- `buses: readonly AudioBusV1[]`
- `clips: readonly ProjectAudioClipV1[]`
- `masterBus: AudioBusV1`

### Brand/Asset Information

**Current state:** No explicit brand-kit schema found in `project-schema`. Brand data appears to be:
- Either not yet implemented as a first-class schema
- Or stored in `variables: Record<string, JsonValue>`
- Or managed separately (requires verification in ADRs)

**Action:** S1 snapshot should represent brand as `BrandSummaryV1` with available/missing fields, marking unavailable data appropriately.

### Provenance Data

From `GenerationProvenanceV1` (model.ts):
- `providerId: string` (opaque, e.g., `'provider-comfy'`)
- `modelId: string` (opaque, e.g., `'sdxl-1.0'`)
- `version: string` (provider model version)
- `prompt?: string` (user prompt)
- `negativePrompt?: string`
- `parameters: Record<string, JsonValue>`
- `costUsd?: number`
- `timestamp: string` (ISO)

**S1 requirement:** Opaque IDs only, never raw paths, signed URLs, or provider credentials.

---

## 4. Privacy Exclusions

### Information INTENTIONALLY Unavailable to Agent

Based on code inspection, the following are **never** exposed through canonical project state:

1. **Provider credentials**
   - Not stored in project schema
   - Resolved server-side only (`@joy-media/provider-sdk`)

2. **Object-store locations**
   - Not stored in `AssetRecordV1`
   - Accessed through opaque asset IDs and server-side resolution

3. **Signed URLs**
   - Not stored in project schema
   - Generated on-demand with limited TTL

4. **API keys/tokens**
   - Never in project, browser, or GBrain
   - Server-side only in `/etc/joy-media/api.env`

5. **Private user data**
   - User identity stored separately from project
   - Project contains no user PII

### Information Available but Opaque

These are available but must be treated as opaque IDs in snapshots:

- `assetId: string` — opaque reference, no path/URL
- `compositionId: CompositionId` — opaque reference
- `trackId: TrackId` — opaque reference
- `clipId: string` — opaque reference
- `visualObject.id: string` — opaque reference
- `captionDocumentId: string` — opaque reference
- `providerId: string` — opaque provider reference (not a credential)
- `modelId: string` — opaque model reference

---

## 5. Existing Plan/Approval Types

### Agent Command Envelope

From `@joy-media/agent-tools/src/envelope.ts`:
- `AgentCommandEnvelope<TParams>` — wraps agent-issued commands
- `baseRevision: ProjectRevisionId` — project revision plan was built against
- `transactionId: string` — groups commands into single undoable transaction
- `idempotencyKey: string` — stable across retries
- `actor: AgentActor` — `{ type: 'agent' | 'human' | 'plugin', id: string }`

### Agent Edit Plan

From `@joy-media/agent-tools/src/plan.ts`:
- `AgentEditPlan` — structured plan with steps
- `snapshotRevisionId: string` — links plan to specific project state
- `steps: readonly AgentPlanStep[]`
- Each step has `tool`, `params`, `estimate`, `preconditions`

**S1 compatibility:** Existing plan system can host read-only proposals without duplication. The `snapshotRevisionId` in `AgentEditPlan` aligns with `SemanticProjectSnapshotV1.revisionId`.

---

## 6. Proposed Snapshot Ownership

### Decision: `@joy-media/project-schema` Package

**New file:** `packages/project-schema/src/semantic-snapshot.ts`

**Exports:**
```typescript
// Types
export type { SemanticProjectSnapshotV1, SceneSummaryV1, ... }

// Projection
export function projectToSemanticSnapshot(
  project: JoyProjectV1,
  revisionId: ProjectRevisionId,
  options?: SnapshotOptions
): SemanticProjectSnapshotV1

// Validation
export function validateSemanticProjectSnapshot(
  snapshot: unknown
): SnapshotValidationResult

// Fixtures for testing
export const EMPTY_SNAPSHOT: SemanticProjectSnapshotV1
```

**Dependencies:**
- Only `@joy-media/project-schema` internal types
- No dependencies on `commands`, `timeline-engine`, or `agent-tools`
- Zero circular dependency risk

### Dependency Direction

```
project-schema (owns snapshot)
    └── semantic-snapshot.ts
    
commands (can consume snapshot)
    └── Can import from project-schema

timeline-engine (can consume snapshot)
    └── Can import from project-schema

agent-tools (can consume snapshot)
    └── Can import from project-schema
    └── Can use snapshot in plan context

editor-web (can consume snapshot)
    └── Can import from project-schema
    └── Can display snapshot in Agent panel
```

---

## 7. Answers to S1 Discovery Questions

### Q1: Which persisted project source and revision ID are canonical?

**A:** 
- Source: `JoyProjectV1` in `@joy-media/project-schema`
- Revision: `ProjectRevisionId` encoded from component revisions via `encodeProjectRevision()` in editor-session
- Format: `local-revision:v1:<encoded-project-id>:timeline=<n>:document=<n>:graph=<n>:artifacts=<n>`

### Q2: Where should a read-only projection live without inverting package dependencies?

**A:** `@joy-media/project-schema` package, in a new file `semantic-snapshot.ts`. This is the innermost package with no dependencies on other JOY packages, ensuring clean dependency direction.

### Q3: Which existing fields already carry assets, clips, captions, audio, animation, brand data, generated provenance, and element-to-track bindings?

**A:**
- **Assets:** `JoyProjectV1.assets` → `AssetRecordV1` (with `generationProvenance?`)
- **Clips:** `CompositionV1.tracks[]` → `TrackV1.clips` → `ClipV1` discriminated union
- **Captions:** `JoyProjectV1.captionDocuments` + `CaptionClipV1.captionDocumentId`
- **Audio:** `JoyProjectV1.audio?` → `ProjectAudioV1` (buses, clips, master)
- **Animation:** `VisualObjectV1.animations?` + `JoyProjectV1.propertyAnimations?`
- **Brand:** Not yet explicit schema; currently in `variables` or separate (needs ADR)
- **Provenance:** `AssetRecordV1.generationProvenance?` → `GenerationProvenanceV1`
- **Bindings:** `TrackV1.clips[]` references `assetId` or `compositionId`; `VisualObjectV1.assetId?`

### Q4: Which project/asset information is intentionally unavailable to an agent for privacy or authorization reasons?

**A:**
- Provider credentials (never in project)
- Object-store locations/paths (never in project)
- Signed URLs (never persisted)
- API keys/tokens (server-side only)
- User PII (separate from project)
- Raw file paths (opaque IDs only)

### Q5: Which current plan/approval types can host a read-only proposal without duplicating the agent workflow?

**A:** `AgentEditPlan` in `@joy-media/agent-tools` already supports:
- `snapshotRevisionId: string` — binds plan to specific project state
- Read-only proposal pattern via tool definitions
- Existing approval policy system (`ApprovalEngine`, `ApprovalPolicy`)
- No duplication needed; S1 snapshot provides the structured context

---

## 8. Implementation Roadmap

### Phase 1: Schema and Types (S1.278)
1. Add `SemanticProjectSnapshotV1` and related types to `project-schema`
2. Add validation functions
3. Export from package

### Phase 2: Projector (S1.279)
1. Implement `projectToSemanticSnapshot()` pure function
2. Derive composition, scenes, timeline, assets, brand, capabilities, warnings
3. Scene segmentation: use explicit markers if available, else deterministic derivation

### Phase 3: Size Budgets and Truncation (S1.280-282)
1. Define initial-context budget (target: ~4KB-8KB)
2. Implement deterministic truncation with omission counts
3. Add hierarchical detail-on-demand references

### Phase 4: Cache (S1.283)
1. Add per-project/revision cache after pure behavior tests
2. Bounded cache with no secrets
3. Invalidation on revision change

### Phase 5: Fixtures and Tests (S1.284)
1. Blank project fixture
2. Mixed-element project fixture
3. Persian/RTL captions fixture
4. Generated asset with provenance fixture
5. Locked/hidden color-labeled track fixture
6. Unavailable asset fixture
7. Oversized project requiring truncation fixture

---

## 9. Open Questions (Require ADR)

1. **Brand source:** Exact existing canonical brand-kit schema location and privacy boundary
2. **Scene boundaries:** Canonical explicit scene markers vs deterministic derivation (WP-36 has `timelineTrackDeck?` but no explicit scene model)
3. **Snapshot ownership:** Confirm `@joy-media/project-schema` is acceptable (this note recommends it, but owner decision required)

---

*This discovery note is based on code inspection of commit `0287946` on 2026-08-17. Verify against current HEAD before implementation.*
