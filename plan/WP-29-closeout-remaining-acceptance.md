# WP-29 Closeout — Remaining Acceptance Gates

**Status:** Planned
**Parent:** [`WP-29-first-project-golden-path-reliability.md`](WP-29-first-project-golden-path-reliability.md)
**Baseline:** product release `e02f646`; documentation head `4d8d95a`
**Target:** close WP-29 without converting unavailable or unobserved behavior into PASS

## Outcome

Close the four remaining product/evidence gates and restore a green required CI
pipeline:

1. Attempt and evidence the 37 cases left NOT-RUN by the 2026-08-09 audit.
2. Deliver exactly-once Worker audio-result review and project insertion.
3. Prove a real browser MP4 download with independent FFprobe validation.
4. Replace cumulative playback counters with session/clip metrics and run the
   controlled reference-host performance matrix.
5. Remove the 81-file formatting baseline so `pnpm verify:ci` is green.

WP-29 closes only when every gate below has evidence. A genuinely unavailable
paid/external operation may be `BLOCKED-CONSENT` or `BLOCKED-INTEGRATION`, but it
must not be called PASS.

## Current verified baseline

- Repository worktree is clean at `4d8d95a`; production API/editor artifacts
  were built from `e02f646`.
- Typecheck, ESLint, build, production audit, 1,722 tests, and the three-viewport
  Playwright/Axe login smoke pass.
- Project media resolution, metadata-preserving placement, content-range export,
  authored audio mix, export cancel/retry, OPFS output cache, Worker derivative
  upload, Worker keepalive, and fail-closed ML capability advertisement exist.
- The signed-in live selector and Audio Studio smoke passed at `1639×1066`,
  `1366×768`, and `1024×768` with no browser warning/error logs.
- `pnpm verify:ci` fails only at `prettier --check .`. The frozen baseline is
  exactly 81 files: 52 TSX, 21 CSS, four Markdown, two HTML, and two MTS.
- The current Playwright suite proves only the login safety envelope. It does
  not yet provide a test identity or drive the signed-in golden path.

## Dependency order

```text
R0 CI hygiene ──┐
                ├── R1 authenticated browser harness ──┬── R2 Worker insertion ──┐
                │                                      ├── R3 FFprobe proof ─────┤
                │                                      └── R4 playback metrics ──┤
                └──────────────────────────────────────────────────────────────────┤
                                                                                   ▼
                                                                    R5 37-case rerun
                                                                                   ▼
                                                                    R6 deploy/close
```

At no point should production receive a test-token route, fixed cookie, auth
bypass, fixture-only result, or committed credential.

## R0 — Make required CI genuinely green

### R0.1 Freeze and normalize the formatting baseline

- Record `git status`, `HEAD`, `origin/main`, deployed releases, and the output
  of `pnpm exec prettier --list-different .` before mutation.
- Format only the exact frozen 81-file list in one mechanical commit. Do not mix
  product edits into it.
- Review the diff by file class:
  - 52 TSX files: whitespace/layout only; no changed string, prop, condition,
    import target, or event handler.
  - 21 CSS files: declaration/order values remain byte-equivalent apart from
    formatting; font URLs and `@font-face` descriptors are unchanged.
  - four Markdown, two HTML, and two MTS files: no wording, attribute, or code
    behavior changes.
- Run `git diff --check` and a semantic guard over JS/TS builds. If Prettier
  changes a generated/vendor file in a risky way, document and add the narrowest
  `.prettierignore` entry rather than accepting an opaque rewrite.

### R0.2 Required workflow split

- Keep `pnpm verify:ci` as the required unit/type/lint/format/build/audit gate.
- Add a separate required `browser-e2e` GitHub Actions job that:
  - depends on `verify:ci`;
  - installs the repository-pinned pnpm and Chromium dependencies;
  - runs the primary golden path, then the two compact viewport checkpoints;
  - uploads Playwright HTML, traces, video, screenshots, console/network logs,
    FFprobe JSON, and failed downloads only when useful.
- Keep the provisioned RNNoise test optional and explicit. A missing licensed
  model must produce a named skip, never fail the default suite.

### R0 gate

- `pnpm format:check`, `pnpm verify:ci`, and both required CI jobs exit zero on
  the exact commit.
- The formatting commit contains no product behavior changes.
- A subsequent product commit cannot hide behind the old formatting baseline.

## R1 — Authenticated, disposable browser test stack

### R1.1 Test-only control plane

- Add `tooling/e2e-server` that starts the real HTTP handlers with:
  - `LocalControlPlane` or the existing in-memory control-plane adapter;
  - an in-memory private-object store;
  - deterministic speech/reasoning provider responses;
  - a fixed test owner and short-lived test session created only by test-process
    dependency injection;
  - ephemeral ports and a temporary data root.
- Start Vite with `/api` proxied to that server. Production builds must not
  contain a test auth branch, route, token, or account.
- Produce Playwright `storageState` during global setup through the ordinary
  test server session contract. Never read or copy the user's production cookie.

### R1.2 Isolation and fixtures

- Give every spec a unique owner/project namespace and a clean browser context.
- Clear test localStorage, IndexedDB, OPFS, downloads, jobs, and private objects
  in teardown. Fail teardown if a temporary project, worker, job, or object
  remains.
- Use the committed fixture manifest for PNG, JPEG, MP4, WAV, MP3, SRT, WebVTT,
  invalid text, and corrupt MP4. Add a zero-byte fixture and Markdown/image Joy
  Code attachment if absent.
- Verify each file against its manifest before the test begins so a changed
  fixture cannot silently change expected results.

### R1.3 Shared browser assertions

- Create helpers that fail on unexpected `pageerror`, console error, failed
  same-origin request, unhandled dialog, page horizontal overflow, stuck busy
  state, or focus escaping an open modal.
- Capture case-scoped screenshots/traces only at named checkpoints and on
  failure. Redact assertion tokens, contacts, local paths, and private refs.
- Prefer accessible locators. Add `data-project-id`, `data-asset-id`,
  `data-track-id`, `data-clip-id`, and `data-job-id` only where geometry or
  duplicate labels make role/name targeting ambiguous.

### R1 gate

- A fresh test identity creates, opens, refreshes, trashes, restores, and purges
  one disposable project through the browser without a production auth bypass.
- The same stack uploads a manifest-verified MP4 and retrieves its authorized
  private bytes after reload.
- Teardown reports zero temporary objects.

## R2 — Real Worker result review and exactly-once insertion

### R2.1 Execution contract

- Enable the Local Worker route only when one connected, non-revoked Worker
  advertises `audio.ml-denoise` and the selected source asset is available to it
  or the user approved a private-byte transfer.
- Build a stable operation fingerprint from:
  `projectId + projectRevision + sourceAssetSha256 + workflowVersion + params`.
- Derive one stable job ID from the operation ID. A repeated click disables
  submission and reattaches to the matching job. The same ID with a different
  fingerprint returns a visible conflict.
- Persist `queued`, `running`, `canceling`, `failed`, `retryable`, `review`, and
  `applied` states in the project operation ledger.

### R2.2 Verified result path

- Worker processes the selected real asset and uploads the derivative through
  the existing lease-authorized derivative endpoint.
- API verifies job/worker/asset ownership, byte length, SHA-256, MIME, current
  lease, and terminal-attempt identity before exposing the derivative.
- Browser fetches the owner-authorized derivative bytes, recalculates SHA-256,
  validates byte length/MIME and audio decodability, then writes the verified
  result to the project's OPFS generated-media cache.
- No Worker-local path, private-object ref, bearer value, or provider secret
  enters the creative document, operation ledger, logs, or UI.

### R2.3 Review and insertion

- Show an A/B review surface with source/result labels, duration, format, and
  play controls. The project remains unchanged until the user chooses:
  - Replace selected clip audio;
  - Add processed result on a new audio track;
  - Discard result.
- Apply exactly one project transaction that creates the generated asset
  descriptor, clip/track update, provenance link, and undo entry.
- Mark the operation complete only after that transaction commits. Reloading or
  repeating Apply reattaches to the same receipt and does not create another
  asset, clip, or undo entry.
- Cancel/failure/discard leaves no partial creative mutation. Purge removes the
  operation record and project-owned cached result while respecting shared
  server-object references.

### R2.4 Tests

- Unit: operation fingerprint/conflict, state machine, SHA/MIME/length mismatch,
  decode failure, apply/discard, and exactly-once transaction.
- API: wrong owner/worker/job/attempt, stale lease, duplicate upload, missing
  source, cancel race, and reference-safe cleanup.
- Daemon: idle 60 seconds remains connected, cancel interrupts the subprocess,
  one terminal receipt is reported, and retry cannot complete the stale attempt.
- Browser: pair → idle → queue selected asset → progress → review → apply → undo
  → redo → refresh, plus cancel/retry/revoke.

### R2 gate

- One selected fixture produces one verified playable result and one project
  mutation after approval.
- Reload at every state reattaches without duplicates or stuck UI.
- A revoked Worker cannot lease or upload another result.

## R3 — Browser MP4 download and independent FFprobe proof

### R3.1 Golden-path export spec

- Extend `golden-path.spec.ts` to create a fresh project, upload the three-second
  H.264/AAC fixture, place it once, trim/move it, add captions, apply Browser DSP,
  and choose a deterministic export preset.
- Register the Playwright download listener before clicking Export. Save the
  completed browser download inside the test output directory.
- Record the project revision, operation ID, preset, range, expected duration,
  dimensions, frame rate, caption mode, audio state, browser/codec capabilities,
  filename, byte length, and SHA-256.

### R3.2 Independent validation

- Run the saved browser file through the existing `verifyExport`/FFprobe path in
  the Node test process and retain sanitized JSON.
- Require:
  - container opens and byte length is nonzero;
  - video codec H.264 and audio codec AAC;
  - selected width/height and 30 fps;
  - duration within one frame (`33,333 µs`) of the content range;
  - exactly one authored audio program path, unless intentionally muted;
  - no unexpected `/media/reference/media-*` request.
- Run FFmpeg `volumedetect` or an equivalent deterministic probe for the fixture:
  audible export is above the silence floor; authored mute is below it; a gain
  change produces the expected directional loudness change.

### R3.3 Recovery proof

- Refresh after completion, use Recent processes to re-download, and require the
  same SHA-256 as the first browser download.
- Reload once during encoding. The original operation becomes
  `interrupted-retryable`; one explicit retry uses the same logical ID and ends
  with one completed output.
- Cancel once during preload/recording and prove media tracks, timers, audio
  context, renderer, object URLs, and partial cache entries are released.

### R3 gate

- The browser-originated MP4 passes all FFprobe and audio assertions on the
  primary viewport; functional re-download/retry checkpoints pass at all three
  viewports.
- Evidence includes download SHA, sanitized FFprobe JSON, duration delta, audio
  measurement, and operation-history screenshot.

## R4 — Controlled playback diagnostics and performance runs

### R4.1 Correct the measurement model

- Introduce a `PlaybackDiagnosticsSession` keyed by play session and active clip
  ID. Reset on play, seek, clip switch, project switch, and explicit diagnostics
  reset.
- Consume `requestVideoFrameCallback` metadata:
  - `mediaTime` for presented source time;
  - `presentedFrames` deltas for presentation gaps;
  - `expectedDisplayTime` versus callback time for presentation lateness.
- Track separate counters/distributions for decode miss, presentation drop,
  media/audio drift, callback lateness, stall duration, intentional seek,
  transition warmup, and background-tab throttling.
- Associate observations with the active clip ID, not the media URL. Two clips
  sharing one asset must remain distinct.
- Remove the current claim that three cumulative drops mean `proxy` quality.
  Display `full`, `proxy`, or `missing` only from the source resolver that
  actually selected that source.
- Expose a sanitized diagnostics snapshot/export with no media URL, filesystem
  path, token, contact, or private object reference.

### R4.2 Deterministic and browser tests

- Unit-test counter resets, presented-frame deltas, p50/p95/max drift,
  background exclusion, stall detection, duplicate-asset identity, and actual
  source-quality labels using a fake clock/callback stream.
- CI smoke covers five seconds of fixture playback and asserts finite metrics,
  no fatal stall, no negative counters, and correct reset behavior. CI timing is
  observational and does not replace the reference-host gate.
- Named Chrome/GPU reference matrix:
  - normal contiguous playback;
  - duplicate-asset clips;
  - timeline gap;
  - `0.5×`, `2×`, and freeze;
  - repeated seek storm;
  - transition boundary;
  - background tab then recovery.

### R4.3 Reference-host protocol

- Run three ten-second passes per scenario at `1639×1066`; exclude the first
  second of warmup and periods intentionally backgrounded or seeking.
- Record Chrome version, OS, GPU, hardware-acceleration status, codec support,
  source tier/quality, project revision, clip IDs, and raw sanitized observations.
- Required normal-play thresholds:
  - presented-frame drop rate `≤2%`;
  - p95 A/V drift `≤50 ms`;
  - max A/V drift `≤100 ms`;
  - no unexplained stall over `500 ms`.
- Rate/freeze/seek/background scenarios use semantic assertions and must recover
  to normal thresholds within two seconds after the special condition ends.

### R4 gate

- All three normal passes meet thresholds. A failure is reproduced once and
  fixed or assigned a blocking defect; results are not averaged to hide a bad
  pass.
- Diagnostics UI and exported metrics agree for the same session.

## R5 — Close the 37 previously NOT-RUN cases

Run deterministic local automation first. Repeat the necessary end-to-end
subset in the signed-in live browser using a disposable project named
`WP-29 closeout <run-id>`. Cases are grouped into resumable batches:

| Batch                       |              Cases |  Count | Required route and evidence                                                                                                                        |
| --------------------------- | -----------------: | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — file bridge             |      15–18, 25, 93 |      6 | Playwright `setInputFiles`/file chooser and real DnD; PNG/JPEG/MP4/WAV/MP3/invalid/corrupt/Markdown; catalog/timeline/attachment state and cleanup |
| B — pointer/gesture         | 10, 32, 33, 37, 46 |      5 | Sign-out cancel path, clip move/trim, rate/freeze, fullscreen enter/exit; pointer coordinates plus state assertions, not screenshots alone         |
| C — captions                |              53–59 |      7 | Delete/revert, Clean/Karaoke/RTL, SRT/WebVTT import/export, real fixture EN/FA transcription, reload and independent file parsing                  |
| D — Worker/audio            |     63, 66, 67, 89 |      4 | Pair/idle status, Browser DSP, Local Worker result review/apply, cloud consent state, cancel/retry/revoke and exact job/result counts              |
| E — effects/color           |      71, 72, 74–77 |      6 | Apply/reorder/remove effect, recipe, favorite/replace transition, grade/reset, LUT/scopes, Inspector targeting, undo/reload                        |
| F — motion/camera/templates |              79–85 |      7 | Create/open/rename/duplicate/delete motion, preset, HTML scene, spatial path, camera, template; selected controller, confirmation, undo/reload     |
| G — destructive/recovery    |            24, 100 |      2 | Disposable cloud/AI/bulk-delete target with action-time consent; reload during queued/running operation; no duplicate or stuck state               |
| **Total**                   |                    | **37** |                                                                                                                                                    |

### R5 execution rules

- Before the first live mutation, record the project list, current project,
  History restore point, deployed commit/releases, viewport, browser version,
  health, and console/network baseline.
- Use the seeded project only for read-only or undoable advanced-object tests.
  Use the disposable project for uploads, Worker output, AI/cloud actions, jobs,
  exports, and deletion.
- Before upload, destructive cloud/AI, paid provider, sign-out, Worker revoke,
  permanent delete, download permission, or browser permission prompt, use the
  existing action-time confirmation rule. A declined action is
  `BLOCKED-CONSENT`, not FAIL.
- Each case receives separate Functional and UI/A11y verdicts, exact expected
  and actual behavior, reproduction steps, build/project/viewport/timestamp,
  evidence path, relevant console/network entry, reproduction count, and defect
  link.
- Reproduce each apparent failure once from refresh/restore. Inconsistent results
  are FLAKY with a pass/fail ratio.
- Consolidate duplicates under `JOY-QA-*`. Any P0/P1 or golden-path P2 blocks
  WP-29 closeout.
- Save results after every batch in
  `docs/qa/gpt-chrome-usage-audit-<run-id>.md`; do not rewrite the historical
  20260809 report.

### R5 cleanup gate

- Cancel temporary jobs, revoke only the disposable Worker, remove temporary
  assets/exports, and permanently delete only the exact named disposable
  project after target review.
- Restore seeded/current projects to their preflight checkpoints.
- List any irreversible job/provider/download and prove no temporary server
  project, worker, job, private object, or browser-local project remains.

## R6 — Candidate verification, deployment, and closeout

### Candidate gate

Run on the exact clean commit:

```text
pnpm verify:ci
pnpm test:e2e
pnpm test:e2e:audit
pnpm audit:prod
```

Also run focused API/Worker result tests, FFprobe export verification, OPFS
reopen tests, and the named-host playback protocol. Record totals and skips.

### Deployment

- Push `origin/main` and the VPS source ref before building.
- Create a fresh database backup and sync it off-host.
- Build immutable API/editor artifacts from the pushed candidate commit.
- Retain `e02f646-wp29-reliability-api` and
  `editor-web-20260810-035553-e02f646-wp29-reliability` as rollback targets
  until the closeout gate passes.
- Run write-free preflight, switch only affected release symlinks/services, then
  verify Nginx, origin/public health, index/static asset hashes, API restart
  count, and signed-in browser load.

### Closeout record

- Mark the parent WP-29 plan complete only when R0–R5 gates pass and cleanup is
  proven.
- Update `STATE.md`, the new 100-case results report, the historical WP-27
  remediation section, and GBrain pages `joy-media-state` and
  `joy-media-wp29-first-project-golden-path`.
- Record source commit, API/editor releases, rollback releases, health/hash
  evidence, browser/FFprobe/performance evidence, temporary-object cleanup, and
  every remaining `BLOCKED-*` outcome.

## Recommended session breakdown

1. **Session 1 — R0 + R1:** formatting-only commit, green `verify:ci`,
   authenticated local stack, project/upload/reload smoke.
2. **Session 2 — R2:** Worker result review/insertion, exactly-once recovery,
   unit/API/daemon/browser tests.
3. **Session 3 — R3 + R4 implementation:** browser download/FFprobe proof and
   corrected playback diagnostics.
4. **Session 4 — R4 reference runs + R5 batches A–D:** performance evidence,
   file/pointer/caption/Worker cases.
5. **Session 5 — R5 batches E–G + R6:** advanced UI/destructive/reload cases,
   cleanup, candidate verification, immutable deployment, GBrain closeout.

If a session ends early, stop only at a completed batch/gate with its report
written and all temporary live state either retained under the named disposable
project or cleaned up explicitly.

## Definition of done

- `pnpm verify:ci`, required browser jobs, and production audit are green.
- All 37 previous NOT-RUN cases have honest new verdicts and evidence.
- One real Worker operation creates one verified result and exactly one approved
  project insertion; cancel/retry/reload/revoke are proven.
- The browser-originated MP4 independently passes FFprobe, duration, audio, SHA,
  reload re-download, interruption, and retry checks.
- Playback metrics are per-session/per-clip and the named host passes all three
  controlled normal-play runs plus recovery scenarios.
- The live disposable project/worker/jobs/assets/private objects are removed,
  the original project is restored, and irreversible operations are listed.
- Source, deployment, rollback, QA report, STATE, and GBrain all agree on the
  final commit and release state.
