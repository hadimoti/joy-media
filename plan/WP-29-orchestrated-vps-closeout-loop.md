# WP-29 — Orchestrated VPS Closeout Loop

**Status:** STEP-00 through STEP-21 approved; WP-29 FINISHED
**Parent:** [`WP-29-closeout-remaining-acceptance.md`](WP-29-closeout-remaining-acceptance.md)
**Execution model:** Codex orchestrator reviews; one persistent Codex agent on the Sweden VPS implements
**Repository:** `/opt/joy-media/repo`
**Live application:** [https://joyst.ir/](https://joyst.ir/)
**Target:** close every remaining WP-29 gate through a review-controlled loop without skipping evidence

## 1. Outcome

The four acceptance areas that originally opened this loop were:

1. Browser-originated MP4 export with independent FFprobe and audio proof.
2. A real Local Worker result reviewed and inserted exactly once.
3. Controlled playback performance evidence on the named Chrome/GPU host.
4. All 37 previously NOT-RUN Chrome cases, including defect repair, rerun, and cleanup.

All four are now closed in the pre-deploy candidate. The exact accepted
checkpoint is:

- `pnpm verify:ci`: PASS — 259 test files and 1,851 tests passed; one file and
  two tests skipped as named integration gates; builds and production audit
  passed.
- R2 Worker insertion: 3/3 in installed Google Chrome, combined with the
  retained licensed real-Worker DSP proof.
- R3 export/audio proof: 3/3 authenticated browser exports passed H.264/AAC
  FFprobe; deterministic duration was 3.013 s for a 3.000 s source (13,000 µs
  delta, below the 33,334 µs tolerance), with audible/gain/mute means of
  -21.1/-33.2/-91.0 dB and the expected 12.1 dB gain-direction change.
- Export recovery: 3/3 in installed Google Chrome.
- R5: 108 direct installed-Chrome instances plus three reconciled R2 CASE-66
  instances, for 111/111 across all 37 cases and three required viewports.

The final candidate SHA, immutable deployment releases, signed-in live cleanup,
and final GBrain update are intentionally pending STEP-19 through STEP-21. This
document does not claim that the current working tree has been deployed.

The orchestrator sends exactly one bounded step to the VPS Codex agent. The
agent implements and reports that step, then stops. The orchestrator independently
reviews the diff, tests, artifacts, and live state. Only an explicit
`APPROVED — CONTINUE STEP-XX` starts the next step.

```text
ORCHESTRATOR assigns one step
             ↓
VPS CODEX implements, tests, commits, reports, and stops
             ↓
ORCHESTRATOR independently reviews evidence
       ┌─────┴─────────┐
       ↓               ↓
    APPROVE          REWORK
       ↓               │
 next step       same step only
       └───────────────┘
             ↓
        all gates pass
             ↓
 deploy → live smoke → cleanup → docs/GBrain → FINISHED
```

## 2. Non-negotiable control rules

1. The doer works on **one step only** and must stop after its report.
2. The doer must not interpret silence as approval or begin the next step early.
3. Every product change ships with focused tests in the same commit.
4. Every apparent defect is reproduced once before classification.
5. A failed review returns to the same step; it never becomes a future TODO.
6. P0, P1, and golden-path P2 defects block progression and deployment.
7. Other confirmed defects must be fixed and rerun, or receive an explicit
   owner-approved `BLOCKED-*` disposition. They cannot silently disappear.
8. Production is changed only during the deployment step after the candidate
   gate passes.
9. No credential, bearer token, contact, local path, private-object reference,
   or provider secret enters a report, project document, trace, or commit.
10. Test authentication exists only inside the test process. Production never
    receives a test route, token, fixed cookie, or auth bypass.
11. Use one exactly named disposable live project and one disposable Worker.
    Never delete, trash, revoke, or overwrite an object whose ID was not captured
    during preflight.
12. Paid/cloud provider execution that is not covered by a deterministic test
    provider receives action-time owner confirmation. A decline is
    `BLOCKED-CONSENT`, not `FAIL`.
13. The prior production API/editor releases and database backup remain
    available until final closeout is accepted.

## 3. Roles

### 3.1 Orchestrator

The orchestrator owns sequencing and acceptance. It:

- records the run ID, starting commits, deployment targets, and restore points;
- sends the doer a prompt for one step only;
- reads the entire step report and changed diff;
- independently reruns the smallest meaningful verification;
- checks repository, browser, service, and evidence state as applicable;
- sends `APPROVED`, `REWORK`, or `BLOCKED` with concrete reasons;
- never edits around an unreviewed doer commit;
- merges, deploys, verifies cleanup, and closes documentation only after every
  preceding gate passes.

### 3.2 VPS Codex doer

The doer owns implementation inside the isolated closeout worktree. It:

- reads `AGENTS.md`, `ORCHESTRATION.md`, `STATE.md`, this plan, and the parent
  acceptance plan before acting;
- checks for user or agent changes before editing and preserves unrelated work;
- uses `apply_patch` for source/document edits;
- implements only the assigned step;
- runs focused verification plus the step gate;
- creates one reviewable commit and pushes the closeout branch;
- writes the step result into the review log;
- reports and stops without starting the next step.

## 4. Run identity and workspace

At kickoff, the orchestrator chooses:

```text
RUN_ID=wp29-closeout-YYYYMMDD-HHMM
BRANCH=codex/wp29-closeout-YYYYMMDD-HHMM
WORKTREE=/opt/joy-media/worktrees/wp29-closeout-YYYYMMDD-HHMM
DISPOSABLE_PROJECT=WP-29 closeout YYYYMMDD-HHMM
REVIEW_LOG=docs/qa/WP-29-closeout-review-log-YYYYMMDD-HHMM.md
RESULTS=docs/qa/gpt-chrome-usage-audit-YYYYMMDD-HHMM.md
EVIDENCE=/opt/joy-media/evidence/wp29-closeout-YYYYMMDD-HHMM
```

The branch begins at the current clean `origin/main`. The main production
checkout `/opt/joy-media/repo` stays on `main`; the doer works only in the
validated worktree path. Before adding the worktree, resolve both absolute paths
and verify the new target is inside `/opt/joy-media/worktrees`.

Binary downloads, videos, traces, and raw performance samples stay in the
excluded evidence directory or CI artifacts. The repository stores sanitized
Markdown summaries, hashes, FFprobe JSON, defect records, and compact screenshots
only when useful.

## 5. Doer report contract

Every doer response must use this exact shape:

```markdown
## STEP-XX report

- Status: READY-FOR-REVIEW | BLOCKED
- Starting commit:
- Result commit:
- Branch:
- Files changed:
- Behavior implemented:
- Defects found/fixed:
- Tests run and exact outcomes:
- Browser/VPS evidence paths:
- Console/network observations:
- Security/privacy checks:
- Rollback or recovery note:
- Deviations from the step:
- Remaining risk inside this step:
- Worktree status:
- Next step: NOT STARTED
```

`READY-FOR-REVIEW` means the doer believes every acceptance item for that step
passes. `BLOCKED` must state the exact blocker, attempted alternatives, and the
smallest missing input or external state.

## 6. Orchestrator review gate

For every step, the orchestrator performs these checks before responding:

### 6.1 Scope and Git

- The reported start/result commits exist on the closeout branch.
- `git status --short` is empty.
- The commit contains only the assigned step and its evidence.
- `git diff <start>..<result> --check` passes.
- No secret-like values, test tokens, personal file paths, or private refs appear
  in the diff or evidence.
- No generated build directory, download, trace, or large temporary media was
  accidentally committed.

### 6.2 Correctness

- The implementation follows the existing project/media/job contracts.
- Failure paths are visible, bounded, recoverable, and tested.
- Idempotency, reload behavior, and target isolation are checked where relevant.
- The expected user-visible outcome is verified semantically, not only through
  screenshots.

### 6.3 Evidence

- Exact commands and outcomes are present.
- Browser failures include console, pageerror, and same-origin request evidence.
- Export evidence includes SHA-256 and sanitized FFprobe/audio measurements.
- Performance evidence includes raw sanitized observations plus calculated
  thresholds.
- A failed case is reproduced once; a flaky case includes its pass/fail ratio.

### 6.4 Review responses

Approval:

```text
APPROVED STEP-XX
Evidence accepted: <brief list>.
CONTINUE STEP-YY ONLY. Do not start STEP-ZZ.
```

Rework:

```text
REWORK STEP-XX
Review failed because:
1. <specific defect/evidence gap>
2. <specific defect/evidence gap>
Remain on STEP-XX. Amend with a new commit, rerun the listed checks, report, and stop.
```

Blocked:

```text
BLOCKED STEP-XX
Reason: <external or owner-controlled condition>.
Preserve the named evidence and restore the worktree/live state.
Do not continue until the orchestrator explicitly resumes this step.
```

## 7. Step-by-step execution

### STEP-00 — Preflight and isolated worktree

Doer actions:

1. Record local/VPS time, `origin/main`, current production source, active API
   and editor releases, service health, public index hash, Chrome version, OS,
   GPU, hardware acceleration, and FFmpeg/FFprobe versions.
2. Confirm `/opt/joy-media/repo` and the local checkout are clean.
3. Create the exact closeout branch/worktree and evidence directory.
4. Create the review log and new results report with the run metadata.
5. Capture the live project list and current project without mutation.
6. Record the current database count summary and object/job/worker baselines
   without exposing private refs.

Gate:

- Branch/worktree are isolated and clean.
- Production remains on the previously deployed release.
- Evidence and restore targets are recorded.
- No mutation has occurred.

### STEP-01 — Reproduce and profile browser export

Doer actions:

1. Use the committed three-second H.264/AAC fixture in the local authenticated
   Playwright stack.
2. Reproduce the 1080×1920 export stall three times from a clean project.
3. Capture duration, progress events, frame count, renderer path, GPU/browser
   warnings, long tasks, memory, and the exact point where download emission
   stops.
4. Compare 320×180, 1080×1920, and one intermediate preset to isolate scaling,
   readback, compositor, or MediaRecorder cost.
5. Write a root-cause note before changing product code.

Gate:

- The failure is reproduced consistently or classified `FLAKY` with a ratio.
- The root cause is supported by measurements.
- A specific repair seam and rollback are identified.

### STEP-02 — Repair the export render/readback path

Doer actions:

1. Implement the smallest repair supported by STEP-01 evidence.
2. Keep preview behavior unchanged unless the same correction is required.
3. Preserve one authored audio path, content-range duration, captions, transforms,
   effects, cancellation, progress, and resource cleanup.
4. Avoid per-frame full-resolution GPU-to-CPU readback when the selected encoder
   can consume the render surface directly; if readback remains necessary,
   demonstrate bounded reuse and no per-frame allocation growth.
5. Add deterministic unit/integration coverage for the repaired seam.

Gate:

- The three-second 1080×1920 fixture emits a download within the agreed reference
  timeout in three consecutive runs.
- No new preview/export parity failure appears.
- Cancellation releases tracks, timers, contexts, renderers, and object URLs.

### STEP-03 — Browser MP4 and independent FFprobe proof

Doer actions:

1. Implement/finish the authenticated golden export Playwright spec.
2. Register the download listener before Export is clicked.
3. Save the browser-originated MP4 under the evidence directory.
4. Run the independent `verifyExportAgainstManifest`/FFprobe path.
5. Record codec, stream counts, dimensions, 30 fps, duration delta, bytes, and
   SHA-256.
6. Run FFmpeg loudness/volume checks for audible, muted, and gain-direction
   cases.
7. Assert no random imported asset falls back to
   `/media/reference/media-*.mp4`.

Gate:

- Exactly one H.264 video stream and one AAC audio stream.
- Dimensions match the selected preset.
- Duration is within one frame of the content range.
- Audible/mute/gain checks match authored state.
- Three consecutive primary-viewport exports pass.

### STEP-04 — Export recovery, retry, and re-download

Doer actions:

1. Refresh after completion and re-download from Recent processes.
2. Verify the second download SHA equals the first.
3. Reload during encoding; require `interrupted-retryable` and one explicit
   retry using the same logical operation ID.
4. Cancel during preload and during recording.
5. Verify there is one final output, no duplicate history record, no stuck UI,
   and no partial OPFS result.
6. Run recovery checkpoints at all three target viewports.

Gate:

- Re-download survives reload with identical bytes.
- Reload/cancel/retry never duplicates an operation or output.
- Resource cleanup assertions pass.

### STEP-05 — Worker environment and real-source preflight

Doer actions:

1. Pair one exactly named disposable Worker through the normal owner flow.
2. Record Worker ID, capabilities, source possession, and health without secrets.
3. Keep it idle for at least 60 seconds and prove presence remains connected.
4. Confirm `audio.ml-denoise` is advertised only when the executable/model is
   actually healthy.
5. Upload/register the committed real audio fixture and prove the Worker maps
   that asset; fixture substitution must remain impossible for non-fixture jobs.

Gate:

- The Worker remains connected after idle.
- Capability and real source availability are honest.
- No paid/cloud route or synthetic input is used.

### STEP-06 — Real Worker result and verified A/B review

Doer actions:

1. Queue one denoise operation using the selected real fixture and a stable
   operation fingerprint/job ID.
2. Observe lease, progress, terminal receipt, derivative upload, and owner
   authorization.
3. Browser-fetch the derivative, recalculate SHA-256, validate length/MIME, and
   prove it decodes as audio.
4. Open the A/B review surface without mutating the project.
5. Verify source/result labels, duration, format, playback, and Discard.

Gate:

- One logical action creates one job, one terminal attempt, and one verified
  derivative.
- The project remains unchanged until Apply.
- No private path/ref or token reaches creative state or UI.

### STEP-07 — Exactly-once insertion, undo, reload, and recovery

Doer actions:

1. Apply Replace selected clip audio and verify one creative transaction.
2. Verify one generated asset, provenance link, clip update, undo entry, and
   audible result.
3. Undo, redo, change tabs, refresh, and reopen the project.
4. Repeat Apply and require reattachment/no-op rather than duplication.
5. Exercise Keep generated asset and Add on new audio track if supported by the
   parent acceptance contract.
6. Test failure between cache write and creative commit; recovery must leave no
   partial mutation.

Gate:

- Apply is exactly once across repeat click and reload.
- Undo/redo/reopen preserve the expected state.
- Failure/cancel/discard create no partial project objects.

### STEP-08 — Worker cancel, retry, stale lease, and revoke

Doer actions:

1. Cancel a running job and prove the subprocess receives cancellation.
2. Retry once with the same logical operation and a new bounded attempt.
3. Reject completion from the stale attempt.
4. Restart API/Worker during the operation and reattach without duplication.
5. Revoke only the disposable Worker and prove it cannot lease or upload again.

Gate:

- One terminal outcome per attempt and one accepted result per operation.
- Stale/revoked actors cannot complete work.
- UI/API/Worker counts agree.

### STEP-09 — Complete playback diagnostics semantics

Doer actions:

1. Review session/clip reset behavior for play, seek, clip switch, project
   switch, and explicit reset.
2. Test presented-frame deltas, decode misses, A/V drift percentiles, callback
   lateness, stall durations, background exclusion, and source-quality labels.
3. Cover duplicate clips referencing the same media asset.
4. Add a sanitized diagnostics export and prove it contains no media URL, path,
   contact, token, or private reference.
5. Add a five-second CI playback smoke for finite, nonnegative counters and no
   fatal stall.

Gate:

- Deterministic/fake-clock tests cover every metric and reset.
- Diagnostics UI and exported snapshot match.
- CI timing is marked observational, not reference-host proof.

### STEP-10 — Controlled reference-host playback matrix

Doer actions:

1. Run three ten-second passes at `1639×1066`, excluding the first second.
2. Run normal, duplicate-asset, gap, 0.5×, 2×, freeze, seek storm, transition,
   and background/recovery scenarios.
3. Save sanitized raw samples and calculated results.
4. Reproduce any failed threshold once before repair/classification.
5. If product repair is required, remain on STEP-10 through the defect loop.

Gate for normal passes:

- Presented-frame drop rate `≤2%`.
- p95 A/V drift `≤50 ms`.
- Maximum A/V drift `≤100 ms`.
- No unexplained stall over `500 ms`.

Gate for special scenarios:

- Semantics remain correct during the condition.
- Metrics recover to normal thresholds within two seconds afterward.

### STEP-11 — Cases 15–18, 25, and 93: file bridge

Run PNG/JPEG/MP4/WAV/MP3 imports, invalid/corrupt/empty rejection, real DnD,
timeline placement, and Joy Code attachment. Verify metadata, duration, selection,
keyboard/touch access, progress, cancellation, reload, and cleanup.

### STEP-12 — Cases 10, 32, 33, 37, and 46: pointer and gesture

Run sign-out cancel, clip move/trim, rate/freeze, and fullscreen enter/exit.
Assert project state and focus, not screenshots alone.

### STEP-13 — Cases 53–59: captions

Run delete/revert, Clean/Karaoke/RTL, SRT/WebVTT import/export, English and
Persian transcription, independent file parsing, seek synchronization, reload,
and RTL visual/accessibility checks.

### STEP-14 — Cases 63, 66, 67, and 89: Worker and audio

Map STEP-05 through STEP-08 evidence into the audit cases. Add Browser DSP and
cloud-consent routing evidence, then verify pair/idle/run/cancel/retry/revoke and
exact job/result counts from the user-facing UI.

### STEP-15 — Cases 71, 72, and 74–77: effects, color, and Inspector

Use the seeded selected object or a disposable bound fixture. Exercise effect
apply/enable/reorder/parameter/remove, recipe validation, transition favorite and
replace, grade/reset, LUT/scopes, Inspector targeting, undo, and reload.

### STEP-16 — Cases 79–85: motion, camera, and templates

Exercise motion create/open/rename/duplicate/delete, favorite/apply preset, HTML
scene, spatial path, camera configuration, and template apply/delete. Verify
Monitor output, selection targeting, confirmation, undo, and reload.

### STEP-17 — Cases 24 and 100: destructive and recovery

Use only the disposable project. Exercise confirmed cloud/AI/bulk-delete behavior
through deterministic or explicitly approved routes. Reload during one queued and
one running operation; prove no duplicate job, lost project state, or stuck UI.

### Batch gate for STEP-11 through STEP-17

Each step must:

- record separate Functional and UI/A11y verdicts for every case;
- include expected/actual behavior, exact reproduction, viewport, build,
  project, timestamp, evidence, console/network entries, and reproduction count;
- rerun every failure once from restored state;
- enter confirmed defects in the defect loop below;
- finish with no unresolved failure inside the batch.

## 8. Mandatory defect loop

When any step finds a defect:

1. Assign `JOY-QA-NNN`, severity, type, affected cases, and reproduction count.
2. The doer stops the batch and reports `DEFECT-FOUND`.
3. The orchestrator reviews classification and assigns a bounded substep such as
   `STEP-13-FIX-01`.
4. The doer writes a failing automated test when feasible, implements the
   smallest repair, runs focused and regression tests, commits, reports, and
   stops.
5. The orchestrator reviews and either returns `REWORK` or sends
   `APPROVED — RERUN JOY-QA-NNN`.
6. The doer reruns the original case twice from refreshed/restored state.
7. Only after two passes may the batch resume.

The batch cannot be marked complete while one of its defect substeps is open.

## 9. Candidate, deployment, and closeout

### STEP-18 — Consolidated candidate review

Doer actions:

1. Rebase or merge the latest `origin/main` only after checking for overlap.
2. Run on the exact clean candidate commit:

   ```text
   pnpm verify:ci
   pnpm test:e2e
   pnpm test:e2e:audit
   pnpm audit:prod
   ```

3. Run focused Worker, export/FFprobe, OPFS reopen, diagnostics, and project
   lifecycle suites.
4. Confirm all 37 case rows have final verdicts and all blocking defects are
   closed.
5. Confirm branch/worktree cleanliness and CI success.

Gate:

- All required commands exit zero on one exact commit.
- Expected integration skips are named; environmental failures are not hidden.
- Review log, results report, and code agree.

### STEP-19 — Merge and immutable production deployment

Orchestrator actions:

1. Review the complete branch diff and commit sequence.
2. Fast-forward or reviewed-merge into `main`, push GitHub, and wait for required
   CI.
3. Fast-forward `/opt/joy-media/repo` to the pushed commit.
4. Create and verify a fresh compressed PostgreSQL backup; sync it off-host when
   the established backup route is available.
5. Build immutable API and editor releases from that commit.
6. Verify release files and `nginx -t` before switching symlinks.
7. Atomically switch only `current-api` and `web`, restart the API, and retain
   the previous releases.
8. Verify origin health, public root, authenticated API behavior, index/static
   hashes, service restart count, and logs.

Rollback immediately if health, assets, authentication, migration, or signed-in
workspace loading fails.

### STEP-20 — Signed-in live rerun and cleanup

Doer actions under orchestrator supervision:

1. Run the primary golden path against `joyst.ir` with the named disposable
   project.
2. Run the necessary compact/minimum viewport checkpoints.
3. Verify browser export/FFprobe, Worker insertion, and playback evidence against
   the deployed commit.
4. Cancel temporary jobs, remove temporary assets/exports, revoke only the
   disposable Worker, and permanently delete only the exact disposable project.
5. Restore the previously current project/checkpoint.
6. Reconcile project, job, worker, private-object, and browser-local counts with
   the preflight baseline.

Gate:

- No temporary live object remains.
- No seeded/current project was changed unintentionally.
- Irreversible or provider operations are listed.
- Production remains healthy after cleanup.

### STEP-21 — Documentation, GBrain, and formal closeout

Doer actions:

1. Mark both WP-29 plans complete only if all prior gates passed.
2. Update `STATE.md`, the new audit report, WP-27 remediation, and this review
   log with final commits/releases/evidence.
3. Update GBrain pages `joy-media-state` and
   `joy-media-wp29-first-project-golden-path` through the safe single-writer
   procedure, verify them, and push the companion GBrain repository.
4. Record candidate/source commits, API/editor/rollback releases, database
   backup, public hashes, FFprobe results, performance thresholds, case totals,
   cleanup, and every `BLOCKED-*` result.
5. Push the docs-only closeout commit and fast-forward the VPS source checkout.

Final gate:

- Repository, deployed runtime, reports, STATE, and GBrain agree.
- All steps are `APPROVED`.
- The review log ends with `WP-29 FINISHED` and no open blocking defect.

## 10. Kickoff and continuation prompts

### 10.1 Initial prompt to the VPS Codex doer

```text
You are the WP-29 VPS doer. Work only in the isolated JOY Media closeout
worktree described by plan/WP-29-orchestrated-vps-closeout-loop.md.

Read completely:
- AGENTS.md
- ORCHESTRATION.md
- STATE.md WP-29 handoff
- plan/WP-29-closeout-remaining-acceptance.md
- plan/WP-29-orchestrated-vps-closeout-loop.md

Execute STEP-00 only. Do not start STEP-01. Preserve unrelated work and do not
change production. Implement, verify, commit, push the closeout branch, append
the review log, return the exact STEP-00 report contract, and stop.
```

### 10.2 Continue prompt after approval

```text
APPROVED STEP-XX.
Execute STEP-YY only from the approved result commit. Apply every requirement
and gate in the orchestration plan. Commit and push, append the review log,
return the exact STEP-YY report contract, and stop. Do not begin the following
step without another orchestrator approval.
```

### 10.3 Rework prompt

```text
REWORK STEP-XX.
The review failed for these exact reasons:
1. ...
2. ...

Remain on STEP-XX. Add a new repair commit; do not rewrite reviewed history.
Rerun the listed checks, update the same review-log entry, return the exact
STEP-XX report contract, and stop. Do not continue.
```

## 11. Completion checklist

- [x] STEP-00 preflight approved.
- [x] STEP-01 export reproduction/profile approved.
- [x] STEP-02 export repair approved.
- [x] STEP-03 browser FFprobe/audio proof approved.
- [x] STEP-04 export recovery approved.
- [x] STEP-05 Worker preflight approved.
- [x] STEP-06 real Worker review approved.
- [x] STEP-07 exactly-once insertion approved.
- [x] STEP-08 Worker recovery/revoke approved.
- [x] STEP-09 diagnostics semantics approved.
- [x] STEP-10 reference-host matrix approved.
- [x] STEP-11 file bridge cases approved.
- [x] STEP-12 pointer/gesture cases approved.
- [x] STEP-13 caption cases approved.
- [x] STEP-14 Worker/audio cases approved.
- [x] STEP-15 effects/color cases approved.
- [x] STEP-16 motion/camera/template cases approved.
- [x] STEP-17 destructive/recovery cases approved.
- [x] Every `JOY-QA-*` defect loop is closed or explicitly owner-blocked.
- [x] STEP-18 exact candidate gate approved.
- [x] STEP-19 immutable deployment approved.
- [x] STEP-20 signed-in live rerun and cleanup approved.
- [x] STEP-21 documentation/GBrain closeout approved.
- [x] Review log ends with `WP-29 FINISHED`.

## 12. Definition of finished

The loop ends only when:

- a browser-originated MP4 passes FFprobe, duration, audio, SHA, reload,
  re-download, cancel, interruption, and retry checks;
- a real Worker processes the selected asset and produces one verified result
  inserted exactly once after approval, with cancel/retry/reload/revoke proven;
- controlled playback meets the reference thresholds in all required passes;
- every one of the 37 cases has a final honest verdict and evidence;
- every blocking defect has been repaired and rerun;
- CI, build, tests, browser suites, and production audit are green;
- the immutable deployment and rollback evidence pass;
- disposable projects, workers, jobs, assets, exports, private objects, and
  browser-local state are removed;
- GitHub, VPS source, live releases, reports, STATE, and GBrain agree.

Until then the correct status is `IN PROGRESS`, never `FINISHED`.
