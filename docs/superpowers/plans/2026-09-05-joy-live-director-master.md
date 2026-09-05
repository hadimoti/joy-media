# JOY Live Director Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or the installed `executing-plans` equivalent) to implement this plan task-by-task. GPT-5.6 Terra is the requested executor. Steps use checkbox syntax for tracking. Do not start another implementation agent unless the owner requests delegation.

**Goal:** Deliver a trustworthy video-observing editor agent, editable art direction and linked deliverables while preserving JOY's browser BYOK architecture and existing projects.

**Architecture:** Keep one built-in Worker runtime and one trusted project controller over JOY's canonical operation/transaction boundary. Add isolated observation services and typed evidence, then compile Looks and version propagation through the same operation API. All releases require independent Astra review of the exact candidate before deployment.

**Tech Stack:** Existing TypeScript/pnpm monorepo, React, browser Workers, OPFS/IndexedDB, JOY project schema/commands/property system/RenderFrameIR, Vitest and Playwright; candidate browser demux/decode adapter behind a narrow interface. No new mandatory backend or local model.

---

## Read order and authority

1. Current repository `AGENTS.md` if present and owner-supplied instructions.
2. [Approved design](../specs/2026-09-05-joy-live-director-design.md).
3. This master plan and its execution/release rules.
4. [R1 foundation and perception](2026-09-05-joy-live-director-r1.md).
5. [R2 Looks and R3 linked versions](2026-09-05-joy-live-director-r2-r3.md).
6. [Existing full-editor operation plan](2026-09-05-joy-agent-full-editor-operation-plan.md), especially sections 5–8. Its incomplete domain requirements are prerequisites, not erased by this document.
7. `docs/reviews/2026-09-05-joy-agent-implementation-review.md` and ADR-0004.

Scope is this three-release JOY Media upgrade. The planning turn writes documentation only. Execution is for the next Terra agent, not automatically launched by these files.

The source baseline inspected for this plan is `6a6a336cdd4fb0126c002dda86167f5c92ebfe32`. A later checkout requires a delta audit, not checkout/reset to the old baseline. The prior foundation release is not proof that the entire prior full-editor plan was implemented.

## Execution state (initial, unimplemented)

| Milestone                | Dependencies                                     | Required acceptance                                                                             | State                                    |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| F: functional foundation | Baseline/ownership audit                         | One runtime, durable controller, actual operation parity ledger and preview/commit verification | Open                                     |
| O: observation           | F contracts; O1/O2 can precede remaining domains | Real video/audio fixtures; exact timing/coverage; consent; no focus theft                       | Open                                     |
| R1 integration           | F + O + skills/presence                          | All R1 scenarios, real Worker, rendered and exported evidence                                   | Open                                     |
| R2 Living Looks          | R1 accepted interfaces and operation support     | Six editable packs, manual/agent parity, audio-reactive timing, creator evaluation              | Open                                     |
| R3 Linked Versions       | R1 + R2                                          | Human overrides, dependency propagation, four deliverable types, recovery                       | Open                                     |
| Release                  | Candidate for the selected milestone             | Astra explicit exact-candidate approval, then scoped deploy/rollback/smoke                      | Not authorized by a checklist tick alone |

Do not conflate milestones: an R1 candidate may be reviewed independently with R2/R3 explicitly open. The whole requested upgrade is complete only when every required milestone passes. A partial release requires the owner to agree to that delivery scope; approval of this plan is not permission to describe a partial slice as complete.

## Task protocol and test harness

Each task contains exact source seams, a concrete behavior contract and named test cases. Small contract snippets are intended to remove ambiguity; they do not license replacing existing reducers/renderers with a toy implementation. Terra must read each touched implementation and its tests before editing it.

For each named scenario, add one focused regression, run it red, implement the smallest complete path, run it green, then commit only that task's files. Do not manufacture test success by mocking away the compiler, persistence or renderer under test. Provider responses may be scripted; the Worker, RPC, host, commit and output paths must remain real in integration tests.

Commands from repository root, PowerShell (run separately; preserve full exit status):

```powershell
git status --short --branch
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm exec vitest run packages/agent-tools/src/editor-operation-definition.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm verify:joy-agent-worker
pnpm exec playwright test tests/e2e/agent-live-preview.spec.ts tests/e2e/agent-live-presence.spec.ts tests/e2e/agent-byok-security.spec.ts --project=desktop-primary
```

The focused test command above is F1's example; each subplan supplies its own exact test filenames. Focused command passes must name the tests run; full-suite counts must come from that candidate's output, never copy historical counts. If an unrelated baseline check fails, record its identity and compare with the untouched baseline in an isolated checkout; do not silently suppress it.

New pure modules live in their owning packages. Host orchestration lives under `apps/editor-web/src/joy-agent/`; browser observation integration under `apps/editor-web/src/media-observation/`. Avoid growing `App.tsx` with another thousand-line controller. Extract only the seams touched by this feature, with parity tests; no unrelated sweeping refactor.

## Phase 0 — ownership, truth and evaluation fixtures

- [ ] Run `& 'C:\Users\HadiMoti\Desktop\gbrain-pc\scripts\Start-Agent-Process.ps1'`, then query authenticated VPS Gbrain for `joy-vps-agent-brief` and newer JOY-specific release pages. A mirror is not the live source of truth.
- [ ] Read `C:\Users\HadiMoti\Desktop\VPS-AGENT-BRIEF.md`. Record only redacted deployment facts. Preserve newer sections from the independent `joy-vps` agent.
- [ ] Record branch/HEAD/tree/lock digest, working changes and current owner task boundaries in `docs/reviews/joy-live-director-baseline.md`. Discover active tasks read-only if necessary. Never reset, clean, stash, commit or deploy another agent's work.
- [ ] Run focused existing agent/media/property/render tests and required full checks. Record real failures/skips rather than infer support from a plan checkbox.
- [ ] Create `docs/reviews/joy-live-director-coverage.json` from source-linked UI/action/property/domain entries, with status `verified`, `unsupported`, `read-only`, `internal-inverse` or `legacy-disabled`. Include test IDs and rendered/audio evidence where relevant. A claimed creative capability cannot be `verified` from metadata alone.
- [ ] Create `tooling/fixtures/joy-director-fixture-manifest.json` and a deterministic generator `tooling/generate-director-fixtures.mjs`, extending the existing `tooling/generate-media-fixtures.mjs` conventions. Use generated/licensed fixture media only. Include timebase, actual PTS/frame count, known pixel event ranges, audio sample counts, hashes, license and generation command/version. FFmpeg is permitted for developer fixture generation; not required for the browser app.
- [ ] Generate CFR and VFR numbered frames, B-frame reorder, nonzero PTS origin, portrait rotation/SAR, duplicate-PTS or explicit unsupported fixture, a single-frame colored flash, hard cut/fade, small text, silent/speech/music audio with known impulses, a long sequence, corrupt/truncated media and missing codec. Assertions use actual source frame identities, not nominal FPS.

## Acceptance scorecard

### Mechanical gates (must pass)

- No unauthorized mutation/upload, no key persistence/logging, no false completion, no stale preview or cross-project authority.
- Exact supported fixtures reproduce expected frame IDs/PTS, including the one-frame flash in exhaustive/focus mode. Overview may miss it but must remain labelled sampled.
- Every targeted creative action in the coverage ledger has real host/compiler/Undo/reload tests; unsupported platform/codec/export capabilities are explicit. No successful fake diff.
- Preview does not mutate canonical stores/history. Commit is one durable transaction per approved local change set; repeated execution returns the prior receipt; failure/reload and two writers do not duplicate/partially apply.
- Rendered capture and final encoded output checks include timing, dimensions, required text/effects, audio and dependency readiness. Structural validation alone does not satisfy a visual goal.
- All new entry points use the real production Worker and common controller. No dormant SDK path counted as integration.

### Proposed performance budgets (validate on recorded hardware/browser)

- Observation decoded working set: default hard 128 MiB, additionally bound in-flight samples/encoded batches; cache budget separate and visible. Count RGBA, transfer copies and queued payloads, not only JPEG sizes. Reject/stream oversized frames without allocating a whole 4K clip.
- Observation cancellation releases owned decoder/bitmap/audio resources within 1 second after local cancellation, excluding explicitly reported unabortable browser/provider work. Deadline failures become diagnostics, never leaked jobs.
- Playback has scheduler priority. On a fixed 1080p benchmark, background overview should add no more than 5 percentage points of dropped preview frames against baseline. Pause analysis when this budget is exceeded.
- No unbounded main-thread analysis loop. Instrument new long tasks; none over 50 ms on the benchmark attributable to batching/serialization/analysis loops. Chunk work or move it to the Worker.
- Provider budgets are request/frame/byte/token limits plus confirmed/estimated cost; unknown cost is shown as unknown. Default max two repair proposals, not an infinite optimization loop.

These are proposed acceptance thresholds, not measured promises. If unsupported hardware cannot meet them, document the bounded degradation/pause behavior; do not silently increase resource budgets.

### Creative/product evaluation (record separately from unit tests)

Use one common task set: 20-second launch edit; Persian editorial/caption clip; music-driven 15-second montage; long interview with an exact quoted moment; four-format campaign update with human overrides. Compare current JOY/manual work with candidate output using the same licensed footage and declared constraints.

Record creator preference, editability, typography/readability, timing, time-to-approved-export, number of repairs/manual corrections, and actual authorized provider cost. The goal is clearly better controllable results, not just a faster first draft. A failed taste study changes packs/procedures; it does not justify relaxing safety gates. No claim of market uniqueness or five-year success from a passing test suite.

## Exact-candidate Astra review gate — mandatory before any deployment

### Terra prepares the handoff

- [ ] Stop all deployment actions. Finish local tests and scoped commits; preserve unrelated dirty work.
- [ ] Create `docs/reviews/joy-live-director-release-review.md` naming requested milestone, implementation base SHA, candidate commit/tree, lock digest, schema/protocol versions, supported browsers/codecs, dependency/license changes and migration/rollback risks.
- [ ] Collect **all scoped changes from the implementation base**, not only the last commit: full binary-capable Git diff, changed-file summary, ordered commits, status and any scoped untracked files not yet in the candidate. Untracked runtime changes must be committed or excluded from the release; no invisible additions.
- [ ] Provide sanitized commands/exit codes/test outputs, screenshots at narrow/wide/RTL/reduced-motion sizes, original/preview/export frame comparisons, audio measurements, privacy/network tests, performance logs, real-model compatibility results and explicit skips/limitations. Exclude owner media, keys, raw prompts/transcripts and private provider responses.
- [ ] Use `git diff --binary BASE_SHA CANDIDATE_SHA` through a safe artifact collector, with SHA-256 hashes for artifacts. `BASE_SHA` and `CANDIDATE_SHA` mean the verified exact values in the review manifest. Include staged and unstaged scope checks separately so nothing is omitted. Do not use `git add .` in a shared dirty worktree.
- [ ] Send the bundle to GPT-6 Astra for **independent source and result review**, using an existing identified review task if available. If no reviewer is available, stop and ask the owner to route the bundle. Do not fabricate an approval or treat a timeout/silence as approval.

Reviewer request to send (substitute the actual manifest and candidate, not invented IDs):

> Review the full JOY Live Director milestone candidate and all base-to-candidate diffs against the approved design, domain coverage ledger and acceptance evidence. Inspect actual production Worker integration, frame/PTS coverage truth, consent and key privacy, canonical transactions/recovery, preview/export fidelity, human overrides, performance and license/migration boundaries. Return blocking findings with file/line and reproduction, or an explicit APPROVE_FOR_DEPLOY tied to the exact candidate commit, tree and lock digest. Do not implement or deploy. Another agent owns unrelated joy-vps work; that scope must remain untouched.

### Approval semantics

- Only an explicit Astra `APPROVE_FOR_DEPLOY` for that candidate satisfies the review gate.
- Astra findings return to Terra for fixes and rerun evidence; resubmit the complete updated diff.
- Any changed runtime file, build input, lockfile, migration or deployment configuration invalidates prior approval. Rebuilt artifacts must match approved source/build inputs; record artifact digest.
- If Astra approves only a subset, only that scoped candidate may proceed after the owner accepts partial release scope. Unfinished milestones remain open.

### After approval, same scoped release procedure

- [ ] Re-read live Gbrain/SSH deployment facts and the Desktop brief, then check for concurrent JOY deployment ownership. Coordinate rather than overwrite another release.
- [ ] Revalidate exact candidate and artifact digests, migration compatibility and reversible last-good release. Preserve a recoverable project backup if migration changes durable state; do not rely on code rollback to reverse a schema migration.
- [ ] Use the repository's current guarded Sweden release procedure after reading it. Limit changes to JOY Media's identified service/artifact; no shared Nginx, unrelated service restarts, broad filesystem sync/delete or changes in another agent's `joy-vps` checkout.
- [ ] Smoke-test the exact deployed build with a disposable project: connect a test provider, reject/approve an edit, inspect a real frame, verify output, cancel and reload. Never use or expose the owner's existing API key/browser media for paid tests.
- [ ] Confirm asset/build identity and health; on failure use the prevalidated rollback and report the failure. Do not relabel a failed smoke as successful deployment.
- [ ] Only the orchestrator writes a redacted result to live VPS Gbrain, reads it back, runs `Invoke-VpsGbrainExport.ps1` with **no arguments**, records the verified export SHA in a private PC receipt, then runs `Publish-PcReceipt.ps1`. Never edit/push the pull-only Desktop `gbrain` mirror or bulk-replicate PC notes.
- [ ] Fresh-read and append the validated JOY release/limitations to Desktop `VPS-AGENT-BRIEF.md`, preserving concurrent edits and unrelated facts. Include candidate/artifact identity, scope, tests, rollback and next open milestone; no secrets.

## Ready-to-use Terra handoff

> Implement the approved JOY Live Director plan in `docs/superpowers/plans/2026-09-05-joy-live-director-master.md`, reading its linked design and both subplans first. Work through F/O/V, then L and C tasks with TDD, source-derived capability coverage and scoped commits. Preserve existing human controls/projects, session-only BYOK and the closed Fontiran gate. Do not require DSH/Kilo/local services. Do not touch the independent agent's joy-vps work. Never claim sampled frames are exhaustive understanding. Stop before deployment; collect all implementation-base-to-candidate diffs and real evidence for GPT-6 Astra. Deployment can proceed only after Astra explicitly approves the unchanged exact candidate, followed by the guarded live verification and Gbrain/Desktop-brief closeout. Report partial milestones honestly.

## Planning self-review

- Requirements mapped in design section 12 to the subplan task IDs.
- New file paths are explicitly proposed; existing seams are source-verified. Contract names are defined where introduced.
- Observing source media, observing composed output and verifying encoded output are distinct gates.
- Privacy is not inferred from connection success; no external skill/plugin installed by the plan.
- Full parity, six Looks and linked versions remain explicit open deliverables, not silently deferred behind a foundation badge.
- Terra implementation and Astra release approval are separate responsibilities.
