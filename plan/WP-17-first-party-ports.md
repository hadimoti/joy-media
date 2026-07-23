# WP-17 — First-Party Workflow Ports (P07 closure)

**Status:** proposed 2026-07-23 · **Parts:** P07 (workflows) closure · **Master plan:** §23.4, §36 Phase 7
**Prerequisite:** WP-16 done (recorder/parameterization shipped, `af9449f` deployed)

## Why

P07-workflows.md marks WP-07.1–07.4 complete and its exit criteria all checked.
STATE.md's P07 row still reads "in-progress" with the note "first-party ports
still stubbed." The first-party workflow *definitions* exist
(`packages/workflow-engine/src/first-party.ts`: long-video→draft-reels,
multilingual-promo, podcast-cleanup — each with tested JSON artifacts under
`packages/workflow-engine/workflows/*.json`), but nothing in `apps/editor-web`
imports `firstPartyDefinitionFiles()` or shows them in the Workflows panel.
A workflow the user can't discover, run, or save a recording of is not a
shipped workflow.

## Scope

### WP-17.1 — Workflows panel: first-party section

- Render the three first-party workflow JSON artifacts alongside recorded
  `user.workflows.*` entries in `WorkflowsPanel.tsx`, under a separator and a
  short label ("System workflows" vs. "Your workflows").
- System entries are read-only: no Save/Run-with-inputs, no delete. A
  "Run with inputs" affordance is enough to prove they are reachable.
- Schema for required inputs comes straight from each definition's
  `inputs.required` + `inputs.properties` — the same `extractWorkflowInputs`
  helper already used for recorded workflows drives the modal, so system and
  user workflows share one Run UX.
- First-party JSON is loaded lazily via
  `import('*.json')` in `apps/editor-web/src/first-party-workflows.ts`,
  fingerprinted by `FIRST_PARTY_WORKFLOWS_VERSION`; a version bump in
  `workflow-engine` surfaces a "system workflows updated" hint in the panel
  header.

### WP-17.2 — Run the long-video→draft-reels seed end-to-end

- Pick one of the three (draft-reels is the owner-stated §23.4 headline).
- Register handlers in a new
  `apps/editor-web/src/first-party-handlers.ts` for every node type the
  first-party definition references that is *not* a recorded
  `editor.commandTransaction` — at minimum:
  `input.item`, `analysis.transcribe`, `analysis.hooks`,
  `decision.approval`, `control.map`, `output.metadata`,
  `transform.reframe`, `transform.caption`, `transform.normalizeAudio`,
  `render.preview`, `render.final`, `output.folder`. The first three can
  stub against the local transcription + a hardcoded hook list; the
  `decision.approval` node must park the run as `waiting_for_input` and
  resume on the panel's human response (same mechanism WP-16's
  `human-input` runtime already supports).
- Integration test: build the workflow via `parseWorkflowJson(importedJson)`,
  execute with `executeWorkflow` against a fake handler registry, feed a
  synthetic human response at the first approval node, assert
  (a) the run parks with `waiting_for_input`, (b) resume finishes,
  (c) the second approval node also parks, (d) the manifest node records the
  output.
- One live-gate test: load the JSON, run with a deterministic input batch,
  verify the output file list is auditable (matches the manifest schema).

### WP-17.3 — Recorded workflows gain a "Derived from" badge

- When a recorded workflow's `steps[0].tool` + `description` match a
  first-party workflow (e.g. a recorded "split + caption" derived from the
  multilingual-promo caption node), the Workflows panel row shows a small
  amber "derived from: joy.first-party.multilingual-promo" pill. This
  fulfils the D-AGENT line that "any process the owner performs once should
  be teachable" — the recorder already does the teach part; this makes the
  lineage visible.

### WP-17.4 — P07 gate closure evidence

- Update `STATE.md` P07 row to `done` with the WP-17 commit SHA.
- Update `plan/P07-workflows.md` status line.
- Browser smoke: Workflows panel renders both sections on `media.joyteam.ir`,
  long-video→draft-reels Run opens the input modal, human-input park/resume
  works, manifest is produced.
- Replay the P07 exit-criteria list with concrete evidence pointers
  (commit SHAs, test names, live URLs) — same format the WP-12/WP-14 gate
  reviews used.

## Out of scope

- Visual builder (§23.7) — explicitly deferred until runtime stabilizes.
- Headless CLI runner — `bin/joy-workflow.mjs` already exists; WP-17 does
  not change it.
- Wiring `multilingual-promo` and `podcast-cleanup` to live providers
  (TTS, denoise) — those need provider SDK work that lives in P05; WP-17
  only proves the *runner* can execute the graph and park at approvals.
- First-party workflow edits — they are shipped as versioned JSON; the
  recorder is for user workflows.

## Exit criteria

- [ ] `firstPartyDefinitionFiles()` JSON artifacts are reachable from the
      editor with a single import; a version bump invalidates the import.
- [ ] Workflows panel shows system + user sections, design-aligned.
- [ ] `executeWorkflow` runs `joy.first-party.long-video-draft-reels`
      with stub handlers, parks at the first `decision.approval`, resumes
      on human input, parks again, and produces a manifest — proven by a
      deterministic test.
- [ ] Live-gate: `https://media.joyteam.ir` Workflows panel Run modal
      works for the first-party system entry.
- [ ] P07 row in STATE.md is `done`; plan status is `done`.

## Decisions needed before starting

- D-W17-1: Where do the system-workflow JSON artifacts live at runtime?
  Options:
  (a) bundled into the editor-web `dist/assets/` via Vite's `import.meta.glob('./workflows/*.json', { eager: true, import: 'default' })`;
  (b) fetched from `/api/first-party/workflows.json` once the API exists;
  (c) a tiny `getFirstPartyWorkflows()` async function that returns the
  inlined definitions.
  Recommendation: (a) for WP-17.1; it's a static, versioned artifact that
  belongs with the bundle until the API surfaces it.
- D-W17-2: What does the approval modal look like for non-clip inputs?
  The recorded-workflow modal is already form-based (text/number fields).
  The draft-reels approval needs a *list picker* for the candidate
  checkboxes. Owner direction: reuse the same modal surface, add a
  checkbox list variant for `choose-candidates` / `approve-render` /
  `accept-edit-diff` kinds.

## Validation

- `pnpm typecheck` clean.
- `packages/workflow-engine` 91+ tests (existing + new first-party-runner
  tests).
- `apps/editor-web` 63+ tests + new first-party handler tests.
- Monorepo green: 1191 + N.
- Live browser: Workflows panel shows both sections, Run modal works for
  the system entry, human-input park/resume observable.

## Risks

- The first-party definitions reference node types
  (`analysis.transcribe`, `render.preview`, etc.) that have no editor
  handlers yet. WP-17.2 must stub them without lying about fidelity —
  the stub must be explicit in the audit trail so a later WP can
  replace it with a real handler without breaking the contract.
- The `control.map` node is a per-item sub-workflow. The existing
  `executeWorkflow` runtime must already support nested workflows; if
  not, that is a separate gate that WP-17.1 will trip and we have to
  fix it before WP-17.2.
