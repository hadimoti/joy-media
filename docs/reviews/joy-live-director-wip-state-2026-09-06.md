# JOY Live Director — WIP state capture

Recorded: 2026-09-06 (continuation session, Claude implementer)
Worktree: `C:\Users\HadiMoti\.config\superpowers\worktrees\joy-media\joy-live-director`
Branch: `codex/joy-live-director` · HEAD `92018ca9` · base tree `52e6bf03…`

## Why this record exists

The prior Codex run left the bulk of R1 (F3–F5, O2–O6, V1–V2) **uncommitted** in this
worktree — 70 modified tracked files + 107 untracked new files. Codex's own handoff said
"working tree clean", but that described the owner's main checkout, not this worktree. This
document records the real red/green state of that uncommitted tree before any of it is
landed, per the master plan's Phase 0 rule ("record real failures/skips rather than infer
support from a plan checkbox").

## Snapshot protection (done first, before any edit)

The uncommitted tree is captured three independent ways so it can never be lost:

| Mechanism          | Ref                                                      | Notes                                                       |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------- |
| git stash          | `stash@{0}` = `e0eb63688ffe493c0f054ca7cdb0dd26e7d6908f` | `git stash push -u`, then `git stash apply` to keep working |
| annotated-safe tag | `wip-snapshot-2026-09-06` → `e0eb6368…`                  | protects the stash commit from GC                           |
| branch pointer     | `codex/joy-live-director-wip` → `92018ca9`               | base for the WIP; not moved                                 |

`git reset --hard`, `git clean`, `git checkout .`, and worktree deletion remain forbidden
here until the WIP is fully committed on `codex/joy-live-director`.

## Local `main` fast-forward

`C:\Users\HadiMoti\joy-media` `main` was 39 commits behind `github/main` / `vps/main`
(0 divergent). Fast-forwarded to `6a6a336c` ("fix: harden JOY agent foundation path"), the
reviewed foundation release that is live in production. No content change; safe FF only.

## Gbrain / live-memory

`Start-Agent-Process.ps1` ran clean (pc_workbench `ca4f5162…`, vps_mirror `940e4152…`).
The authenticated **VPS Gbrain MCP is not reachable from this session** (no connector
configured; no HTTP route). The read-only PC mirror confirms `6a6a336c` is the live
foundation release and carries no Live Director page yet. Per the master plan and the
`joy-live-director-baseline.md` precedent, authoritative live-memory reads and writes are
marked **sync pending**; the Desktop briefs are the working context. The pull-only Desktop
`gbrain` mirror was not edited.

## Toolchain

- Node `v22.22.3`, pnpm `11.15.0`.
- `pnpm install --frozen-lockfile`: **clean** — node_modules already matched the WIP
  lockfile. The WIP lockfile differs from the committed one only by adding
  `mediabunny@1.55.7` (the O2 decode adapter, reviewed in
  `docs/reviews/joy-observation-decoder-selection.md`) and wiring `@joy-media/media-core`
  into `apps/editor-web` with new `browser` / `observation` export subpaths. Consistent.

## Red/green state of the uncommitted tree

Captured after applying the WIP and making the minimal fixes listed under "Phase-A fixes".

| Check                                       | Result                                                           |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm typecheck` (`tsc -b`, whole monorepo) | **GREEN** (after 1 one-line fix — see below)                     |
| `pnpm lint` (`eslint .`)                    | **GREEN** — 0 errors (2 pre-existing warnings, unrelated files)  |
| `pnpm format:check` (`prettier --check .`)  | **GREEN** (after `pnpm format` — the WIP files were unformatted) |
| `pnpm test` (full vitest, 507 files)        | **GREEN** — 3995 passed, 38 skipped, **0 failed**                |

Playwright / `pnpm verify:joy-agent-worker` / `pnpm build` not yet run in this capture —
they belong to the per-milestone acceptance in Phase B step 10.

### Baseline "known failure" is resolved

`docs/reviews/joy-live-director-baseline.md` records
`packages/plugin-sdk/src/cli.test.ts` → "creates a panel package from the published
scaffold" as a known pre-existing failure. **It now passes** (fixed somewhere in the 39
commits between the old local `main` and `6a6a336c`, or on the branch). The baseline note
is stale on this point; there is no outstanding known-failure to carry to the candidate.

## Codex self-review bugs (plan §5) — status

All three were **already fixed in the uncommitted WIP** (Codex kept working past its own
self-review) and **already covered by focused regressions**:

| #   | File                                                                                                                                        | Regression that locks it                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/editor-web/src/media-observation/resource-scheduler.ts` — release must identify the specific lease, not just its ID                   | `resource-scheduler.test.ts` → "does not let a stale lease release a later lease with the same resource ID" (identity check `this.#active.get(id) !== active` + `released` guard)                                                                                                                                       |
| 2   | `apps/editor-web/src/media-observation/sampling-policy.ts` — event promotion must not drop a stronger selected event for a weaker later one | `sampling-policy.test.ts` → "does not replace a selected stronger event with a weaker event" (strongest-first pass + `event.score <= selected.score` guard)                                                                                                                                                             |
| 3   | `apps/editor-web/src/joy-agent/observation-consent.ts` — consent must be immutable + replay-safe after approval                             | `observation-consent.test.ts` (8 tests) → "freezes and canonicalizes the issued scope", "rejects reflected model JSON rather than letting it grant consent", "does not reset spent budgets or let a revoked issued scope resume" (private `ISSUED` symbol + `WeakSet`, immutable `snapshotConsent`, `CLAIMED_CONSENTS`) |

Codex's fourth note — the observation scheduler / batching / consent registry / execution
receipts have **no production callers yet** — still stands. Wiring the foundation modules
into a real Creative-Brief→observe→propose→prepare→preview→approve→commit→verify journey
is the actual R1 finish line (plan §7 step 9 / r1.md V1).

## Phase-A fixes applied (minimal, to reach green)

| File                                                                                                                                                                                       | Change                                                                                                                                                                                                                                     | Rationale                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/editor-web/src/media-observation/sampling-policy.ts`                                                                                                                                 | annotate `add(candidate: CanonicalSamplingCandidate)` in the `createCanonicalFrameSampler` return object                                                                                                                                   | `Object.freeze({ add(candidate) {…} })` lost contextual typing → `TS7006` implicit `any`. Only real typecheck break in the whole WIP.                                                                                                                                                                        |
| `apps/editor-web/src/export-recovery-contract.test.ts`                                                                                                                                     | update the guarded-failure assertion to the new 3-way status (`interrupted-retryable` / `verification-required` / `failed`)                                                                                                                | The WIP legitimately extended the export-failure path with an O6 `verification-required` branch when the final-encoded-export verification receipt is `unavailable`. The pre-existing source-text contract test still asserted the old 2-way ternary. Behavior is intended; the contract test now tracks it. |
| `eslint.config.mjs`                                                                                                                                                                        | globals block `tooling/*.mjs` → `tooling/**/*.mjs`, add `structuredClone`; add `varsIgnorePattern: '^_'` (mirrors the existing `argsIgnorePattern: '^_'`)                                                                                  | the new `tooling/release/*.test.mjs` sits one dir deeper than the old pattern; `_`-prefixed discard bindings in the WIP (`_cacheState`, `_frame`, …) match the established convention                                                                                                                        |
| 6 files: `engine.worker.ts`, `multimodal-transport.ts`, `observation-review-controller.ts`, `observation-transfer-port-protocol.ts`, `observation-transfer-service.ts`, `engine-client.ts` | `// eslint-disable-next-line no-control-regex` (+ justification) / `prefer-const` disable in one deferred-assignment closure                                                                                                               | the control-char + bidi-override regexes are deliberate anti-injection / anti-spoofing controls; `no-control-regex` is the "are you sure?" rule and here we are                                                                                                                                              |
| `apps/editor-web/src/App.tsx`                                                                                                                                                              | remove 10 now-dead imports (`PlaybackDiagnosticsSnapshot`, `ArtifactStore`, `CreativeBriefV1`, `EditorContext`, `HistoryEntry`, `ProjectWriterStorage`, `DualLensProjection`, `DataLane`, `WorkflowGraphV2`, `ControlPlaneProjectBinding`) | each had exactly one usage at HEAD that the WIP refactor removed                                                                                                                                                                                                                                             |
| `bounded-tool-loop.ts`, `observation-tool-adapter.ts`, `composition-observer.ts`, 3 test files                                                                                             | drop unused imports; empty-interface → `type` alias; two-statement form for `x.frames(…)[Symbol.asyncIterator]()` (prettier/eslint conflict)                                                                                               | mechanical                                                                                                                                                                                                                                                                                                   |
| whole tree                                                                                                                                                                                 | `pnpm format`                                                                                                                                                                                                                              | the WIP files were never prettier-formatted; also fixed one pre-existing violation in `apps/editor-web/src/dock-layout.ts`                                                                                                                                                                                   |

`packages/evaluator/src/evaluate.test.ts` and `packages/project-schema/src/model.test.ts`
were restored to HEAD — `eslint --fix` had removed pre-existing (and still-present)
"unused eslint-disable directive" **warnings** in them, which are not in scope and do not
fail `eslint .`.

## Committed vs. uncommitted (task mapping)

**Committed on `codex/joy-live-director`** (`6a6a336c..92018ca9`, 14 commits):
Phase 0 (plan + fixtures), **F1** (`feat(agent): define source-backed operation coverage`),
**O1** (`feat(media): define timestamped observation evidence`), **F2** (3 commits:
execution receipts / prepared-change binding / durable edit authority fence),
plus partial O2 (`resource-scheduler`), O3 (`evidence-batches`), O5
(`observation-consent`) and two follow-up hardening commits.

**Uncommitted (this capture), grouped by r1.md task:**

- **F3** — `joy-agent/host-rpc.ts`, `provider-capabilities.ts`, `run-budget.ts`,
  `host-tool-contract.ts`; `engine-client.ts`, `bounded-tool-loop.ts`, `protocol.ts`,
  `tool-bridge.ts`, `context-snapshot.ts`, `engine.worker.ts` edits.
- **F4** — `joy-agent/run-controller.ts`, `run-store.ts`, `run-events.ts`,
  `composer-host-lease.ts`, `conversation-entity-references.ts`,
  `conversation-target-constraint.ts`; `AgentPanel.tsx` / `App.tsx` / conversation edits.
- **F5** — `joy-agent/domain-parity.test.ts`, `{timeline-edit,timeline-split,title-keyframe,transition-add}-readback.ts`,
  `joy-code-asset-descriptors.ts`; timeline-compiler / compound-compiler / compound-runner edits.
- **O2** — `media-observation/source-decoder.ts`, `browser-sample-decoder.ts`,
  `observation.worker.ts`, `observation-worker-client.ts`, `observation-protocol.ts`;
  `packages/media-core/src/browser.ts`; `project-media-resolver.ts` epoch invalidation.
- **O3** — `media-observation/observation-service.ts`, `evidence-store.ts`,
  `observation-cache.ts`; `sampling-policy.ts` canonical sampler.
- **O4** — `packages/audio-core/src/observation-analysis.ts`, `beat-envelope.ts`;
  `media-observation/audio-observer.ts`, `transcript-evidence.ts`.
- **O5** — `joy-agent/multimodal-transport.ts`, `observation-transfer-service.ts`,
  `observation-transfer-port-protocol.ts`, `worker-observation-transfer.ts`,
  `observation-payload-resolver.ts`, `observation-run-authority.ts`,
  `observation-tool-adapter.ts`, `observation-host-factory.ts`.
- **O6** — `media-observation/composition-observer.ts`, `render-verification.ts`,
  `final-encoded-export-decoder.ts`; `export-final-verification.ts`;
  `apps/editor-web/src/App.tsx` export-verification gate + `export-history.ts`
  `verification-required` status.
- **V1** — `packages/agent-tools/src/creative-skill.ts`, `creative-skills.ts`;
  `joy-agent/skill-runner.ts`, `director-verifier.ts`, `observation-review-controller.ts`,
  `entry-points.ts`.
- **V2** — `AgentEvidenceFilmstrip.tsx` (+css+test), `AgentObservationConsent.tsx`
  (+css+test), `JoyAgentSettingsDialog.tsx`, `editor-panel-context.ts`; panel edits.
- **e2e (Playwright)** — `tests/e2e/agent-director-{lifecycle,runtime}.spec.ts`,
  `agent-observation-decode.spec.ts`, `agent-timeline-split-parity.spec.ts`,
  `final-encoded-export-decoder.spec.ts`; `agent-byok-security.spec.ts`,
  `wp30-animated-timeline-export.spec.ts` edits.
- **tooling** — `generate-director-fixtures.test.mjs`,
  `release/verify-agent-operation-coverage.test.mjs`.

Focused vitest for the observation + agent + media surface: **77 files, 532 tests,
all passing.**

## Coverage ledger honesty (open item for the R1 gate)

`docs/reviews/joy-live-director-coverage.json` has 14 operations, all
`status: verified` / `verificationScope: bounded-proposal-path`. Its own `parityRule`
says a bounded-proposal-path pass "never proves domain-complete UI parity, rendered
output, decoded audio, or external job effects." Before the R1 candidate is bundled for
review, the ledger must be reconciled against the real F5/O6 readback + render-verification
consumers that now exist, and any operation without a rendered/audio/state readback
consumer must be demoted from `verified` or given one. This is r1.md F5 / O6 / V3 work,
not done in this capture.

## Next steps (Phase B)

1. Retarget the branch plan docs to Claude-only roles (`docs: retarget Live Director roles
to Claude-only review`).
2. Commit the WIP grouped by r1.md task, F3 → F4 → F5 → O2 → O3 → O4 → O5 → O6 → V1 → V2,
   each with the plan's commit message, verifying that task's named tests first.
3. Per milestone group: local `pnpm` green → push → CodeRabbit → self-hosted CI lanes.
4. Wire the real Creative-Brief journey (r1.md V1) and run the Playwright + worker verifier
   acceptance.
5. R1 release gate: CodeRabbit clean + 3 self-hosted CI lanes green ×2 + independent Opus
   ("Astra") `APPROVE_FOR_DEPLOY` on the exact candidate + owner go-ahead.
