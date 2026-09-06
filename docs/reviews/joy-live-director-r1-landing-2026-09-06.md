# JOY Live Director — R1 landing status

Recorded: 2026-09-06 (Claude implementer, continuation session)
Branch: `codex/joy-live-director`
Implementation base: `6a6a336c` (live foundation release)
Landed range: `131e409c..` (this session's commits on top of Codex's `92018ca9`)

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

1. **`skill-runner` / `creative-skills` recipe layer (V1) has no production
   caller.** The named procedures (Watch and Map, Find Moment, Build Rough
   Cut, Title/Caption Polish, Motion/Transition Polish, Audio Balance, Verify
   Deliverable) exist as validated manifests and the runner is unit-tested,
   but nothing in `entry-points.ts` constructs a `CreativeSkillRunAdapter`
   wired to the observation service / compound compiler / preview /
   director-verifier. r1.md V1 wants each procedure invocable end to end with
   its own Playwright spec.
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
   `readback: rendered-output`. `render-verification` also does not yet accept
   `audioStreamCount: 0` — a fully silent export fails closed with
   `audio-streams-mismatch` (documented as a scope limit in the module).
4. **V3 acceptance demonstration** (r1.md V3): the scripted end-to-end
   showcase — find the single-frame flash in exact mode, build a rough cut
   from observed source ranges, refine a Persian title over two turns,
   animate a property/effect/transition, balance real audio, verify encoded
   output + one Undo/reload — has not been run and recorded as a bundle.
5. **Real BYOK model compatibility** (r1.md V3): needs separately authorized
   test credentials + spend cap; not run. Label live creative evaluation
   blocked until an authorized model is available.
6. **Live-memory sync pending** — VPS Gbrain MCP was unreachable this session.

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
