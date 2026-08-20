# WP-37 — AI Creative OS Foundation: Semantic Project Intelligence and Critique

**Status:** the bounded Creative Brief/runtime/editor surface is closed and deployed; autonomous free-form video-cut execution remains a separate WP-38 follow-up. The original G0 GBrain operational checklist remains explicitly deferred rather than silently marked complete.
**Authoring date:** 2026-08-17  
**Product direction:** JOY Media becomes an AI-native creative workspace: a human and an AI designer operate on the *same editable project*. It is not an MP4 generator and it is not a UI-clicking bot.

This document is the next-agent execution plan after WP-36. It turns the owner’s north-star direction into bounded, reviewable work packages without reopening completed Timeline, Worker, provider, or agent foundations.

## 1. Why this is the right next milestone

WP-36 completed the managed, universal Timeline deck and durable label semantics. The current product already has the important mechanical foundations:

- a persisted, editable project and universal Timeline;
- deterministic command/undo semantics and an agent command envelope;
- preview/export, local Worker, asset delivery, jobs, workflows, and provider seams;
- an Agent/approval surface and asynchronous generation provenance;
- a live immutable-release deployment process.

The missing high-value layer is not another individual AI button. It is the ability for the agent to understand a project as a creative object, produce an auditable plan, apply only approved semantic commands, inspect a preview, and propose a bounded repair. That is the difficult, differentiating part of the target architecture.

The intended loop is:

```text
Human intent
  -> semantic project snapshot
  -> agent plan (no mutation)
  -> policy + human approval
  -> deterministic commands / asynchronous jobs
  -> editable project revision
  -> low-resolution preview and structured critique
  -> optional, separately approved repair plan
  -> export
```

The model chooses *what* should change. JOY Media’s command engine, renderer, and Worker remain responsible for *how* it changes. No model or agent may drive the editor DOM as an editing mechanism.

## 2. Measured starting point (do not overwrite with stale handoffs)

Reconfirm these facts at the beginning of the next session; they are a planning snapshot, not a substitute for verification.

| Area | Observed 2026-08-17 | Consequence for WP-37 |
| --- | --- | --- |
| Product source | The local `joy-media-fix` checkout and `/opt/joy-media/repo` both resolve to `0287946` (`Record WP-36 GBrain reconciliation`). The deployed WP-36 product revision is `733f584`. | Begin with a clean, fast-forwarded checkout; never assume a historic handoff commit is current. |
| Product state | WP-36 is marked finished: managed V/A runways, persisted deck metadata, color labels, lock state, shared human/Agent synchronization, reorder, and guarded keyboard delete. | Reuse these contracts. Do not reintroduce generic track CRUD, virtual lanes, or kind-specific timeline assumptions. |
| Release health | `joy-media@api` is active on loopback `:8790`; `gbrain-http` is active on `10.250.99.1:3131`; the public editor is `https://joyst.ir`. | Product deployment stays through JOY Media’s immutable release procedure, not direct edits to `/opt/joy-media/web`. |
| GBrain | HTTP health is `ok`, PGLite-backed, version `0.42.59.0`. `doctor --fast --json` reports health score 85/100. It warns about a missing retrieval-reflex host path and an unresolved historical post-upgrade migration. A newer version (`0.46.12.3`) is available. | GBrain work is an explicit operational gate, not a silent prerequisite or an unreviewed upgrade. |
| GBrain content quality | `joy-media-state` is approximately 336 KB, far above GBrain’s 50 KB page-warning threshold. The WP-36 reconciliation page is also approximately 56 KB. | Repair the knowledge shape before treating GBrain as a reliable planning/retrieval input. Do **not** keep appending full release histories to one page. |
| Link context | The original shared ChatGPT URL cannot currently be fetched. The owner supplied its content separately. | This plan uses that supplied vision as the product direction; do not claim the inaccessible URL was verified. |

### Safety facts

- The Sweden host was rebuilt after the 2026-07-26 compromise. Use `ssh sweden` and the current host key only. Do not reuse old IPs, keys, backups, or host fingerprints.
- JOY Media product code belongs in its own repository. The `joy-vps` repository is only the identity/operations sibling; never edit `/opt/joy-wg-bot` directly.
- Browser, agent, plugin, project, and prompt data must never contain provider keys, Worker credentials, object-store references, or protected KiloCode credentials.
- Do not upgrade GBrain, run migrations, enable `retrieval-reflex`, or install a host integration during WP-37 without a reviewed backup/rollback plan and explicit owner authorization. Those change shared VPS behavior.

## 3. Product contract and non-negotiable invariants

### 3.1 The user-visible outcome

From an existing editable project, a user can ask:

> “Make this 30-second Instagram Reel feel 20% more premium without changing its structure.”

JOY Media returns a reviewable creative brief and a proposed change set that names the affected scenes, assets, clips, captions, brand rules, and expected result. In the first slice it does **not** make changes automatically. After approval, existing semantic commands make the allowed reversible changes. The project remains editable in Timeline, Inspector, Motion, Audio, and Assets.

### 3.2 Architecture invariants

1. **Canonical project state remains authoritative.** The semantic representation is a versioned, read-only projection of persisted project state; it is never a second editable project model.
2. **All mutations remain commands.** An agent produces typed intent/tool calls which resolve to existing command transactions or explicitly approved asynchronous jobs. It cannot synthesize DOM events, mutate React state, write storage directly, or call an undocumented endpoint.
3. **Plan before execution.** Every nontrivial request has a durable snapshot revision, plan ID, stated assumptions, risk/cost classification, and preconditions before any mutation.
4. **Approval is bound, not conversational.** Approval grants bind to the exact plan and revision. A changed project requires a re-plan. “Autopilot” remains bounded by the policy system; remote egress, spend, overwrite, export, file writes, and destructive actions remain separately gated.
5. **Generated output has provenance.** Generated assets and provider jobs preserve provider/model/version, prompt, inputs/hashes, parameters, cost, timestamps, and opaque asset reference. Undo removes a reference from the project; it does not pretend to refund a paid generation.
6. **Preview critique is advice first.** A critic never edits the project directly. It returns structured observations tied to timestamps/evidence and can create a separate repair proposal only.
7. **Editable delivery is the product.** Export is a leaf operation. The project, its assets, timeline bindings, parameters, and provenance must remain inspectable and editable after every agent run.
8. **Provider-neutral core.** Project commands use JOY concepts such as `createVisualAsset`, `placeAsset`, `setCaptionStyle`, and `setGrade`; no domain command mentions a vendor such as Higgsfield, Kling, Veo, or OpenAI.
9. **No secrets or public asset locations cross boundaries.** Provider selection and credential resolution remain server-side; the browser receives only policy-safe status, opaque IDs, bounded errors, and signed/brokered bytes where already designed.
10. **No fake success.** A capability with no executable local/remote route is shown as unavailable or setup-required and cannot return fabricated results.

## 4. Scope boundaries

### Included now

- GBrain information-quality remediation plan and a read-only baseline report.
- A versioned semantic project snapshot that can describe scenes, timeline elements, assets, captions, audio, brand rules, and project goal without duplicating canonical state.
- A deterministic snapshot-to-brief/critique contract with fixtures and a read-only agent integration.
- A constrained “Improve project” planning path which produces proposals, not changes.
- The policy, provenance, revision, and quality gates needed for the next implementation step.

### Explicitly excluded from WP-37

- New cloud-video provider integrations or paid-provider credentials.
- Autonomous “make me a video from nothing” execution.
- A generic graph database inside the editor, real-time collaboration, marketplace work, or a second workflow designer.
- Replacing the Timeline, universal track deck, preview renderer, Worker control plane, agent host, or existing approval architecture.
- An unreviewed GBrain upgrade, database migration, shared-host installation, or deletion of historical knowledge.
- Brand-kit authoring UI redesign. WP-37 may consume the existing canonical brand data and report missing fields; it must not invent a parallel brand store.

## 5. Work-package order

Only one package is active at a time. Each package gets a separate, reviewable commit and a corresponding `STATE.md` update. If an invariant requires changing, stop and add an ADR or decision request instead of widening the implementation.

| Order | Package | Deliverable | Deploy? |
| --- | --- | --- | --- |
| G0 | Knowledge-quality baseline and GBrain remediation | Small, linked GBrain pages; read-only quality report; no upgrade | No, except an explicitly authorized GBrain-only maintenance window |
| S1 | Semantic Project Snapshot contract | Read-only, versioned canonical projection with fixtures | No |
| S2 | Scene/brand inference and validation | Deterministic derived descriptors with explainable warnings | No |
| S3 | Creative brief and read-only critique | Typed recommendations tied to snapshot evidence | No |
| S4 | Constrained agent planning surface | “Improve project” produces a revision-bound proposal, no mutations | Yes, after local gate and authenticated browser proof |
| S5 | Approved low-risk execution bridge | Existing command transactions execute an accepted bounded proposal | Yes, only after S4 is accepted |
| V1 | Preview/critique repair loop | Low-res render → structured critic → separate repair proposal | Yes, only after owner approves its vision/provider/privacy policy |
| P1 | First provider-backed creative job | One provider-neutral job route and one approved provider implementation | Yes, separately authorized |
| W1 | Record-to-skill workflow | Save a successful approved run as a parameterized workflow | Yes, after P1 or when current workflow contracts prove it is ready |

The next implementation agent must implement **G0 and S1 only**, unless the owner explicitly asks them to continue. S2–W1 are design-locked follow-ons, not implied authorization to do a giant feature branch.

## 6. G0 — GBrain knowledge-quality baseline and remediation

### Goal

Make the information that future agents retrieve short, canonical, linked, and truthful. GBrain informs human planning and product operations; it is not the runtime source of truth for an open media project.

### G0.1 Read-only audit

Run from the VPS with no mutation:

```bash
gbrain doctor --fast --json
gbrain health
gbrain stats
gbrain sources list
gbrain orphans --count
gbrain jobs stats
gbrain list -n 200
```

If a PGLite command blocks, time-box it, record the timeout, and do not kill or restart the production service as a convenience. Use HTTP `/health`, service logs, and the existing audit files for the report instead.

Record:

- command versions, exact health/doctor output, service bind address, and data size;
- source list and whether the JOY Media repository is actually registered/synced;
- page, link, tag, embedding, and orphan counts when available;
- the exact page IDs over the warning threshold and the reason; and
- unresolved shared-service issues: retrieval-reflex warning, historic upgrade failure, and available version.

Never print bootstrap tokens, environment files, URLs containing credentials, or the contents of private configuration.

### G0.2 Replace the monolithic Media status page

Do not delete `joy-media-state` in this package. First create a reversible, linked information architecture:

```text
joy-media-index
├── joy-media-current-state              (<10 KB; current revision, deployed release, open work)
├── joy-media-architecture-index         (<10 KB; ADR and package map)
├── joy-media-release-index              (<10 KB; links one page per release)
├── joy-media-quality-index              (<10 KB; test/reliability summaries)
├── joy-media-wp36-managed-...           (split summary + linked evidence chunks)
└── joy-media-history-YYYY-MM             (append-only monthly archive shards)
```

Rules:

- The current-state page contains only current truth and links; it is not a journal.
- Each release page contains source SHA, artifact/release paths, test totals, high-level proof, rollback reference, and links to evidence—not entire command logs or a copied `STATE.md`.
- Put large browser logs, screenshots, and checksums in repository QA evidence or files, and link them with a short summary. Do not paste huge markup into a GBrain page.
- Preserve old page content until the new index is reviewed. If deprecation is desired later, replace the old body with a compact pointer only after export/backup and owner approval.
- Use explicit typed links (`supersedes`, `evidence_for`, `implements`, `related_to`) between the index, release records, relevant ADRs, and current plan.

### G0.3 GBrain operational decision gate

Create `docs/qa/gbrain/` evidence (or the repository’s current equivalent) and a short GBrain report page. Do not run these actions in G0 without owner approval:

- `gbrain self-upgrade` or any migration/apply-migrations command;
- enabling autopilot/nightly probes or installing `retrieval-reflex` into a host repository;
- modifying shared GBrain service configuration or bind address;
- bulk-deleting/rewriting pages.

The report must frame the choices:

| Decision | Recommendation | Why |
| --- | --- | --- |
| Upgrade from 0.42.59.0 | Schedule separately with snapshot, compatibility/readiness check, migration dry-run or documented recovery, and service rollback | There is a recorded historical post-upgrade failure. |
| Retrieval reflex | Do not install into JOY Media by default | The warning proves no visible host path; a new host integration affects shared agent behavior and needs a design/permission review. |
| Oversized pages | Split/index now | This is safe, reversible, and directly improves retrieval quality. |
| Runtime project access | Keep out of GBrain | The editor’s persisted project and revision system is the authoritative live model; GBrain is too indirect and stale for command preconditions. |

### G0 exit criteria

- [ ] Read-only audit evidence exists and does not expose secrets.
- [ ] Every current JOY Media fact is retrievable from a small index/current-state page.
- [ ] The new pages are under 50 KB each, linked, tagged, and no current status page duplicates raw logs.
- [ ] Old oversized pages remain recoverable; no destructive rewrite occurred without approval.
- [ ] The unresolved GBrain upgrade/retrieval-reflex issues are explicitly recorded as deferred operational decisions.
- [ ] `STATE.md` has only a terse, accurate pointer to the new evidence—not a copied report.

## 7. S1 — Semantic Project Snapshot contract

### Goal

Define one read-only, versioned snapshot that lets a planner or critic reason about the project without scraping UI state and without needing proprietary provider details. It must be derived from canonical persisted state at a specific revision.

### Discovery before code

The implementation agent must inspect, not assume, the current contracts in:

- `packages/project-schema/` and persistence/migration code;
- `packages/timeline-engine/`, universal Timeline/deck projection, and current element-family routing;
- `packages/commands/` command registry and transaction/undo semantics;
- `packages/agent-tools/` agent plan, policy, job/provenance, and KiloCode-host contracts;
- `apps/editor-web/src/agent-command-bus.ts`, Agent panel/history/composer, project factory/session, and preview/export integration;
- ADR-0019 through ADR-0035, particularly project persistence, command transactions, agent host, generation provenance, universal Timeline, and brand/asset decisions;
- `STATE.md` top handoff, `ORCHESTRATION.md`, and the current WP-36 evidence.

The output of discovery is a short architecture note answering:

1. Which persisted project source and revision ID are canonical?
2. Where should a read-only projection live without inverting package dependencies?
3. Which existing fields already carry assets, clips, captions, audio, animation, brand data, generated provenance, and element-to-track bindings?
4. Which project/asset information is intentionally unavailable to an agent for privacy or authorization reasons?
5. Which current plan/approval types can host a read-only proposal without duplicating the agent workflow?

If the answer requires a new cross-package dependency, stop for an ADR instead of importing editor-web code into a core package.

### Proposed contract

Names are tentative until discovery confirms package ownership. The central shape is deliberately serializable, bounded, and safe for model context:

```ts
type SemanticProjectSnapshotV1 = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly revisionId: string;
  readonly capturedAt: string;
  readonly composition: {
    readonly durationUs: number;
    readonly frameRate: { readonly numerator: number; readonly denominator: number };
    readonly width: number;
    readonly height: number;
    readonly aspectRatio: string;
  };
  readonly goal?: { readonly destination?: string; readonly durationTargetUs?: number; readonly brief?: string };
  readonly brand: BrandSummaryV1;
  readonly scenes: readonly SceneSummaryV1[];
  readonly timeline: TimelineSummaryV1;
  readonly assets: readonly AssetSummaryV1[];
  readonly capabilities: Readonly<Record<string, 'ready' | 'setup-required' | 'unavailable'>>;
  readonly warnings: readonly SnapshotWarningV1[];
  readonly truncation: SnapshotTruncationV1;
};

type SceneSummaryV1 = {
  readonly id: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly purpose?: 'hook' | 'problem' | 'explanation' | 'proof' | 'cta' | 'unknown';
  readonly elements: readonly SemanticElementSummaryV1[];
  readonly narration?: NarrationSummaryV1;
  readonly captionCoverage?: CaptionCoverageV1;
  readonly visualCoverage: 'none' | 'sparse' | 'adequate' | 'dense';
  readonly evidence: readonly EvidenceRefV1[];
};
```

Requirements:

- Snapshot fields are semantic summaries and opaque IDs, never raw filesystem paths, signed URLs, provider keys, secret references, or object-store locations.
- Include track family/order/lock/visibility state via the typed deck, but do not make `V1`/`A1` positional labels stable IDs.
- Each summary must carry evidence references to canonical IDs/time ranges so a human can inspect why the system made a statement.
- Deterministic ordering, deterministic truncation, and explicit omission counts are mandatory. The agent must know when it has an incomplete summary.
- Bound the serialized payload with a tested budget. Prefer hierarchical detail-on-demand (`getSceneDetail`, `getAssetDetail`) over placing every transcript/token/frame in the initial context.
- The projection must be pure/read-only: creating it cannot cause migration, saves, jobs, asset uploads, model calls, or timestamp mutations.
- `revisionId` is part of the cache key. A snapshot cannot be used to execute a plan after the project revision changes.

### S1 implementation tasks

1. Add the schema/types in the dependency-safe package discovered above. Version exported types and validation.
2. Implement a pure projector from canonical state, with an injected clock only if a timestamp is required for the presentation layer.
3. Add a small scene-segmentation strategy. Start deterministic: explicit scene markers/sections if available, then cuts/gaps/caption/narration boundaries. Mark inference confidence; do not call an LLM to silently manufacture scene structure.
4. Derive asset and element summaries through existing opaque IDs and provenance. Use metadata already authorized for the current project.
5. Add snapshot size budgets with graceful, deterministic truncation and high-level aggregate counts.
6. Add a per-project/revision cache only after pure behavior and invalidation tests exist. Caches must be bounded and contain no secrets.
7. Write fixtures for: a blank project, the existing mixed-element project, Persian/RTL captions, a generated asset with provenance, a locked/hidden color-labelled track, an asset whose details are unavailable, and an oversized project requiring truncation.
8. Do not change the live UI yet unless a minimal internal development inspector is necessary; if added, gate it behind the existing developer/test affordance and render opaque IDs safely.

### S1 acceptance tests

- [ ] Same persisted project + revision produces byte-stable semantic JSON.
- [ ] A mutation advances revision and invalidates/rejects the prior snapshot for planning.
- [ ] A snapshot has no raw path, signed URL, secret-shaped value, provider credential, or object-store reference.
- [ ] Visual/audio family, deck order, lock/visibility, captions, asset provenance, and brand availability are described correctly from the WP-36 data model.
- [ ] Missing/unsupported data is represented as `unknown`/warning, never fabricated as ready or present.
- [ ] The snapshot fits its defined initial-context budget; overflow behavior is deterministic and reports omissions.
- [ ] Snapshot creation does not modify project bytes, durable revision, undo history, jobs, or network activity.
- [ ] Existing WP-35/WP-36 Timeline, project persistence, agent command, and preview/export tests remain green.

## 8. S2 — Deterministic scene and brand intelligence

### Goal

Turn the S1 snapshot into explainable descriptors that are useful to a creative planner, without pretending that a heuristic is a vision-model judgment.

### Deliverables

- `BrandReadinessV1`: available/missing colors, fonts, logo, voice/tone instructions, prohibited claims/effects, and completeness warnings.
- `SceneCoverageV1`: narration, captions, visual density, clip/audio overlap, duration, pace signals, and explicit evidence ranges.
- `ProjectReadinessV1`: destination/aspect/duration alignment, captions availability, audio-state readiness, export suitability, and unresolved runtime needs.
- A deterministic rule catalog with rule ID, severity, evidence, user-facing explanation, and suggested *intent* (not a mutation).

Example result:

```json
{
  "ruleId": "scene.visual-coverage.sparse",
  "severity": "suggestion",
  "sceneId": "scene-02",
  "evidence": [{ "startUs": 8000000, "endUs": 11000000, "elementIds": ["clip-narration"] }],
  "message": "Narration runs for 3.0 seconds without a visual change.",
  "suggestedIntent": "consider-broll-or-motion"
}
```

Do not label a scene “luxury,” “weak,” “cinematic,” or “on-brand” from deterministic metadata alone. Those are model/human judgments and belong in S3 with confidence, evidence, and review status.

## 9. S3 — Creative brief and read-only critique

### Goal

Given a user request and `SemanticProjectSnapshotV1`, produce a structured brief and recommendations without producing a command or changing project state.

### Required model boundary

The LLM receives only the bounded snapshot, allowed creative request, and policy-safe detail calls. It returns validated JSON conforming to a strict schema. It does not receive browser DOM, raw API credentials, private URLs, unbounded transcript data, or unrestricted tool access.

```ts
type CreativeBriefV1 = {
  readonly snapshotRevisionId: string;
  readonly request: string;
  readonly interpretedGoal: string;
  readonly assumptions: readonly AssumptionV1[];
  readonly recommendations: readonly CreativeRecommendationV1[];
  readonly blockedBy: readonly CapabilityGapV1[];
  readonly requiresHumanDecision: readonly HumanDecisionV1[];
};

type CreativeRecommendationV1 = {
  readonly id: string;
  readonly kind: 'pacing' | 'caption' | 'visual-coverage' | 'brand' | 'audio' | 'transition' | 'color' | 'structure';
  readonly confidence: 'low' | 'medium' | 'high';
  readonly evidence: readonly EvidenceRefV1[];
  readonly rationale: string;
  readonly expectedBenefit: string;
  readonly proposedIntent?: string;
  readonly risk: 'none' | 'reversible-local' | 'destructive' | 'remote-egress' | 'spend';
};
```

### Safety and quality rules

- The parser rejects extraneous fields, unrecognized tool names, unbounded text, invalid IDs, and a snapshot-revision mismatch.
- The system must visibly distinguish facts from model inferences and suggestions.
- A recommendation must point to evidence. “Premiumize it” with no affected range/element is not executable or reviewable.
- Model uncertainty, missing brand data, and unavailable capabilities appear as questions/blockers rather than silently selected defaults.
- Persian/RTL content must survive snapshot, model input, JSON parsing, preview, and user-facing display tests without forced directionality errors.
- Start with a deterministic fake/planned-model adapter for tests. A real reasoning-model call is behind existing OpenRouter/project policy and explicit owner authorization.

## 10. S4 — Constrained “Improve project” plan surface

### Goal

Add a single user journey to the existing Agent surface:

```text
Improve project
  -> choose/change request scope
  -> capture snapshot/revision
  -> show brief + recommendations
  -> select recommendations
  -> create an execution proposal
```

At S4, proposal creation may map only to already-supported, reversible, local semantic commands. It must not secretly invoke a provider job, pay, export, overwrite, upload, or change a project.

### UI contract

- Present a compact project brief first, then recommendations grouped by scene/timestamp.
- Each recommendation shows impact, evidence, confidence, risk, and whether it is actionable now.
- “Explain” expands evidence; it does not expose raw prompt or secret/provider internals.
- “Create proposal” creates an immutable, revision-bound plan using the existing plan/history contract.
- “Preview changes” uses the existing dry-run/change visualization path when available.
- “Approve and apply” remains disabled for any unsupported/high-risk action and follows existing capability/approval rules for supported actions.
- Stale revision, missing capability, policy denial, and model-schema failure have truthful recovery messages.

### S4 acceptance proof

Using a disposable mixed project, a user can request a more premium short-form reel. The system identifies at least one factual project condition and one evidence-backed suggestion, shows no mutation after planning, rejects approval after an intervening human edit, and never shows an unavailable provider/generation action as complete.

## 11. S5 — Approved low-risk execution bridge

### Goal

Allow selected S4 recommendations to resolve into existing atomic command transactions. This is a deliberately small first execution set, chosen only after S4 discovery verifies commands and UX already exist.

Candidate first intents (not automatic authorization):

- adjust existing caption style through a canonical style command;
- add a pre-existing approved transition between compatible adjacent clips;
- apply a saved/reversible grade preset to selected existing visual items;
- trim/split/move an explicitly selected clip when all preconditions and ripple implications are visible;
- place an already-owned, already-authorized asset where the user has approved its target.

Do not include generation, purchase, remote upload, destructive source replacement, or automatic structural rewrite in S5.

The bridge must reuse the agent envelope, durable revision, idempotency, transaction, policy, history, undo, and visual-diff contracts. No parallel `applyCreativePlan` persistence path is permitted.

## 12. V1 — Preview → critique → repair proposal

### Goal

Close the differentiating feedback loop safely:

```text
accepted command/job run
  -> existing preview renderer creates bounded low-res artifact
  -> critic receives preview + semantic snapshot + user goal
  -> critic returns timestamped observations
  -> separate repair proposal (never auto-apply)
```

### Preconditions

- S1–S5 are accepted with durable revision and provenance behavior.
- Owner approves the vision-model/provider, privacy/retention policy, spend caps, and whether a preview leaves the device.
- The preview artifact is authorization-scoped, bounded in resolution/duration, expires, and has no public bucket URL.
- A deterministic fixture critic exists so this workflow is testable without a live vision provider.

### Critique schema requirements

- observation type, timestamp/range, severity, confidence, evidence frame/reference, and user-facing rationale;
- no direct command payload;
- `visual-overlap`, `caption-readability`, `pacing-gap`, `narration-visual-mismatch`, and `brand-mismatch` are distinct observations;
- low-confidence/inconclusive output is allowed and must be shown truthfully;
- repair proposals are re-planned against the current revision and independently approved.

## 13. P1 — Provider-neutral generation, one vertical proof

### Goal

Only after the semantic/approval loop works, prove one valuable provider-backed creative operation end-to-end. Recommended first proof: **generate a still B-roll image from a text prompt and place it as an editable asset**. It is materially lower-risk than full generated video while proving the provider/job/provenance/editability architecture.

### Provider contract

```text
generateVisualAsset(prompt, references, aspectRatio, styleConstraints)
  -> policy check
  -> provider selection (server-side)
  -> asynchronous job
  -> opaque owned asset + complete provenance
  -> explicit human placement proposal
  -> existing command transaction inserts editable timeline item
```

Implement a provider capability manifest and adapter interface only if the existing provider SDK cannot express the operation. Do not create another provider framework. The first live adapter should be selected by a separate owner decision after capability, pricing, Iranian-access, terms, retention, and cancellation behavior are checked.

The provider manager may choose among OpenAI/Flux/Gemini/ComfyUI/local routes later, but project commands must never name the provider. “Higgsfield/Kling/Veo/Runway” video selection remains later work, after the still-image proof and a separate video-generation contract.

## 14. W1 — Teach once: record successful work as a skill/workflow

The repository already has a workflow engine and record-to-workflow direction. This package should not start by building another workflow format.

After a successful approved agent run:

1. show `Save as workflow` as a deliberate action;
2. serialize existing command/job steps in the canonical workflow JSON DAG;
3. promote only safe timing/content/target inputs to parameters;
4. bake project-specific opaque IDs unless an explicit portability contract exists;
5. preserve policy requirements and provider/spend gates in the recorded workflow;
6. run the workflow through the same dry-run, approval, revision, and provenance rules.

Never turn an opaque model conversation into an executable workflow without a validated command graph.

## 15. Tests, observability, and deployment gates

### Required test layers

| Layer | Required proof |
| --- | --- |
| Unit | snapshot projection, truncation, scene derivation, validation, policy classification, parser rejection, provenance serialization |
| Package integration | persisted revision → snapshot → brief → proposal; stale revision rejection; command bridge atomicity and one-step undo |
| Fixture/model | deterministic fixture adapters for planning/critique/provider responses, including malformed and ambiguous responses |
| Browser | existing project opens; Agent plan is readable/keyboard accessible; no mutation before approval; stale plan behavior; Persian/RTL content; error states |
| Renderer | label-only metadata remains non-rendering; approved visual changes affect Preview/Export only through canonical render state |
| Security | no secret/path/URL leakage in snapshots, logs, UI, serialized plans, telemetry, or browser requests; policy gates fail closed |
| Production | immutable artifact, API health, signed-in disposable-project smoke, rollback target, public hash parity, and teardown/cleanup proof |

### Telemetry/audit events

Add structured, redacted events only through the existing observability boundary:

- `semantic_snapshot.created` (schema version, size bucket, truncation count—not body);
- `creative_brief.created` / `creative_brief.rejected` (reason class);
- `creative_proposal.created`, `approved`, `stale`, `denied`, `applied`, `rolled_back`;
- `preview_critique.completed` / `inconclusive` / `failed`;
- `provider_job.requested`, `policy_denied`, `completed`, `failed`, `cancelled` (no prompt or credential payload in generic logs).

### Performance budgets to decide before V1/P1

Record baselines before enforcing numbers. At minimum measure:

- snapshot generation on small, reference, and oversized projects;
- initial brief render and dry-run proposal creation;
- context byte/token budget and detail-fetch count;
- preview render/critic duration and memory use;
- Worker/provider queue latency, cancellation, and retry behavior.

No performance claim should be recorded before it is measured on the actual Windows Worker and VPS/browser path.

## 16. Architecture decisions the next agent must not guess

Create a decision request/ADR and stop the affected package if any of these are still unresolved:

| Question | Required decision |
| --- | --- |
| Semantic snapshot ownership | Core package and dependency direction; whether a new `project-intelligence` package is justified |
| Scene boundaries | Canonical explicit scene markers vs deterministic derivation and migration/UX implications |
| Brand source | Exact existing canonical brand-kit schema and entitlement/privacy boundary |
| Reasoning/vision provider | Approved model, data retention, geography/access, terms, spend cap, cancellation, and fallback behavior |
| Preview privacy | Whether preview leaves device; storage TTL; who can view it; how it is revoked |
| Autonomy | Exact actions allowed in Low-Risk and Full Auto modes for creative plans |
| Provider selection | First adapter/provider after a real capability and commercial review |
| GBrain upgrade | Snapshot/rollback, migration plan, maintenance window, and validation owner |

## 17. Next-agent checklist (G0 + S1 only)

1. Read `ORCHESTRATION.md`, current `STATE.md` handoff, this plan, relevant ADRs, and the current WP-36 plan/evidence.
2. Verify the local checkout is clean and compare its commit to `/opt/joy-media/repo`; do not use historic state documents as deployment facts.
3. Run the read-only GBrain audit and create the G0 evidence report. Do not perform an upgrade/migration/installation.
4. Make the GBrain current-state/index split in reviewable, reversible commits only if the actual GBrain page/editor contract supports it safely. Otherwise write the exact blocker and stop G0.
5. Produce the S1 discovery note: canonical source/revision, package ownership, field mapping, privacy exclusions, and dependency-graph finding.
6. Implement only the validated S1 schema/projector/fixtures/tests. Do not add provider calls, a new model dependency, UI automation, or S2+ work.
7. Run targeted tests, then the relevant workspace checks; record exact commands/results and pre-existing failures separately.
8. Update this plan’s checkboxes and the concise `STATE.md` row. Commit with `joy-media(WP-37): ...` messages. Push/deploy only if the owner asks and the phase has an approved user-facing surface.

### G0/S1 completion checklist

- [x] Orientation facts were remeasured and any drift was recorded.
- [x] G0 audit/evidence and safe index plan are complete; no shared-service mutation was made without authorization.
- [x] S1 discovery note maps canonical state, revision, fields, package ownership, and privacy boundary.
- [x] Semantic snapshot schema/projector/validation/fixtures are implemented in the correct dependency direction.
- [x] All S1 acceptance tests and focused regressions are green, with existing unrelated exceptions itemized.
- [x] No UI-driven editing, direct persistence mutation, secret leakage, provider integration, or unapproved deployment was introduced.
- [x] `STATE.md`, GBrain’s new concise current state, QA evidence, and this plan agree on the exact commit and remaining package.

### S2 completion checklist

- [x] `BrandReadinessV1` reports available/missing canonical brand fields without fabricating defaults.
- [x] `SceneCoverageV1` derives per-scene duration, visual/audio/caption coverage, and visual-change signals with evidence.
- [x] `ProjectReadinessV1` reports destination/aspect/duration alignment, caption availability, capability state, and blockers.
- [x] Deterministic rule catalog with 16 factual rules across brand/visual/caption/audio/destination/capability categories.
- [x] All rules have stable IDs, severity, scope, evidence, explanations, and non-executable suggested intents.
- [x] Pure functions only: no persistence, network, model calls, GBrain access, or clock nondeterminism.
- [x] Byte-stable output for identical snapshots; deterministic ordering.
- [x] S1 evidence references reused; no paths, URLs, secrets, or object-store IDs exposed.
- [x] 32 focused S2 tests covering all acceptance criteria.
- [x] All existing project-schema tests remain green (171 tests total).
- [x] No S2 dependencies on editor-web, provider calls, UI, or GBrain mutation.
- [x] `STATE.md` updated with S2 commit SHA and status.

### S3 completion checklist

- [x] S3 is a read-only Creative Brief contract in `@joy-media/agent-tools`; implementation commit `13b819fd3748109f049b57b4a6b2e073c4f91f7a`.
- [x] It uses a deterministic test-only adapter, not a real provider/model.
- [x] Revision/evidence validation, Persian preservation, bounds, and forbidden-data checks are covered.
- [x] No UI, command execution, approval, jobs, caching, deployment, provider call, or GBrain mutation was added.
- [x] 4 test files / 171 tests passed.

### Integration milestones (verified completed work)

- 31d0c85: Creative Brief panel registry — added durable panel ID `creative-brief` with label, intent `automation`, command label, and default preset `automate`; not added to CORE_WORKSPACE_PANELS.
- 8aab2fd: lazy-mounted opted-in panel — mounted in App.tsx behind explicit opt-in gate; panel remains unavailable until user enables Creative Brief.
- c028177: persisted opt-in GET route and App hydration — server-side route with typed error handling and URL encoding; App consumes hydrated opt-in state.
- 0342c15: server wiring of canonical S1/S2 input resolver — produces Creative Brief input from persisted S1 semantic snapshot and S2 scene/brand intelligence.
- 0425e77: browser opt-in read client — `getCreativeBriefOptIn(projectId)` returning typed `{ creativeBriefOptIn, revision }` using existing authenticated conventions.

State: 49 panel tests, 103 editor integration tests, 60 HTTP tests, and 28 resolver tests pass where applicable. API/editor builds are green, with only the known editor chunk-size warning. The bounded runtime is now deployed behind opt-in and free-only policy; the remaining gap is autonomous free-form video-cut execution, tracked separately below.

### Runtime/browser closeout — 2026-08-20

- `d06baab` is the deployed API source for the current free-only runtime hardening. The adapter sends `reasoning_effort: "none"`, bounds output to 1024 tokens, keeps the exact Lightning/Nemotron `:free` allowlist, requires zero spend, and preserves strict validation.
- Live VPS configuration maps the owner-approved encrypted systemd credential to `joy-media/openrouter/creative-brief/v1`; the active free model is `nvidia/nemotron-3.5-lightning:free`, with no paid fallback.
- Browser canary on `https://joyst.ir/` completed successfully: the opted-in Creative Brief rendered a validated brief with goals, facts, inferences, assumptions, and a reversible pacing recommendation. Adapter tests: 101 passed; adapter/API builds: green.
- Joy Code browser verification remains intentionally bounded: direct deterministic timeline intents produce guarded plans, while free-form KiloCode/server-session responses are not connected. Therefore a complete autonomous picture-mix + professional text-style cut is **not** claimed by WP-37; it requires a follow-up execution/adapter work package.

## 18. Definition of success for the larger program

The program reaches its first real north-star demonstration only when a user can request a branded short-form reel and JOY Media can:

1. create or select assets through authorized, provenance-preserving jobs;
2. build an editable Timeline/Motion/Audio/Caption project with semantic commands;
3. present a revision-bound plan and human-readable approval boundary;
4. preview a low-resolution result, critique it with timestamped evidence, and propose—not silently make—repairs;
5. preserve human control, undo/redo, policy checks, costs, and audit history; and
6. export while leaving the complete, editable project intact.

Do not call JOY Media an autonomous creative designer merely because it has multiple providers. The claim is earned by the safe, inspectable `plan → execute → preview → critique → repair → export` loop on an editable project.
