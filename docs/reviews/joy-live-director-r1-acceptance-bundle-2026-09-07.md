# JOY Live Director — R1 acceptance & review bundle

Recorded: 2026-09-07 (Claude implementer). This bundle is the r1.md **V3**
deliverable: the evidence index for the independent Opus ("Astra") review. It
is **not** a self-approval — Astra rules on the exact candidate below.

## Candidate identity

| Field    | Value                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| commit   | `369a41966f5e6383f05f63732f4dfcc181594b9d` (branch `codex/joy-live-director`)              |
| tree     | `7a348582ccfd8b55da0413b65e445bf91f223691`                                                 |
| lockfile | `pnpm-lock.yaml` sha256 `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3` |
| base     | `6a6a336c` (live foundation release, schema 5)                                             |

If Astra requires a change, a new candidate SHA is cut and this bundle is
re-dated; the review is always against one exact SHA/tree/lock triple.

## Full-suite / build / security / performance at this candidate

| Check                                            | Result                                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -w run check` (typecheck+lint+format+test) | exit 0 — **vitest 4033 passed / 38 skipped / 0 failed** (513 files)                                                                                   |
| `release-candidate.yml` (self-hosted CI)         | run on this candidate — see the CI status appendix; the last full green was `34078187134` on `fd8497b0` and this candidate re-runs it (`34097358089`) |
| CI lanes (each ×2)                               | `validate-candidate`, `windows-worker-clean`, `linux-real-services`, `acceptance` (7 desktop profiles), `real-service-acceptance`                     |
| CodeRabbit                                       | clean — reviewed per-commit across the whole branch and again over the full V1 delta; every finding fixed                                             |
| BYOK security e2e                                | `tests/e2e/agent-byok-security.spec.ts` (4) — no key/baseUrl leak into UI, storage, or Worker messages                                                |
| Worker size gate                                 | `pnpm verify:joy-agent-worker` — engine.worker within budget                                                                                          |
| Coverage verifier                                | `node tooling/release/verify-agent-operation-coverage.mjs` — 16 bounded operations; 8 domains explicitly unsupported                                  |

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
- **exhausted budget says partial**: `evidence status` is `'partial'` when
  `budget.maxObservationRequests` / `maxEvidenceItems` is hit
  (`observation-service.test.ts`).
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

## Real BYOK model / endpoint / capability — LABELLED BLOCKED

Per r1.md V3: no separately authorized test credentials, footage, or spend cap
are available in this environment. **Live model compatibility and live
creative evaluation are BLOCKED and are not claimed.** The deterministic fake
provider (`tests/e2e/fixtures/fake-openai-provider.ts`) exercises the full
Worker/host RPC/repair/approval path but does not substitute for a real model.
Owner decision required: provide a scoped test key + cap, or accept R1 shipping
with this labelled as a documented follow-up.

## Coverage ledger & limitations (from actual results)

`docs/reviews/joy-live-director-coverage.json` — 16 advertised operations, all
`verificationScope: bounded-proposal-path` / `readback: not-verified` /
`e2eEvidence: shared-host-lifecycle`; 8 domains unsupported. The `limitations`
array records the V1 recipe availability matrix and the R1 recipe-wiring
completeness. The **one open ledger question** (does R1 require an
operation-specific rendered/audio browser consumer per advertised kind?) is
stated in `joy-live-director-coverage-ledger-position-2026-09-07.md` for
Astra's ruling.

## Stop-before-deploy

This candidate has: CodeRabbit clean + local `pnpm check` green + (pending) the
full self-hosted `release-candidate.yml` green ×2. It now goes to the
independent Claude Opus reviewer ("Astra"), who is given only this bundle + the
candidate triple and must return `APPROVE_FOR_DEPLOY <commit> <tree> <lock>` or
a change list. The implementer never self-approves. A live production deploy to
joyst.ir additionally requires the owner's explicit go-ahead and follows the
master guarded Sweden procedure. R2 and R3 remain closed until their own tasks
and evidence pass.
