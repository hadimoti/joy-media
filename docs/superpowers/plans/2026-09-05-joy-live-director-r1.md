# JOY Live Director R1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` / installed `executing-plans`. A Claude implementer agent executes the checkboxes; an independent Claude Opus agent reviews the complete candidate before deployment. Read the master plan first.

**Goal:** Make JOY's built-in agent genuinely observe, control, preview and verify the editor, with exact evidence and no hidden authority.

**Architecture:** Extend the existing command/session/runtime seams, add an isolated observation adapter and evidence store, and connect first-party skills to the one project run controller. The UI consumes trusted lifecycle events and real previews.

**Tech Stack:** Existing TypeScript, React, Workers, RenderFrameIR, OPFS/IndexedDB, Vitest/Playwright; version-pinned browser demux/decode candidate subject to the O2 gate.

---

All paths below are repository-relative. `Create` means a proposed new module, not an existing capability. Test commands use `pnpm exec vitest run PATH` unless Playwright is specified. A red test must fail for the intended missing behavior, not an unrelated import/configuration error. Each checkbox is tracked individually; split large domain implementation steps into one action/operation commit at execution time.

## F1 — Source-derived operation and property coverage

**Files**

- Create: `packages/agent-tools/src/editor-operation-definition.ts`, `apps/editor-web/src/joy-agent/editor-operation-registry.ts`, `tooling/release/verify-agent-operation-coverage.mjs`.
- Modify: `packages/agent-tools/src/joy-code-plan.ts`, `packages/property-system/src/property-coverage.ts`, `apps/editor-web/src/agent-command-bus.ts`.
- Test: `packages/agent-tools/src/editor-operation-definition.test.ts`, `apps/editor-web/src/joy-agent/editor-operation-registry.test.ts`.
- Evidence: `docs/reviews/joy-live-director-coverage.json`.

Define an operation's access class, runtime input/output schemas, target resolver, context selectors, pure prepare adapter, preview capability, policy metadata and postconditions. Keep domain implementations outside the schema package. Model-visible schemas and human/skill dispatch must derive from the same registered definition. No arbitrary document replacement/JSON-path write tool.

```ts
export type OperationAccess =
  'read' | 'ephemeral-ui' | 'reversible-edit' | 'external-job' | 'export' | 'destructive';
export type CoverageStatus =
  'verified' | 'unsupported' | 'read-only' | 'internal-inverse' | 'legacy-disabled';
export interface OperationEvidence {
  id: string;
  status: CoverageStatus;
  source: string;
  tests: readonly string[];
  reason?: string;
}
export function canAdvertiseOperation(row: OperationEvidence): boolean {
  return row.status === 'verified' && row.tests.length > 0;
}
```

This predicate is only an advertising guard. CI separately verifies the referenced tests and actual operation paths; a nonempty string is not acceptance evidence.

- [ ] Inventory handlers in `App.tsx`, `AgentPanel.tsx`, command bus, domain panels, workflows and property evaluators. Include ephemeral UI controls separately from creative mutations. Map every existing plan operation and every user-facing creative action to its canonical definition or concrete unsupported reason.
- [ ] Add red registry tests: a workflow stub and an inverse-only command are not advertised; a missing renderer property consumer blocks `verified`; duplicate operation IDs fail; new UI actions without entries fail the coverage script.
- [ ] Run `pnpm exec vitest run packages/agent-tools/src/editor-operation-definition.test.ts apps/editor-web/src/joy-agent/editor-operation-registry.test.ts`.
- [ ] Implement typed definitions and host assembly. Keep inverse commands internal. Add compact domain discovery/pagination instead of placing hundreds of schemas in every prompt.
- [ ] Run the tests and `node tooling/release/verify-agent-operation-coverage.mjs`; inspect the generated ledger. Commit only F1 files with `feat(agent): define source-backed operation coverage`.

## F2 — Durable atomic edit authority

**Files**

- Modify: `apps/editor-web/src/editor-session.ts`, `joy-code-compound-compiler.ts`, `joy-code-compound-runner.ts`, `agent-idempotency-store.ts`, `project-operation-ledger.ts`, `project-document-hydration.ts`.
- Create: `apps/editor-web/src/joy-agent/prepared-change-store.ts`, `project-writer.ts`, `execution-receipt.ts`.
- Test: corresponding `.test.ts` files plus `apps/editor-web/src/joy-agent/atomic-recovery.test.ts`.

Prepared changes are immutable, revision-bound compiled results, not mutable model objects. Approval binds project, revision, canonical operation digest, policy version, external-effects declaration and consent scopes. Use canonical deterministic serialization and SHA-256; model-provided IDs/digests cannot supply authority.

```ts
export interface ExecutionReceipt {
  version: 1;
  executionId: string;
  projectId: string;
  operationDigest: string;
  baseRevision: string;
  resultRevision: string;
  writerFence: number;
  status: 'committed';
  changedEntityIds: readonly string[];
  undoEntryId: string;
}
```

- [ ] Add failing tests for mixed timeline/document/graph/artifact changes and exactly one Undo; reject a mutated draft after approval; retry one execution ID after reload without a second edit; distinguish same ID/different digest as conflict.
- [ ] Inject failure before journal write, before durable commit marker, between stores, after commit before response, and during recovery. Expected: complete old state or complete new state with receipt, never success with mixed state.
- [ ] Race two tabs/writers against the same project revision. Use browser Web Locks where supported plus durable revision/fencing validation; fallback must reject stale writers, not assume an in-memory mutex spans tabs. Writer death/reload expires ownership safely.
- [ ] Run `pnpm exec vitest run apps/editor-web/src/joy-agent/atomic-recovery.test.ts apps/editor-web/src/agent-idempotency-store.test.ts apps/editor-web/src/project-operation-ledger.test.ts` red, then extend the current session/journal boundary. Preserve existing split/duplicate/freeze lifecycle behavior and migration.
- [ ] Return receipt identity atomically with the change; postcommit cancellation reports the committed checkpoint. Disable old success-without-commit routes until they use this authority.
- [ ] Run the same tests green, plus existing session/compiler/runner tests; commit `feat(agent): fence and persist atomic execution receipts`.

## F3 — One production runtime, discovery and canonical preparation RPC

**Files**

- Modify: `packages/joy-agent-engine/src/engine.ts`, `tools.ts`, `apps/editor-web/src/joy-agent/engine.worker.ts`, `bounded-tool-loop.ts`, `protocol.ts`, `engine-client.ts`, `tool-bridge.ts`, `context-snapshot.ts`.
- Create: `apps/editor-web/src/joy-agent/host-rpc.ts`, `provider-capabilities.ts`, `run-budget.ts`.
- Test: `apps/editor-web/src/joy-agent/host-rpc.test.ts`, `provider-capabilities.test.ts`, `tests/e2e/agent-director-runtime.spec.ts`.

Consolidate into the reusable engine boundary, porting protections from the currently active Worker. Do not activate the dormant SDK loop without transport/policy parity. Delete redundant loop semantics only after real Worker tests pass. Bump/validate protocol version on both ends; stale cached Worker messages get an actionable reload/reconnect error, not unchecked coercion.

```ts
export type AgentOutcome =
  | { kind: 'answer'; text: string; evidenceIds: readonly string[] }
  | { kind: 'clarification'; question: string }
  | { kind: 'no-op'; reason: string }
  | { kind: 'unavailable'; capability: string; reason: string }
  | { kind: 'prepared'; changeSetId: string; digest: string }
  | { kind: 'committed'; executionId: string; verificationId: string };
```

Read/query tools are paged by domain and frozen revision. Preparation invokes the canonical host compiler while the model can still respond to diagnostics. Structured diagnostics include operation/field/error code, relevant safe facts and retryability. The Worker receives opaque change/evidence references, not writer objects or storage URLs.

- [ ] Red tests: query an asset/clip beyond the first 128 entries; find a title by content; create a title then keyframe its typed output with reversed input array order; receive a compiler range error and repair it without changing state.
- [ ] Test valid answers and clarification with zero edit operations. Keep provider structured-plan capability distinct from user plan-only execution policy. Connection probe must validate a named tool, valid arguments and continuation, not just a nonempty tool-call array.
- [ ] Run `pnpm exec vitest run apps/editor-web/src/joy-agent/host-rpc.test.ts apps/editor-web/src/joy-agent/provider-capabilities.test.ts`.
- [ ] Implement correlated RPC IDs/deadlines, bounded output bytes, validated errors and one versioned budget; cancel outstanding calls by run epoch. Preserve redaction, redirect/CORS protections and no silent provider fallback. Keep encrypted/provider continuation state ephemeral and out of display logs/persistence.
- [ ] Run actual Worker test `pnpm exec playwright test tests/e2e/agent-director-runtime.spec.ts --project=desktop-primary`, existing BYOK security tests and Worker release verifier. Commit `feat(agent): unify runtime with canonical host tools`.

## F4 — Project run controller, conversation and exact lifecycle

**Files**

- Create: `apps/editor-web/src/joy-agent/run-controller.ts`, `run-store.ts`, `run-events.ts` and corresponding tests.
- Modify: `apps/editor-web/src/AgentPanel.tsx`, `App.tsx`, `joy-code-conversation.ts`, `agent-presence.ts`, `agent-ui-targets.ts`, `joy-agent/stage-preview.ts`.
- Test: `tests/e2e/agent-director-lifecycle.spec.ts`.

Controller states: idle, inspecting, preparing, preview-ready, awaiting-approval, committing, verifying, completed, failed, cancel-requested, cancelled and interrupted. It owns run/project/conversation ID, epoch, monotonic sequence, change-set version, receipts and verification. Persist safe checkpoints but never revive an old approval or API key.

Event acceptance contract:

```ts
export interface RunScope {
  projectId: string;
  runId: string;
  epoch: number;
  seq: number;
}
export function isNextEvent(current: RunScope, next: RunScope): boolean {
  return (
    next.projectId === current.projectId &&
    next.runId === current.runId &&
    next.epoch === current.epoch &&
    next.seq > current.seq
  );
}
```

- [ ] Red tests: unmount/remount composer during a run; switch projects then receive an old event; cancel in every state; timeout while awaiting a host call; manual edit after preview; reload after committed-but-unreported result. No duplicate writes, obsolete overlays or false “nothing changed”.
- [ ] Test second-turn “make that title smaller” uses the prior created entity, not guessed IDs; deleted entity causes clarification. Keep per-project conversation migration and explicit reconnect after reload.
- [ ] Run `pnpm exec vitest run apps/editor-web/src/joy-agent/run-controller.test.ts apps/editor-web/src/joy-agent/run-events.test.ts` red; implement controller outside panel mounts and safe typed run/artifact references alongside display text.
- [ ] Wire target events only from actual host operations/jobs. Before/after previews share one immutable bundle across timeline/Inspector/Monitor; require renderer acknowledgement for “preview ready”.
- [ ] Run `pnpm exec playwright test tests/e2e/agent-director-lifecycle.spec.ts tests/e2e/agent-live-presence.spec.ts --project=desktop-primary` green. Commit `feat(agent): own project run lifecycle outside panels`.

## F5 — Complete domain adapters; no advertised stubs

**Files/seams**

- Registry/compiler: F1/F2 files and `apps/editor-web/src/joy-code-operation-references.ts`.
- Timeline/assets: `apps/editor-web/src/timeline-presentation.ts`, `timeline-media-import.ts`, `timeline-nested-playback.ts`, `speed-ramp.ts`, `packages/commands/src/`, `packages/media-core/src/`.
- Inspector/motion: `packages/property-system/src/`, `packages/motion-core/src/commands.ts`, `packages/expression-core/src/`, `apps/editor-web/src/components/PropertyRow.tsx`, `apps/editor-web/src/InspectorPanel.tsx`.
- Effects/color/transitions: `apps/editor-web/src/effects-apply-state.ts`, `joy-code-transition-operations.ts`, domain packages located by the coverage inventory.
- Text/captions/audio: `packages/project-schema/src/text-style.ts`, `caption-style.ts`, `audio.ts`, `packages/audio-core/src/`, editor `AudioPanel.tsx`, `audio-studio-runtime.ts`, text/caption handlers inventoried in F1.
- Camera/3D/HTML: `packages/camera-core/src/scene.ts`, `packages/html-scene-runtime/src/manifest.ts`, `scene-inputs.ts`, editor scene owners located by F1.
- Jobs/workflows: `apps/editor-web/src/workflow-runner.ts`, `joy-agent/media-job-bridge.ts`, `agent-worker-job-client.ts` and current export/import service seams in `App.tsx`.
- Create tests: `apps/editor-web/src/joy-agent/domain-parity.test.ts`, `tests/e2e/agent-director-domain-parity.spec.ts`.

Implement each row below as a separate tracked slice, using the exact operation definitions and source locations in F1's checked-in ledger. Do not create generic `setAnything` tools to shorten the work.

| Slice                     | Required operations and counterexamples                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Timeline/assets/project   | Tracks and clips create/read/update/remove; split/duplicate/freeze/trim/move; source ranges, media-family placement, nesting/speed/reverse; import/relink/dependency checks. Reject cycles and cross-project IDs; preserve linked state/animations/audio     |
| Inspector/keyframes       | Discover/evaluate/set supported property bindings; insert/update/remove/reorder keys; interpolation/easing/curves and supported expressions. Validate type/unit/range/owner/time domain, locked fields, nested/reversed/remapped timing; reject arbitrary JS |
| Effects/color/transitions | Catalog/query/add/remove/reorder/enable/parameter changes; animatable bindings only with evaluator/renderer support; transition junction constraints. Verify actual changed frames, not just descriptor edits                                                |
| Text/captions/audio       | Rich text/RTL/free-font styles; word/segment timing and burn-in; tracks/buses/gain/pan/mute/automation and implemented processing. Verify pixels and decoded/mixed samples; never promote audio computation with no commit                                   |
| Camera/3D/HTML            | Existing supported persisted scene/node/material/camera/typed manifest editing; declared variables/dependencies and actual staged render. Reject unsafe executable input and missing render adapter, not substitute placeholders                             |
| Workflows/jobs/export     | Real prepare/submit/status/cancel/reconcile/output import; task instance/checkpoint/provenance; export preflight. Ambiguous paid submit reconciles before retry. Local Undo never implies refund or deletion of external output                              |

- [ ] For each slice, add red tests for selected/nonselected/newly-created targets, malformed input, unsupported capabilities, no-op, policy denial, staging, approval, commit, Undo/Redo, reload, stale revision and actual output readback. Use table-driven cases in `domain-parity.test.ts`; each case references a concrete operation ID and source fixture from the ledger.
- [ ] Run `pnpm exec vitest run apps/editor-web/src/joy-agent/domain-parity.test.ts`. Implement one operation at a time using shared human/agent compilation; never edit a second hidden state store.
- [ ] Wire per-domain real preview and semantic activity consumers, including exact Inspector curve/property, effect instance, audio lane and scene node. Mark unsupported platform functions unavailable rather than regress manual editing.
- [ ] Run `pnpm exec playwright test tests/e2e/agent-director-domain-parity.spec.ts --project=desktop-primary` and ledger verification after each slice. Commit with that domain name and evidence.
- [ ] Close F only when every in-scope creative UI action has a verified mapping or a justified existing platform limitation approved in review. An unimplemented adapter for a working advertised editor feature is unfinished scope, not a completed limitation.

## O1 — Evidence identity, timing and coverage algebra

**Files**

- Create: `packages/media-core/src/observation.ts`, `observation-coverage.ts`, `observation-cache-key.ts`, corresponding tests and exports in `index.ts`.
- Reuse: `packages/project-schema/src/time.ts`, `model.ts` time mapping; never infer source PTS from nominal frame rate.

Core types (extend with bounded runtime schemas; no raw paths/URLs):

```ts
export interface FrameIdentity {
  assetDigest: string;
  streamId: string;
  presentationIndex: number;
  ptsTicks: string;
  timebaseNumerator: number;
  timebaseDenominator: number;
  sourceTimeUs: number;
  durationUs: number;
}
export interface EvidenceCoverage {
  mode: 'overview' | 'focus' | 'exhaustive' | 'provider-video';
  intendedFrameIds: readonly string[];
  decodedFrameIds: readonly string[];
  submittedFrameIds: readonly string[];
  reviewedFrameIds: readonly string[];
  status: 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
  omittedReason?: string;
}
export function hasExhaustiveInputCoverage(c: EvidenceCoverage): boolean {
  if (c.mode !== 'exhaustive' || c.status !== 'complete' || c.intendedFrameIds.length === 0)
    return false;
  const decoded = new Set(c.decodedFrameIds);
  const submitted = new Set(c.submittedFrameIds);
  const reviewed = new Set(c.reviewedFrameIds);
  return c.intendedFrameIds.every((id) => decoded.has(id) && submitted.has(id) && reviewed.has(id));
}
```

Arrays illustrate the public bounded page contract, not storage for all frames of a feature film. Back it with paged frame-index manifests and interval/bitmap coverage in the local store; verify whole-manifest completion without loading everything into memory. “Reviewed” means input tied to a completed model analysis, not a guarantee of model comprehension. Overall findings must still indicate uncertainty.

- [ ] Red unit examples: exhaustive intended `[a,b,c]`, reviewed `[a,c]` is false; duplicate `[a,a,c]` does not cover `b`; provider-video mode is false even if it spans first/last timestamp; cancelled/zero-frame requests are false.
- [ ] Test integer/rational conversion, half-open ranges, duplicate PTS disambiguated by presentation index, frame spanning a requested boundary, invalid negative/NaN/overflow inputs, and cache separation for crop/rotation/proxy/model/analysis version.
- [ ] Run `pnpm exec vitest run packages/media-core/src/observation-coverage.test.ts packages/media-core/src/observation-cache-key.test.ts`; implement schemas, typed findings and digests.
- [ ] Keep source and composition identities separate; composition adds revision, composition ID, output time, renderer/evaluator version and dependency digests. Privacy origin flags distinguish user/reference/synthetic artifacts.
- [ ] Run green and commit `feat(media): define timestamped observation evidence`.

## O2 — Exact browser decode adapter and resource scheduler

**Files**

- Create: `apps/editor-web/src/media-observation/source-decoder.ts`, `browser-sample-decoder.ts`, `observation.worker.ts`, `resource-scheduler.ts`, `observation-protocol.ts` and their tests.
- Modify: `apps/editor-web/src/project-media-resolver.ts`, `timeline-frame-store.ts`, `bounded-decoder-pool.ts` only where shared lifetime/budget seams require it; editor `package.json`, lockfile and notices if adopting the candidate.
- Test: `tests/e2e/agent-observation-decode.spec.ts`.

```ts
export interface ObservationFrame {
  id: string;
  requestedTimeUs?: number;
  actualTimeUs: number;
  presentationIndex: number;
  width: number;
  height: number;
  close(): void;
}
export interface SourceObservationDecoder {
  frames(
    range: { startUs: number; endUs: number },
    signal: AbortSignal,
  ): AsyncIterable<ObservationFrame>;
  close(): void;
}
```

- [ ] Pin/test the candidate browser demux/decode package against O1 fixtures before wiring the agent. Record version/license, bundled size, worker compatibility, codec/browser support and sample timestamps in `docs/reviews/joy-observation-decoder-selection.md`. Mediabunny is the selected first candidate, not an already-installed dependency. Do not add optional codec packages without their own review.
- [ ] Red tests use real fixture bytes: exact presentation order and frame count, B-frames/VFR/nonzero origin, portrait orientation/SAR, end-boundary behavior and the single-frame flash. Unsupported codec and corrupted source produce structured errors, never static reference frames.
- [ ] Run `pnpm exec playwright test tests/e2e/agent-observation-decode.spec.ts --project=desktop-primary` red; implement the adapter and assert actual decoder-returned timestamps. A source index is a presentation sample identity, not a request counter.
- [ ] Build a dedicated observation worker/pool; do not seek the live Monitor video element. Add byte/in-flight limits, playback priority, cancellation, timeout and `finally` closure for decoded frames/bitmaps/audio. Stream source/ranges; no entire-video RGBA array.
- [ ] Add epoch cancellation to media resolution so clear/relink/project switch cannot repopulate stale URLs/evidence. Revoke only owned object URLs. Guard original/proxy/version cache identity; never call a proxy “original detail”.
- [ ] Run resource tests for cancel, error, queue backpressure, large frames and repeated project switches; verify zero owned live samples after terminal cleanup. Run real browser fixture tests green and record resource/playback budgets. Commit `feat(media): stream exact observation frames in browser`.

The existing HTML decoder may remain a playback tier. If changed, add the high-readyState seek regression with awaited actual presentation, same-time handling, source generation, timeout/abort and existing playback tests. It must not become the exact evidence tier merely by changing its returned timestamp field.

## O3 — Overview, focus, exhaustive review and local evidence storage

**Files**

- Create: `apps/editor-web/src/media-observation/observation-service.ts`, `sampling-policy.ts`, `evidence-store.ts`, `observation-cache.ts`, `evidence-batches.ts`, corresponding unit tests.
- Test: `tests/e2e/agent-observation-coverage.spec.ts`.

Overview selects chronological scene/event samples with start/end coverage, bounded dedup and explicit omitted counts. Focus resolves exact source frames and neighboring sequence/crops. Exhaustive mode disables semantic frame dropping, enumerates the intended interval, batches every intended frame and checkpoints completed responses. Duplicate encoded images may share storage but keep every temporal identity; dedup cannot erase semantic input coverage silently.

- [ ] Red coverage cases: a capped overview must not say “all frames”; a 100-frame batch interrupted at 60 resumes missing identities only; failed provider response leaves submitted but unreviewed frames; retries do not inflate totals; dedup holds still-frame duration identity.
- [ ] Run `pnpm exec vitest run apps/editor-web/src/media-observation/sampling-policy.test.ts apps/editor-web/src/media-observation/evidence-batches.test.ts`.
- [ ] Implement selection policies and paged local manifests with quota handling. Default ephemeral storage; explicit local persistence preference for analysis metadata. Cache reads revalidate asset/revision/model/prompt-policy identities; clearing is scoped to derived analysis, never originals.
- [ ] Provide bounded query APIs: `media.describe`, `media.observe`, `media.frames`, `media.transcript`, `evidence.read`, `evidence.coverage`, `evidence.clear`. Each request validates project/run scope, asset/range and budgets. `evidence.clear` requires user intent, not a model cleanup shortcut during a still-active review.
- [ ] Run `pnpm exec playwright test tests/e2e/agent-observation-coverage.spec.ts --project=desktop-primary` for overview then exact focus on a deliberately missed flash; exhaustive failure/resume; quota exceeded and stale asset replacement. Commit `feat(media): add honest adaptive and exhaustive observation`.

## O4 — Audio, transcripts and temporal synchronization

**Files**

- Create: `packages/audio-core/src/observation-analysis.ts`, `beat-envelope.ts`, corresponding tests; editor `media-observation/audio-observer.ts`, `transcript-evidence.ts` and tests.
- Reuse: `packages/audio-core/src/analysis.ts`, `apps/editor-web/src/local-transcription.ts`, `audio-studio-runtime.ts`; use existing caption time primitives.

Produce sample-count/rate/timebase-aware audio windows, peaks, silence, RMS and basic onset/envelope analysis locally. Preserve channel layout, source offsets and composition time mapping. Beat estimates carry confidence and algorithm version; silence/speech may have no valid beat grid. A transcription job is distinct from listening to actual audio.

- [ ] Red tests: known impulse at 500 ms maps to expected source/composition time through trim/reverse/speed; silent audio has no invented beats; stereo analysis does not drop a channel; transcript words remain ordered/in-range; reference fixture can never satisfy user-media evidence.
- [ ] Run `pnpm exec vitest run packages/audio-core/src/observation-analysis.test.ts packages/audio-core/src/beat-envelope.test.ts apps/editor-web/src/media-observation/transcript-evidence.test.ts`.
- [ ] Implement bounded audio window extraction with source sample counts and declared resampling. Keep ASR provider choice explicit and consented; existing server transcription is not silently repurposed as direct-BYOK private analysis. Unsupported local ASR is shown honestly; optional engine download requires an explicit size/privacy choice.
- [ ] Label existing approximate loudness as RMS/approximate, not certified LUFS. If delivery requires BS.1770, implement/use a vetted compliant adapter with reference conformance fixtures before offering that verification predicate; otherwise declare that predicate unavailable.
- [ ] Test video/audio drift against a synchronized flash/impulse fixture and mixed exported output; commit `feat(audio): add timed evidence and bounded motion envelopes`.

## O5 — Explicit multimodal BYOK sharing and capability probes

**Files**

- Create: `apps/editor-web/src/joy-agent/observation-consent.ts`, `multimodal-transport.ts`, corresponding tests.
- Modify: F3 provider capabilities/protocol/Worker; existing Agent Settings connection components found by F1 inventory; retain success notification and explicit connection state.
- Test: `tests/e2e/agent-observation-privacy.spec.ts`, existing `agent-byok-security.spec.ts`.

```ts
export interface ObservationConsent {
  projectId: string;
  runId: string;
  endpointOrigin: string;
  modelId: string;
  evidenceIds: readonly string[];
  modalities: readonly ('image' | 'audio' | 'video' | 'transcript')[];
  maxRequests: number;
  maxBytes: number;
  expiresAtMs: number;
}
```

The host issues this envelope after user approval; model JSON cannot grant it. Capability probes use synthetic/public test artifacts with explicit disclosure, never owner's footage. Probe image, audio/video and valid tool continuation separately. Text-only models remain useful for structural editing but cannot claim visual review.

- [ ] Red tests: connected key without media consent sends zero media; range/model/origin expansion invalidates consent; redirects and malformed endpoint fail; text-only provider cannot receive image data; cancellation prevents later batches; expired approval cannot resume after reload.
- [ ] Run `pnpm exec vitest run apps/editor-web/src/joy-agent/observation-consent.test.ts apps/editor-web/src/joy-agent/multimodal-transport.test.ts`.
- [ ] Implement direct bounded payload generation to the configured approved provider. Default to explicit frame batches; optional native video has separate size/format support and `provider-video` coverage. No public upload URL workaround and no secret-bearing file, request log, project artifact or JOY-server proxy.
- [ ] Show request/frame/byte/audio budgets and estimated/unknown price before transfer, with action to narrow range. No hidden paid fallback. Provider-side retention cannot be promised away; display the selected provider policy link.
- [ ] Run `pnpm exec playwright test tests/e2e/agent-observation-privacy.spec.ts tests/e2e/agent-byok-security.spec.ts --project=desktop-primary`. Inspect network/storage using dummy canary credentials only; sanitized failure reports must redact request bodies. Commit `feat(agent): gate multimodal requests by explicit consent`.

## O6 — Real composition capture and encoded-output verification

**Files**

- Create: `apps/editor-web/src/media-observation/composition-observer.ts`, `render-verification.ts`, tests; `tests/e2e/agent-director-render-verification.spec.ts`.
- Modify: existing render-service seams extracted narrowly from `apps/editor-web/src/App.tsx`; `packages/render-ir/src/` only if the current contract lacks required diagnostics; reuse `packages/renderer-pixi/src/browser-export.ts`, current headless/export adapters and ADR-0004.

Capture frozen canonical or prepared composition state at exact output times through the same evaluator/render path. Require asset/font/shader/scene readiness and include unavailable/approximation diagnostics. Source observations alone cannot verify composed titles, transitions or color.

- [ ] Red tests: title opacity/keyframe changes alter expected pixels; Before retains canonical pixels; transition boundary/time-remap/nested scene produce expected rendered sequence; a missing font/scene/asset blocks successful visual verification.
- [ ] Run `pnpm exec vitest run apps/editor-web/src/media-observation/composition-observer.test.ts apps/editor-web/src/media-observation/render-verification.test.ts`.
- [ ] Implement isolated render capture with shared RenderFrameIR inputs and explicit revision/version identity. Keep readback free of selection outlines, agent highlights and DOM UI; capture cannot change user playhead/selection/history. Reuse actual audio mix for composition measurements.
- [ ] Decode the **final encoded export**, not just its source canvas: assert container/dimensions/duration/frame PTS, black/missing frames, title/effect presence and audio track/synchronization against fixture tolerances. If real-time MediaRecorder drops timing, fix the export seam or provide an explicitly gated deterministic adapter; do not waive the defect because the recording event completed.
- [ ] Run `pnpm exec playwright test tests/e2e/agent-director-render-verification.spec.ts --project=desktop-primary` green; repeat with supported export path and reference frame/audio measurements. Commit `feat(agent): verify composed and encoded media results`.

## V1 — Real skills and an evidence-aware editing loop

**Files**

- Create: `packages/agent-tools/src/creative-skill.ts`, `creative-skills.ts`, tests; `apps/editor-web/src/joy-agent/skill-runner.ts`, `director-verifier.ts`, corresponding tests.
- Modify: `apps/editor-web/src/joy-agent/entry-points.ts`, run controller, `AgentPanel.tsx`, `workflow-runner.ts`, `joy-code-conversation.ts`.
- Test: `tests/e2e/agent-director-skills.spec.ts`.

Skill manifest: ID/version/title, typed inputs, context selectors, required operation IDs, evidence needs, capability/privacy/budget requirements, deterministic procedure checkpoints, preview/postconditions and acceptance fixture IDs. A recipe cannot increase permissions. Available skills are computed from verified adapters, not metadata titles.

- [ ] Implement and test these procedures, each in its own recipe entry: Creative Brief → structured artifact; Watch and Map → evidence map; Find Moment → cited exact interval; Build Rough Cut → source ranges/typed assembly; Title and Caption Polish → readable text/RTL/keyframes; Motion and Transition Polish → exact property/junction edits; Audio Balance → measured mix; Verify Deliverable → render/audio/export predicates.
- [ ] Red tests reject a skill whose required operation is unavailable; reject hostile OCR/transcript/instruction-pack text asking for keys or uploads; an answer/no-op must create zero edit/job effects. Creative Brief attaches to the same project conversation instead of generating an unrelated mode/history.
- [ ] Run `pnpm exec vitest run packages/agent-tools/src/creative-skill.test.ts apps/editor-web/src/joy-agent/skill-runner.test.ts apps/editor-web/src/joy-agent/director-verifier.test.ts`.
- [ ] Implement observe → propose → canonical prepare/repair → preview → authority → commit → verify. Findings contain evidence IDs and uncertainty; verification statuses distinguish structural/rendered/audio-measured/model-reviewed/user-approved. Subjective beauty is not a Boolean schema pass.
- [ ] Test two repair proposals maximum by default; each uses a new revision/digest and applicable approval. User correction or new manual edit invalidates stale repair. Stop preserves committed checkpoints and bills; ambiguous paid jobs reconcile before any resubmit.
- [ ] Run `pnpm exec playwright test tests/e2e/agent-director-skills.spec.ts --project=desktop-primary` with the real Worker. Commit `feat(agent): run evidence-aware creative skills`.

## V2 — Truthful activity and evidence UI

**Files**

- Create: `apps/editor-web/src/AgentEvidenceFilmstrip.tsx`, `AgentEvidenceFilmstrip.test.tsx`, `AgentObservationConsent.tsx`, associated scoped CSS and tests.
- Modify under `apps/editor-web/src/`: `AgentPanel.tsx`, `AgentActivityIndicator.tsx`, `AgentPreviewBadge.tsx`, `AgentTimelineOverlay.tsx`, `TimelinePanel.tsx`, `InspectorPanel.tsx`, `components/PropertyRow.tsx`, existing exact target consumers from F5.
- Test: `tests/e2e/agent-director-ui.spec.ts`.

- [ ] Add red UI tests for active read range vs proposed edit range, exact property highlight, evidence card timestamp/coverage labels, hidden-tab badge and an independently movable review cursor. The user playhead is unchanged with Follow off.
- [ ] Show “Reading selected frames”, “Preparing title opacity”, “Awaiting approval”, “Verifying export” only from real corresponding events. Progress comes from measured completed/total units; unknown total is indeterminate. A CSS welcome animation cannot generate work state.
- [ ] Place evidence in an optional collapsible filmstrip inside the existing single project conversation. Keep composer input anchored; do not create new history/Brief/3D tabs or reintroduce the large logo/layout regressions. Controls have keyboard labels and focus; text wraps at narrow panel widths.
- [ ] Add reduced-motion static status, restrained live announcements and Persian/RTL fixtures. Preserve track identity icons and hover-only track actions, icon-only compact aspect control, centered composer bounds and API connection success notification.
- [ ] Run `pnpm exec playwright test tests/e2e/agent-director-ui.spec.ts --project=desktop-primary --project=desktop-compact --project=desktop-minimum`, plus component tests. Capture screenshots with synthetic fixture data, not owner keys/media. Commit `feat(agent-ui): show real work and inspectable media evidence`.

## V3 — R1 acceptance and review bundle

- [ ] Run every F/O/V test and the master full-suite/build/security/performance checks at one exact candidate. Use long-media, low-memory, offline/cache-miss, codec error, stale session, two writer and project-switch cases.
- [ ] Demonstrate: find the single-frame flash via exact mode; construct a rough cut using observed source ranges; refine a created Persian title over two turns; animate property/effect/transition; balance real audio; operate on persisted 3D/HTML supported content; verify encoded output and one Undo/reload.
- [ ] Prove overview says sampled, native video says unknown/provider coverage, exhausted budget says partial, and missing modalities never say watched/heard. Prove the same trusted operation path is used by a manual control and a skill.
- [ ] Record real BYOK model/endpoint/date/capability tests only with separately authorized test credentials, footage and spend cap. If no authorized model is available, label live compatibility/creative evaluation blocked; deterministic tests cannot substitute for it or claim full live acceptance.
- [ ] Update the earlier foundation plan with a dated evidence addendum rather than rewriting historical results. Update coverage ledger and limitations from actual results.
- [ ] Follow the master **stop-before-deploy** bundle and independent Opus review gate. R2/R3 remain open until their tasks and evidence pass.
