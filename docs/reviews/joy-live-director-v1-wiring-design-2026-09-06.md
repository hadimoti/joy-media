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
- [ ] **Provide the remaining concrete `CreativeSkillEditorPrimitiveDeps` from
      `App.tsx`.** The blocker is that a recipe's `propose` must produce a
      _staged, previewable_ change, and that machinery — the `validate_proposal`
      RPC handler and the run-consumption loop — currently lives inside the
      ~600-line `handleSubmit` closure in `AgentPanel.tsx`. The careful seam
      extraction (with parity tests + a browser check that the direct
      tool-loop path is unchanged):
  - Extract `createJoyAgentEditRunController(deps)` from `handleSubmit`,
    carrying: the `prepareProposal` closure (host-lease + revision + session
    identity checks → `preparedChanges.stage` → `agentPreviewStore` populate),
    the run iterator consumption (the `for await (const event of runIterator)`
    body: proposal validation, `awaitingPreviewRender` renderer-ack gate,
    lifecycle `acceptRunLifecycle` calls), and `revokeStagedChange` /
    `terminalizeConnectionReset`. `deps` = `{ client, buildHost, preparedChanges,
agentPreviewStore, runController, session/refs accessors, proposalTargetsRef,
threadId, appendMessage }`.
  - `handleSubmit` becomes a thin caller of that controller (parity: the
    existing `agent-live-preview` / `agent-director-*` specs must stay green
    unchanged).
  - The recipe path then calls the same controller with a recipe-scoped host
    (wrapped `observe` tool recording the manifest id via
    `onObservationCompleted`) and the manifest-derived `allowedToolNames`.
  - `readObservationCoverage` = `observationBridge.tools.coverage({ manifestId })`
    for the recorded id; `confirmPreviewRendered` = read
    `agentPreviewStore.getBundle()` + `isAgentPreviewBundleReady`;
    `verifyComposedAndEncoded` = the O6 `composition-observer` +
    `final-encoded-export-decoder` for `verify-deliverable` only, each absent
    method an `unavailable` check.
- [ ] Modify `AgentPanel.tsx` — a recipe picker in the existing single project
      conversation (not a new tab); disabled entries show `missingCapabilities`
      / `missingOperations`; run events feed the V2 activity strings.
- [ ] Modify `joy-code-conversation.ts` — a recipe run attaches to the same
      per-project conversation (Creative Brief especially: no separate history).
- [ ] Create `tests/e2e/agent-director-skills.spec.ts` — on `desktop-primary`
      with the real Worker: run `find-moment` on `single-frame-flash-vfr` and
      assert the cited interval; run `build-rough-cut` and assert a prepared
      change that only commits after approval and reverses with one Undo; run
      `verify-deliverable` and assert the `DirectorVerificationReport`
      distinguishes rendered vs model-reviewed; assert an unavailable recipe
      cannot be started; assert hostile OCR/transcript instruction text in an
      artifact is rejected.
- [ ] Update `docs/reviews/joy-live-director-coverage.json` `limitations` with
      the recipe availability matrix.

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
