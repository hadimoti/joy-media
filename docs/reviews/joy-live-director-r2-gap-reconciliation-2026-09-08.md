# JOY Live Director R2 — gap reconciliation vs. the approved plan

**Written 2026-09-08 (session `joy-media-62`).** The owner reviewed candidate
`7a509e6c` and ruled: **finish R2 to the approved plan before deploying — no
apply-only partial release.** This document reconciles
`docs/superpowers/plans/2026-09-05-joy-live-director-{master,r2-r3}.md` against the
implementation on `codex/joy-live-director` and lists every remaining requirement,
source-anchored, with an implementation approach and named tests.

**Preserved decisions (not gaps):**

- **English-only.** `persian-editorial` stays retired. Do not restore it. The
  standalone `rtl-*` templates + Vazirmatn + the pre-existing RTL caption engine
  stay untouched.
- **No OpenAI/Codex; never self-approve; BYOK browser engine kept; Fontiran
  redistribution gate stays CLOSED; parallel `joy-vps` work untouched.**

**Plan acceptance bar (master line 34):** _"Six editable packs, manual/agent
parity, audio-reactive timing, creator evaluation."_ Master line 38: a partial
slice may not be called complete without explicit owner scope acceptance — the
owner has declined that, so all of the below must close.

Music Pulse re-enters scope: the owner said **fix it, don't hold it**. R2 ships
**five** packs (editorial-clean, product-precision, kinetic-type,
quiet-documentary, music-pulse).

---

## What is already DONE (keep, re-verify at the new candidate)

| Layer               | Done                                                                                                                                                                                                | Source                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| L1 schema           | `LookInstance` type, `isLookBindingWritable`, `validateLookInstance(s)`; project schema **v3** additive (`LATEST_PROJECT_SCHEMA_VERSION = 3`, `lookInstances?`, `migrateV2ToV3`, `migrateToLatest`) | `packages/project-schema/src/{living-look,v3,migration}.ts`  |
| L2 compiler         | `compileLook` → canonical ops + FNV-1a digest, fail-closed, override-aware; `mapLookControl`; `validateLookDefinition` ("no fake slider" mechanical)                                                | `packages/motion-core/src/looks/{compile,validate,types}.ts` |
| L2 adapter (apply)  | `translateLookOperations` 1:1 → JoyCode plan; `prepareLookPlan`; `catalog` / `describe`                                                                                                             | `apps/editor-web/src/joy-agent/look-operations.ts`           |
| L2 run host (apply) | `stageLookRun` → `createJoyAgentProposalStagingHandler` (R1 handler unchanged); `contextProjectId = session.visualProject.id`                                                                       | `apps/editor-web/src/joy-agent/look-run-host.ts`             |
| L2 panel (apply)    | `LivingLooksPanel` + AgentPanel `runLook` → staged preview → Approve → Undo                                                                                                                         | `apps/editor-web/src/{LivingLooksPanel,AgentPanel}.tsx`      |
| L3 packs            | 4 typed packs + goldens + `packs-render-fidelity.test.ts` (numeric)                                                                                                                                 | `packages/motion-core/src/looks/packs/`                      |
| L4 core             | `bakeAudioReactive` (bounded keys, approximation error, silence rest line)                                                                                                                          | `packages/motion-core/src/looks/audio-reactive.ts`           |
| L4 bridge           | `beatEnvelopeToLookEnvelope` + `bakeLookAudio`; `LookCompileInput.audioBakes`                                                                                                                       | `apps/editor-web/src/joy-agent/look-audio-bridge.ts`         |

---

## GAP 1 — Saved, reopenable, adjustable Look instances (L1 + L2)

**Plan (r2-r3 L1):** _"Include instances in session revision, atomic journal, Undo
and package portability."_ **(L2):** _"Implement `looks.catalog`, `looks.describe`,
`looks.prepareApply`, `looks.prepareUpdate`, `looks.detach` and
`looks.resetOverrides` through the R1 operation registry … Detach preserves
authored entities as ordinary editable content … User edits on linked bindings
mark overrides through the canonical operation path."_ **e2e:** _"prove … exact
Undo/Redo/reload and project export/import."_

**Current state:** the editor document bridge still reads `JoyProjectV1` only —
`apps/editor-web/src/project-package.ts` (`as JoyProjectV1`, `validateJoyProjectV1`)
and `project-document-hydration.ts` (`visualProject: JoyProjectV1`,
`synchronizeVisualProject(next: JoyProjectV1)`). A Look apply commits its
operations through the normal approve path (Undo works) but **no `LookInstance` is
persisted**, so nothing is reopenable, adjustable, detachable, or portable. No
`looks.prepareUpdate` / `looks.detach` / `looks.resetOverrides`.

### 1a — editor reads/writes schema v3

- **Files:** `apps/editor-web/src/project-package.ts`,
  `project-document-hydration.ts`, `project-package.test.ts`,
  `project-document-hydration.test.ts` (+ any `App.tsx` graph wiring for the
  session revision / journal).
- **Approach:** the hydration seam runs `migrateToLatest` on load so any v2 doc
  becomes a v3 doc with `lookInstances` defaulting absent; `validateJoyProjectV3`
  replaces `validateJoyProjectV1` at the document boundary; `synchronizeVisualProject`
  carries `lookInstances` through. Editing surfaces that only understand v1/v2
  fields keep working unchanged (v3 is additive). Package export/import round-trips
  `lookInstances`; credentials / evidence bytes still excluded.
- **Red tests:** schema-5 (v2) project with no Looks round-trips byte-identical;
  a v3 project with one instance hydrates, survives `synchronizeVisualProject`,
  and re-serializes equal; unknown newer schema opens read-only without stripping
  `lookInstances`; export→import preserves the instance and its `overriddenBindingIds`.

### 1b — `looks.prepareUpdate` / `looks.detach` / `looks.resetOverrides` host ops

- **Files:** `apps/editor-web/src/joy-agent/look-operations.ts` (+ test),
  `look-run-host.ts` (+ test), operation-registry wiring, `AgentPanel.tsx`.
- **Approach:**
  - **persist on apply** — `stageLookRun` success also stages a `LookInstance`
    write into `lookInstances[id]` as part of the _same_ approved change-set
    (instances live in the canonical journal, one Undo reverts both the ops and
    the instance record).
  - **`prepareUpdate(instanceId, nextControlValues | nextBindings)`** —
    recompiles the pinned definition with the new inputs, diffs against the
    instance's last compiled digest, emits only the changed keyframes/templates,
    and **never rewrites a binding in `overriddenBindingIds`** unless
    `resetBindingIds` names it (compiler already enforces this — the host just
    passes `overriddenBindingIds` through).
  - **`resetOverrides(instanceId, bindingIds)`** — clears the named ids from
    `overriddenBindingIds` and re-applies the definition to exactly those.
  - **`detach(instanceId)`** — removes the `LookInstance` record, leaves every
    authored keyframe/template in place as ordinary editable content (no op
    emission). Removal of instance-owned created entities is a separate explicit
    intent, not part of detach.
  - **override marking** — a manual Inspector edit (or a user-directed agent
    edit) on a linked binding adds that `bindingId` to the instance's
    `overriddenBindingIds` through the canonical commit path. Hook the existing
    property-commit seam so both manual and agent edits mark identically.
- **Red tests** (`look-operations.test.ts`, `look-run-host.test.ts`): apply then
  reopen yields the same control values; `prepareUpdate` with a changed control
  re-emits only the affected bindings; a hand-edited binding is untouched by
  `prepareUpdate` and touched by `resetOverrides`; `detach` leaves ops, drops the
  record, and one Undo restores the record; an update targeting a stale revision
  fails closed with no partial commit.

### 1c — panel: reopen + adjust + detach

- **Files:** `LivingLooksPanel.tsx` (+ test), `AgentPanel.tsx`.
- **Approach:** the panel lists applied `LookInstance`s for the active
  composition; selecting one loads its controls; changing a control routes
  through `prepareUpdate` → the same staged-preview + Approve + Undo path; a
  Detach action routes through `detach`; the Inspector shows an "override" marker
  on a hand-edited linked binding. Manual and agent both call the identical host
  ops (parity — GAP 4).
- **e2e** (`tests/e2e/agent-living-looks.spec.ts`, extended): apply a Look →
  reload the project → the Look is still listed and reopenable → adjust a control
  → Approve → Undo/Redo restore exactly → hand-edit one bound property → adjust a
  _different_ control → the hand-edit survives → `resetOverrides` re-links it →
  export the project, re-import into a fresh session → the instance and its
  overrides come back.

---

## GAP 2 — Audio-reactive motion end to end (L4)

**Plan (r2-r3 L4):** _"Compare preview/export evaluation at exact impulse/key
times, then decode the export to verify A/V alignment. Run … `living-looks-audio-motion.spec.ts`."_
Master line 34: _"audio-reactive timing."_

**Current state:** pure core (`bakeAudioReactive`) + host bridge
(`beatEnvelopeToLookEnvelope`, `bakeLookAudio`) + `LookCompileInput.audioBakes`
all exist and are unit-tested. **No UI path** feeds a decoded audio track's bakes
into `runLook`; **no `living-looks-audio-motion.spec.ts`.**

- **Files:** `AgentPanel.tsx` / `LivingLooksPanel.tsx` (+ tests),
  `apps/editor-web/src/joy-agent/look-run-host.ts`,
  `tests/e2e/living-looks-audio-motion.spec.ts` (new),
  `tooling/fixtures/living-looks.json` (audio fixture).
- **Approach:** when the active composition has a decoded audio track with an R1
  `BeatEnvelopeEstimate`, the Music Pulse panel offers "bake from audio";
  choosing it runs `beatEnvelopeToLookEnvelope` (host owns source→composition
  time map) → `bakeLookAudio` → passes `audioBakes` into `stageLookRun` → the
  compiler emits the baked keyframes verbatim on the target binding, superseding
  the slider drive (already supported). The baked keys are ordinary editable
  keyframes; editing one marks the binding overridden (GAP 1b); silence /
  confidence < 0.15 → a flat rest line (already enforced in the baker).
- **Red / e2e tests:** a known-impulse fixture bakes to keyframes at the expected
  composition times; smoothing never exceeds the declared property range; a
  speed/remap change invalidates the derived timing; **decode the exported
  media and assert the scale peak lands within tolerance of the beat** (the
  A/V-alignment check the plan names); low-confidence input reports without
  inventing a downbeat.

---

## GAP 3 — Music Pulse is honest (L3)

**Owner:** _"Fix Music Pulse before advertising or shipping it."_ **Taste review
findings:** (a) the "Accent cuts" boolean compiles to a permanent-on track — the
compiler's boolean branch calls `emitKeyframes(id, value, value, …)` so the
declared `profile` is inert (`compile.ts` ~line 491-499); (b) the pulse has no
rate control, so `atFractions: [0, .25, .5, .75, 1]` gives exactly two swells per
composition at any length; (c) `subject-treatment` applies a **text** template to
a generic `visual-object` slot.

- **Files:** `packages/motion-core/src/looks/{types,compile,validate}.ts`
  (+ tests), `packages/motion-core/src/looks/packs/music-pulse.ts`,
  `music-pulse.test.ts`, goldens; re-add `musicPulse` to `BUILT_IN_LOOK_PACKS`.
- **3a — boolean drive gets a live rest value.** Add `LookBooleanDrive.rest?:
number` (default 0). Boolean-on emits `emitKeyframes(id, rest, whenTrue,
atFractions, profile, interpolation)` so the profile shapes a real
  rest→peak→rest cut pattern. Boolean-off still emits `whenFalse` (flat) or
  omits. `validate.ts`: a boolean drive with a non-`omit` `whenFalse` equal to
  `rest` and `whenTrue` equal to `rest` is a fake toggle → reject.
- **3b — a real rate control.** Add `LookEnumDrive.periodsByOption?:
Record<string, number>`. When present for the selected option, the compiler
  generates `2·periods + 1` evenly-spaced fractions with an alternating
  `[0,1,0,…,0]` profile and emits `emitKeyframes(id, byOption[opt] /*rest*/,
settled /*peak*/, generatedFractions, generatedProfile, interpolation)`.
  Add a `rate` enum control to Music Pulse (`calm` / `steady` / `driving` →
  periods `2` / `4` / `6`) driving `subject-scale-x/y` between rest `1` and peak
  `1.12`. Replace the fixed-table `depth` scalar (its amplitude role folds into
  the fixed bounded peak; L4 audio is the real dynamic path). `validate.ts`:
  `periodsByOption` values must be integers ≥ 1; an enum drive with
  `periodsByOption` still needs a rest/peak pair.
- **3c — slot honesty.** Rename the `subject` slot label to make the
  text-template expectation explicit (e.g. "Pulsing headline / logotype") **or**
  move `subject-treatment` to a text-bearing binding. Prefer the rename — Music
  Pulse's subject is a title-card object in every pack fixture.
- **Tests:** boolean-on with `[0,1,0,1,0]` profile emits `0,1,0,1,0` not
  `1,1,1,1,1`; `rate: driving` emits 13 keyframes across the composition;
  `rate: calm` emits 5; golden snapshots re-blessed; `music-pulse.test.ts`
  folded back into the main `packs.test.ts` loop (5 packs).

---

## GAP 4 — Actual rendered-frame + encoded-export acceptance (L3)

**Plan (r2-r3 L3):** _"Render before/after/keyframe boundary frames and full
short motion previews using actual JOY rendering. Establish golden expectations
for stable geometry/timing/pixels with pinned fixture fonts … Run …
`living-looks-render.spec.ts`. Review actual motion and legibility visually; save
sanitized samples … A passing schema test is not art-direction approval."_

**Current state:** only `packs-render-fidelity.test.ts` — numeric `sampleCurve`
of compiled keyframes. **No `tests/e2e/living-looks-render.spec.ts`; no rendered
frames; no encoded-export check; no sample images.**

- **Files:** `tests/e2e/living-looks-render.spec.ts` (new),
  `tooling/fixtures/living-looks.json`, sanitized sample renders under
  `docs/reviews/assets/r2-look-samples/` (or attached to the scorecard).
- **Approach:** drive from a test harness (not the finished panel): for each of
  the 5 packs, portrait + landscape, on a pinned-font sanitized fixture —
  1. apply the pack, render the first frame, a mid-motion keyframe-boundary
     frame, and the settle frame via the real JOY renderer;
  2. assert stable geometry/timing with an explicit rasterization tolerance
     (numeric RGBA compare, not a broad screenshot mask);
  3. assert legibility invariants the plan names — text inside safe margins, no
     clipping of the headline box, contrast ratio of the resolved template pair
     ≥ threshold;
  4. encode a short export and decode it back — assert the keyframed property
     value at a sampled PTS matches the preview evaluation (preview/export
     parity), and for Music Pulse the audio-aligned case (shared with GAP 2).
- **Sample renders:** save 2–3 sanitized frames per pack for the scorecard's
  owner/creator visual read. These supplement — do not replace — the numeric
  `packs-render-fidelity.test.ts`, which stays.

---

## GAP 5 — Manual / agent parity through the canonical boundary (L2)

**Plan (r2-r3 L2):** _"Agent and manual interactions compile the same inputs to
identical complete state. User edits on linked bindings mark overrides through the
canonical operation path, including edits made by user-directed agent commands."_

**Current state:** apply parity exists (`LivingLooksPanel` `onRun` and AgentPanel
`runLook` both call `stageLookRun`). **Reopen / update / detach / override-marking
do not exist yet**, so parity for those paths is unbuilt.

- **Approach:** every host op from GAP 1b is called identically by the panel
  (manual) and by an agent capability (`runLook` / a new `updateLook` /
  `detachLook` on the composer capability). One code path, one approval boundary,
  one Undo grouping.
- **Tests:** a manual `prepareUpdate` and an agent-issued `updateLook` with the
  same inputs produce byte-identical change-sets and the same instance state;
  an agent edit on a linked binding marks the override exactly as a manual edit
  does.

---

## Sequencing

1. **GAP 1a** (editor v3 bridge) — foundational; everything else needs persisted instances.
2. **GAP 1b** (host ops) + **GAP 5** (parity is the same code path).
3. **GAP 3** (Music Pulse compiler + pack) — independent of 1/2, can interleave.
4. **GAP 1c** (panel reopen/adjust/detach) + **GAP 2** (audio panel path).
5. **GAP 4** (rendered-frame + export acceptance) — last; exercises the finished packs + panel.
6. Re-cut candidate → CodeRabbit → full self-hosted gate ×2 → independent Opus
   "Astra" `APPROVE_FOR_DEPLOY` on the exact triple → **notify owner, wait for
   go-ahead** → guarded deploy → Gbrain/PC-receipt/Desktop-brief closeout.

Each task: red test → smallest complete implementation → green → scoped commit.
No mocking away the compiler, persistence, or renderer. Earlier green CI on
`7a509e6c` / `93d1c082` does not carry to the new candidate.

## Status ledger (updated as tasks land)

| Gap                                                       | State       | Candidate  |
| --------------------------------------------------------- | ----------- | ---------- |
| 1a editor v3 bridge                                       | NOT STARTED | —          |
| 1b host ops (prepareUpdate/detach/resetOverrides/persist) | NOT STARTED | —          |
| 1c panel reopen/adjust/detach                             | NOT STARTED | —          |
| 2 audio end-to-end + A/V test                             | NOT STARTED | —          |
| 3 Music Pulse honest (boolean rest + rate control + slot) | **DONE**    | `3eaa8cd7` |
| 4 rendered-frame + export acceptance                      | NOT STARTED | —          |
| 5 manual/agent parity for update/detach                   | NOT STARTED | —          |

---

## Verified reconciliation — 2026-09-09 (session `joy-media-62`)

Re-checked the ledger against the actual tree at R2 HEAD **`3eaa8cd7`**
(`codex/joy-live-director`, local == `github/codex/joy-live-director`, working
tree clean). Method: read the named files / grep the named symbols /
`git show --stat` the GAP-3 commit. **Preserve completed work — nothing here is
to be re-implemented.**

| Item                                                                                         | Prior claim                | Verified @ `3eaa8cd7`                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation — L1 schema, L2 compiler/adapter/apply-host/apply-panel, L3 packs, L4 core+bridge | DONE, keep + re-verify     | **PRESENT.** All 10 named files exist; `validateJoyProjectV3` / `isJoyProjectV3` / `LATEST_PROJECT_SCHEMA_VERSION` exported. `BUILT_IN_LOOK_PACKS` = **5 packs** (`persian-editorial` retired `7a509e6c` — English-only, correct).                                                                                                                                                                       |
| GAP 1a — editor reads/writes schema v3                                                       | NOT STARTED                | **NOT STARTED.** `project-package.ts` + `project-document-hydration.ts` still type/validate `JoyProjectV1` only; no `migrateToLatest` at the document boundary.                                                                                                                                                                                                                                          |
| GAP 1b — `prepareUpdate` / `detach` / `resetOverrides` + persist-on-apply                    | NOT STARTED                | **NOT STARTED.** None of those symbols in `look-operations.ts` / `look-run-host.ts`. Apply commits ops only (Undo works); no `LookInstance` record.                                                                                                                                                                                                                                                      |
| GAP 1c — panel reopen/adjust/detach                                                          | NOT STARTED                | **NOT STARTED** (blocked on 1b).                                                                                                                                                                                                                                                                                                                                                                         |
| GAP 2 — audio-reactive motion end to end + A/V decode test                                   | NOT STARTED                | **NOT STARTED.** L4 core + bridge present & unit-tested; **no panel path**, **no `tests/e2e/living-looks-audio-motion.spec.ts`** (only `agent-living-looks.spec.ts`).                                                                                                                                                                                                                                    |
| GAP 3 — Music Pulse is honest                                                                | NOT STARTED (doc predates) | **DONE @ `3eaa8cd7`.** `LookBooleanDrive.rest?`, `LookEnumDrive.periodsByOption?`, `rate` enum, subject-slot relabel, `validate.ts`/`compile.ts` rules + `compile.test.ts`(+121)/`validate.test.ts`(+65), goldens re-blessed, `packs.test.ts` 5-pack loop, `musicPulse` back in `BUILT_IN_LOOK_PACKS`. Commit records `pnpm test` 4206 pass / 0 fail + tsc/eslint/prettier clean. Matches spec 3a/3b/3c. |
| GAP 4 — rendered-frame + encoded-export acceptance                                           | NOT STARTED                | **NOT STARTED.** No `tests/e2e/living-looks-render.spec.ts`, no sample renders. `packs-render-fidelity.test.ts` (numeric) present — **stays**, supplemented not replaced.                                                                                                                                                                                                                                |
| GAP 5 — manual / agent parity for update / detach                                            | NOT STARTED                | **NOT STARTED.** Apply parity exists (`onRun` + `runLook` → `stageLookRun`). No `updateLook` / `detachLook`; update/detach/override paths don't exist yet to have parity.                                                                                                                                                                                                                                |

**Net remaining R2 implementation: GAP 1a → 1b (+ GAP 5) → 1c → GAP 2 → GAP 4**,
in the Sequencing order above. GAP 3 is done. Foundation is intact and needs only
re-verification at the final candidate (full `pnpm test` + tsc + lint +
`agent-living-looks` e2e), not rework.

**Open R2 _acceptance_ items (not implementation):**

- Per-pack owner taste verdicts re-confirmed for the **final** candidate's 5
  shipping packs (verdicts were applied once at `770511d3` / `7a509e6c`; any pack
  still `PENDING` in the scorecard does not ship).
- Fresh full gate on the completed R2 candidate via the **accepted optimized
  gate** (after CI v2 is independently accepted) — the stale `93d1c082` /
  `7a509e6c` runs do not carry.
- External **Astra** candidate-specific `APPROVE_FOR_DEPLOY <sha> <tree> <lock>`.
- Owner go-ahead → guarded Sweden deploy → closeout.

**Branch-integration note:** `codex/joy-live-director-ci-opt` forked from this
exact R2 HEAD (`merge-base` = `3eaa8cd7`); its diff is CI harness + workflows +
CI docs, plus small touches to `apps/editor-web/vite.config.ts` (preview proxy
only), `tests/e2e/wp32-responsive-checkpoints.spec.ts`, and `package.json`
(`test:harness`). When CI v2 is accepted, fold that branch into
`codex/joy-live-director` before cutting the final R2 candidate.
