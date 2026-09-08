# JOY Live Director — R2 ("Living Looks") acceptance & review bundle

Recorded: 2026-09-08 (Claude implementer). This bundle is the evidence index for
the independent Opus ("Astra") review of R2. It is **not** a self-approval —
Astra rules on the exact candidate below, and R2 additionally carries
owner-delegated taste review (recorded in the scorecard; all four shipping packs
`APPROVED`).

## Candidate identity

| Field    | Value                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commit   | `7a509e6c5aeca07aa4dc6539b326b283f511078e` — re-cut 2026-09-08 after the taste fixes + `persian-editorial` retirement (branch `codex/joy-live-director`)         |
| tree     | `71c57ff611fda8dade07d37e667fe5f89cc2b141`                                                                                                                       |
| lockfile | `pnpm-lock.yaml` sha256 `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3` (byte-identical to R1 — zero lockfile delta; R2 adds no dependencies) |
| base     | `855734cf0c875101a632426983db2638c2adddcd` (R1, **LIVE** on joyst.ir since 2026-09-07)                                                                           |

The review is always against one exact SHA / tree / lock triple. If Astra
requires changes, a new candidate SHA is cut and this bundle is re-dated. Branch
HEAD may carry docs-only commits ahead of the candidate; the gate always runs on
the pinned SHA.

**Candidate history.** `93d1c082` (tree `a92dce70…`) passed one full green
self-hosted `release-candidate.yml` run (`34168068793`, 20/20). The
owner-delegated taste review then landed three source changes — `editorial-clean`
`y`-sign flip, `kinetic-type` `phrase-2/3` treatment bindings, `music-pulse`
held out of `BUILT_IN_LOOK_PACKS` for R2.1 — and the owner retired
`persian-editorial` (English-only app). That is a source change, so a new
candidate is cut and the gate re-runs from scratch (×2).

**Self-hosted `release-candidate.yml`** is the gate instrument. Per the Opus CI
ruling: R2 gates on the proven self-hosted instrument; R3 moves the heavy lanes
to a dedicated CI VPS. ~4.5h unattended, needs ×2 green on the exact candidate.

## What R2 is

"Living Looks": art-directed, deterministic Look packs an operator applies to a
composition through the **same bounded prepare → approve → atomic-commit → Undo
path** that R1's agent edits and recipes use. No new operation kinds, no model
in the apply path, no renderer in `motion-core`.

- **L1** — `LookInstance` schema (`packages/project-schema/src/living-look.ts`),
  project schema **v3** additive over v2 (`lookInstances?`), `migrateV2ToV3`,
  write-guard `isLookBindingWritable`.
- **L2** — the pure compiler (`packages/motion-core/src/looks/`): a versioned,
  pinned `LookDefinition` with typed controls that declare exactly which binding
  targets they drive over a bounded range; `compileLook` emits ordinary
  `motion.setKeyframe` + `*.setTemplate` operations with a deterministic FNV-1a
  digest, never writes an overridden binding unless `resetBindingIds` names it,
  and fails closed with zero operations. Editor adapter
  (`apps/editor-web/src/joy-agent/look-operations.ts`) translates 1:1 to a
  JoyCode plan; `look-run-host.ts` stages it through
  `createJoyAgentProposalStagingHandler` — the R1 handler unchanged.
- **L3** — four built-in packs as typed data
  (`packages/motion-core/src/looks/packs/`): editorial-clean, product-precision,
  kinetic-type, quiet-documentary. `music-pulse` is authored but held out of
  `BUILT_IN_LOOK_PACKS` for R2.1 (kept covered by `music-pulse.test.ts`);
  `persian-editorial` was retired (English-only app). Typography and palette are
  expressed through the **fixed** `TEXT_TEMPLATES` / `JOY_CAPTION_TEMPLATES`
  catalogues (Opus L3 ruling) — no new op kinds, no R1 re-review. "No fake
  slider" is enforced mechanically.
- **L4** — audio-reactive baking (`audio-reactive.ts` +
  `apps/editor-web/src/joy-agent/look-audio-bridge.ts`): R1's
  `BeatEnvelopeEstimate` → bounded, editable `motion.setKeyframe` keyframes on one
  declared binding, with a hard key ceiling + reported approximation error,
  smoothing that cannot overshoot the declared range, and a flat rest line for
  silence / low confidence (never an invented downbeat).
  `LookCompileInput.audioBakes` lets a baked track supersede the slider on its
  binding, exactly like a hand-edit override.

## Full-suite / build at this candidate

| Check                                             | Result                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run verify:ci` (check + build + prod audit) | local at the re-cut candidate: **vitest 4190 passed / 38 skipped / 0 failed** (527 files); `tsc -b` + `eslint .` + `prettier --check` clean                                                      |
| CI green ×2                                       | `PENDING` — self-hosted `release-candidate.yml` on the re-cut candidate. `93d1c082` (pre-taste-fix) had one green run (`34168068793`, 20/20); the re-cut candidate needs ×2.                     |
| CodeRabbit                                        | round 1 (14) + round 2 (4) + round 3 (4, all docs) — all fixed. Round 4 on the re-cut candidate `PENDING`.                                                                                       |
| Font redistribution gate                          | ✅ `tooling/release/src/font-assets.test.ts` — no retired-foundry ownership marker in any runtime surface; Vazirmatn is Fontsource OFL, bundled (still used by the standalone `rtl-*` templates) |
| Coverage verifier                                 | ✅ unchanged — R2 adds no operation kinds                                                                                                                                                        |

## New tests (R2)

| Area           | File                                                                                                                                                                                          | Count                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| L1 schema      | `packages/project-schema/src/{living-look,v3}.test.ts`                                                                                                                                        | 152 + 131 assertions          |
| L2 compiler    | `packages/motion-core/src/looks/{validate,compile,compile-audio-bakes}.test.ts`                                                                                                               | 11 (bakes) + validate/compile |
| L3 packs       | `packages/motion-core/src/looks/packs/{packs,packs-golden,packs-render-fidelity,music-pulse}.test.ts`                                                                                         | 30 + 12 + 8 + 2               |
| L4 core        | `packages/motion-core/src/looks/audio-reactive.test.ts`                                                                                                                                       | 10                            |
| L4 bridge      | `apps/editor-web/src/joy-agent/look-audio-bridge.test.ts`                                                                                                                                     | 8                             |
| Editor adapter | `apps/editor-web/src/joy-agent/{look-operations,look-run-host,look-packs-conformance}.test.ts`                                                                                                | 12 + 4 + 4                    |
| Panel          | `apps/editor-web/src/LivingLooksPanel.test.tsx`                                                                                                                                               | 3                             |
| e2e            | `tests/e2e/agent-living-looks.spec.ts` (four packs render + run editorial-clean → staged preview → Approve → Undo; all four shown available; music-pulse + persian-editorial asserted absent) | 2                             |

## Honesty / safety properties

- **Same trusted path.** A Look apply is staged by the identical
  `createJoyAgentProposalStagingHandler` used by direct agent edits and recipes;
  `stageLookRun` passes `contextProjectId = session.visualProject.id`, walks the
  same lifecycle, and produces a real `modelChangeSetId` change-set that the
  existing approval card + Undo own. On any failure it returns `blocked` with
  diagnostics and **no partial stage**.
- **Deterministic + bounded.** Identical inputs → identical `operationDigest`;
  a control value out of range, an unbound required slot, a missing font, or a
  definition that fails validation → zero operations.
- **No fake controls.** Every control kind must drive ≥1 declared binding;
  color/font drives are required non-empty; validated at authoring time and in
  CI (`packs.test.ts`, `validate.test.ts`).
- **Operator edits win.** A hand-edited binding (`overriddenBindingIds`) is never
  rewritten unless an explicit `resetBindingIds` re-opens it — same rule for a
  slider drive and an audio bake.
- **Audio never invents.** Silence or beat confidence < 0.15 → a flat two-key
  rest line; smoothing averages already-clamped values so it cannot overshoot
  the declared property range.
- **Fonts.** Only bundled Fontsource OFL families; the retired-foundry gate stays
  closed and is CI-enforced.

## Scoped follow-ups (documented, NOT defects — for Astra to note)

1. **L3 scope-downs** (Opus L3 ruling): product-precision does **not** reframe
   footage (no crop/mask op — timed emphasis on operator-bound objects);
   kinetic-type is **phrase-object-scoped**, not per-word; `text.insertTemplate`
   object creation for auto-placed callouts / per-word phrases is a compiler
   follow-up.
2. **`music-pulse` — HELD for R2.1.** Authored, kept in the tree with its own
   validation/compile coverage (`music-pulse.test.ts`), but out of
   `BUILT_IN_LOOK_PACKS`. The taste review found the "Accent cuts" boolean
   compiles to a permanent-on track and the slider-only pulse is rate-less;
   both need compiler work (a live-rest boolean drive + a real rate control).
   The L4 audio path (pure core + host bridge, both tested) also lands with
   R2.1: feeding a decoded track's `audioBakes` from the panel into `runLook`
   - `tests/e2e/living-looks-audio-motion.spec.ts`.
3. **`LookInstance` persistence.** A Look currently commits its operations through
   the normal approve path (Undo works) but is not yet re-openable — the v1→v3
   editor-document bridge (`project-package.ts` / `project-document-hydration.ts`
   still read `JoyProjectV1`) and `looks.prepareUpdate` are R2 follow-ups.
4. **L3b sample renders.** The numeric-tolerance harness landed as
   `packs-render-fidelity.test.ts` (8 tests — compiled keyframes sampled back
   through the renderer evaluator). What remains is presentational only: a few
   sanitized sample renders attached to the scorecard for the owner's visual
   read. Not a pipeline gate.

## Owner-delegated taste review — COMPLETE

Per the owner's standing delegation of taste calls on this project to Claude
Opus, an Opus agent reviewed all packs on 2026-09-08. Result in
`docs/reviews/joy-live-director-r2-look-scorecard-2026-09-08.md`: **all four
shipping packs `APPROVED`** (editorial-clean and kinetic-type after their fixes
landed in this candidate). `music-pulse` HELD for R2.1; `persian-editorial`
RETIRED (English-only app — no Persian-script idiom review gate).

## Gate

CodeRabbit clean + `release-candidate.yml` green ×2 on the exact candidate +
independent Opus ("Astra") `APPROVE_FOR_DEPLOY <sha> <tree> <lock>` + owner
go-ahead. Owner taste verdicts are recorded (above). The implementer never
self-approves. No OpenAI / Codex anywhere in the toolchain.
