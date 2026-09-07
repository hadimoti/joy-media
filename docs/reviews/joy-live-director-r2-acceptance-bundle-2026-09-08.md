# JOY Live Director — R2 ("Living Looks") acceptance & review bundle

Recorded: 2026-09-08 (Claude implementer). This bundle is the evidence index for
the independent Opus ("Astra") review of R2. It is **not** a self-approval —
Astra rules on the exact candidate below, and R2 additionally carries
owner-gated taste review (see the scorecard).

## Candidate identity

| Field    | Value                                                                                  |
| -------- | -------------------------------------------------------------------------------------- |
| commit   | `PENDING` (branch `codex/joy-live-director`)                                           |
| tree     | `PENDING`                                                                              |
| lockfile | `pnpm-lock.yaml` sha256 `PENDING`                                                      |
| base     | `855734cf0c875101a632426983db2638c2adddcd` (R1, **LIVE** on joyst.ir since 2026-09-07) |

The review is always against one exact SHA / tree / lock triple. If Astra
requires changes, a new candidate SHA is cut and this bundle is re-dated.

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
- **L3** — six built-in packs as typed data
  (`packages/motion-core/src/looks/packs/`): editorial-clean, product-precision,
  kinetic-type, quiet-documentary, music-pulse, persian-editorial. Typography and
  palette are expressed through the **fixed** `TEXT_TEMPLATES` /
  `JOY_CAPTION_TEMPLATES` catalogues (Opus L3 ruling) — no new op kinds, no R1
  re-review. "No fake slider" is enforced mechanically.
- **L4** — audio-reactive baking (`audio-reactive.ts` +
  `apps/editor-web/src/joy-agent/look-audio-bridge.ts`): R1's
  `BeatEnvelopeEstimate` → bounded, editable `motion.setKeyframe` keyframes on one
  declared binding, with a hard key ceiling + reported approximation error,
  smoothing that cannot overshoot the declared range, and a flat rest line for
  silence / low confidence (never an invented downbeat).
  `LookCompileInput.audioBakes` lets a baked track supersede the slider on its
  binding, exactly like a hand-edit override.

## Full-suite / build at this candidate

| Check                                             | Result                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run verify:ci` (check + build + prod audit) | `PENDING` — local `pnpm test` at `990a6c5b`+flake-fix: vitest **4196 passed / 38 skipped / 0 failed** (526 files)                                   |
| `r2-candidate.yml` (GitHub-hosted CI)             | `PENDING` — target: every lane green ×2 (verify, worker-package, acceptance 7 profiles, real-service-acceptance)                                    |
| CodeRabbit                                        | `PENDING`                                                                                                                                           |
| Font redistribution gate                          | ✅ `tooling/release/src/font-assets.test.ts` (6) — no retired-foundry ownership marker in any runtime surface; Vazirmatn is Fontsource OFL, bundled |
| Coverage verifier                                 | ✅ unchanged — R2 adds no operation kinds                                                                                                           |

## New tests (R2)

| Area           | File                                                                                                                                               | Count         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| L1 schema      | `packages/project-schema/src/{living-look,v3}.test.ts`                                                                                             | —             |
| L2 compiler    | `packages/motion-core/src/looks/{validate,compile,compile-audio-bakes}.test.ts`                                                                    | 9 (bakes) + … |
| L3 packs       | `packages/motion-core/src/looks/packs/{packs,packs-golden}.test.ts`                                                                                | 43 + 18       |
| L4 core        | `packages/motion-core/src/looks/audio-reactive.test.ts`                                                                                            | 8             |
| L4 bridge      | `apps/editor-web/src/joy-agent/look-audio-bridge.test.ts`                                                                                          | 8             |
| Editor adapter | `apps/editor-web/src/joy-agent/{look-operations,look-run-host,look-packs-conformance}.test.ts`                                                     | 12 + 4 + 4    |
| Panel          | `apps/editor-web/src/LivingLooksPanel.test.tsx`                                                                                                    | —             |
| e2e            | `tests/e2e/agent-living-looks.spec.ts` (six packs render + run editorial-clean → staged preview → Approve → Undo; unavailable pack shown honestly) | 2             |

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
2. **L4 panel path.** The pure core + host bridge are complete and tested;
   feeding a decoded audio track's `audioBakes` from the panel into `runLook`
   (music-pulse) + `tests/e2e/living-looks-audio-motion.spec.ts` (decode the
   export for A/V alignment) are the remaining wiring. Recommendation: ship
   music-pulse's audio path as an R2-first documented follow-up (parallels R1's
   real-BYOK decision), with the slider-driven pulse honest in the meantime.
3. **`LookInstance` persistence.** A Look currently commits its operations through
   the normal approve path (Undo works) but is not yet re-openable — the v1→v3
   editor-document bridge (`project-package.ts` / `project-document-hydration.ts`
   still read `JoyProjectV1`) and `looks.prepareUpdate` are R2 follow-ups.
4. **L3b sample renders.** The numeric-tolerance harness landed as
   `packs-render-fidelity.test.ts` (12 tests — compiled keyframes sampled back
   through the renderer evaluator). What remains is presentational only: a few
   sanitized sample renders attached to the scorecard for the owner's visual
   read. Not a pipeline gate.

## Owner-gated (NOT self-certifiable)

Per the Opus L3 ruling, the creator taste study and the Persian-script idiom
review are the owner's. See
`docs/reviews/joy-live-director-r2-look-scorecard-2026-09-08.md` — every pack
carries `OWNER_TASTE_REVIEW: PENDING` and R2 does not ship a pack whose line
still reads `PENDING`.

## Gate

CodeRabbit clean + `r2-candidate.yml` green ×2 on the exact candidate +
independent Opus ("Astra") `APPROVE_FOR_DEPLOY <sha> <tree> <lock>` + owner
go-ahead + owner taste verdicts recorded. The implementer never self-approves.
No OpenAI / Codex anywhere in the toolchain.
