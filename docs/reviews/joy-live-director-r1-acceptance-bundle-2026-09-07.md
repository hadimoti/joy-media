# JOY Live Director — R1 acceptance & review bundle

Recorded: 2026-09-07 (Claude implementer). This bundle is the r1.md **V3**
deliverable: the evidence index for the independent Opus ("Astra") review. It
is **not** a self-approval — Astra rules on the exact candidate below.

## Candidate identity

| Field    | Value                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| commit   | `855734cf0c875101a632426983db2638c2adddcd` (branch `codex/joy-live-director`)              |
| tree     | `54ccefce85daf174b25620b24b64b9d54c130dcc`                                                 |
| lockfile | `pnpm-lock.yaml` sha256 `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3` |
| base     | `6a6a336c` (live foundation release, schema 5)                                             |

The commit above (`855734cf`) is what `release-candidate.yml` runs on. Branch
HEAD is one further **prose-only** pin commit ahead (this paragraph + the run
id). `855734cf` = the round-1 candidate (`0cff0470`, CI-green code tree
`369a4196`) plus the two Astra round-1 fixes (`f8d27577`, see the Astra section
below). `f8d27577`'s source change is confined to the `observeSources` primitive
contract shape + its two tests; the coverage verifier still passes (16 bounded
operations, 8 domains unsupported).

If Astra requires further changes, a new candidate SHA is cut and this bundle is
re-dated; the review is always against one exact SHA/tree/lock triple.

## Full-suite / build / security / performance at this candidate

| Check                                            | Result                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -w run check` (typecheck+lint+format+test) | exit 0 — **vitest 4033 passed / 38 skipped / 0 failed** (513 files)                                                                                                                                                 |
| `release-candidate.yml` (self-hosted CI)         | **two full green runs on the round-1 code tree**: `34078187134` (`fd8497b0`) and `34097358089` (`369a4196`). A fresh run (`34123884446`) is dispatched on the exact SHA above (round-1 + the Astra fix `f8d27577`). |
| CI lanes (each ×2)                               | `validate-candidate`, `windows-worker-clean`, `linux-real-services`, `acceptance` (7 desktop profiles), `real-service-acceptance`                                                                                   |
| CodeRabbit                                       | clean — reviewed per-commit across the whole branch and again over the full V1 delta; every finding fixed                                                                                                           |
| BYOK security e2e                                | `tests/e2e/agent-byok-security.spec.ts` (4) — no key/baseUrl leak into UI, storage, or Worker messages                                                                                                              |
| Worker size gate                                 | `pnpm verify:joy-agent-worker` — engine.worker within budget                                                                                                                                                        |
| Coverage verifier                                | `node tooling/release/verify-agent-operation-coverage.mjs` — 16 bounded operations; 8 domains explicitly unsupported                                                                                                |

Stress cases from V3 are covered by existing specs: long media
(`agent-observation-decode` `long-sequence.mp4`), low memory
(`ObservationResourceScheduler` unit tests + `render-verification` byte
budgets), offline/cache-miss (`wp30-cross-browser-assets`, engine-client
handshake specs), codec error (`agent-observation-decode` `corrupt-truncated.mp4`,
`final-encoded-export-decoder` malformed-reply test), stale session
(`agent-director-runtime` "invalidates a real Worker preview when its revision
becomes stale" / "clearing a model connection terminalizes an in-flight run"),
two-writer & project switch (`prepared-change-store` authority tests,
`AgentPanel` conversation-per-project effect).

## V3 demonstration checklist → evidence

| V3 item                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find the single-frame flash via exact mode        | `tests/e2e/agent-observation-decode.spec.ts` decodes `single-frame-flash.mp4` in exhaustive mode and pins the flash PTS; `find-moment` recipe advertised runnable and unit-covered (`entry-points.test.ts`, `agent-director-skills.spec.ts` scripted)                                                                                                                                                                                               |
| Construct a rough cut from observed source ranges | **`agent-director-skills.spec.ts` "runs Build Rough Cut through the real Worker"** — picker → real Worker tool-loop → staged `timeline.trimClip` → Approve trims the clip 10s→6s → one Undo restores                                                                                                                                                                                                                                                |
| Refine a created Persian title over two turns     | `agent-director-lifecycle.spec.ts` "uses the prior committed title entity for a second-turn edit" + "rejects a follow-up proposal that targets another valid title"; Persian pronoun boundary handling unit-tested in `AgentPanel`                                                                                                                                                                                                                  |
| Animate property / effect / transition            | `agent-live-preview.spec.ts` "creates a title and applies its dependent motion keyframe from an empty Worker object context"; `motion.setKeyframe` / `transition.addAtJunction` compiler + F5 readback unit tests (`joy-agent/*-readback`, `domain-parity.test.ts`)                                                                                                                                                                                 |
| Balance real audio                                | **Out of R1 scope** — `audio-balance` recipe is visible-but-**unavailable** (no verified `audio-mix` capability); `audio-observer` decode is unit-tested. Honest limitation in the coverage ledger.                                                                                                                                                                                                                                                 |
| Operate on persisted 3D / HTML supported content  | `wp35-universal-timeline.spec.ts` (GLTF import → preview → durable rendered layer); `three-d-render-layer` + `html-scene-surfaces` persistence unit tests; `MotionPanel`/`TemplatesPanel` scene-preview teardown fixed (`f7615432`)                                                                                                                                                                                                                 |
| Verify encoded output and one Undo/reload         | **`agent-director-skills.spec.ts` "runs Verify Deliverable through the real Worker"** — advisory recipe → honest R1 `DirectorVerificationReport` (structural real via `validateSpikeProject`; rendered/audio/encoded `unavailable` with stated uncertainty); `final-encoded-export-decoder.spec.ts` (4) proves real decode + `audioStreamCount: 0`; `agent-director-lifecycle` "does not revive an approval-capable preview after a browser reload" |

## Observation honesty proofs

- **overview says sampled**: `evidence-store.test.ts` `derivedMetadata.sampled: false`
  for exhaustive, and the coverage summary distinguishes sampled vs exhaustive
  input; `creative-skill-editor-deps.readObservationCoverage` reports
  `"(sampled input, status …)"` vs `"(exhaustive input …)"`.
- **native video says unknown / provider coverage**: the source decoder never
  claims model comprehension — `JoyAgentEvidenceCoverageSummary.modelComprehensionGuaranteed`
  is the literal type `false` (`tool-bridge.ts`).
- **exhausted budget says partial**: when a bounded observation request hits
  its per-request frame / metadata-byte cap the adapter returns
  `status: 'partial'` (`apps/editor-web/src/joy-agent/observation-tool-adapter.test.ts`
  ~lines 221 and 276), and `hasExhaustiveInputCoverage` refuses to label
  `partial` (or provider / cancelled / zero-frame) work exhaustive
  (`packages/media-core/src/observation-coverage.test.ts:47`). Separately, when
  the observation _service_ exhausts its own working-set budget it fails closed
  with `ObservationServiceError('budget-exceeded')` rather than silently
  degrading. (The recipe manifest's `budget.maxObservationRequests` /
  `maxEvidenceItems` are not re-enforced by the R1 editor `observeSources`
  implementation — see the coverage-ledger `limitations`.)
- **missing modalities never say watched / heard**:
  `render-verification` returns `'unavailable'` checks with stated uncertainty
  rather than a passed audio/rendered check when the evidence is absent
  (`render-verification.test.ts`, incl. the new silent-export tests);
  `verifyComposedAndEncoded` in the recipe path does the same.

## Same trusted operation path — manual control and skill

`createJoyAgentProposalStagingHandler` (the canonical `validate_proposal` →
compile → prepare → staged preview → digest handler) is built **once** and
used by both the direct Joy Code composer (`AgentPanel.submitPrompt`) and the
recipe path (`recipe-scoped-host.runScopedCreativeSkillEditToolLoop`). A
recipe's `ready-for-approval` staged change flows into the **same**
`modelChangeSetId` approval card, `applyPreparedJoyCodeChange` commit, and
Undo as a manual edit. Proven by `agent-director-skills.spec.ts` "runs Build
Rough Cut" reaching the identical approval region and `Undo` control asserted
by `agent-live-preview.spec.ts`.

## Real BYOK model / endpoint / capability — DOCUMENTED FOLLOW-UP (owner decision 2026-09-07)

Per r1.md V3: no separately authorized test credentials, footage, or spend cap
are available in this environment, so **live model compatibility and live
creative evaluation were not performed and are not claimed for R1.** The
deterministic fake provider (`tests/e2e/fixtures/fake-openai-provider.ts`)
exercises the full Worker / host RPC / repair / approval path but does not
substitute for a real model.

**Owner decision, 2026-09-07: ship R1 with live-model creative evaluation as a
documented follow-up.** It is a first-run item for R2's evidence bundle, to be
executed with a scoped authorized test key + spend cap. Nothing in R1 asserts
or depends on live-model behaviour beyond the deterministic Worker contract
tests; the BYOK security boundary itself is separately proven
(`agent-byok-security.spec.ts`).

## Coverage ledger & limitations (from actual results)

`docs/reviews/joy-live-director-coverage.json` — 16 advertised operations, all
`verificationScope: bounded-proposal-path` / `readback: not-verified` /
`e2eEvidence: shared-host-lifecycle`; 8 domains unsupported. The `limitations`
array records the V1 recipe availability matrix and the R1 recipe-wiring
completeness. The **one open ledger question** (does R1 require an
operation-specific rendered/audio browser consumer per advertised kind?) is
stated in `joy-live-director-coverage-ledger-position-2026-09-07.md` for
Astra's ruling.

## Independent Opus ("Astra") review

**Round 1** (candidate `cbc583fc`, 2026-09-07): `CHANGES_REQUIRED`. Astra
independently verified the hard limits, the V1 recipe layer (closed 8-name tool
catalog with no apply/commit; one shared staging handler; real run fence), the
observation-honesty invariants (`modelComprehensionGuaranteed` is the literal
type `false` and payloads that break it are rejected; `uncertainty` required
for every `unavailable`/`model-reviewed` check), the coverage-verifier ratchet,
and both green CI runs. Two blocking defects, both in the release's honesty
thesis, neither a safety risk:

1. this bundle's "exhausted budget says partial" proof cited the wrong file and
   mechanism;
2. `maxObservationRequests` / `maxEvidenceItems` were declared on the
   `observeSources` primitive contract, passed by the adapter, then silently
   dropped.

**Ruling on the open coverage-ledger question:** _a first release is acceptable
as-is; R1's advertising bar does **not** require an operation-specific
rendered-frame or decoded-audio browser consumer per advertised kind._ The
verifier ratchet is the protection and it works; nothing model-visible is
unmediated; per-kind rendered verification is an R2 quality goal, not an R1
safety gate. For R2 Astra specified the split — rendered-frame readback for the
9 text / motion / caption-appearance / transition-add kinds; project-state
readback for the 7 structural timeline / caption-timing / transition-remove
kinds.

**Fixes** (`f8d27577`): item 1 — bundle proof rewritten to cite
`observation-tool-adapter.test.ts` ~221/276 + `observation-coverage.test.ts:47`,
and to note the service fails closed with `budget-exceeded`. Item 2 — the two
budget fields moved under a `budget` sub-object whose doc comment states R1 does
not re-enforce a per-checkpoint cap (recipe observation is bounded by the
tool-loop call budget, the O5 consent envelope, and the run-budget); recorded in
`coverage.json` `limitations`.

**Round 2:** this candidate returned to Astra for the follow-up ruling.

## Stop-before-deploy

This candidate has: CodeRabbit clean + local `pnpm -w run check` green (4033
tests) + two full green `release-candidate.yml` runs on the round-1 code tree +
a fresh run on the exact SHA. It is with the independent Claude Opus reviewer
("Astra") for the round-2 verdict: `APPROVE_FOR_DEPLOY <commit> <tree> <lock>`
or a further change list. The implementer never self-approves. A live production
deploy to joyst.ir additionally requires the owner's explicit go-ahead and
follows the master guarded Sweden procedure. R2 and R3 remain closed until their
own tasks and evidence pass.
