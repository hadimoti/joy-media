# WP-17 — First-Party Workflow Ports (P07 closure)

**Status:** done 2026-07-23 (owner-accepted) · **Parts:** P07 (workflows) closure · **Master plan:** §23.4, §36 Phase 7
**Prerequisite:** WP-16 done (recorder/parameterization shipped, `af9449f` deployed)

## Why

P07-workflows.md marks WP-07.1–07.4 complete and its exit criteria all checked.
STATE.md's P07 row still read "in-progress" with the note "first-party ports
still stubbed." The first-party workflow _definitions_ exist
(`packages/workflow-engine/src/first-party.ts`: long-video→draft-reels,
multilingual-promo, podcast-cleanup — each with tested JSON artifacts under
`packages/workflow-engine/workflows/*.json`), but nothing in `apps/editor-web`
imported `firstPartyDefinitionFiles()` or showed them in the Workflows panel.
A workflow the user can't discover, run, or save a recording of is not a
shipped workflow.

## Scope

### WP-17.1 — Workflows panel: first-party section — done

- System workflows load via `@joy-media/workflow-engine` (`buildFirstPartyWorkflows`,
  D-W17-1a) in `first-party-workflows.ts`.
- Panel sections: **Your workflows** / **System workflows** with version badge.
- System rows are read-only (run only); inputs come from each definition's
  `inputs` schema; `asset` is prompted as `assetId` and normalized for the runner.

### WP-17.2 — Run the long-video→draft-reels seed end-to-end — done

- `createStubFirstPartyLibrary()` builds real `buildNodeLibrary` handlers with
  stub ports; every stub return includes `__stub: true`.
- `runWorkflow` / `resumeWorkflow` call `executeWorkflow` for first-party IDs,
  park at `decision.approval`, and resume with human inputs.
- Deterministic test: `wp17-first-party-live-gate.test.ts` covers park →
  choose-candidates → approve-render → manifest.

### WP-17.3 — Recorded workflows gain a "Derived from" badge — done

- Amber badge on **recorded** rows only via `detectDerivedFrom()` (goal/name /
  first-step text matching a first-party id). System rows are not labeled Derived.

### WP-17.4 — P07 gate closure evidence — done

- Decisions D-W17-1 / D-W17-2 recorded as DEFAULT in DECISIONS.md.
- STATE/plan stay `gate-review` until live browser evidence is attached.

## Out of scope

- Visual builder (§23.7) — explicitly deferred until runtime stabilizes.
- Headless CLI runner — `bin/joy-workflow.mjs` already exists; WP-17 does
  not change it.
- Wiring `multilingual-promo` and `podcast-cleanup` to live providers
  (TTS, denoise) — those need provider SDK work that lives in P05; WP-17
  only proves the _runner_ can execute the graph and park at approvals.
- First-party workflow edits — they are shipped as versioned JSON; the
  recorder is for user workflows.

## Exit criteria

- [x] `firstPartyDefinitionFiles()` JSON artifacts are reachable from the
      editor with a single import; a version bump invalidates the import.
- [x] Workflows panel shows system + user sections, design-aligned.
- [x] `executeWorkflow` runs `joy.first-party.long-video-draft-reels`
      with stub handlers, parks at the first `decision.approval`, resumes
      on human input, parks again, and produces a manifest — proven by a
      deterministic test.
- [x] Live-gate path: Workflows panel Run modal works for the first-party
      system entry on media.joyteam.ir (assetId → park → checkbox approval).
- [x] P07 row in STATE.md is `done`; plan status is `done` (owner-accepted after live evidence).

## Decisions used

- D-W17-1: bundled via `@joy-media/workflow-engine` (DEFAULT).
- D-W17-2: reuse run modal; checkbox list for `choose-candidates` (DEFAULT).

## Validation

- `pnpm typecheck` clean.
- `apps/editor-web` 69/69 including WP-17 live-gate.
- Stub ports never claim real provider fidelity (`__stub: true`).

## Gate review evidence (2026-07-23)

Independent Chromium headless against `https://media.joyteam.ir/` (release `e1f9307`):

1. Editor mounts; Workflows tab active; **System workflows v1.0.0** lists all three
   first-party definitions (`Long video → draft reels`, multilingual promo, podcast cleanup).
2. Run opens modal for `joy.first-party.long-video-draft-reels` with asset input default `asset-demo-1`.
3. Submit parks at `choose-candidates` with checkbox list Hook A/B/C; status
   `Waiting for approval: choose-candidates`.
4. Continue parks at `approve-render`; status `Waiting for approval: approve-render`.
5. Continue finishes; status `Finished joy.first-party.long-video-draft-reels`; modal cleared.
6. Console: only expected identity `401` resource failures (no workflow/page errors).
7. Unit evidence: `wp17-first-party-live-gate.test.ts` park→resume→manifest with `__stub: true`.
8. `pnpm typecheck` clean; editor-web 69/69.

### Residual / honesty (not blocking editor reachability)

- Stub ports do **not** mutate the live timeline into real editable branches; they prove
  graph execution + approval parking in the editor. Real providers remain P05 scope.
- WP-17.1 “system workflows updated” toast on version bump is not implemented; only the
  static `v{FIRST_PARTY_WORKFLOWS_VERSION}` badge is shown.
- Derived-from badge requires a recorded workflow whose goal/name matches; empty user
  list correctly shows no badge.

**Gate status:** accepted by owner 2026-07-23. P07/`done` closed.
