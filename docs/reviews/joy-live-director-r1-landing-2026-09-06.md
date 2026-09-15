# JOY Live Director — R1 landing status

Recorded: 2026-09-06 (Claude implementer, continuation session)
Branch: `codex/joy-live-director` — **pushed to `github`** (`git push github codex/joy-live-director`, 2026-09-06)
Implementation base: `6a6a336c` (live foundation release)
Landed range: `131e409c..` (this session's commits on top of Codex's `92018ca9`)

## 2026-09-07 update — automated gate GREEN on `fd8497b0`

- **CodeRabbit** — clean (per-commit across the whole branch + the full V1
  delta `f7615432..fd8497b0`; last major finding — an aborted recipe run never
  cancelling its Worker run — fixed in `fd8497b0`).
- **local `pnpm -w run check`** — exit 0 on `fd8497b0` (typecheck + lint +
  format + **vitest 4030 pass / 38 skip / 0 fail**).
- **self-hosted `release-candidate.yml` run `34078187134`** on `fd8497b0` —
  **`conclusion: success`, all 20 jobs green**: `validate-candidate`,
  `windows-worker-clean` ×2, `linux-real-services` ×2, `acceptance` (7 desktop
  profiles ×2), `real-service-acceptance` ×2.
- **V1 recipe layer — host-wired + picker DONE** (see the V1 wiring design
  doc): `createCreativeSkillEditorPrimitiveDeps` (all 5 primitives),
  `createJoyAgentProposalStagingHandler` (shared with the direct edit path),
  `runScopedCreativeSkillEditToolLoop`, `runEditorCreativeSkill`, and the Joy
  Code **Recipes** picker (honest availability; a `ready-for-approval` staged
  change routes into the existing approval UI).
- **Still open for a full R1 candidate** (below, items 2–5): the coverage-ledger
  per-op decision (a question FOR Astra), O6 `audioStreamCount: 0`, the V3
  acceptance demonstration, a model-driven recipe run-through e2e (fixture
  work), and the real BYOK model test (blocked on authorized credentials).
- **Astra Opus review — still not started** (per plan: only on a
  candidate-complete R1).

## Milestone-gate status (F/O/V groups landed + green)

- **local `pnpm`** (typecheck / lint / format / test / build / worker-verifier
  / coverage-verifier) — ✅ green.
- **push branch to `github`** — ✅ done.
- **CodeRabbit** — ✅ 2 rounds, clean (15 → 3 → resolved/documented).
- **self-hosted CI lanes** — re-running on candidate `f1daf140` (dispatch
  `34042653454`). Started `joy-media-ci-worker` (it was offline).
  `validate-candidate` ✅; `linux-real-services` ×2 and `windows-worker-clean`
  ✅ on the prior run after fixing 3 runner-environment flakes: stale `dist/` on
  the persistent linux container (font-assets false failure); a teardown race on
  the still-exiting self-test worker; a hardcoded 4-entry migration ledger in
  `real-service-smoke.mjs` missing `005-stock-video`.
- **acceptance lane — 5 pre-existing failures fixed.** The 7-profile matrix
  (added in `62dd5176` before the foundation deploy, never re-run) had 5 specs
  failing **identically on production `6a6a336c`**, so not Live Director
  regressions. All now green on every one of the 7 desktop profiles:
  - `wp32-responsive-checkpoints:7` — File menu gained "Import/Export Editable
    Project…"; keyboard walk to plain "Export" was 2 steps short and matched
    non-exactly. _(test, `080bb9b5`)_
  - `wp29-r5-batch-d:219` — product renamed "Cloud Brain" → "Remote provider"
    in the AudioPanel run flow. _(test, `080bb9b5`)_
  - `wp29-r5-batch-a:210` — Joy Code empty-state welcome floats over the
    attachment chips on short viewports and swallowed the Detach click.
    _(app: `pointer-events: none` on the decorative overlay, `f1daf140`)_
  - `wp35-universal-timeline:13` — the 3D Scene panel rendered a bare `<div>`
    (and `null` while its lazy chunk loaded), never exposing the named
    `article` panel shell the panel-open contract expects. _(app: wrap in a
    `joy-panel-root` article "3D Scene", `f1daf140`)_
  - `stock-video-ui:51` — compact grid `minmax(8rem,…)` auto-fill collapsed to
    one column in the narrow rail before the 17rem container query engaged.
    _(app: tighten to `6.5rem`, `f1daf140`)_
  - After the fixes, local `pnpm test` = 4020 pass, 1 pre-existing flake
    (`resumable-original-upload` async-finalize race; passes in isolation).
- **independent Opus "Astra" review** — not started; deferred until R1 is
  candidate-complete (V1 finish + V3 + ledger) so the review is not spent on an
  incomplete milestone.

Owner instruction 2026-09-06: "use opus review and confirmations not me" — the
Opus `APPROVE_FOR_DEPLOY` is the approval authority for push / CodeRabbit / CI /
candidate bundling; a live production deploy stays a guarded, surfaced step.

## What landed this session

The ~177-file uncommitted WIP from the prior Codex run is now committed in
reviewable, green units:

| Commit                                                                     | Scope                                                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `docs: retarget Live Director roles to Claude-only review`                 | GPT→Claude in the forward-looking plan docs                                                               |
| `docs: capture Live Director WIP state before landing R1`                  | `joy-live-director-wip-state-2026-09-06.md`                                                               |
| `chore(editor): wire media-core observation subpath and pin mediabunny`    | deps, aliases, eslint globals                                                                             |
| `feat(agent): unify runtime and own the project run lifecycle (F3-F5)`     | host-rpc, run controller/store/events, domain `*-readback` adapters                                       |
| `feat(media): add Live Director observation and evidence (O2-O6)`          | source/worker decode, evidence store, audio, consent transport, composition + encoded-export verification |
| `feat(agent): run evidence-aware creative skills (V1)`                     | creative-skill manifests, skill-runner, director-verifier, review controller                              |
| `feat(agent-ui): show real work and inspectable media evidence (V2)`       | evidence filmstrip, consent surface, panel wiring                                                         |
| `test(agent): expand director fixtures, coverage verifier, decoder review` | fixtures, ledger, decoder-selection doc                                                                   |

## Verification run (this candidate, this machine)

| Check                                                      | Result                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                           | PASS                                                                                                                                                                                                                                                                |
| `pnpm lint`                                                | PASS (0 errors; 2 pre-existing warnings in unrelated test files)                                                                                                                                                                                                    |
| `pnpm format:check`                                        | PASS                                                                                                                                                                                                                                                                |
| `pnpm test`                                                | 506 files / **3999 passed, 38 skipped, 0 failed** (incl. the CodeRabbit-fix regressions)                                                                                                                                                                            |
| `pnpm build`                                               | PASS (editor-web + worker)                                                                                                                                                                                                                                          |
| `pnpm verify:joy-agent-worker`                             | PASS (engine.worker raw 110 334 B / gzip 30 934 B)                                                                                                                                                                                                                  |
| `pnpm exec playwright test … --project=desktop-primary`    | **34 passed** — `agent-director-lifecycle` (8), `agent-director-runtime` (4), `agent-observation-decode` (7), `agent-timeline-split-parity` (1), `final-encoded-export-decoder` (4), `agent-live-preview` (4), `agent-live-presence` (2), `agent-byok-security` (4) |
| `node tooling/release/verify-agent-operation-coverage.mjs` | PASS (16 bounded operations; 8 domains explicitly unsupported)                                                                                                                                                                                                      |

## CodeRabbit review (base `6a6a336c` → the landed R1 commits)

`coderabbit review --committed` completed after several dropped connections
(the review service kept closing the WebSocket mid-stream this session; local
`coderabbit doctor` is all-pass). It returned **15 findings — 1 critical, 7
major, 7 minor — across 172 reviewed files.** All 15 were legitimate; none
were dismissed. Fixed in `fix(agent): resolve CodeRabbit R1 review findings`:

| Sev      | Location                                                                         | Fix                                                                                                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| critical | `run-budget.ts`                                                                  | a single over-budget output-byte chunk latched a cancellation state that failed re-parse (`=== maxOutputBytes` → `<= maxOutputBytes`); regression added                                                                                                  |
| major    | `protocol.ts`                                                                    | `FORBIDDEN_RESULT_KEYS` was run over the serialized JSON string, rejecting innocent prose ("Follow the path of the hero"); removed the serialized check (per-key denylist + per-value unsafe-pattern check remain); regression added                     |
| major    | `bounded-tool-loop.ts`                                                           | an `AbortError` became a repairable diagnostic and the call batch kept issuing host RPC after cancel; now checked before each call and rethrown from the catch                                                                                           |
| major    | `worker-observation-transfer.ts`                                                 | per-run cleanup deleted a replaced controller Set; now guarded with an identity check                                                                                                                                                                    |
| major    | `sampling-policy.ts`                                                             | `createCanonicalFrameSampler` claimed `completeSourceCoverage` from `sourceFrameCount <= maxFrames` instead of "every selected identity accounts for a source frame"; fixed + first tests for that function                                              |
| major    | `engine.worker.ts`                                                               | replacing the BYOK session did not abort in-flight runs, so the old key/baseUrl kept serving; now aborts every run in `configure`                                                                                                                        |
| major    | `protocol.ts`                                                                    | `runEpoch` was optional in the type but required by the validator; made required, callers pass `Omit<JoyAgentRunRequest, 'runEpoch'>`                                                                                                                    |
| major    | `conversation-entity-references.ts`                                              | `record?.[entityId] !== undefined` read the prototype chain (`constructor`, `toString`); switched to `Object.hasOwn`; regression added                                                                                                                   |
| minor    | `AgentPanel.tsx`                                                                 | no Dismiss control once an image review reached `failed`; now rendered for the terminal state                                                                                                                                                            |
| minor    | `export-final-verification-contract.test.ts`, `export-recovery-contract.test.ts` | slice markers not asserted before slicing App.tsx; added an explicit guard                                                                                                                                                                               |
| minor    | `JoyAgentSettingsDialog.test.tsx`                                                | vacuous `not.toContain('Image Supported')` (never rendered with a space) → assert the result element is absent                                                                                                                                           |
| minor    | `AgentPanel.tsx`                                                                 | Persian pronoun alternatives matched bare substrings (این inside اینکه); anchored on `\p{L}\p{M}` boundaries                                                                                                                                             |
| minor    | `export-history.ts`                                                              | a `verified` receipt failing only the strict manifest cross-check dropped the whole history row; now downgraded to `verification-required` (retry metadata kept, cached bytes and completion claim dropped); two "drops…" tests updated to "downgrades…" |
| minor    | `provider-capabilities.ts`                                                       | a present-but-invalid plan-only probe reported `provider-probe-missing`; now reports `plan-only-response-invalid`                                                                                                                                        |
| minor    | `verify-agent-operation-coverage.mjs`                                            | failure text said "advertised operation kinds" for a rule that rejects any kind                                                                                                                                                                          |

**CodeRabbit run 2** (after the fix commit) returned **3 findings — 1 major,
2 minor** (the 15 from run 1 are resolved). Fixed in the follow-up commit:

| Sev   | Location                 | Fix                                                                                                                                                                                                       |
| ----- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| major | `protocol.ts`            | the same key-denylist-over-prose bug on the error `message` field (`Provider token limit exceeded` was dropped); switched to `UNSAFE_CONTEXT_VALUE`                                                       |
| minor | `render-verification.ts` | a fully silent export always failed `audio-streams-mismatch`; documented as a deliberate O6 scope limit (supporting `audioStreamCount: 0` is tracked follow-up) rather than half-implementing it untested |
| minor | this doc                 | markdown list-continuation indentation                                                                                                                                                                    |

Re-run CodeRabbit on the exact R1 candidate before the bundle; expect it to
be clean or to surface only the tracked open items above.

After the CodeRabbit fixes: `pnpm typecheck` / `lint` / `format:check` green;
**3999 unit tests pass**; the affected Live Director Playwright specs
(`agent-director-lifecycle`/`runtime`, `agent-byok-security`,
`agent-live-preview`, `agent-observation-decode` — 27 specs) pass on
desktop-primary.

## Real journey — status

The production journey **is wired and E2E-proven** through `runJoyAgentTask`
(tool-loop) + the single Worker + `joy-code-compound-runner`:

Creative Brief (`runCreativeBriefTask`, plan-only) → prompt → observation
tools in the Worker → propose → canonical host prepare/repair (model still
answers diagnostics) → preview with renderer acknowledgement → awaiting
approval with an opaque prepared proposal → atomic commit → **F5
operation-specific project-state readback** in the compound runner →
`export-final-verification` gate (new `verification-required` status).
`agent-director-lifecycle` + `agent-director-runtime` assert this end to end,
including second-turn entity reference, stale-revision invalidation,
cancellation, and no preview revival after reload.

## Open items before the R1 candidate can be bundled for review

_All resolved as of 2026-09-07 (candidate `369a4196`); left here for the audit
trail._

1. **V1 recipe layer — DONE.** Full host wiring landed: the shared
   `createJoyAgentProposalStagingHandler` (used by the direct edit path and the
   recipe path), `runScopedCreativeSkillEditToolLoop`,
   `createCreativeSkillEditorPrimitiveDeps` (all 5 concrete primitives from the
   `AgentPanel` graph), `runEditorCreativeSkill`, and the Joy Code **Recipes**
   picker. Browser e2e (`agent-director-skills.spec.ts`): honest availability
   matrix; `build-rough-cut` real-Worker run-through → staged change → Approve
   → one Undo; `verify-deliverable` advisory run-through → honest report. Audio
   Balance and Title/Caption Polish stay visible-but-unavailable for R1 (no
   verified audio-mix op / RTL-text readback).
2. **Coverage ledger reconciliation.** All 16 advertised ops are
   `verificationScope: bounded-proposal-path` / `readback: not-verified`.
   The F5 `*-readback` assertions (trim, move, split, created-title opacity
   keyframe, transition add/remove) are now wired into the commit path and
   unit/`domain-parity` tested. The release verifier only lets a row leave
   `bounded-proposal-path` when it also has
   `e2eEvidence.classification = operation-specific`; today only
   `timeline.splitClip` does (`agent-timeline-split-parity.spec.ts`). Decide
   per operation: add an operation-specific Playwright spec and upgrade to
   `readback: project-state-only`, or leave it honest. **Whether the desktop
   plan's stricter bar — a rendered/audio consumer for every advertised
   kind — is required for R1 is an explicit question for the independent
   Opus review.**
3. **O6 decoders not wired as per-operation ledger consumers.**
   `composition-observer`, `render-verification` and
   `final-encoded-export-decoder` are built, unit- and E2E-tested, and the
   encoded-export decoder gates export completion, but no ledger row claims
   `readback: rendered-output`. **RESOLVED:** `render-verification` now accepts
   `audioStreamCount: 0` — a deliberately silent export verifies against zero
   audio streams and skips every audio window/decode/codec/sync check; a `0`
   expectation carrying an `audioCodec` or `audioSyncPredicates` is rejected as
   `invalid-request`, and a decoded artifact that still carries audio fails
   closed (3 regressions in `render-verification.test.ts`).
4. **V3 acceptance demonstration** (r1.md V3): **RECORDED** in
   `docs/reviews/joy-live-director-r1-acceptance-bundle-2026-09-07.md` — the
   candidate triple, full-suite results, the V3 checklist mapped to concrete
   evidence (`build-rough-cut` and `verify-deliverable` now have real-Worker
   browser run-throughs), observation-honesty proofs, and the same-trusted-path
   proof. `balance real audio` is out of R1 scope (`audio-balance` visible-but-
   unavailable).
5. **Real BYOK model compatibility** (r1.md V3): **owner decision 2026-09-07 —
   ship R1 with live-model creative evaluation as a documented follow-up.** It
   is a first-run item for R2's evidence bundle (scoped authorized key + spend
   cap). R1 asserts nothing that depends on live-model behaviour; the BYOK
   security boundary is separately proven.
6. **Live-memory sync pending** — VPS Gbrain writeback is a post-deploy ritual.

## Not in scope / unchanged

- BYOK browser engine preserved; no KiloCode / local model / rewrite.
- Fontiran redistribution gate stays CLOSED.
- No deploy, service restart, pipeline run, or `joy-vps` change.
- WIP snapshot retained: `stash@{0}` `e0eb6368`, tag `wip-snapshot-2026-09-06`,
  branch `codex/joy-live-director-wip`.

## Release gate (unchanged, not yet started)

CodeRabbit clean + 3 self-hosted CI lanes green ×2 on the exact candidate +
independent Claude Opus reviewer `APPROVE_FOR_DEPLOY <commit> <tree>
<lock-sha>` + owner go-ahead. The implementer never self-approves.
