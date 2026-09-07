# V1 recipe-layer production wiring — design decision

Recorded: 2026-09-06 (Claude implementer). Status: **design agreed; runtime +
adapter + `entry-points` API landed (`686369be`); real host primitives + UI +
e2e still open.**
This addresses the "`skill-runner` / `creative-skills` has no production caller"
open item in `joy-live-director-r1-landing-2026-09-06.md`.

## The question

`packages/agent-tools/src/creative-skill.ts` defines eight R1 recipes as typed
manifests, and `apps/editor-web/src/joy-agent/skill-runner.ts` runs a recipe's
`inspect / observe / propose / preview / verify` checkpoints through an injected
`CreativeSkillRunAdapter`. Nothing in `entry-points.ts` constructs that adapter.
r1.md V1 wants "observe → propose → canonical prepare/repair → preview →
authority → commit → verify" with "at most two repair proposals by default" and
`tests/e2e/agent-director-skills.spec.ts` on the real Worker.

The open architectural point: **where does the model reasoning sit** inside a
checkpoint adapter?

## Decision: the recipe is a scaffold around the existing tool-loop, not a parallel executor

The production `CreativeSkillRunAdapter` **delegates to the same infrastructure
`runJoyAgentTask` already uses** — one built-in Worker, the observation host
bridge (`createJoyAgentObservationHostBridge` in `App.tsx`), the canonical
compound compiler/runner, the staged-preview path, and `director-verifier`.
There is no second model loop and no second executor.

Concretely, `apps/editor-web/src/joy-agent/creative-skill-host-adapter.ts`
(new) builds a `CreativeSkillRunAdapter` from the objects `App.tsx` already
owns:

- **`inspect`** — one bounded `read_project_context` host RPC scoped to the recipe's `contextSelectors`; emits a `context` artifact (no model call)
- **`observe`** — a scoped observation pass: the observation service is asked for the recipe's `evidenceRequirements` within `budget.maxObservationRequests` / `maxEvidenceItems`; emits `evidence` / `moment` artifacts with coverage + uncertainty. For `explicit-media-consent` recipes this is gated by the existing `ObservationConsentRegistry`.
- **`propose`** — a scoped `runJoyAgentTask({ mode: 'tool-loop' })` with `allowedToolNames` restricted to `read_project_context` + `validate_proposal` (+ the observe tools only if the recipe declares them) and a **recipe-owned prompt template** that carries the recipe title, its required operation kinds, and the `inspect`/`observe` artifact summaries. The model still reasons, but only inside the one Worker, and can only reach the canonical host compiler — exactly as today. Emits a `prepared-change` artifact (the opaque proposal digest).
- **`preview`** — stage the prepared change through the existing preview path; require renderer acknowledgement before the checkpoint completes. Emits a `preview` artifact.
- **`verify`** — build a `DirectorVerificationReport` from real evidence: `structural` from the F5 `*-readback` result, `rendered` from `composition-observer`, `audio-measured` from `audio-observer`, `encoded-output` from `final-encoded-export-decoder` — each only when the recipe declares that evidence requirement; otherwise the check is `unavailable` with stated uncertainty. Emits a `verification` artifact.

Commit stays where it is: `skill-runner` has no `apply`, and a
`prepared-change` artifact makes the run `ready-for-approval`. The user
approves through the existing envelope; the compound runner then runs the F5
project-state readback.

### Repair loop

The `propose` handler passes `budget.maxRepairProposals` (0–2) to the scoped
`runJoyAgentTask`; the bounded-tool-loop already caps repairs and routes every
repair through the canonical host compiler. A user correction or a new manual
edit between `propose` and `preview` invalidates the prepared change via the
existing revision/digest binding — no new mechanism.

## Runtime capability computation

`resolveCreativeSkillAvailability` needs a `CreativeSkillRuntime`
(`capabilities` + `operationDefinitions`). Compute it in `entry-points.ts` from
**verified seams only**:

- `project-context`, `canonical-prepare`, `preview`, `approval` — always true
  in the editor host (proven by `agent-live-preview.spec.ts`).
- `source-observation`, `evidence-coverage`, `transcript-evidence`,
  `audio-analysis` — true when the observation host bridge is present
  (`App.tsx` constructs it) and the corresponding
  `media-observation` module has a passing browser spec.
- `composition-capture`, `encoded-output-verification` — true; proven by
  `agent-director-render-verification` / `final-encoded-export-decoder` specs.
- `audio-mix`, `rtl-text` — **false for R1** unless a verified audio-mix
  operation and an RTL-text readback exist. `audio-balance` and
  `title-and-caption-polish` therefore stay _visible-but-unavailable_, which is
  the honest state (`resolveCreativeSkillAvailability` already models this).
- `operationDefinitions` — the F1 registry, filtered to `canAdvertiseOperation`.

Net R1 availability: `creative-brief`, `watch-and-map`, `find-moment`,
`build-rough-cut`, `motion-and-transition-polish`, `verify-deliverable`
runnable; `title-and-caption-polish` and `audio-balance` visible-unavailable
until their capabilities are verified. Record this in the coverage ledger's
`limitations`.

## Files (implementation checklist)

- [x] `apps/editor-web/src/joy-agent/creative-skill-runtime.ts` + `.test.ts`
      (5 tests) — the verified-seam → `CreativeSkillCapability[]` mapping and
      `R1_EDITOR_CREATIVE_SKILL_SEAMS` (audio-mix / rtl-text = false).
- [x] `apps/editor-web/src/joy-agent/creative-skill-host-adapter.ts` +
      `.test.ts` (8 tests) — the single-use adapter that turns
      `CreativeSkillHostPrimitives` into recipe checkpoints; asserts **no
      `apply`/`commit`**, authority re-checks, per-recipe phase routing
      (find-moment → moment+coverage; build-rough-cut → prepared-change +
      preview; verify-deliverable → `DirectorVerificationReport`), block on
      no-prepared-change / renderer-not-acknowledged, and hostile-text
      rejection through the runner's artifact gate.
- [x] `entry-points.ts` — `listCreativeSkills(seams?)` and
      `runCreativeSkill({ skillId, scope, primitives, isAuthorityCurrent,
signal?, onEvent? })` (3 new tests in `entry-points.test.ts`). The
      **`CreativeSkillHostPrimitives` are injected** by the caller so the real
      host-wired implementation lives with the `App.tsx` object graph.
- [x] `apps/editor-web/src/joy-agent/creative-skill-editor-primitives.ts` +
      `.test.ts` (6 tests) — `createCreativeSkillEditorPrimitives(deps, scope)`
      builds `CreativeSkillHostPrimitives` from narrow function `deps`, runs
      one memoized scoped tool-loop shared by `observe`/`propose`, maps
      `answer` on an edit recipe to `no-actionable-edit`, and rethrows a
      `failed` loop. `buildCreativeSkillToolAllowList` (manifest-derived) and
      the product-owned `RECIPE_PROMPTS` live here.
- [x] `entry-points.ts` `runScopedCreativeSkillToolLoop({ client, host, prompt,
baseRevision })` — wraps `runJoyAgentTask` and maps its terminal event to
      `CreativeSkillScopedToolLoopResult` (3 tests). This is the
      `runScopedToolLoop` dep.
- [x] **Extract the `validate_proposal` staging handler** (`e611447c`) —
      `joy-agent/edit-proposal-staging.ts` `createJoyAgentProposalStagingHandler`.
      A pure factory over narrow deps; the ~110-line handler moved verbatim out
      of the `submitPrompt` closure. AgentPanel −123/+19. Not the whole
      `createJoyAgentEditRunController` — the run-consumption loop stays in
      AgentPanel for the direct path and `runJoyAgentTask` already provides it
      for the recipe path.
- [x] **Generalize the run fence + build the recipe host** (`ba7d96b2`) — the
      handler's `runId`/`activeModelRunIdRef`/`getComposerHostLease` deps became
      two predicates (`hasHostAuthority(rpcRun)`, `isRunCurrent()`); the editor
      path passes its composer-lease check, the recipe path its scope-current
      check. `joy-agent/recipe-scoped-host.ts`
      `runScopedCreativeSkillEditToolLoop(deps, input)` builds the recipe host
      (shared handler + manifest `allowedToolNames` bounded to the closed
      catalog + optional recipe-scoped observation tools + staged-change revoke
      on cancel) and runs it through `runScopedCreativeSkillToolLoop`. Parity
      e2e stayed green (18–21 on desktop-primary). This is the `runScopedToolLoop`
      dep.
- [x] **Concrete `CreativeSkillEditorPrimitiveDeps`** (`16d21c99`, `992f7a63`) —
      `joy-agent/creative-skill-editor-deps.ts`
      `createCreativeSkillEditorPrimitiveDeps(appGraph)` holds per-run
      observation state keyed by `scope.runId`; `recipe-scoped-host`'s
      `onObservationCompleted` widened to `{observationId, manifestId}`.
  - `readProjectContext` = bounded session summary, no model call.
  - `runScopedToolLoop` = `runScopedCreativeSkillEditToolLoop` with the graph.
  - `readObservationCoverage` = `bridge.tools.coverage({ manifestId }, ...)`.
  - `confirmPreviewRendered` = bounded wait on the shared preview store.
  - `verifyComposedAndEncoded` = `validateSpikeProject` structural check +
    `rendered`/`audio-measured`/`encoded-output` `unavailable` for R1.
  - `entry-points.ts` `runEditorCreativeSkill({ skillId, scope, deps,
isAuthorityCurrent })` composes primitives + `runCreativeSkill`.
- [x] **Fence the recipe observation bridge to its Worker run** (`9ba36632`) —
      `runScopedCreativeSkillToolLoop` forwards `onRunStart`; `recipe-scoped-host`
      captures the Worker run id and builds the recipe bridge via the App-owned
      `observationAdapterFactory` with a `currentAuthority` bound to that exact
      run. Deps gained `observationAdapterFactory` + `getModelId` +
      `getPromptPolicyDigest` (replacing the opaque `buildObservationBridge`).
- [x] **Extract `buildJoyAgentContextInput`** (`01ec7cd2`) —
      `joy-agent/context-input.ts`; `submitPrompt` and the recipe deps both call it.
- [x] **Wire it in `AgentPanel.tsx` + recipe picker** (`ef26f25c`, `9d268bf9`) —
      a third composer capability "Recipes" lists `listCreativeSkills()` with
      honest availability (dimmed + disabled Run + missing caps/ops for the
      unavailable ones). `createCreativeSkillEditorPrimitiveDeps` built from the
      existing panel graph; `runRecipe` allocates a `CreativeSkillRunScope`,
      fences concurrent direct edits via `activeModelRunIdRef`, drives the run
      lifecycle, routes a `ready-for-approval` staged change into the existing
      `modelChangeSetId` approval UI, and posts advisory / blocked / unavailable
      outcomes to the per-project conversation. `onStaged` passthrough added.
      (Recipe runs already `appendMessage` to the per-project conversation — no
      `joy-code-conversation.ts` change needed.)
- [x] **`agent-director-skills.spec.ts`** (`76638d7d`) — added the browser check
      that the picker renders the same runnable / visible-unavailable matrix as
      the module-level availability test, with disabled Run buttons.
- [x] **Model-driven recipe run-through e2e (advisory path)** — `agent-director-skills.spec.ts`
      "runs Verify Deliverable through the real Worker" drives the picker →
      `runEditorCreativeSkill` → concrete primitives → advisory tool-loop
      (new `advisoryAnswer` fake-provider mode) → `verifyComposedAndEncoded` →
      the honest R1 report in the conversation, with no approval card.
- [ ] **Edit-recipe run-through e2e (`build-rough-cut` approve + Undo)** — still
      open: the Timeline Elements Showcase's human-readable track ids (`"Video 1"`)
      are not valid model-plan identifiers, so a model `timeline.trimClip`
      proposal against it is rejected before the staging handler. Needs a
      video-bearing fixture project with token-safe clip/track ids (import a
      generated fixture, or a dedicated showcase). The staged-change → approval
      routing itself is unit-proven (`recipe-scoped-host.test.ts` drives a real
      `validate_proposal`) and the direct-edit approve/Undo is covered by
      `agent-live-preview` / `agent-director-lifecycle`.
- [ ] Update `docs/reviews/joy-live-director-coverage.json` `limitations` with
      the recipe availability matrix (already carries the V1 recipe note; refine
      once the run-through e2e lands).

## The observe/propose split — resolution for the real primitives

`skill-runner` calls `observe` and `propose` as separate checkpoint handlers,
but the model reasoning that decides _which_ asset/range to observe and _what_
edit to prepare is one continuous thing. The real adapter therefore runs **one
scoped `runJoyAgentTask` tool-loop per recipe run**, started lazily on the
first checkpoint that needs the model, with later checkpoints reading the
cached run:

- `readProjectContext` (inspect) — a direct `read_project_context` host RPC.
  No model. Feeds its summary into the tool-loop prompt.
- The first of `observe` / `propose` to run starts the scoped tool-loop:
  - `allowedToolNames` = `['read_project_context']`
    - `+ ['media_describe','media_observe','media_coverage', ...]` iff the
      manifest's `evidenceRequirements` is not `['none']`
    - `+ ['media_transcript']` iff it requires `transcript`
    - `+ ['validate_proposal']` iff the manifest has `requiredOperationKinds`
      (i.e. an edit recipe, not an advisory one)
  - prompt = a **product-owned template** keyed by `skillId` (constant, never
    model/user text) + the recipe title + the required operation kinds + the
    inspect/observe artifact summaries. `maxRepairProposals` from the budget.
  - The run is `mode: 'tool-loop'`; `taskKind` = a new `'creative-skill'` kind
    so policy/telemetry can distinguish it.
- `observe` reads the tool-loop's observation evidence + coverage
  (`media_coverage` result) → `evidence` / `moment` artifact + coverage status.
- `propose` reads the tool-loop's terminal state:
  - `awaiting-approval` with an opaque `proposal` → `prepared` result
    (`changeSetId` = `proposal.changeSetId`, digest, count).
  - `completed` with an `answer` and no proposal → for an **advisory** recipe
    this is success (the cited interval / evidence map is the answer); for an
    **edit** recipe it is `{ kind: 'unavailable', reason: 'no-actionable-edit' }`.
  - `failed` → the adapter throws → run `blocked`.
- `stagePreview` — the tool-loop already stages the preview (it emitted
  `previewing` before `awaiting-approval`). This primitive confirms the
  renderer acknowledged that staged preview (the same renderer-ack signal
  `agent-live-preview.spec.ts` asserts) and returns `previewId`.
- `verifyDeliverable` (verify-deliverable only) — runs
  `composition-observer` at the composed output times and
  `final-encoded-export-decoder` on the last export artifact, mapping their
  results to `DirectorVerificationCheck`s (`rendered`, `encoded-output`);
  `audio-measured` from `audio-observer` when the project has audio; each
  absent method is an `unavailable` check with stated uncertainty.

Commit is still only the existing approval envelope: `propose` returning a
`prepared` result makes the skill-runner report `ready-for-approval`, and the
user approves exactly as they do for a direct tool-loop edit today.

## Non-goals for R1

- No `audio-mix` or RTL-text readback capability (kept visible-unavailable).
- No new state system, history tab, or Brief tab.
- Recipe prompt templates are product-owned constants, never model- or
  user-authored, and cannot raise `allowedToolNames` beyond the manifest.
- One tool-loop per recipe run; no second executor, no parallel model loop.

## Appendix: `AgentPanel.tsx` seam map (Option A)

Concrete line references as of `b634d3cd`. The extraction target is the
`void (async () => { … })()` IIFE inside `submitPrompt`.

| Region                                                             | Lines         | Moves to                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitPrompt` fn                                                  | 1313–2048     | stays; becomes thin caller                                                                                                                                                                           |
| tool-loop guard + run-id allocation + `discard*` + `beginRun`      | 1367–1439     | stays in `submitPrompt` (UI/refs setup)                                                                                                                                                              |
| **the async IIFE**                                                 | **1440–2016** | **`createJoyAgentEditRunController(deps).start(runInput)`**                                                                                                                                          |
| `contextInput: JoyAgentContextSnapshotInput` build                 | 1446–1513     | stays; passed in as `runInput.contextInput`                                                                                                                                                          |
| `mode` / `structured` / `capturedModelId` / `capturedPolicyDigest` | 1514–1521     | into controller (`runInput` carries `mode`, `taskKind`)                                                                                                                                              |
| `observationBridge` construction                                   | 1522–1584     | stays in `submitPrompt`; passed as `runInput.observationBridge` (recipe path injects its own)                                                                                                        |
| `revokeStagedChange` (mutates `stagedChangeSetId`)                 | 1585–1597     | controller-owned                                                                                                                                                                                     |
| `terminalizeConnectionReset`                                       | 1598–1632     | controller-owned                                                                                                                                                                                     |
| `host` literal (`createJoyAgentHostRpcMethodsForSnapshot(…)`)      | 1633–1764     | `deps.buildHost({ prepareProposal, allowedToolNames, observationTools, onObservationCompleted, onCancelled })` — direct path passes the snapshot builder, recipe path passes the manifest-scoped one |
| `prepareProposal` = the `async (proposal, rpcContext) => {…}` body | 1638–1748     | controller-owned; the one piece both hosts share                                                                                                                                                     |
| `contextSnapshot` (non-structured only)                            | 1765–1767     | stays with `buildHost` caller                                                                                                                                                                        |
| `client.startRun(...)` + `runIterator`                             | 1768–1779     | controller-owned (`deps.client`)                                                                                                                                                                     |
| `beginRunLifecycle` + `createJoyAgentComposerHostLease`            | 1782–1792     | controller-owned                                                                                                                                                                                     |
| **`for await (const event of runIterator)` loop**                  | **1793–1974** | controller-owned                                                                                                                                                                                     |
| `catch` (failed-run cleanup + presence dispatch)                   | 1975–2005     | controller-owned                                                                                                                                                                                     |
| `finally` (lease revoke, `setThinkingThreadId`, `setAgentRunId`)   | 2006–2015     | controller-owned                                                                                                                                                                                     |

`deps` (all from the `AgentPanel` body, stable identities already `useCallback`/`useRef`):

- stores/clients: `client` (`joyAgentEngineClient`), `buildHost`, `preparedChanges`,
  `agentPreviewStore`, `agentPresenceStore`, `runController`
- refs: `activeModelRunIdRef`, `activeComposerHostLeaseRef`, `proposalTargetsRef`,
  `modelChangeSetIdRef`, `deferredPreviewApprovalRef`, `latestSessionRef`,
  `latestSettingsRef`
- session snapshot accessor: `getSession()` → live `session` (loop reads
  `session.projectRevisionId` / `session.historyCursorSequence` fresh each event)
- lifecycle helpers: `beginRunLifecycle` (789), `acceptRunLifecycle` (739),
  `cancelRunLifecycle` (802), `revokeActiveComposerHostLease` (782)
- prepared-change helpers: `currentPreparedAuthority` (1066),
  `setPreparedModelChange` (1077), `discardPreparedModelChange` (1082),
  `clearAgentPreviewForSourceRun` (822), `stageJoyAgentPreview` (import)
- observation: `registerObservationReviewCandidate` (594)
- UI: `setAgentPhase`, `setThinkingThreadId`, `setAgentRunId`, `appendMessage` (1174),
  `threadId`
- constants: `LEGACY_JOY_AGENT_TOOL_NAMES` / `JOY_AGENT_HOST_TOOL_NAMES`,
  `targetsForJoyCodeOperations`, `targetForJoyAgentTask`

`runInput` (per call): `{ runId, threadId, taskKind, taskTarget, prompt: body,
baseRevision, mode, structured, contextInput, selectedEntityReference?,
observationBridge?, allowedToolNames }`.

Recipe reuse: the recipe path builds `runInput` with `taskKind: 'creative-skill'`,
`allowedToolNames` from `buildCreativeSkillToolAllowList(manifest)`, and an
`observationBridge` whose `observe` tool records the manifest id via
`onObservationCompleted`; then reads back the controller's terminal
`{ kind: 'prepared' | 'answer' | 'failed', changeSetId?, … }` — the same shape
`runScopedCreativeSkillToolLoop` returns today.

Parity gate (must stay green unchanged): `tests/e2e/agent-live-preview.spec.ts`,
`agent-live-presence.spec.ts`, `agent-director-lifecycle.spec.ts`,
`agent-director-runtime.spec.ts`, plus the full editor-web vitest suite. Add a
focused `edit-run-controller.test.ts` with a fake `client` + in-memory
`preparedChanges` / `agentPreviewStore` asserting: staged change on
`awaiting-approval`, renderer-ack gate defers approval, `terminalizeConnectionReset`
revokes without touching a newer run, hostile proposal digest mismatch throws.
