# WP-37 S4-F10-E4: Canonical Creative Brief Input Resolution Design

**Date:** 2026-08-19  
**Status:** Architecture Design (Read-Only)  
**Scope:** Server-side Creative Brief input resolution for WP-37 free creative requests

---

## Executive Summary

**Confirmed Storage Reality:** `JoyProjectV1` is **NOT persisted server-side** in `apps/api`. The ControlPlane (`LocalControlPlane` at `apps/api/src/control-plane.ts:474` and `PostgresControlPlane` at `apps/api/src/postgres-control-plane.ts:138`) only stores `ProjectMetadata` (lines 8-18: id, title, revision, ownerId, assetSyncEnabled, trashedAt, creativeBriefOptIn). The PostgreSQL schema at `apps/api/src/postgres-schema.ts:3` confirms this: the `projects` table has no project document column. The `JoyProjectV1` document exists **only in the browser** via `EditorSession.visualProject` (`apps/editor-web/src/editor-session.ts:160`).

**Recommendation:** Keep Creative Brief **unavailable** until server-side project persistence is implemented. The first implementation task is: **Add a server-side project document store with revisioned JoyProjectV1 persistence to the ControlPlane interface.**

---

## 1. Where JoyProjectV1 is Persisted Today

**File/Function Evidence:**

- `apps/editor-web/src/editor-session.ts:160` — `EditorSession` class owns `visualProject: JoyProjectV1` (line 164: `readonly #visualObjectPersistence: LocalProjectPersistence<JoyProjectV1, VisualObjectTransaction>`)
- `apps/editor-web/src/editor-session.ts:126-131` — `visualObjectAdapter: PersistenceAdapter<JoyProjectV1, VisualObjectTransaction>` with `validate: validateJoyProjectV1`
- `packages/project-persistence/src/persistence.ts:134` — `LocalProjectPersistence<P, T>` handles snapshots/transactions for generic project types
- `apps/api/src/postgres-control-plane.ts:42-50` — `ProjectRow` interface has NO document field; only metadata
- `apps/api/src/control-plane.ts:262` — `ControlPlane` interface has NO method to get/set project documents
- `apps/api/src/postgres-schema.ts:3` — PostgreSQL `projects` table: `id text, owner_id text, title text, revision integer, ...` — no `document` column

**Conclusion:** `JoyProjectV1` is **browser-only** today. The server (`apps/api`) has zero access to project documents. Without server-side `JoyProjectV1`, the `CreativeBriefInputResolver` **cannot** resolve `CreativeBriefInputV1` from canonical state.

---

## 2. How Canonical Project Revision is Represented Server-Side

**File/Function Evidence:**

- `apps/editor-web/src/editor-session.ts:285` — `projectRevisionId: ProjectRevisionId` is computed via `encodeProjectRevision()` (line 285)
- `packages/project-schema/src/model.ts` — `ProjectRevisionId` is an opaque string type
- `apps/api/src/control-plane.ts:274-277` — `getProject()` returns `ProjectLifecycleMetadata` with `revision: number` (metadata revision, NOT document revision)
- `apps/api/src/http-server.ts:429-433` — `CreativeBriefInputResolverRequest` carries `projectId` and `snapshotRevisionId`

**Conclusion:** Server-side `revision` in `ProjectMetadata` is a **metadata revision** (incremented on title/trash/restore), NOT a `ProjectRevisionId` for the canonical document. The browser's `session.projectRevisionId` encodes all component revisions (timeline, visual objects, etc.) but is **not available server-side**.

---

## 3. Can S1 and S2 Be Recomputed Without Browser Input?

**File/Function Evidence:**

- `packages/project-schema/src/semantic-snapshot-impl.ts:532` — `projectToSemanticSnapshot(project: JoyProjectV1, revisionId: ProjectRevisionId, options?: SnapshotOptions): SemanticProjectSnapshotV1`
- `packages/project-schema/src/semantic-intelligence.ts:1009` — `computeSemanticIntelligence(snapshot: SemanticProjectSnapshotV1): { brandReadiness: BrandReadinessV1; sceneCoverages: readonly SceneCoverageV1[]; projectReadiness: ProjectReadinessV1; allRules: readonly IntelligenceRuleV1[] }`
- `packages/agent-tools/src/creative-brief.ts:1087` — `createCreativeBriefInput(snapshot: SemanticProjectSnapshotV1, intelligence: {...}, request: CreativeBriefRequestV1): CreativeBriefInputV1`

**Conclusion:** YES — S1 and S2 **can** be recomputed deterministically from `JoyProjectV1` + `ProjectRevisionId`. The pipeline is:

```
JoyProjectV1 + ProjectRevisionId 
  → projectToSemanticSnapshot() → SemanticProjectSnapshotV1 (S1)
  → computeSemanticIntelligence() → BrandReadinessV1 + SceneCoverageV1[] + ProjectReadinessV1 + IntelligenceRuleV1[] (S2)
  → createCreativeBriefInput() → CreativeBriefInputV1
```

**Blocker:** Server has no `JoyProjectV1` to start this pipeline.

---

## 4. Exact Missing ControlPlane/Storage Capabilities

**Required additions to `ControlPlane` interface (`apps/api/src/control-plane.ts:262`):

```typescript
// Missing methods:
getProjectDocument(actor: Actor, projectId: string, revisionId?: ProjectRevisionId): JoyProjectV1 | Promise<JoyProjectV1>;
setProjectDocument(actor: Actor, projectId: string, document: JoyProjectV1, baseRevision: ProjectRevisionId): ProjectMetadata | Promise<ProjectMetadata>;
listProjectRevisions(actor: Actor, projectId: string): readonly { revisionId: ProjectRevisionId; createdAt: string }[] | Promise<...>;
```

**Missing PostgreSQL schema (add to `apps/api/src/postgres-schema.ts:3`):

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS document_revision_id text NULL;
CREATE TABLE IF NOT EXISTS project_documents (
  project_id text NOT NULL,
  revision_id text NOT NULL,
  schema_version integer NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, revision_id)
);
CREATE INDEX IF NOT EXISTS project_documents_project_revision_idx ON project_documents (project_id, revision_id);
```

**Storage Contract:** `projects.document_revision_id` is the **atomic current-head pointer**. Do NOT rely on `created_at` timestamps to determine the head revision; the head is explicitly tracked by `document_revision_id`.

**Missing from `PostgresControlPlane` (`apps/api/src/postgres-control-plane.ts:138`):
- No storage/retrieval of `JoyProjectV1` documents
- No revision tracking for project documents

---

## 5. Smallest Safe Architecture for Real CreativeBriefInputResolver

### Target Flow

```
HTTP Request (projectId, snapshotRevisionId, request)
  ↓
ControlPlane.getProjectDocument(actor, projectId, snapshotRevisionId)
  ↓
JoyProjectV1 + ProjectRevisionId
  ↓
projectToSemanticSnapshot() → SemanticProjectSnapshotV1 (S1)
  ↓
computeSemanticIntelligence() → BrandReadinessV1 + SceneCoverageV1[] + ProjectReadinessV1 + IntelligenceRuleV1[] (S2)
  ↓
createCreativeBriefInput(snapshot, intelligence, request) → CreativeBriefInputV1
  ↓
CreativeBriefInputResolver.resolve() returns { status: 'resolved', input }
```

### Ownership & Boundaries

| Concern | Owner | Boundary |
|---------|-------|----------|
| JoyProjectV1 persistence | ControlPlane | `getProjectDocument` / `setProjectDocument` |
| Revision validation | ControlPlane | Compare `snapshotRevisionId` with current head |
| S1 projection | Pure function | `projectToSemanticSnapshot()` from `@joy-media/project-schema` |
| S2 intelligence | Pure function | `computeSemanticIntelligence()` from `@joy-media/project-schema` |
| Input assembly | Pure function | `createCreativeBriefInput()` from `@joy-media/agent-tools` |
| Resolution | CreativeBriefInputResolver | Server-side only, no browser trust |

### Auth/Privacy/Caching

- **Authentication:** Enforced at route level before resolver (existing: `authenticate` in `http-server.ts`)
- **Ownership:** ControlPlane methods require `actor: Actor`; only owner can access project documents
- **Privacy:** `JoyProjectV1` contains no secrets (validated by `validateJoyProjectV1`); asset locations are opaque refs
- **Caching:** ControlPlane MAY cache most-recent document per project; MUST validate revision match
- **Size limit:** Enforce max `JoyProjectV1` size at `setProjectDocument` (e.g., 10MB)
- **Stale revision:** If `snapshotRevisionId !== current head revisionId`, resolver returns `stale-revision`

---

## 6. Phased Implementation Sequence (2-5 minutes per phase)

### Phase 1: Server-Side Project Document Storage (FIRST - 3 minutes)

**Files to create/modify:**
- `apps/api/src/control-plane.ts` — Add `getProjectDocument`, `setProjectDocument`, `listProjectRevisions` to interface
- `apps/api/src/postgres-schema.ts` — Add `project_documents` table
- `apps/api/src/postgres-control-plane.ts` — Implement document storage methods
- `apps/api/src/local-control-plane.ts` — Add in-memory document map (or extend existing)
- `apps/api/src/postgres-control-plane.test.ts` — Add document storage tests
- `apps/api/src/local-control-plane.test.ts` — Add document storage tests

**Tests:**
- Round-trip: store `JoyProjectV1`, retrieve, verify deep equality
- Revision isolation: store two revisions, retrieve each independently
- Owner isolation: actor A cannot read actor B's project document
- Stale rejection: resolver returns `stale-revision` when revision mismatch
- Size limit: reject documents exceeding limit

### Phase 2: S1/S2 Projector Service (2 minutes)

**Files to create:**
- `apps/api/src/project-snapshot-service.ts` — Pure service: `projectToSnapshot(snapshotRevisionId: ProjectRevisionId, project: JoyProjectV1): SemanticProjectSnapshotV1`
- `apps/api/src/project-snapshot-service.test.ts` — Unit tests

**Logic:**
```typescript
async function projectToSnapshot(
  controlPlane: ControlPlane,
  actor: Actor,
  projectId: string,
  snapshotRevisionId: ProjectRevisionId,
): Promise<SemanticProjectSnapshotV1 | null> {
  const document = await controlPlane.getProjectDocument(actor, projectId, snapshotRevisionId);
  if (!document) return null;
  return projectToSemanticSnapshot(document, snapshotRevisionId);
}
```

**Tests:**
- Deterministic: same input → byte-identical output
- Persian/RTL: preserves RTL text in captions, assets
- Missing revision: returns null

### Phase 3: S2 Intelligence Service (2 minutes)

**Files to create:**
- `apps/api/src/project-intelligence-service.ts` — Pure service: `snapshotToIntelligence(snapshot: SemanticProjectSnapshotV1): {...}`
- `apps/api/src/project-intelligence-service.test.ts` — Unit tests

**Logic:**
```typescript
function snapshotToIntelligence(snapshot: SemanticProjectSnapshotV1): {
  brandReadiness: BrandReadinessV1;
  sceneCoverages: readonly SceneCoverageV1[];
  projectReadiness: ProjectReadinessV1;
  rules: readonly IntelligenceRuleV1[];
} {
  return computeSemanticIntelligence(snapshot);
}
```

**Tests:**
- Deterministic output for identical snapshot
- Rules triggered correctly for known conditions (no captions, no visuals, etc.)

### Phase 4: Real CreativeBriefInputResolver (3 minutes)

**Files to create/modify:**
- `apps/api/src/creative-brief-input-resolver.ts` — Add `RealCreativeBriefInputResolver` implementing the full pipeline
- `apps/api/src/creative-brief-input-resolver.test.ts` — Add integration tests

**Logic:**
```typescript
class RealCreativeBriefInputResolver implements CreativeBriefInputResolver {
  constructor(
    private readonly controlPlane: ControlPlane,
    private readonly snapshotService: ProjectSnapshotService,
    private readonly intelligenceService: ProjectIntelligenceService,
  ) {}

  resolve(request: CreativeBriefInputResolverRequest): CreativeBriefInputResolverResult {
    // 1. Fetch canonical document
    const document = await this.controlPlane.getProjectDocument(
      { id: request.projectId }, // actor resolved from route context
      request.projectId,
      request.snapshotRevisionId,
    );
    if (!document) {
      return { status: 'stale-revision', code: '...', message: 'Revision not found' };
    }
    
    // 2. Project S1
    const snapshot = this.snapshotService.projectToSnapshot(
      request.projectId,
      request.snapshotRevisionId,
      document,
    );
    
    // 3. Project S2
    const intelligence = this.intelligenceService.snapshotToIntelligence(snapshot);
    
    // 4. Build input
    const input = createCreativeBriefInput(snapshot, intelligence, request.request);
    
    return { status: 'resolved', input };
  }
}
```

**Tests:**
- End-to-end: request → resolved input with valid snapshot/intelligence
- Stale revision: mismatch returns `stale-revision`
- Missing project: returns `unavailable`
- Persian text: preserved through full pipeline
- No side effects: no writes, no network, no secrets

### Phase 5: Wire Resolver to HTTP Route (2 minutes)

**Files to modify:**
- `apps/api/src/http-server.ts` — Change default `creativeBriefInputResolver` from `UnavailableCreativeBriefInputResolver` to `RealCreativeBriefInputResolver` when project persistence is available

**Logic:**
```typescript
// In createControlPlaneHttpServerOptions:
creativeBriefInputResolver: options.creativeBriefInputResolver 
  ?? (options.enableCreativeBrief 
      ? new RealCreativeBriefInputResolver(options.controlPlane, snapshotService, intelligenceService)
      : UnavailableCreativeBriefInputResolver),
```

**Tests:**
- Route integration: POST /v1/projects/:id/creative-brief returns 200 with brief when enabled
- Feature flag: disabled → 503 unavailable

---

## 7. Explicit Recommendation

**Implement server-side project persistence FIRST.**

Without server-side `JoyProjectV1` storage:
- The `CreativeBriefInputResolver` **cannot** access canonical state
- Any attempt to resolve input would require trusting browser-supplied data (VIOLATES requirement)
- The feature must remain **unavailable** in production

**First implementation task (PostgreSQL schema complete):**
> PostgreSQL schema for revisioned project documents is defined in `apps/api/src/postgres-schema.ts`. Next: implement `getProjectDocument` and `setProjectDocument` methods on the `ControlPlane` interface, with `PostgresControlPlane` implementation using the `project_documents` table and `document_revision_id` head pointer, plus `LocalControlPlane` in-memory store, and tests proving round-trip persistence and owner isolation.

**Keep unavailable until then:** The current `UnavailableCreativeBriefInputResolver` (`apps/api/src/creative-brief-input-resolver.ts:93`) correctly fails closed. Production **must not** enable `RealCreativeBriefInputResolver` until Phase 1 is complete and deployed.

---

## File Evidence Index

| Question | Answer | Evidence |
|----------|--------|----------|
| Where is JoyProjectV1 persisted? | Browser only | `editor-session.ts:160`, `postgres-schema.ts:3` |
| Canonical revision representation? | Metadata-only on server | `control-plane.ts:274-277`, `editor-session.ts:285` |
| S1 computable from state? | YES | `semantic-snapshot-impl.ts:532` |
| S2 computable from S1? | YES | `semantic-intelligence.ts:1009` |
| Input assembly possible? | YES | `creative-brief.ts:1087` |
| Missing ControlPlane capability? | Document storage | `control-plane.ts:262` (no document methods) |
| Missing PostgreSQL capability? | project_documents table | `postgres-schema.ts` (schema added: `projects.document_revision_id` head pointer + `project_documents` revision history) |

---

**SHA:** (to be filled at commit time)  
**Decision:** Server-side project document store MUST precede real CreativeBriefInputResolver.  
**First Task:** Implement Phase 1 (ControlPlane document storage).
