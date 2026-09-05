# JOY Agent: full-editor operation architecture and implementation plan

Date: 2026-09-05
Status: foundation slice implemented/reviewed; full plan remains open

Implementation evidence (reviewed foundation slice): bounded Unicode-safe context
packing with selection/identity priority; typed created-output references for the
title-to-motion journey; compound timeline presentation preparation shared with
the human dispatch seam; inspector property-row presence routing; and replay-safe
approval/readback semantics. The current proposal registry contains 16 supported
kinds; it is not a complete shared-operation/runtime/skill implementation. Full
domain adapters, skill runtime, project lifecycle, canonical repair RPC, and
render/audio verification remain open.
Source baseline: `dde0a4ab3ce56898ba1a9f6a8a80f4dbebff9783`
Scope: built-in agent, editor-operation parity, skills, project conversation, verification, and truthful live activity.

## 1. Decision and outcome

Keep JOY's built-in, provider-neutral browser agent. Do not reintroduce KiloCode, code-server, a local DSH process, or a mandatory server-side reasoning service. The editor already has valuable command, revision, preview, persistence, and Undo infrastructure. The principal gap is that the active agent cannot discover or operate most of that infrastructure through one complete, truthful API.

Make JOY's **Editor Operation API** the common semantic boundary for human editing, agent editing, recorded workflows, and future external agent adapters. Build skills on that API. Keep the existing pinned AI SDK behind the JOY runtime boundary; consolidate the two current loop implementations into one production-tested implementation rather than adopting another agent framework.

“The agent can do everything” means every supported creative editor action is discoverable, has a typed operation or explicitly classified UI action, and has an executable, testable result. It does not mean arbitrary JavaScript, arbitrary document replacement, unrestricted filesystem/network access, or bypassing user consent. Unsupported editor/render capabilities must remain honestly unavailable until implemented.

The desired user experience is one project conversation. The user can ask for a result, attach references and skills, watch real work in the relevant panels, compare a real preview, approve according to their policy, and continue refining the actual result. Complex tasks can use several explicitly recorded checkpoints; one approved local change set is one Undo action.

## 2. What was reviewed and verified

Four read-only audit lanes traced the actual browser Worker, schemas and compilers, command/property domains, editor callbacks, persistence, skills/workflows, conversation, and presence/preview integration. Reviewed the earlier P06 and WP-15 agent plans, WP-34 agent/coverage closure, the 2026-09-04 engine design/implementation plan, ADR-0042, and the current source after the workspace cleanup. `ARCHITECTURE_SUMMARY.md` contains older model descriptions and is not a reliable current capability inventory.

- Local source was clean at the baseline before this planning document was added.
- Authenticated VPS Gbrain's current operational brief identifies that baseline as the current release. This audit did not independently redeploy or change production.
- A fresh focused run passed **43 Vitest files / 590 tests** across `agent-tools`, `joy-agent-engine`, editor `joy-agent`, command bus, revision, idempotency, presence, targets, and preview foundations.
- A separate focused helper run passed 5 files / 17 tests, overlapping the above and additionally covering project-conversation storage. Do not add those numbers together as unique tests.
- Browser E2E sources were inspected, not executed in this audit. No real provider call, billable generation, owner-project mutation, or new visual/export acceptance was performed.

Passing these tests establishes useful existing contracts, not full agent capability. Several historical checklists describe broader integration than the active path or their assertions prove. Preserve their historical context, but add a source-bound capability/evidence ledger rather than carrying their checked boxes forward as acceptance.

### Actual active path

```text
Project Composer: newest prompt + thin snapshot
  -> engine-client -> engine.worker
  -> custom bounded exchange: read_project_context / validate_proposal
  -> final JSON proposal, limited to 14 operation kinds
  -> main-thread compound compiler -> revision-bound scratch preview
  -> explicit approval -> compound runner -> EditorSession -> persistence + Undo
  -> fixed UI success message (no model readback/verification continuation)
```

The reusable `packages/joy-agent-engine` ToolLoopAgent and 13-tool catalog are not this active loop. Likewise the legacy `agent-tools` registry is not proof of model access to its tools.

## 3. Confirmed findings

Source references below are repository-relative and refer to the baseline above. “P1” means functionality/correctness work to do before claiming a general editor agent; it does not imply a demonstrated production security incident.

| Priority | Finding                                                           | Evidence and consequence                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Active runtime and documented runtime differ                      | `apps/editor-web/src/joy-agent/engine-client.ts:42`, `engine.worker.ts:11`, `bounded-tool-loop.ts:79`, `packages/joy-agent-engine/src/engine.ts:211`. Production offers two tools, four model requests/eight tool calls, 60 seconds and 2,048 output tokens per request. The reusable package/design describes a different tool catalog and 12/24/32 limits. A larger dormant catalog does not increase live capability.                              |
| P1       | Model cannot discover required edit targets                       | `AgentPanel.tsx:560`, `joy-agent/context-snapshot.ts:3`, `packages/agent-tools/src/joy-code-plan.ts:130`. Snapshot has clip timing and asset labels, not current text/object IDs/caption segments/properties/effects/animations. Existing-title and subtitle edits require IDs the model is not given. Only the first 128 clips/assets are available, with no retrieval paging.                                                                       |
| P1       | Tool arguments are underspecified                                 | `joy-agent/bounded-tool-loop.ts:98`, `engine.worker.ts:248`. The provider sees an array of arbitrary objects plus four kind examples, not each operation's required fields. Most validation failures become one generic code, weakening repair.                                                                                                                                                                                                       |
| P1       | “Staged” is not canonical scratch compilation                     | `bounded-tool-loop.ts:189`, `AgentPanel.tsx:642`. Worker snapshot validation precedes the actual compiler; compiler rejection ends the run rather than returning repairable diagnostics to the model. Dependency order is checked differently in Worker and compiler. Created entities have no model-addressable output references.                                                                                                                   |
| P1       | Human and agent timeline semantics diverge                        | `App.tsx:2560`, `agent-command-bus.ts:30`, `joy-code-compound-compiler.ts:95`. Human split/duplicate/freeze invokes derived presentation handling and delete removes animation bindings; agent paths do not run the same full document lifecycle. Compare full document/audio/property state, not only clip timing, before expanding this route.                                                                                                      |
| P1       | Most requested domains are absent from the active operation union | `packages/agent-tools/src/joy-code-plan.ts:5` has 14 kinds: 5 timeline, 3 text, 4 caption, 2 transition. It has no general inspector/keyframe/effect/color/audio/track/scene/export operation families.                                                                                                                                                                                                                                               |
| P1       | No closed execution-and-verification loop                         | `joy-agent/protocol.ts:87`, `AgentPanel.tsx:743`. Worker finishes planning before approval; committed revision, actual property values and rendered output are never returned to it. A fixed success message is not verification of user intent.                                                                                                                                                                                                      |
| P1       | Activity identifies inferred intent, not exact operations         | `AgentPanel.tsx:548,617`, `agent-ui-targets.ts:137,182`. English prompt regex chooses a surface; tool-to-target mapper and entity-presence hook have no production consumers. Multi-domain and Persian requests cannot reliably drive precise work cues this way.                                                                                                                                                                                     |
| P2       | Some preview badges do not prove a surface preview                | `AgentPreviewBadge.tsx:13`, `AssetLibraryPanel.tsx:931`, `JoyCode3DViewer.tsx:436`. Any global preview can light unrelated surfaces. Real Monitor/Inspector document projection and timeline ghost geometry do exist; extend them, do not replace them with animation.                                                                                                                                                                                |
| P2       | Project conversation is a UI log, not model memory                | `joy-code-conversation.ts:18`, `AgentPanel.tsx:586`, `engine.worker.ts:245`. Each request reconstructs a single user turn. Attached-assets UI selection is not encoded as model references. “Make that smaller” cannot reliably resolve the preceding result.                                                                                                                                                                                         |
| P2       | Skills and all-entry-point integration are not complete           | `AgentPanel.tsx:1053`, `joy-agent/entry-points.ts:7,184`, `workflow-runner.ts:431`. Edit/Brief are hardcoded capabilities, entry-point inventory tests do not prove actual panels work, and bundled workflows still use stub handlers. Portable recorded workflows are not project-bound run state.                                                                                                                                                   |
| P2       | Durable authority/lifecycle needs consolidation                   | `joy-code-compound-runner.ts:21`, `joy-code-compound-compiler.ts:199`, `editor-session.ts:447`, `App.tsx:104,1229`. Model replay state is in memory; proposal hash is FNV32 over operations; compound parts do not include graph; global presence stores outlive project remounts. Some failure/reject branches omit terminal presence updates and apply uses sequence 99. These are audit/recovery gaps, not a reproduced duplicate-commit incident. |
| P2       | Existing coverage reports can overstate behavior                  | `property-system/src/property-coverage.ts:805` sets evaluator/consumer support from a classification flag. `agent-tools/src/verification.ts:166,345` does not decode output or inspect requested values. `tests/e2e/agent-live-preview.spec.ts:44` checks Undo availability and badges, not exact state restoration.                                                                                                                                  |

### Foundations to retain

- Immutable reducers, timeline invariants, inverse commands and typed V2 property bindings/time domains.
- `EditorSession.projectRevisionId` covers timeline, visual document, graph and artifacts (`editor-session.ts:285`).
- `dispatchCompound` prepares local changes, journals multiple persistence writes, recovers failed writes, and records a shared Undo action (`editor-session.ts:447,800`). Whole-document replacement is already undoable; its gap is semantic operation identity, not necessarily missing Undo.
- Main-thread approval checks plan/hash/base revision and rejects stale drafts (`joy-code-compound-runner.ts:29`). Worker cannot directly mutate the live editor.
- Real staged document reaches Inspector/Monitor (`App.tsx:4851,7343`); timeline overlay uses actual compiled geometry (`TimelinePanel.tsx:1524,2372`). Follow is off by default.
- Page-session BYOK, fresh/terminated Workers on connection lifecycle, redacted contexts, redirect rejection, bounded responses, and cancellation guards.

### Legacy code must not become a shortcut

The older registry contains 10 query and 11 edit tools. Five legacy audio tools return success/diffs without committing their computed audio state (`agent-tools/src/edit-tools.ts:890,1011,1121,1245,1377`); its dispatcher exposes only timeline dispatch (`context.ts:23`). Do not wire these unchanged into the new runtime. Either route them through the new semantic adapters or label/remove their execution availability. The unused bridge that returns empty styles and staged counts (`joy-agent/tool-bridge.ts:33`) is integration debt, not an active production executor.

## 4. Capability contract: measure coverage end to end

An initial static inventory found 112 distinct command discriminants across the existing timeline/audio/voice/graph/artifact/visual buses, including internal inverse/restore commands. This is not 112 model tools or a coverage percentage. Exclude internal restoration commands from public discovery.

For every user-facing action, record: **readable → discoverable schema → compilable → policy-bound → previewable → committable → verifiable → undo/reload-safe → live-targeted**. A feature is complete only when every applicable column has executable evidence. “Not applicable” requires a reason; “unsupported” must be visible to the model and user.

| Domain                       | Required operation/read coverage and acceptance example                                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects/compositions        | List/select/create/rename, dimensions, frame rate, background, nesting, markers, duplicate/import/export. Project activation is a scoped UI/session action, not an unannounced destructive switch.                                                                                     |
| Assets                       | Search/list/read metadata and availability, explicitly attached references, import authorised handles, relink, provenance, metadata, reference-aware removal, placement by correct media family. Imported media must decode and be available before a successful placement claim.      |
| Tracks/timeline              | Track lifecycle/order/name/family/lock/mute/visibility/solo; insert/move/ripple/trim/split/join/duplicate/grouped moves; speed/reverse/freeze/remap/nesting. Preserve derived bindings, audio config, keyframes and source ranges on split/delete.                                     |
| Inspector/static properties  | Descriptor-driven transforms, crop, opacity, appearance, style, alignment, dimensions, ownership and parenting. Read actual base/evaluated values, units, bounds and enumerations.                                                                                                     |
| Keyframes/motion/expressions | Enable/disable animation; add/update/remove/move keys; curves/easing/Bezier handles; copy/paste/retime; expressions and diagnostics; spatial paths. Support declared owner/time domains and reject unsupported combinations. Verify frame samples through nested/speed-remapped clips. |
| Effects/filters/color        | Discover actual renderer-backed catalog and parameter schemas; add/remove/reorder/enable/update; masks/bindings; effect animation; clip/layer/master grade and adjustments. Verify actual pixels, not merely stored JSON.                                                              |
| Transitions                  | Discover implemented transition descriptors; add/remove/update junction, duration, direction/easing/parameters and animation where supported. Verify both source clips and exact overlap/junction frames.                                                                              |
| Text/captions                | Create/edit rich text and templates, typography/layout; caption documents/segments/words/speakers/timing/style/burn-in. Existing targets must be discoverable, and RTL/font availability must be checked.                                                                              |
| Audio/voice                  | Clip/bus routing, gain/pan/mute/solo/fades, automation, implemented effects, meters and mix verification. Transcription/cleanup/generation require real handlers; voice consent is not something a skill may fabricate.                                                                |
| Camera/3D                    | Scene/model/material/light/camera/hierarchy/transform operations for persisted supported state; asset dependencies; staged render and editable result. Extract service/state from isolated viewer behavior before claiming general 3D control.                                         |
| HTML scenes/motion templates | Typed manifest/property edits, safe parameter animation, preview/export consistency and sandbox errors. No arbitrary page-script execution tool or hidden flattened substitute.                                                                                                        |
| Workflows/artifacts          | Real graph/node/edge/parameter operations; reusable templates separate from project instances, run inputs/outputs, approvals and checkpoints. Replace stub execution before promoting a skill.                                                                                         |
| Render/export/delivery       | Preflight, frame/audio observation, render settings, start/status/cancel, validate output and explicitly approved destination/download. Completion means a valid artifact exists, not that an export dialog opened.                                                                    |
| UI/navigation                | Select entity, seek/play/pause, inspect/reveal panel or property, view mode and follow. Separate ephemeral view actions from creative document edits and from security/settings controls. No reliance on clicking DOM selectors for editing.                                           |

## 5. Target architecture

```text
Human UI / project conversation / skills / workflow / optional external adapter
                           |
              JOY Editor Operation API + capability registry
                           |
        project-scoped AgentRunController (authority + lifecycle)
             |                           |
   Worker: model, tools, BYOK       trusted operation services
             |                           |
   bounded reads + staged ops --> pure scratch compiler + diagnostics
                                         |
                          validated diff + actual preview adapters
                                         |
                        policy / exact approval / revision check
                                         |
                         EditorSession atomic local transaction
                                         |
                         durable receipt + postcondition checks
                                         |
                            model receives observed result
```

All tools remain operations on JOY data/services, not an unrestricted coding shell. UI rendering remains a consumer, not a second mutation authority. Model text never chooses arbitrary panel selectors, executable code, allowed capabilities, or spend policy.

### 5.1 One operation definition, several consumers

Introduce a dependency-light `EditorOperationDefinition` contract in the command layer or a dedicated small package if needed to avoid cycles. Domain implementations remain in their existing packages; the editor host assembles adapters. Do not put React or `EditorSession` into pure command packages.

Each definition needs:

- Stable ID/version, discriminated input schema and result schema, examples, domain, availability and implementation status.
- Typed target resolver, required context selectors, input/output entity references, value/time units and capability requirements.
- Access class: read, ephemeral UI, reversible local mutation, external job, export/delivery, destructive/privileged.
- Pure prepare/validate/compile adapter, real affected-entity diff and output references, inverse or documented compensation boundary.
- Preconditions, postconditions, preview adapter, trusted semantic UI targets, cost/privacy metadata and test IDs.

Generate model-facing tool schemas and support docs from these definitions. Use compact per-domain discovery/active tool subsets so “complete API” does not mean sending hundreds of schemas on every turn. Keep low-level inverse commands internal. Snapshot writes may stay as an internal persistence mechanism behind typed operations; models must not supply complete arbitrary project documents or JSON paths.

Give Inspector and agent the same property descriptors: `{ownerKind, ownerId, propertyId, timeDomain}`, value type, units/ranges/enums, writable/animatable/expression support, base value, evaluated value and actual renderer consumer. Use stable bindings, not translated display labels. Expression support means JOY's validated expression language, not arbitrary executable JavaScript.

### 5.2 Query, prepare, commit, verify

Proposed logical API groups (names are new design, not claims of existing endpoints):

- `capabilities.describe`, `operations.describe`, `catalog.query`, `project.query`, `selection.read`, `entity.read`, `property.describe/read/evaluate`, `animation.read`, `media.observe`.
- `changes.prepare`, `changes.inspect`, `changes.preview`, `changes.discard`; all scratch-only and bound to a frozen revision.
- `changes.commit`, `receipt.read`, `changes.undo`; trusted controller applies policy and current revision checks. The Worker never receives `EditorSession`.
- `jobs.prepare/start/status/cancel/reconcile`, `export.preflight/start/status`; external effects have separate authority and receipts.
- `ui.reveal/select/seek` as ephemeral scoped actions, with default focus-preserving behavior.

Queries are paged and selection/attachment-prioritised. They expose omitted counts/cursors, source and revision; never invent defaults for unknown entities. Clip reads include media linkage, family, source range and associated document bindings. Property and style catalogs reflect installed/implemented capabilities.

Preparation must run the canonical compiler while the model is still active. Return structured, redacted diagnostics: operation ID, field path, expected type/range, error code, retryability and safe relevant facts. Let the model repair within a bounded budget. Support typed references such as an operation's created clip/object output, resolved deterministically after topological sorting. Identical semantics apply regardless of input array ordering.

### 5.3 Atomicity and safety without disabling useful work

Extend the existing compound transaction boundary rather than building another editor state store. Cover timeline, document properties, graph, artifacts, and related project records with one prepared transaction/journal. Cross-domain invariants include ownership, media links, tracks, nested compositions, animation bindings and audio routing.

Bind approval to project, revision, canonical compiled-operation digest (SHA-256), resolved inputs/outputs, policy version, consent scopes and external effects. Changed content invalidates approval. Persist execution ID and receipt with the transaction so retries/reload return the previous outcome. Enforce a single writer per project, including multiple tabs/external adapters; stale fencing/revision checks must reject competing commits.

Offer Plan only, Preview and approve, and policy-scoped automatic reversible edits. The latter can execute eligible local changes within a user-approved task envelope; it is not carte blanche for paid jobs, privacy changes, remote data transfer, destructive media removal, or delivery. A session key being configured is not blanket permission to send all media.

External generation, uploads and exports cannot be made financially reversible with document Undo. Use prepare → consent → submit once → observe/reconcile → validate artifact → atomic import/edit. Show completed external costs/effects separately when a later document operation fails. Do not retry an ambiguous paid submission without reconciliation.

### 5.4 One real runtime and project conversation

Make `packages/joy-agent-engine` the single runtime implementation consumed by the production Worker. Port the active transport/redaction/cancellation protections and JOY authority gates into that boundary; use the pinned SDK only as a replaceable provider/tool-loop utility. Remove alternate dormant semantics only after equivalent production-Worker tests pass. Distinguish provider **structured-plan capability** from user **suggest-only execution policy**: a provider without a tested tool cycle may still propose a typed plan for canonical validation and approval, but its capability never grants mutation authority. Migrate the current overloaded plan-only labels accordingly. Never silently switch model/provider or choose a paid fallback.

Add a project-scoped `AgentRunController` outside dock-panel mount/unmount. It owns run identity, session epoch, event sequencing, prepared change sets, approval, commit receipts, verification, cancellation and terminal cleanup. Protocol runtime validators apply on both sides. A probe must test a correctly named tool with valid arguments and continuation, not just any nonempty tool-call array.

Support outcomes beyond mutation: answer/explanation, clarification, blocked/unavailable, validated no-op, staged change, applied-and-verified change and external job. Asking about the project must not fail simply because there are zero edit operations.

Compile bounded conversational context from safe recent turns, a project summary, explicit attachment references, active selection, referenced prior results and current facts. Store typed run/result/artifact references alongside display messages. Revalidate referenced entities against the current revision; old prose is not authority. Keep credentials out of messages, summaries, receipts, browser persistence and telemetry. Preserve existing project-local history migration.

Separate lifecycle states: generating, inspecting, preparing, preview-ready, awaiting approval, committing, verifying, completed, failed, cancel-requested, cancelled and interrupted/recovery-required. Cancellation after a committed checkpoint preserves that checkpoint and reports it; it must not claim that nothing happened.

### 5.5 Skills are reusable editing procedures

Define first-party versioned skill manifests with ID/title/description, input schema, context selectors, required operations, allowed capabilities, budgets/privacy class, procedure, preview expectations, postconditions, fixtures and availability probe. A skill combines model guidance with deterministic operations and checks; it is not just a prompt or a new tab.

Initial skills should be small vertical slices: Creative Brief, refine selected title, caption styling, shorten an intro, animate a selected property, transition polish and audio balancing. Enable each only after its real operations pass. Later add 3D composition, montage, audio cleanup and export delivery when their adapters are ready.

Creative Brief becomes an attachable planning skill/artifact in the same conversation. The user can use it together with editing/motion/audio skills; it must not be a competing conversation mode. Skills can be explicitly chosen or transparently suggested; neither selection nor downloaded instructions grants new authority. Local first-party skills need no marketplace/account.

Keep portable skill/workflow templates separate from project-bound inputs, instances, checkpoints and output provenance. Defer arbitrary remote skill execution; custom instruction packs are untrusted data with declared capabilities, no embedded arbitrary JS/shell, and no access to provider secrets. Read-only specialist planning may run in parallel; mutations are serialized by the one controller.

### 5.6 Real creative observation and verification

The model cannot design against images or audio it has not observed. Add local bounded observations: timeline/selection facts, actual evaluated property values, frame renders/thumbnails, transcript slices, waveform/loudness/peak measurements, scene bounds and dependency availability. Keep media handles opaque; only an explicit permitted request sends bounded media observations directly to the chosen capable BYOK provider.

Record whether a result is structurally validated, rendered, decoded, audibly measured, model-reviewed or user-approved. Verification predicates must inspect committed state and real outputs. “Looks beautiful” remains subjective; do not equate schema validity with creative quality. Compare requested numeric/structural constraints deterministically and present visual/audio evidence for subjective decisions.

The full loop is inspect → plan → prepare → preview → approve/eligible auto-apply → commit → read/render/measure → report or propose repair. A repair is a new revision-bound change set, not a silent post-approval rewrite. Bound steps, tokens, observations, wall time and repair attempts; show unknown provider cost as unknown rather than claiming a hard dollar limit from token counts alone.

## 6. Live UI behavior

Use one trusted event envelope: protocol version, project/conversation/run IDs, session epoch, monotonically increasing sequence, timestamp and base/result revision. Correlate step/tool-call/operation/proposal/job IDs. Events carry safe activity codes, typed entity references, changed property bindings and measured progress when available—not hidden reasoning, raw model payloads, secrets or model-selected CSS selectors.

Actual query/compile/render/commit/job boundaries emit started/completed/failed events. The controller validates order and scope. Terminal cleanup and project switch clear only the relevant run's overlays; late events cannot resurrect old work. “Preview ready” requires a successfully compiled version and renderer acknowledgement for the claimed surface.

| Surface                   | Truthful activity behavior                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer                  | Compact current-step rail, completed steps, selected skills, stop/cancel-pending, approval card and actual final receipt. No fabricated percentage or continuous generic “editing” animation.         |
| Dock/feature tabs         | Subtle active/read/preview/approval state driven by registered target. Hidden panels receive a badge; Follow off never opens or rearranges them.                                                      |
| Timeline                  | Exact affected clips/tracks and relevant time span; added/moved/trimmed ghosts, removal outlines, current step label. Existing track identity glyphs stay visible; retain hover-only action controls. |
| Inspector/keyframe editor | Reveal/highlight actual property or curve; canonical → proposed value and time/easing change. Read activity differs visually from modification.                                                       |
| Effects/transitions/color | Highlight the specific instance and parameter section, not every effects panel. Render-backed proposed state must be distinguishable from canonical state.                                            |
| Assets                    | Only queried/used assets or real generated-output placeholders have activity. Pending output is never labelled a ready editable asset.                                                                |
| Monitor                   | Versioned before/after projection, affected region where known, render-ready/error state. Timeline/Inspector/Monitor share the same preview bundle/version and Before semantics.                      |
| 3D                        | Actual affected scene node/material/camera and a staged scene preview only when the scene adapter can render it. No generic global preview badge.                                                     |
| Audio/jobs/export         | Real stage and measured unit/total, meters or waveform comparison, explicit queued/running/cancel-requested/finished states. Unknown duration stays indeterminate.                                    |

Keep keyboard focus, current selection and layout under user control by default. Follow can reveal/scroll the relevant target without hijacking typing or playback. Include accessible status text, restrained announcements, reduced-motion static states and RTL/Persian tests. Ambient welcome-text animation is decorative and must not count as agent work evidence.

## 7. Implementation packets and dependency order

Each packet ends with real fixtures, failure cases, source-bound evidence and an updated coverage ledger. Do not mark an entire phase complete from helper tests or screenshots of badges. Implementation may delegate independent domain adapters, but one integrator owns registry/session/compiler contracts.

### A — Establish the truth and regression fixtures

1. Create a machine-readable operation/action/property inventory and map every relevant UI mutation handler, model/recipe path and workflow handler. Mark legacy, read-only, unsupported, experimental and inverse-only explicitly.
2. Add failing regression fixtures for human/agent split and delete parity, title/caption target discovery, created-entity references, compiler feedback, conversation follow-up, misleading badges, project switch and every terminal cleanup path.
3. Add a short audit addendum to the earlier checked engine plan; do not rewrite historical results as though they had never happened. Replace current capability claims with the new evidence ledger.

Primary files: `packages/agent-tools/src/joy-code-plan.ts`, `packages/property-system/src/property-coverage.ts`, editor `App.tsx`, `AgentPanel.tsx`, `joy-agent/*`, and `tests/e2e/agent-*`.

Gate: tests identify unsupported behavior explicitly; inventory differentiates the active two-tool route from dormant/legacy catalogs. Baseline artifact records the exact commit and commands run.

### B — Shared semantic operations and all-local atomic transactions

1. Introduce operation/property contracts and adapter assembly. Generate runtime schemas, discovery and targets from the same definitions.
2. Extract App's derived clip/document lifecycle into reusable pure compilation shared by UI, model, recipes and workflows. Migrate split/delete first; then duplicate/freeze/move/import and other handlers. Preserve existing reducers, history and snapshot migration.
3. Extend compound preparation to graph and all affected local stores; validate cross-document invariants and one-Undo semantics.
4. Add canonical SHA-256 proposal identity, durable execution receipts and replay/recovery with writer fencing. Adapt or disable legacy success-without-commit tools.

Primary files: `packages/commands/src/*`, `packages/property-system/src/*`, editor `editor-session.ts`, `agent-command-bus.ts`, `joy-code-compound-compiler.ts`, `joy-code-compound-runner.ts`, `speed-ramp.ts`, `agent-idempotency-store.ts`.

Gate: the same semantic operation through human and agent adapters produces identical complete state and inverse/reload output. Inject failures at every journal/store step: either all old state or all committed state, never partial success. Mutation of a prepared draft or revision invalidates approval.

### C — One runtime, real discovery and repairable scratch RPC

1. Integrate the sole runtime into the production Worker with strict request/event schemas and truthful capability probing. Keep hardened direct BYOK transport and exact Worker release budgets.
2. Implement paged domain queries, typed full schemas, selection/attachment prioritisation and frozen-revision scratch reads.
3. Invoke canonical prepare/compile during tool execution and return structured repair diagnostics. Resolve operation-output references in dependency order. Remove separate shallow validation rules where the canonical validator can be reused.
4. Add answer/clarify/no-op/unavailable outcomes. Configure measured bounded budgets from one versioned policy, not independent constants in parallel loops.

Primary files: `packages/joy-agent-engine/src/*`, editor `joy-agent/engine.worker.ts`, `bounded-tool-loop.ts`, `protocol.ts`, `engine-client.ts`, `context-snapshot.ts`, `tool-bridge.ts`; new controller/host RPC adapters.

Gate: using the actual Worker path, find and change an existing title/subtitle without hidden IDs; reach clip 129+ by query; split then address/style the new part; handle reversed dependency-array order; receive a real compiler failure and repair it without changing canonical state. Plan-only and tool-capable providers remain explicit and tested.

### D — Conversation, post-apply verification and persistent run lifecycle

1. Move orchestration out of panel-local callbacks into the project-scoped controller. Keep present conversation migration and add typed result/run references.
2. Pass bounded safe conversational context and explicit attached references. Resolve prior artifacts against current project state.
3. Add approval/commit/verification-result continuation and result predicates. Persist recoverable receipts/checkpoints, but never resurrect an expired approval or a provider key after reload.
4. Centralize reject/failure/timeout/cancel/project-switch cleanup. Add manual user-edit conflicts, dock unmount and multiple-tab tests.

Primary files: `AgentPanel.tsx`, `joy-code-conversation.ts`, `App.tsx`, `joy-agent/protocol.ts`, `engine-client.ts`, new `AgentRunController`, receipt/verification adapters.

Gate: a second turn such as “make that title smaller” resolves the previous real title, including after reload with explicit reconnect if needed. Two projects never share active authority, conversation references or overlays. A completed edit includes committed revision, changed values, verification status and Undo reference.

### E — Exact live presence and preview parity

1. Wire the controller/host events into the existing presence store, extending its scope and semantic entities. Remove keyword inference as the authoritative targeting mechanism and sequence-99 completion.
2. Use per-surface/per-entity preview selectors and real preview version/render acknowledgements. Connect Inspector before/after properties, curve changes, timeline ghosts and Monitor to one bundle.
3. Wire precise entities in Assets, Effects, Transitions, Color, Audio and 3D as each adapter becomes available. Unsupported previews stay unavailable, not decorative.
4. Preserve Follow/focus behavior, hover-control cleanup, reduced motion, accessibility, narrow layouts and RTL.

Primary files: `agent-presence.ts`, `agent-ui-targets.ts`, `AgentActivityIndicator.tsx`, `AgentPreviewBadge.tsx`, `AgentTimelineOverlay.tsx`, `TimelinePanel.tsx`, `InspectorPanel.tsx`, `App.tsx`, relevant domain panels.

Gate: English and Persian mixed-domain requests produce the same semantic targets from actual operations; read vs preview vs apply is visually distinct. Stop/reject/drift/project-switch/failure leaves no stale markers. Before/after compares actual frame/document values, not just labels.

### F — Domain completeness and first-party skills

Deliver independently gated slices using B/C contracts; these can develop in parallel after the registry and atomic seams stabilise:

1. **Timeline + assets + projects:** full track/clip lifecycle, correct media-family placement, nesting/source ranges, import/relink and dependency safety.
2. **Inspector + motion:** property descriptors and complete keyframe/curve/expression/time-domain operations. This is a first-class deliverable, not a later cosmetic enhancement.
3. **Effects + color + transitions:** actual catalogs, parameter/style/animation operations and renderer parity.
4. **Text + captions + audio:** rich text/RTL/fonts, segment/word operations, mixer/automation and measurable output.
5. **Camera + 3D + HTML scenes:** persisted editable scene ownership, typed manifests/scene operations, source dependencies and actual staged render adapters.
6. **Workflow + artifacts:** eliminate promoted stub handlers, bind project instances/receipts, reuse typed operations and real outputs.

Add the skill manifest/runtime and composer skill picker as the first slices become verified. Creative Brief is the first shared skill/artifact. No skill is advertised as available based only on its title, metadata or prompt.

Gate for each slice: create/read/update/remove or explicitly justified equivalents; selected and non-selected targets; malformed/unsupported input; unchanged-state no-op; policy rejection; prepared preview; commit/Undo/Redo/reload; cancellation/stale revision; real render/audio readback; truthful presence. A UI action cannot be “covered” merely because its command name exists.

### G — Long-running jobs, visual observation and export

1. Extract existing import/audio/render/export handlers into injectable services usable without clicking dialogs. Add explicit local-vs-remote availability and consent policy.
2. Implement bounded local frame/audio observations and explicit remote multimodal sharing. Feature-gate by tested provider modality/tool capability.
3. Add job submission receipts, status/progress/cancel/reconcile and output validation, then atomic output import. Replace workflow stubs with these real adapters.
4. Add export preflight, actual artifact/decode/duration/resolution/audio checks and approved destination handling.

Primary files: `joy-agent/media-job-bridge.ts`, `agent-worker-job-client.ts`, `AudioPanel.tsx`, `workflow-runner.ts`, `App.tsx` export/import handlers, worker/job-protocol/provider/export packages.

Gate: cancellation and ambiguous paid submission cannot create silent duplicate work; failed decode cannot report success; partial external work is disclosed separately; final artifact and project provenance are real. Browser-only editing uses the built-in browser Web Worker and remains usable without an optional native/media worker. Only operations requiring that separate media service become unavailable until it is connected; it is not a prerequisite for BYOK reasoning.

### H — Complete parity gate and optional external agent adapter

1. CI fails for new creative UI actions/properties without operation mapping and tests or an explicit unsupported reason. Validate actual evaluator/renderer references, not manual flags.
2. Provide a small documented SDK over the same operation API. If external HTTP/MCP access is desired, implement an opt-in scoped adapter after parity: authenticated project session, capability discovery, approval/revision fences, same receipts/events and revocation. It must not read stale server snapshots as if they were the open browser project, nor expose unrestricted anonymous mutations.
3. Run the acceptance matrix below at the exact release candidate, then staged integration, browser checks, immutable deployment/rollback and memory closeout in a separately authorised implementation/release turn.

Gate: internal and optional external adapters cannot bypass any validation, policy or single-writer rule. Native/external packaging is not a prerequisite for the built-in browser agent.

## 8. Release acceptance: demonstrate results, not labels

Required deterministic scenarios use real `EditorSession`, production Worker/RPC, domain compilers and renderers with scripted provider replies. Fake providers are appropriate for deterministic CI; they must not replace the actual compiler, commit, persistence or render path. Separately record a small explicitly authorised real-BYOK compatibility/creative-quality matrix with model/version/date and actual cost.

1. Import image/video/audio, create tracks, assemble a sequence, split/reorder/trim and keep metadata, source range, audio and animations intact.
2. Create and refine a title over two conversation turns, add three keyframes and easing, then sample values/pixels before/at/after keys. Repeat with nested/reversed/remapped timing.
3. Find an existing subtitle by content, edit text/timing/style, preserve word/segment validity, and render RTL text with installed free fonts.
4. Add/update/reorder an effect and transition, animate a supported parameter, verify junction/frame output, and reject an unsupported parameter cleanly.
5. Mix independent audio lanes, automate gain/pan, measure peaks/loudness and export the correct audio/video duration. Real processing/decode must run.
6. Edit a persisted 3D scene/camera or typed HTML manifest; compare actual preview/export frames and keep the result editable.
7. Work on an entity outside the initial context page and on a newly created entity referenced by a prior operation. IDs must be resolved, never guessed.
8. Before approval, compare canonical timeline/document/graph/artifact hashes, persistence and history count: unchanged. Preview pixels/geometry must actually differ. Approval adds exactly one transaction; one Undo restores exact state and applicable rendered output.
9. Reject, stop in each phase, provider timeout/malformed output, missing media, renderer error, compiler repair, stale user edit, project switch, panel unmount and Worker teardown. No stale preview, misleading completion or late-event resurrection.
10. Inject each journal/store failure and reload; retry the same execution ID; race two writers. Exactly one durable committed outcome or no edit, with explicit recovery if storage is unavailable.
11. Paid/remote/destructive/privacy-changing operations remain policy-bound; credentials, raw secrets and unauthorised media do not enter project/receipt/log/JOY server requests. Probe/CORS/redirect and provider-capability failures stay actionable and never silently reroute.
12. Mixed-domain English/Persian request: exact tool/operation targets, per-surface real previews, focus preserved with Follow off, sensible Follow on, reduced-motion/keyboard/RTL and narrow-panel behavior.
13. A real skill/workflow completes registry → discovery → actual operations/jobs → validated preview → policy → output → verification → receipt. A stub, unavailable handler or unchanged fake diff fails acceptance.
14. Hostile instructions in project names/text/transcripts, attachments, provider output and custom skill text cannot change endpoint, capabilities, approval or external-send policy. Explanation and verified no-op requests cause zero document mutations and zero external jobs. Test structured-plan capability independently from suggest-only/approval/automatic execution policies.

Record run success, field repair rate, semantic/visual correctness, expected vs actual changed entities, approval/revert rate, latency, token/observation count and measured/unknown cost separately. Target zero safety/atomicity failures in deterministic gates. Establish creative-quality thresholds from recorded fixtures and owner evaluation; do not invent a success percentage before running a baseline.

## 9. Implementation start and boundaries

Recommended first implementation slice: **A + the B/C foundation needed for one existing-title → keyframe → real preview → approved apply → readback → one Undo journey**, with the human/agent split/delete parity regression fixed at the shared seam. Then bring exact live events into that slice before broadening the domain list. This proves the architecture on the user's requested inspector/keyframing behavior rather than adding another inventory-only framework.

Do not begin with new settings cosmetics, more capability labels, a framework rewrite, a general shell tool, or enabling all dormant/stub functions. These do not solve the confirmed bottleneck. Do not flatten editable designs to video merely to claim an operation succeeded.

No source implementation, provider configuration, database migration or deployment was performed by this audit. This document is ready for an implementation turn; release status remains unchanged. Fontsource/Google Fonts migration and the closed Fontiran-specific redistribution gate remain unchanged; the separate whole-artifact licensing review is outside this agent plan.

## 10. External reference checks

- The [AI SDK ToolLoopAgent reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) documents multi-step tool execution, active tool subsets and stop conditions. These primitives support the chosen reuse strategy; they do not supply JOY's editor operations, policy, previews or verification automatically. Validate the pinned installed version and Worker build rather than assuming all current documentation APIs are available.
- Any optional remote adapter must follow the applicable versioned [MCP authorization requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). MCP is an interoperability transport, not a replacement for JOY's project permission, transaction or approval boundaries. Select and validate the supported protocol version when that optional work starts.
