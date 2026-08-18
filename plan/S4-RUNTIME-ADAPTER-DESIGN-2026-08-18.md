# S4 Runtime Adapter Design — Creative Brief Server-Side Contract

**WP-37 S4-F1** | 2026-08-18 | *Design only – no implementation*

---

## 1. Owning API Route

**`POST /v1/projects/:projectId/creative-brief`** in `apps/api/src/http-server.ts` (new route).

The route is served by `createControlPlaneHttpServer` which already injects:
- `authentication: ApiAuthentication` (`Actor | undefined` from request header token)
- `controlPlane: ControlPlane` (durable `PostgresControlPlane` in production)
- Server-only `mistral: MistralProviderRegistry` (never serializes credentials)

---

## 2. Per-Project Opt-In Enforcement

Opt-in is checked via a new **project-scoped policy flag** stored in the existing Postgres control-plane.

**Location:** `PostgresControlPlane` (`apps/api/src/postgres-control-plane.ts`) extends the `projects` table with:

```sql
ALTER TABLE projects ADD COLUMN creative_brief_opt_in BOOLEAN DEFAULT false;
```

**Enforcement:** Route handler rejects with `403 PolicyDenied` if:
- `actor` is `undefined` (unauthenticated)
- Actor is NOT the project owner (from `ProjectMetadata.ownerId`)
- `project.creative_brief_opt_in` is `false`

The `ControlPlane` interface gains: `async getProjectPolicy(actor: Actor, projectId: string): Promise<{ creativeBriefOptIn: boolean }>`

---

## 3. Bounded Browser-to-Server Request

Request body (JSON, max 16 KB):

```typescript
// apps/api/src/routes/creative-brief.ts (future)
interface CreativeBriefServerRequest {
  // Snapshot identity - ties the brief to a specific project revision
  readonly snapshotRevisionId: ProjectRevisionId;
  
  // User's creative intent - free-form but bounded to 512 UTF-16 code units
  readonly request: string;
  
  // Bounded scope - enumerated CreativeBriefScope from @joy-media/agent-tools
  readonly scope: CreativeBriefScope;
  
  // Optional destination context
  readonly destination?: DestinationPreset;
  
  // Optional duration target in microseconds
  readonly durationTargetUs?: number;
}
```

**Validation at route entry:**
- `request` length ≤ 512 UTF-16 code units
- `scope` is a valid `CreativeBriefScope`
- `snapshotRevisionId` matches the current project revision (from `ControlPlane.getProject`)
- **Never contains:** paths, URLs, object-store references, credentials, or command payloads

**Server-side resolution:**
1. `ControlPlane.getProject(actor, projectId)` → `ProjectMetadata` including `revisionId`
2. `ControlPlane.getProjectSnapshot(projectId, snapshotRevisionId)` → `SemanticProjectSnapshotV1`
3. `ControlPlane.getS2Intelligence(projectId, snapshotRevisionId)` → `BrandReadinessV1`, `ProjectReadinessV1`, `SceneCoverageV1[]`, `IntelligenceRuleV1[]`
4. Validate revision match before proceeding

---

## 4. KiloCode/OpenRouter Secret-Resolution Boundary

**Boundary:** `MistralProviderRegistry` (`apps/api/src/mistral-provider.ts`) is **already** server-only.

**Configuration:**
- `JOY_MEDIA_MISTRAL_API_KEY` (env var, server-side only, **never exposed to browser**)
- Keys resolved via `process.env` at server startup only

**Provider resolution flow:**
1. Server validates project opt-in and actor ownership
2. Server constructs `MistralCompletionRequest` with:
   - `model` (from `MISTRAL_REASONING_MODELS`)
   - `messages` (prompt engineered from `CreativeBriefInputV1`, **no secrets**)
   - `idempotencyKey` (deterministic hash of `projectId:snapshotRevisionId:request`)
   - `privacyMode: 'local-only'` is NOT allowed; must be `'ask-before-remote'`
   - `approvedRemoteProcessing: true` (explicitly granted by server policy)
   - `approvedSpend: true` (explicitly granted by server policy)
3. `MistralProviderRegistry.complete(actorId, request)` invokes the adapter
4. **No prompt data, project bytes, or user input is written to logs or ledgers** (per `computePrivacyPreflight`)

**Credential boundary:** The `@joy-media/adapter-mistral` package accepts API key at construction. The server passes this from `process.env.JOY_MEDIA_MISTRAL_API_KEY` **only during startup**. Browser never sees the adapter or its configuration.

---

## 5. Typed Response/Error Contract

All responses are JSON with a discriminant `status` field:

```typescript
// Success
interface CreativeBriefReady {
  readonly status: 'ready';
  readonly brief: CreativeBriefV1;  // From @joy-media/agent-tools
}

// Failures
interface CreativeBriefUnavailable {
  readonly status: 'unavailable';
  readonly reason: 'adapter-not-configured' | 'provider-unhealthy';
}

interface CreativeBriefPolicyDenied {
  readonly status: 'policy-denied';
  readonly reason: 'not-opted-in' | 'not-owner' | 'unauthenticated';
}

interface CreativeBriefStale {
  readonly status: 'stale';
  readonly reason: 'revision-mismatch';
  readonly expectedRevisionId: ProjectRevisionId;
  readonly actualRevisionId: ProjectRevisionId;
}

interface CreativeBriefInvalidOutput {
  readonly status: 'invalid-output';
  readonly errors: readonly { readonly code: string; readonly message: string }[];
}

interface CreativeBriefProviderFailed {
  readonly status: 'provider-failed';
  readonly errorCode: 'MISTRAL_UNAUTHORIZED' | 'MISTRAL_UNAVAILABLE' | 'MISTRAL_TIMEOUT' | 'MODEL_ERROR';
  readonly message: string;
}

interface CreativeBriefTimeout {
  readonly status: 'timeout';
  readonly timeoutMs: number;
}

type CreativeBriefServerResponse = 
  | CreativeBriefReady
  | CreativeBriefUnavailable
  | CreativeBriefPolicyDenied
  | CreativeBriefStale
  | CreativeBriefInvalidOutput
  | CreativeBriefProviderFailed
  | CreativeBriefTimeout;
```

HTTP status codes:
- 200 OK → `ready`
- 400 Bad Request → `stale`, `invalid-output`
- 403 Forbidden → `policy-denied`
- 503 Service Unavailable → `unavailable`, `provider-failed`, `timeout`

---

## 6. Cost/Spend, Rate-Limit, Cancellation, Audit, Retention

### Decision record — 2026-08-18 (owner-approved)

This record supersedes the earlier KiloCode transport wording in this document.

- **Provider/transport:** Use OpenRouter's OpenAI-compatible chat-completions API through `@joy-media/adapter-openrouter`. KiloCode is an editor host and is not a server-side transport.
- **Initial model policy:** Permit only an explicit, server-side allowlist of OpenRouter free-model IDs (starting with NVIDIA Nemotron or another explicitly selected `:free` model). There is no automatic paid-model fallback. A provider response that identifies a model outside the allowlist must be rejected and must trip the runtime's unavailable/circuit-breaker path.
- **Secret-reference mapping:** Configuration carries only the opaque reference `joy-media/openrouter/creative-brief/v1`. A future server-only resolver maps that reference to a local-development secret store or to a VPS service credential. The resolver is injected into the API runtime; browser code, configuration parsing, adapters, logs, and audit records never receive the secret value. For VPS deployment, prefer a systemd-managed credential available only to the API service over a committed file or browser-visible environment value.
- **Spend enforcement:** Initial policy is **zero payable spend**. Enforce it before egress with the free-model allowlist, no paid fallback, a bounded output-token limit, and a per-actor request-rate limit. Record provider-reported model and token usage after a request. If the provider reports a non-free/unknown model, pricing, or an unparseable usage condition, disable further requests until an owner explicitly re-enables the runtime. Do not claim that a `SPEND_LIMIT_USD_CENTS` field alone enforces cost at OpenRouter.
- **Configuration implication:** A future configuration schema may represent the free-only policy with a zero-cent budget, but that change must be made deliberately with matching validation and runtime tests; it is not a license to enable remote calls now.

### Cost/Spend
- Server tracks spend via existing `ProviderLifecycle` (from `@joy-media/provider-sdk`)
- Each completion records `UsageRecord` with `providerId`, `modelId`, `inputTokens`, `outputTokens`
- **No spend data is returned to the browser**

### Rate-Limit
- Per-actor limit enforced at route level: max 10 creative brief requests per minute
- Uses existing in-memory rate-limiter pattern from `apps/api/src/media-auth.ts`

### Cancellation
- Timeout: 30 seconds per request (configurable via env `JOY_MEDIA_BRIEF_TIMEOUT_MS`, default 30000)
- Uses AbortController passed to `fetchImpl` in `MistralProviderRegistry`

### Audit
- All requests logged via `ProviderLifecycle.recordJobStart/End` with:
  - `providerId`, `modelId`, `jobId` (idempotency key), `status`, `durationMs`
- **Prompt content is NOT logged** (per `computePrivacyPreflight`)
- Success/failure/timeout counts tracked per actor and per project

### Retention
- Brief results are NOT persisted server-side (stateless response)
- Request/response pairs are NOT stored
- Only usage metrics (counts, token counts, duration) retained in Postgres `provider_invocations` table

### No-Log-Redaction
- Input `request` string is checked against `FORBIDDEN_PATTERNS` from `packages/agent-tools/src/creative-brief.ts` BEFORE any processing
- If any pattern matches, return `400 Bad Request` with `invalid-output` status and code `FORBIDDEN_CONTENT`
- No redaction needed (request is rejected entirely)

---

## 7. Server Output → S3 Validation Path

**Flow:**

1. Server receives `CreativeBriefServerRequest`
2. Server resolves `CreativeBriefInputV1` from project state
3. Server constructs `ModelAdapterInputV1` and calls the model adapter
4. Server receives `ModelAdapterOutputV1` from adapter
5. Server passes `ModelAdapterOutputV1` to `createCreativeBrief()` from `packages/agent-tools/src/creative-brief.ts`
6. `createCreativeBrief()` validates and returns `CreativeBriefV1`
7. Server validates the result with `validateCreativeBrief()` from `packages/agent-tools/src/creative-brief-validation.ts`
8. If validation fails, return `invalid-output` with validation errors
9. If validation passes, return `ready` with the `CreativeBriefV1`

**Key:** The server-side adapter uses the **same** `createCreativeBrief` function as S3 tests, ensuring identical validation and behavior.

---

## 8. Test Strategy

**Unit tests:** `apps/api/src/routes/creative-brief.test.ts` (new file)

- **Fake server-side adapter:** `FakeCreativeBriefAdapter` (test-only, in test file) implementing `CreativeModelAdapter` interface
- **Zero real network traffic:** All tests use the fake adapter
- **Test cases:**
  - Unauthenticated → `policy-denied`
  - Not project owner → `policy-denied`
  - Not opted-in → `policy-denied`
  - Stale revision → `stale`
  - Invalid request (forbidden patterns) → `invalid-output`
  - Adapter unavailable → `unavailable`
  - Adapter returns invalid output → `invalid-output`
  - Adapter returns valid output → `ready`
  - Timeout → `timeout`
  - Persian/RTL request preserved byte-for-byte

**Integration tests:** Use `MemoryMistralInvocationLedger` to avoid database dependency

---

## 9. Rollout Plan

- **Disabled by default:** New route returns `501 Not Implemented` unless `JOY_MEDIA_CREATIVE_BRIEF_ENABLED=true`
- **Per-project opt-in:** Each project owner must explicitly enable via settings UI (future work)
- **No deployment in this package:** This design note does NOT include any implementation or deployment
- **Feature flag:** Route is gated by environment variable check at the top of the route handler

**Future work (not in this design):**
- Settings UI for per-project opt-in
- Admin UI to view usage metrics
- Cost tracking dashboard

---

## 10. Next Implementation Files & Blockers

### Next files to create:
1. `apps/api/src/routes/creative-brief.ts` — Route handler
2. `apps/api/src/routes/creative-brief.test.ts` — Tests with fake adapter
3. `apps/api/src/creative-brief-server-adapter.ts` — Server-side adapter wrapping Mistral provider
4. Update `apps/api/src/http-server.ts` — Add route mounting
5. Update `apps/api/src/postgres-control-plane.ts` — Add `creative_brief_opt_in` column and policy getter

### Architecture blockers:

**Blocker 1: S1/S2 snapshot resolution**
- `ControlPlane.getProjectSnapshot` must be implemented and return `SemanticProjectSnapshotV1`
- Currently `ControlPlane` interface (`apps/api/src/control-plane.ts`) does NOT have this method
- The snapshot must be derived from persisted project state (not generated on the fly)

**Blocker 2: S2 intelligence resolution**
- `ControlPlane` must expose methods to retrieve S2 intelligence:
  - `getBrandReadiness(projectId, revisionId)` → `BrandReadinessV1`
  - `getSceneCoverages(projectId, revisionId)` → `SceneCoverageV1[]`
  - `getProjectReadiness(projectId, revisionId)` → `ProjectReadinessV1`
  - `getIntelligenceRules(projectId, revisionId)` → `IntelligenceRuleV1[]`
- These are NOT yet implemented in `PostgresControlPlane`

**Blocker 3: Input size limits**
- S1 snapshot serialization must not exceed server memory limits
- Need validation that snapshot + intelligence payload < 2 MB before sending to model

**Blocker 4: KiloCode/OpenRouter adapter for Creative Brief**
- Need a new adapter in `@joy-media/adapter-kilocode` or extend `@joy-media/adapter-mistral`
- Adapter must implement `CreativeModelAdapter` interface from `packages/agent-tools/src/model-adapter.ts`
- Must support `createCreativeBriefInput` → `ModelAdapterOutputV1` conversion

**Blocker 5: Prompt engineering for Creative Brief**
- Need deterministic prompt templates that:
  - Accept `CreativeBriefInputV1`
  - Produce structured JSON output matching `ModelAdapterOutputV1`
  - Respect token limits (prompt + output ≤ 16k tokens for mistral-large)
- Prompts must be validated against `FORBIDDEN_PATTERNS`

**Blocker 6: Model capability gap**
- Current model adapters (`@joy-media/adapter-mistral`) are designed for chat completion
- Need adapter that specifically implements the `CreativeModelAdapter` contract:
  - Accept `ModelAdapterInputV1` (contains S1 snapshot + S2 intelligence + request)
  - Return `ModelAdapterOutputV1` (structured brief data)
- This adapter must be added to the server's provider registry

### Dependencies (already exist):
- `@joy-media/agent-tools` — `CreativeBriefV1`, `CreativeBriefInputV1`, `createCreativeBrief`, `validateCreativeBrief`
- `@joy-media/project-schema` — `SemanticProjectSnapshotV1`, `ProjectRevisionId`
- `@joy-media/provider-sdk` — `ProviderLifecycle`, `CapabilityResult`
- `apps/api` — `ControlPlane`, `MediaAuthApi`, route patterns

### Dependencies (do NOT exist yet):
- S1 snapshot storage and retrieval in control-plane
- S2 intelligence storage and retrieval in control-plane
- Server-side CreativeModelAdapter implementation for real providers

---

## Summary

| Aspect | Location | Status |
| --- | --- | --- |
| API route | `POST /v1/projects/:projectId/creative-brief` | Design complete |
| Opt-in check | `PostgresControlPlane` + `creative_brief_opt_in` column | Needs implementation |
| Request validation | Route handler | Design complete |
| Secret boundary | `MistralProviderRegistry` + env vars | Exists, verified |
| Response contract | Typed discriminated union | Design complete |
| S3 validation | `validateCreativeBrief()` | Exists in agent-tools |
| Test strategy | Fake adapter, no network | Design complete |
| Rollout | Disabled by default, per-project opt-in | Design complete |
| Blockers | 6 identified (see Section 10) | **NOT READY FOR IMPLEMENTATION** |
