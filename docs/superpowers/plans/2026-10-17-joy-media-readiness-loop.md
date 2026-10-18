# JOY Media readiness test and fixture loop implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for orchestration.
> Use the owner-approved local Kilo CLI for bounded implementation only when
> its isolation and billing gates are verified; otherwise implement in the
> isolated worktree. Track the checkboxes below. The orchestrator verifies
> actual diffs and results independently before accepting each work package.

**Goal:** Close the evidence and behavior gaps that prevent the Windows app and
agent-facing CLI from being dependable for their documented supported workflows.

**Architecture:** Keep the existing Vitest, CLI subprocess harness, generated
media fixtures, Playwright journeys, desktop package scripts, and two-pass release
gate. Connect them with one scenario inventory and evidence contract; add failing
scenarios at real process, storage, media, and installed-application boundaries.

**Tech stack:** TypeScript, Node >=22, pnpm 11.15.0, Vitest 3, Playwright,
Electron, SQLite, FFmpeg/FFprobe, existing self-hosted Windows/Linux runners.

**Spec:** [Repository audit and readiness definition](../../qa/evidence/2026-10-17-readiness-audit.md).

**Status (continued 2026-10-18):** Tasks 1 and 2 are complete and committed as `930d73cb`
and `6eacd9b5`. Tasks 3–7 have extensive local Windows evidence for playable CLI
output, recovery, fresh-profile project operations, packaged editor workflow, and
staging package/launcher checks, but remain open where their full scope is not yet
accepted. This worktree passed `pnpm verify:ci`, `pnpm test:harness` (31 passed, 11
expected platform skips), and the full source Playwright audit (826 passed, 7 known
skips, 0 retries) across seven viewports. The two viewport-sensitive Director tests
also passed three repeats each at 1920px. The local Worker status detects an RTX 5070
Ti but reports 0/4 model environments ready and no model directory, so real-GPU
qualification remains open. Task 8 is partially exercised but open; Task 9 remains
open for a frozen-candidate two-pass run, independent reviews, owner release decision,
and required closeout receipt. This plan is not an app-ready or release certificate.
The October 18 continuation also added a test-first Windows reserved-device
output-path guard and verified both staged CLI launchers with decoded media.

**Status (runner continuation 2026-10-18):** Candidate `55ba6516725b6a43c4899bde0758ad3d4dcce295`
passed hosted validation, the hosted editor bundle, shipped-bundle smoke, both
Linux real-service passes, and both P3 passes on run
[`39113930140`](https://github.com/hadimoti/joy-media/actions/runs/39113930140).
The Windows Docker runner built the frozen installer, CLI, and Worker, and pass 1
completed, but pass 2 failed in installed candidate editor restart/save/export
acceptance. The lifecycle wrapper had discarded the Playwright stdout while keeping
only its final 16 combined stdout/stderr lines, so the underlying assertion was not
retained. A test-first fix now preserves bounded stdout and stderr separately; a
fresh exact-candidate run is required to learn and close the remaining Windows
failure. Local `pnpm verify:ci` passes 631 files / 5,609 tests with 28 skips,
workspace build and production audit; `pnpm test:harness` passes 36 with 11
expected host-specific skips. Real-GPU qualification, the full two-pass release
gate, external review, release authorization, and the final Gbrain receipt remain
open. This plan is not an app-ready or release certificate.

**Rulings (updated 2026-10-18):** The owner directs us to use standard
GitHub-hosted runners for lanes their resources and prerequisites support, and
fall back to the existing self-hosted runners when a hosted runner is unavailable
or insufficient. The public repository's standard runner is free, the artifact
inventory was empty, and the one-file quota probe passed as run `39084850937`.
The current workflow uses `ubuntu-24.04` for candidate validation, editor bundle,
and responsive-only browser acceptance. Media-export desktop-primary acceptance
and shipped-bundle UI smoke use the isolated self-hosted Linux acceptance runner
after exact hosted-runner export timeouts. The workflow retains self-hosted
runners for isolated real-service/P3 evidence, the Windows Docker installer
lifecycle, and the evidence gate summary. Fixture-only browser jobs explicitly
clear runner-local database, object-storage, Worker, evidence, and OpenCLI
settings. Transfer the renderer
bundle with a one-day artifact bound to run/attempt/candidate and verify its full
file manifest on the Windows Docker runner. This keeps the memory-heavy Vite
build off the 1 GiB-visible Hyper-V container while preserving the container-local
Windows acceptance boundary. The workflow fails closed if runner or transfer
availability is misjudged. Kilo was not invoked:
its local CLI exposes no hard filesystem sandbox, so the owner-required worker
isolation gate remains unverified. The cost if this ruling is wrong is one fresh
runner/artifact dependency and no independent worker diff; external review and
candidate approval remain required.
Exact-candidate run `39085505980` confirmed the hosted renderer upload and Windows
manifest verification, production-bundle public UI smoke, and both Linux/P3 real-
service passes. The Windows package lane then failed because `package:installer`
could not resolve `@joy-media/joy-agent-engine` and `@joy-media/motion-core` from
the clean checkout: their workspace outputs had not been built. The workflow now
builds the CLI dependency closure sequentially before packaging to fit the Windows
container. Local `package:installer` produced the v1.0.2 archive (188.96 MB), but
the new exact-candidate two-pass run is still required; no installed-Windows
lifecycle evidence was produced by run `39085505980`.
Exact-candidate run `39086664395` then passed the sequential CLI dependency build,
Windows package integrity, hosted renderer transfer, public-bundle UI smoke, and
both Linux/P3 service passes. Its Windows lifecycle step failed before installation:
in the clean Windows PowerShell 5.1 checkout, `git status --porcelain` emits no
objects, so calling `.Trim()` on its captured `$null` raised the null-valued-method
error. I reproduced that behavior inside the same Docker runner (Windows
10.0.20348.5622). The harness now captures porcelain output as an array, checks
Git's exit code, and rejects a non-empty array; the package checker tests both
empty and dirty states. That regression test failed against the old harness before
the guard was added, then passed. The same pass also adds line diagnostics and
guards for unset User PATH/profile values and the PowerShell 5.1-incompatible
`String.Contains` overload. The updated package checker passes.

Exact-candidate run `39088536140` passed the hosted editor bundle, primary and
responsive browser lanes, shipped-bundle public smoke, and both Linux/P3 service
passes. Windows packaging and the Worker self-test passed, but lifecycle stopped
before installation because pinned v1.0.1 `SHA256SUMS` lists only the setup EXE and
portable ZIP, not the desktop EXE or CLI bundle inside that ZIP. The archive hash
was verified against the pinned sidecar; the lifecycle helper now derives the two
installed-file hashes from the verified archive entry when a direct sidecar entry
is absent, while retaining strict duplicate/malformed/direct-entry checks. Its
PowerShell regression test failed before implementation and passes afterward. This
worktree's exact candidate still needs a fresh two-pass run.

The October 18 local verification on the revised worktree passed `pnpm verify:ci`,
`pnpm test:harness` (30 passed, 11 expected host-specific skips), and
`pnpm run test:e2e:audit --retries=0` (826 passed, 7 known skips across all seven
viewports). The seven skips include the documented Local Worker audio scenario;
they are not reported as accepted live-audio evidence. The Windows lifecycle,
real-GPU model output, 30-minute soak, and exact-candidate CI evidence remain open.
`joy-media worker status --json` detects the RTX 5070 Ti but confirms
all four local model environments are absent and `JOY\\models` does not exist.

The first new exact-candidate run `39093151282` is pinned to
`4994ba108417f86c654a7df25325b4843196abab` and completed with failure. Hosted
candidate validation and the editor-web artifact build passed; the hosted
shipped-bundle smoke lane failed at `pnpm install` because it did not enable
Corepack on the fresh GitHub runner. Both passes of the Linux and P3 real-service
lanes passed. The Windows Docker job built the frozen candidate but its lifecycle
step failed before installation: the pinned v1.0.1 ZIP stores files under
`joy-media-win32-x64/`, while the lifecycle looked for root-level entries. Later
browser acceptance and the real-service soak were skipped by the failed Windows
gate. Commit `a5a2b5e6` adds the missing pinned pnpm bootstrap and a runner-policy
regression test; commit `19f47d96` adds a 200-command timeline edit/readback
scenario. The new policy test passes 25/25, the full timeline CLI suite passes
66/66 (160.52 s), and the sustained case passes with 200 edits in 59.89 s. Run
`39093151282` cannot certify `a5a2b5e6` or later commits.

Exact-candidate run `39094711674` at `56126fbf2794ad7455f2aa0d80066b9af6e09b24`
passed candidate validation, editor-bundle transfer, both Linux/P3 service
passes, and Windows package creation. Hosted production-bundle UI checks passed
three cases but timed out twice waiting for media-export downloads (120 s and
240 s); the same production bundle passed those journeys in a local reproduction.
The Windows lifecycle cleanup then failed because Windows PowerShell 5.1 parsed
`-and` as a `Test-Path` parameter, masking the underlying lifecycle exception.
The cleanup expression now groups each `Test-Path` call and has a regression test.
The runner-policy test now requires primary and shipped-bundle media-export jobs
on `joy-media-acceptance`, with fixture-only runner settings, and keeps the
responsive-only six-viewport layout job on hosted Ubuntu. A new exact-SHA run is
still required to see the original Windows lifecycle error and verify the routed
production-export smoke on the capable runner.

Local verification after these fixes passed: the runner-policy suite (24/24),
Windows lifecycle harness (32 passed, 11 expected host-specific skips), and
real CLI video suite (12 passed, 2 expected skips). The integrated retry passed
the full test matrix (630 files, 5,591 passed, 28 skipped), built the workspace,
and completed the production audit with no known vulnerabilities. The first
integrated attempt's only failure was the Windows provider-ACL test hitting its
30-second timeout under suite load; it passed alone in 1.9 seconds and passed
the integrated retry in 16.4 seconds.

The ZIP-layout failure now has a test-first fix: a regression test failed while
the lifecycle requested root-level files, the fixture was changed to reproduce
the actual `joy-media-win32-x64/` layout, and the script now hashes the correct
desktop and CLI entries. The same local harness passes 31 tests with 11 expected
host-specific skips. A fresh `pnpm verify:ci` passes typecheck, lint, formatting,
the full Vitest suite, production build, and production audit after also correcting
a lint rule in the hosted-runner policy test. These are worktree results; a new
exact-SHA two-pass release workflow is still required.

On the modified worktree at HEAD `325cc4d7277d3008bd79c18749ddcff9c9a53051`,
`pnpm verify:ci` passed (typecheck, lint, formatting, full Vitest suite, build, and
production audit); `pnpm test:harness` passed 29 with 11 expected host-specific
skips. `pnpm exec vitest run apps/cli/src/humanized/render-real.e2e.test.ts
--no-file-parallelism` passed 12 with 2 skips, including decoded playable H.264/AAC
from the source and single-file bundle entry points. These are working-tree results,
not exact-candidate or installed-artifact evidence. A new exact-SHA two-pass run is
still required to prove the revised Windows lifecycle harness and frozen artifacts.
The implementation began from remote baseline SHA
`c1fffd59d5078902e031e7684e69c27df40ce607`. The earlier October 14 plan was removed
upstream and its statement that CLI rendering produces no media is superseded.

**Owner-confirmed requirement (2026-10-17):** `joy-media render` must produce
playable video for the CLI to count as ready. A render-plan manifest alone does
not satisfy closeout. Required acceptance checks the actual output file through
FFprobe and decoding, including picture, audio where expected, and timing.

**Owner model instruction (2026-10-17):** Never use GPT-6 Astra. The
candidate-specific model review gate, if required for release, must use
GPT-6.1-sol. This supersedes the Astra references in the originating audit and
does not waive the independent Claude Code review or the owner's release decision.

## Global constraints

- Preserve the current branch, existing untracked `nul`, other worktrees, and user profiles.
- Use isolated work based on the fetched candidate; do not reset this checkout.
- Follow the existing PR #7 handoff: branch integration remains on
  `hadimoti/wonderful-ritchie-vfpgv7`; workers return patches, never push or merge.
- Before any worker, read `C:\Users\HadiMoti\Desktop\agents-handoff.md` and
  verify billing, effective isolation, and sanitized configuration. For this task,
  the owner approved `C:\Users\HadiMoti\Desktop\KILO-BYTEPLUS-RUNBOOK.md` as its
  replacement because the handoff file is absent. Implementation route:
  `kilo/byteplus-coding/deepseek-v4-flash`; existing quota only. No retired
  routes, new purchases, paid fallback, production credentials, or Gbrain writes.
- Preserve external Claude Code independent review; if unavailable, record that
  gate as pending. Do not silently replace it or launch Claude-model workers.
- Prefer standard GitHub-hosted `ubuntu-24.04` for portable source, browser, and
  shipped-bundle lanes after the transfer probe passes. Retain self-hosted runners
  where isolated services, persistent evidence, or Windows Docker lifecycle
  prerequisites need them. Do not use paid larger runners.
- No real provider calls in deterministic tests. Separate fake-provider contract
  tests from explicitly scoped real-provider or real-GPU acceptance.
- A plan, mock response, worker self-test, or successful CI summary cannot stand
  in for decoded media or installed-app acceptance.
- Reuse `release-candidate-v2.yml` and its exact-candidate two-pass gate. Recheck
  its contract before dispatch; do not relax missing-evidence/freshness checks.
- GPT-6.1-sol's candidate-specific `APPROVE_FOR_DEPLOY` and the owner's
  release authorization remain required. This plan authorizes no publication.

## Review focus

1. CLI renders unsupported editor features without matching their meaning:
   Task 3 must either prove the result or reject it explicitly.
2. Audio is present as a stream but muted, wrong, clipped, or shifted:
   Tasks 2–4 must inspect decoded samples and timing.
3. An interrupted or concurrent operation loses projects, media references, or
   the last successful output: Tasks 3 and 5 must inject these failures.
4. Linux passes while the Windows shipped entry, DPAPI, paths, or cleanup fail:
   Tasks 6–7 must run on Windows and the final artifact.
5. A skipped/retried test, stale receipt, or source build is reported as proof of
   the installer: Tasks 1 and 9 must reject incomplete/mismatched evidence.

## The loop used for every work package

1. **Choose one scenario:** record risk ID, fixture IDs, expected state/media,
   entry/platform, and current candidate SHA in the ledger.
2. **Reproduce:** run against that candidate in a disposable profile. A failure
   must be an observable assertion, not a missing dependency or broken harness.
3. **Fix in bounded work:** give Kilo exact allowed files, one behavior, test
   commands, and output restrictions. Require a real session ID and actual diff.
4. **Prove the regression:** retain test-red-on-parent, fix-green evidence.
   New scenarios that already pass expand coverage without a gratuitous fix.
   Negative controls run only in disposable work; never revert shared changes.
5. **Review and verify:** external independent review, then Codex runs the
   targeted suite plus relevant neighboring boundary tests independently.
6. **Integrate:** stage only the accepted scope, commit test and fix together,
   and update the ledger. A changed candidate invalidates affected prior evidence.
7. **Close or repeat:** close only with artifacts and reviewer receipt. A repeated
   flake gets an owner, reproduction, and fix; required P0/P1 cases cannot be
   waived by quarantine, retries, or a review-round limit.

Do not run the entire monorepo after every small patch. Run it at integration
milestones; run the existing full exact-candidate gate for release acceptance.

## Task 1: Freeze the baseline and make readiness measurable

**Files:** Create `docs/qa/READINESS-MATRIX.md`,
`tooling/release/src/readiness-evidence.ts`, and its `.test.ts` sibling.
Modify `docs/product/FEATURE-STATUS.md`, `STATE.md`, and
`tooling/release/src/gate.ts` with its existing tests.

**Interfaces:** A scenario record has `id`, `surface`, `priority`, `supported`,
`fixtureIds`, `platform`, `entry`, `testCommand`, `status`, and `evidencePath`.
A `ReadinessEvidence` record has `schemaVersion: 1`, `candidateSha`,
`lockfileSha256`, artifact SHA-256 where applicable, toolchain versions,
fixture-manifest hash, start/end UTC, commands/exit codes, pass/fail/skip/retry
counts, scenario results, and redacted artifact paths/hashes.
`validateReadinessEvidence(evidence, expectedCandidateSha): string[]` returns
blocking reasons; it supplements existing gate validation rather than replacing it.

- [x] Inventory CLI help/commands, app menus/panels, worker operations, account
      flows, persistence and installer surfaces. Map every documented supported
      operation to a scenario or explicit open gap; mark unavailable features honestly.
- [x] Add `rejectsDifferentCandidate`, `rejectsMissingRequiredScenario`,
      `rejectsRequiredSkip`, `rejectsRetryOnlySuccess`, and
      `rejectsInstallerHashMismatch` tests. Each must return a nonempty blocker list
      for its named invalid evidence; a complete matching record returns `[]`.
- [x] Run the new tests red, implement validation and gate wiring, then run:
      `pnpm exec vitest run tooling/release/src` and `pnpm test:harness`.
- [x] In the isolated candidate checkout, record fresh `pnpm verify:ci`,
      `pnpm test:harness`, tool versions, and `pnpm exec playwright test --list`.
      Classify every skip by requirement; fail setup when required tools are absent.
- [x] Refresh stale status documents using linked evidence; do not change audit
      dates merely to make a gate pass.
- [x] Commit baseline/ledger/gate changes together after final review.

**Exit:** One candidate identity, an exhaustive supported-surface ledger, and a
validator that cannot call skipped or mismatched evidence ready.

## Task 2: Establish reusable fixtures with independent expected results

**Files:** Extend `tooling/generate-media-fixtures.mjs`,
`packages/test-fixtures/media/manifest.json`, and
`packages/test-fixtures/src/media-manifest.test.ts`.
Create `packages/test-fixtures/src/readiness/{projects,tolerances}.ts` and tests.
Reuse existing `reference-project.ts` and animation builders after locating them
in the fixture package; preserve the existing 16-input manifest contract.

**Interfaces:** Export named project builders from `projects.ts` and
`READINESS_TOLERANCES` from `tolerances.ts`. Manifest additions identify purpose,
generator/tool version, byte hash/size, provenance/license, expected decoded
duration/frame/stream/sample properties, and consumers. Keep existing fields and
update its explicit file-list test intentionally.

- [x] Add fixtures: red/blue hard-cut plus known tones; flash/click sync marker;
      silent and audio-only sources; stereo channels with distinct frequencies;
      44.1/48 kHz audio; VFR and 30000/1001 video; rotation metadata; alpha image;
      odd dimensions encoded losslessly with a format that supports them; truncated,
      empty, and mislabeled files; Persian/emoji/path-with-spaces variants.
- [x] Add project builders: basic A/V delivery, gaps/parallel tracks,
      kitchen-sink of supported editor domains, Persian/RTL, each supported historical
      schema, missing/relinked assets, and generated 10,000-clip scale case.
- [x] Test the generator output with independent FFprobe/decode expectations.
      A hash-only test against a manifest rewritten by the same generator is
      insufficient. Force an incorrect duration/tone in disposable test output and
      demonstrate failure of the semantic check.
- [x] Initial proposed bounds: duration within one output frame; flash/click
      onset within one output frame after decoder timestamp/encoder-delay handling;
      normalized PCM RMS absolute error <=0.02; no NaN/Inf; solid-color center samples
      use the existing red/blue/green predicates. Keep existing visual goldens'
      tolerances; calibrate new complex-scene comparisons before accepting them.
- [x] Pin/record FFmpeg builds for strict byte goldens. Across platforms compare
      decoded semantics using declared tolerances; do not claim byte identity across
      encoders. Never auto-bless changed expected output.
- [x] Generate in disposable storage first; after review update intended fixture
      files. Run `pnpm exec vitest run packages/test-fixtures/src`, review provenance
      and exact diff, then commit. No copyrighted/customer source media.

**Exit:** Reproducible inputs with independently checked expected outputs shared
by CLI, browser, desktop, and release tests.

## Task 3: Close CLI media delivery and parity risks first

**Files:** Extend `apps/cli/src/humanized/render-real.e2e.test.ts` and
`render-benchmark.e2e.test.ts`; create `render-parity.e2e.test.ts` and
`render-recovery.e2e.test.ts` beside them. Modify
`apps/cli/src/commands/{render-cmd,render-media}.ts` only where tests demonstrate
gaps. Reuse the current subprocess harness and real FFmpeg.

**Interfaces:** Retain the current NDJSON contract: real delivery has
`mediaProduced: true` and a playable `mediaPath`; explicit plan output has
`mediaProduced: false`. Evolve any error/event schema deliberately in Task 7.
Recommended behavior decision: default real-render requests reject unsupported
features with a machine-readable `unsupported-feature` error and no replacement
output. Keep explicit `--manifest-only` for planning. If partial export is wanted,
it needs an explicit opt-in, enumerated omissions, and a visibly partial outcome.

- [x] Add `metadataMatchesDecodedTimeline`: gap/overlap/parallel-track projects
      assert duration equals timeline end, fps and frame count agree with decoded
      media, and completion/manifest totals describe the actual result. Existing
      `render-parity.e2e.test.ts` covers decoded frame count, fps, duration, and
      matching manifest/completion totals for gaps and parallel tracks.
- [x] Prove the declared audio subset with distinct stereo tones, audio-only
      placement, and no-audio silence. Gain, pan, mute, solo, fades, bus gain, and
      audio effects fail closed until their CLI semantics are implemented.
- [x] Add feature cases for transforms/crop/alpha, captions/Persian text, effects,
      transitions, speed/reverse, and nested scenes. For every supported operation,
      compare CLI output with the desktop reference. Otherwise assert explicit
      unsupported behavior and document the limitation; no silent success/omission.
- [x] Add `failedRenderPreservesLastGoodOutput` and
      `manifestFailureCannotReportComplete` cases for FFmpeg failure, blocked
      manifest output, cancellation, and recovery between media and sidecar
      promotion. They verify the previous pair, cleanup, error outcome, and no false
      success event.
- [x] Inject a POSIX permission-denied failure while writing the staged manifest;
      prove the prior media/manifest pair remains byte-identical, the CLI reports
      an output error, and a later render recovers the stale partial and lock.
- [x] Inject ENOSPC at the staged-media `write(2)` boundary and prove the last good
      deliverable remains intact; the Linux-only interposer returns the real
      `ENOSPC` errno and marks the injection so a size-limit simulation cannot
      satisfy this check.
- [x] Add `concurrentSameOutputDoesNotCrossPublish`: two renders either serialize,
      reject contention, or publish separate outputs with matching metadata; they
      must never pair one render's media with another's manifest.
- [x] Reproduce the SIGTERM exit-code and manifest-cancellation regressions red,
      fix them, and prove the focused signal/fixture tests green (5 passed). Run the
      CLI parity/recovery and neighboring persistence/fixture matrix on Linux and
      Windows. Latest Ubuntu: 30 files, 508 passed, 9 skipped; full Windows
      `verify:ci` passed.
- [x] Repeat representative real rendering through the source `bin`, bundle, and current staged installed `joy.cmd` and `joy-media.cmd`; FFprobe and full decode pass. Hash-bound local staging evidence is recorded in `docs/qa/evidence/2026-10-18-windows-staged-cli-acceptance.md`.
- [ ] Repeat against frozen exact-candidate artifacts and bind their hashes
      to the two-pass release receipt.
- [x] Update the local readiness ledger and commit accepted CLI fixes with tests.
- [ ] Obtain the required independent reviews. Candidate-specific release approval
      remains Task 9.

**Exit:** The CLI delivers correct media for its declared supported scope and
cannot misreport unsupported, failed, interrupted, or partial delivery as complete.

## Task 4: Prove desktop editing, preview, save/reopen, and export together

**Files:** Extend `tests/e2e/{final-encoded-export-decoder,timeline-editing-features,wp29-export-recovery,wp32-real-project-journey}.spec.ts`;
create `tests/desktop/editor-acceptance.spec.ts` and a separate
`playwright.desktop.config.ts`. Modify the affected editor/export source only
after a failing real workflow identifies a defect.

**Interfaces:** Desktop config launches the packaged application with a disposable
profile and fixture media. It must not reuse a browser-only editor server as
proof of Electron acceptance. Browser helpers remain reusable where applicable.

- [x] Drive: create project -> import A/V -> split/trim/move -> title/caption ->
      effect/keyframe/transition -> undo/redo -> save -> restart -> read back -> export
      -> decode final media. The retry-free packaged Electron journey now covers
      each listed edit and reopened value before probing and decoding its MP4.
- [x] In the packaged Electron journey, assert Local preview status, Monitor
      repaint at 0/0.5/1.5 seconds, transport progression, decoded audio onset,
      persisted clip/effect/keyframe/transition/audio/caption values after restart,
      screenshots and axe scans at 1024x768, 1366x768, and 1920x1080, and
      accessibility at 150% display scaling. A separate simple-project journey
      compares sampled Monitor frames with decoded export frames.
- [x] Add packaged title and clip-move edits, mixed-bidi authored title/caption
      entry, and a keyboard-only edit route through title creation, text replacement,
      and RTL direction selection. Existing packaged keyboard checks also cover menu
      navigation, seeking, and trim/undo/redo.
- [x] Compare decoded desktop export against fixture expectations and sampled
      preview frames. The packaged suite checks all five presets' encoded dimensions,
      H.264/AAC streams and full video decode; distinct left/right test tones; HTML
      scene output against Monitor samples; and cancel/retry through a completed MP4.
- [x] Run `pnpm run test:e2e:audit --retries=0` and the packaged Electron journey
      with retries disabled. The October 18 full audit passed 826 tests, skipped 7
      optional cases, and failed none across seven viewport projects. The latest
      packaged journey also covers a duplicate, effect, keyframe, transition, audio,
      Persian caption, SQLite persistence across restart, and playable export.
- [x] Add/verify axe scans and keyboard reachability across supported packaged panels;
      packaged Electron scans cover Timeline, Captions, Audio, Effects, Motion,
      Color, Inspector, Joy Code, imported Assets, the View menu, Workflows and its
      System tab, Plugins, Transitions, the selected-transition inspector, and
      Persian caption Style. Keyboard checks cover menu/trim paths and visible
      transition favorites when focused.
- [x] Record/fix failures through the loop, review, and commit. The packaged
      acceptance run exposed heading hierarchy and transition-card interaction/focus
      defects; the retry-free packaged Electron suite passed all 5 tests after fixes.
      Any browser-only proof stays labeled browser-only until the packaged-app
      equivalent passes.

**Exit:** An installed creator can edit, restart, scrub/play locally, and deliver
an inspected file with the intended picture, timing, and sound.

## Task 5: Close persistence, media portability, and interruption safety

**Files:** Extend `packages/project-persistence/src/{persistence,sqlite-store}.test.ts`,
`apps/cli/src/humanized/{project-robustness,project-lifecycle}.e2e.test.ts`, and
editor project-package tests. Create `apps/cli/src/humanized/asset-recovery.e2e.test.ts`.
Potential fix owners: `apps/cli/src/utils/{asset-sources,project-loader}.ts`,
`apps/cli/src/commands/timeline-cmd.ts`, and persistence adapters.

**Interfaces:** Use existing JSON/project-package and SQLite store contracts.
Fresh-process reads are the oracle; a worker's in-memory object is insufficient.

- [x] Add `parallelRegistrationsRetainBothAssets`: concurrent CLI processes add
      distinct files; restart and render each project; neither source-map entry
      may disappear. The existing six-process test verifies all registrations and
      renders each exported project after the operations finish.
- [x] Add `exportImportRelinkRendersOnFreshProfile`: export, move originals,
      import in a clean profile, relink explicitly, and inspect the resulting media.
      No dependence on the original profile's path registry is allowed.
- [x] For every supported historical schema, load/migrate/save/reopen with
      semantic timeline preservation and idempotent migration. Newer schemas are
      rejected without rewriting; malformed/dangling/cyclic inputs fail without
      data loss. Import-side future-schema rejection is covered by the October 17
      follow-up test.
- [x] Kill disposable writers at database commit and file-rename boundaries;
      readback stays at the old complete revision/file, SQLite rolls back, and a
      retry removes the orphaned atomic-write temp before succeeding.
- [x] Inject SQLite `SQLITE_FULL` at commit and prove rollback, a stable
      `DATABASE_FULL` response, and successful retry; existing tests also cover
      read-only SQLite and stale-lock recovery.
- [x] Hold a project database lock from another process and verify bounded
      `DATABASE_BUSY` behavior, unchanged revision, and successful monotonic retry.
      Physical full-volume and held-file publication failures remain untested.
- [x] Persist packaged editor project documents through the desktop's allow-listed
      SQLite bridge; retain legacy localStorage reads and migrate on write. A fresh
      Electron process restores edits, effects, keyframes, transitions, audio and
      captions from the app profile. Authentication and UI preferences remain browser-only.
- [x] Run `pnpm exec vitest run packages/project-persistence/src apps/cli/src/humanized/project-robustness.e2e.test.ts apps/cli/src/humanized/asset-recovery.e2e.test.ts --no-file-parallelism`
      plus affected editor package tests. The expanded Windows selection passed
      117/117, including `project-lifecycle.e2e.test.ts` at 62/62 and the editor
      project-package suite at 7/7. After the separate-process lock case was added,
      the complete `project-robustness.e2e.test.ts` passed 31/31. The crash-boundary
      cases passed again after the preload was converted to ESM. Workspace typecheck,
      lint, and formatting checks passed.

**Exit:** The app and CLI preserve projects and can recover/relink media after
concurrent edits, interrupted writes, and transfer to another profile.

## Task 6: Make the shipped Windows artifacts the acceptance boundary

**Files:** Extend `tests/desktop/installer-package-check.mjs`,
`apps/desktop/scripts/{smoke-packaged,smoke-standalone}.mjs`; create
`tests/desktop/windows-lifecycle.ps1` and
`tests/desktop/installed-cli-acceptance.mjs`. Change packaging only for proven bugs.

**Interfaces:** Lifecycle harness accepts explicit `InstallerPath`, `ExpectedSha256`,
`PreviousInstallerPath`, and `EvidenceDir`; refuses the developer's active install
or profile. Use a disposable Windows VM/user. Installed CLI harness accepts its
explicit `joy.cmd` path and sanitized disposable state directory.

- [ ] Before implementation, inspect actual installer options and lock supported
      install/uninstall/data-retention behavior into tests; do not invent flags.
- [ ] Test clean install -> first launch offline -> Task 4 workflow -> restart ->
      installed CLI JSON project/edit/render -> upgrade from v1.0.1 with project,
      settings, library, and DPAPI-wrapped synthetic key -> uninstall. Verify registry,
      shortcuts, actual version, expected retained data, and no orphan worker/FFmpeg.
- [ ] Exercise paths with spaces/Persian, non-admin install, locked output, and
      PowerShell 5.1/7 hosts. Verify executable precedence: `joy.cmd` invokes the CLI;
      the desktop executable must not accidentally satisfy a CLI version assertion.
- [ ] Verify installer/archive/sidecar hashes and tamper rejection. Record actual
      signing status; unsigned acceptance remains an explicit owner release decision.
- [x] Build with `pnpm --filter @joy-media/desktop package:unpacked` and run
      `pnpm --filter @joy-media/desktop test:smoke-packaged`. The packaged Playwright
      acceptance also passed with `--retries=0` (1 journey, including playable export).
- [x] Rebuild the unsigned Windows staging package and run both launcher render journeys, packaged/standalone smoke, and package-integrity checks. This proves staging entrypoints only; see `docs/qa/evidence/2026-10-18-windows-staged-cli-acceptance.md`.
- [x] Reproduce and remove the clean-checkout PowerShell 5.1 null dereference; package-level regression checks cover empty and dirty git status results, and lifecycle errors now print their source line. Exact installed-artifact lifecycle acceptance remains open below.
- [x] Use the lockfile-pinned Electron executable to run the safe-storage lifecycle fixture; the installed app's `--run-as-node` invocation hung on the previous candidate. The harness parses and its fixture passes locally; actual installed-artifact acceptance remains open.
- [x] Preserve Playwright stdout in the Windows lifecycle failure summary when
      stderr contains teardown logs. The regression test failed with the old
      combined 16-line tail, then passed after the summary retained bounded stdout
      and stderr independently (6/6 Windows lifecycle harness tests).
- [ ] Run clean install/update/rollback/uninstall in the designated disposable Windows host. Associate all
      lifecycle evidence with exact source, lockfile, and artifact hashes.
- [ ] Fix/review/commit; never uninstall or overwrite the owner's working install.

**Exit:** The actual Windows artifacts work without the source checkout or a
developer's preexisting configuration; upgrade preserves data and cleanup works.

## Task 7: Finish the agent-facing command and failure contract

**Files:** Extend `apps/cli/src/humanized/{cli-contract,doctor-worker,agent-run,agent-secrets,agent-resilience}.e2e.test.ts`;
create `apps/cli/src/humanized/agent-delivery.e2e.test.ts` and versioned schemas
under `apps/cli/schemas/`. Extend the Windows self-hosted lane and its policy tests.

**Interfaces:** Reuse `createSandbox()` and the existing scripted local provider.
Schema fixtures cover help/error/doctor/project/timeline and each render NDJSON
event, including real-media and plan-only completion. Preserve documented exit
semantics: success 0, runtime failure 1, usage failure 2; treat termination policy
explicitly per platform rather than copying POSIX signal numbers onto Windows.

- [x] Run local mock-agent journey: discover help -> create -> add real media ->
      split/trim -> make one invalid request -> consume structured error -> correct ->
      render -> inspect artifact -> reopen project in a fresh process. The fake provider
      receives the typed validation error; the corrected edit survives a fresh CLI
      process; FFprobe confirms a playable H.264 artifact. The JSON envelope and NDJSON
      are parsed, stdout has no ANSI/banner noise, and stderr contains neither the
      synthetic key nor a SQLite startup warning. The agent may write progress to stderr.
      The journey passes through both shipped `bin` and `bundle` entries.
- [x] Add versioned schemas for help/error/doctor/project/timeline, agent-run results,
      and each render NDJSON event. Real `bin` and `bundle` output validates for
      help, error, doctor, project create/list/show/export/import, timeline add/split/
      trim/remove, render errors, and plan-only events; real-media and agent-delivery
      suites validate encoded-render events.
- [ ] Run the contract suite on additional supported Node versions that reproduced
      the startup warning; current evidence is Node 24.19.0 only.
- [x] Verify Windows ACL inspection for synthetic credentials, `taskkill` process-tree
      termination, real SQLite writer-lock behavior, and paths containing spaces;
      the affected Windows selections passed. Both `bin` and `bundle` pass the new
      real-media agent journey.
- [x] Reject Windows reserved-device export paths; a black-box test proves `NUL` returns a JSON usage error without creating an output.
- [x] Run installed `joy.cmd` and `joy-media.cmd` acceptance against the disposable staged package; validate all ten v1 CLI schemas through both launchers with a loopback-only fake provider and reject reserved `NUL` export paths. Do not touch the active install; evidence is hash-bound in `docs/qa/evidence/2026-10-18-windows-staged-cli-acceptance.md`.
- [x] Cover provider 401/429/500, malformed tool/SSE, hung stream, cancellation,
      bounded retry, and no project mutation after failed/denied proposals. Scan logs,
      reports, and persisted state for synthetic keys. Existing offline CLI tests cover
      these routes, including Windows credential ACL and process-tree checks; desktop
      main-process credential transfer remains a separate packaged-app gate.
- [x] Run the CLI, project-persistence, and fixture Vitest suites with
      `--no-file-parallelism` on Linux; the latest run passed 30 files, 508 passed,
      9 skipped. The full Windows `pnpm verify:ci` passed after the signal fixes;
      an earlier Windows no-file-parallelism run passed 30 files, 494 passed,
      21 skipped. Windows runner policy harness also passed.
- [x] Review/commit and publish the supported CLI contract in help/docs; the schema
      directory documents the v1 compatibility policy and contract test command.

**Exit:** An automated caller can diagnose errors, recover, and obtain verified
media through every shipped CLI entry on Windows without parsing human prose.

## Task 8: Qualify optional services and sustained use

**Files:** Extend `apps/api/src` account/device/gateway tests,
worker/job-protocol tests, `tests/e2e/agent-byok-security.spec.ts`,
`tooling/benchmark/src`, and existing release-performance observers. Reuse existing
disposable Postgres/provider/worker acceptance harnesses under `ops/self-hosted`.

**Interfaces:** Separate outcomes for deterministic mocks, real local worker, and
real services. Evidence must name which ran and what remained unavailable.

- [ ] Test account OTP expiry/replay/rate limits, revoke/device entitlement,
      ledger idempotency under duplicate/concurrent requests, and documented failure
      charging policy. Exercise disposable database backup/restore and the control
      plane deny-list; do not contact real customers or alter production records.
- [x] Run the no-model CLI doctor/Worker tests and deterministic Worker protocol,
      job, and fake-Windows-runner suites. `doctor-worker.e2e.test.ts`: 16 passed,
      8 platform skips; `pnpm --filter @joy-media/worker test`: 56 passed, 1
      platform skip. This proves bounded unavailable/error handling and protocol
      behavior only; it does not qualify model output.
- [ ] Real-GPU qualification: one supported job per advertised capability with
      decoded output checks; the local GPU is detected but all model runtimes and
      weights are absent.
- [x] Add and run a 200-edit CLI persistence scenario: 200 real CLI processes add
      non-overlapping clips, then fresh-process readback verifies revision 201 and
      all 200 exact spans. Local Windows/Node 24.19.0 run: 59.89 s for the edits.
- [ ] Run the existing 30-minute effects/media soak, with warmup and machine/toolchain
      recorded. First measure baseline; proposed release bound
      is <=20% slowdown against the same machine class and <=10% post-warmup retained
      heap growth. Calibrate sampling/GC method before freezing these new bounds;
      retain existing stronger gates. Resource exhaustion must fail without data loss.
- [ ] Run the existing benchmark/performance and real-service harness commands
      resolved from the current release workflow, then targeted tests for changed code.
      Record unavailable hardware/service checks as blocking for advertised features,
      or disable/relabel those features explicitly before release.
- [ ] Review and commit fixes/evidence; include dependency/security and
      redistribution/source-obligation checks for the exact packaged artifacts.

**Exit:** Optional features fail predictably when unavailable; advertised live
capabilities and resource behavior have distinct, real acceptance evidence.

## Task 9: Repeat the exact-candidate release gate and close the ledger

**Files:** Extend `.github/workflows/release-candidate-v2.yml` and its policy/
evidence tests only for missing desktop/CLI requirements. Update Task 1's matrix,
release notes, and artifact-bound evidence index.

- [ ] Freeze a candidate after all work packages integrate. Run `pnpm verify:ci`
      and `pnpm test:harness`; run required generated-fixture, CLI Windows/Linux,
      packaged desktop, decoded media, real-service/GPU, restore, and soak checks.
- [ ] Dispatch the existing exact-SHA two-pass release workflow on permitted
      runners after checking current inputs. Its development-CI counterpart and its
      two one-test responsive jobs cannot substitute for release acceptance.
- [ ] Require retry-free first-pass success for every mandatory scenario in
      both isolated passes. Retain diagnostic retries as failed/flaky evidence;
      they do not erase the original failure. Missing required fixtures/tools fail.
- [ ] Verify source SHA, lock hash, fixture hash, package hashes, freshness,
      required scenario completeness, and redacted artifacts through the gate.
      A binary rebuild needs a new artifact hash and binary acceptance; source changes
      require a new candidate and new release evidence.
- [ ] Close all supported-surface rows. Zero open data-loss/security/false-success
      or other P0/P1 defects. Every remaining P2 has an owner, user-visible limitation,
      workaround, and release-note entry. Coverage count alone closes nothing.
- [ ] Obtain external Claude Code review and GPT-6.1-sol's exact-candidate
      `APPROVE_FOR_DEPLOY`; resolve findings through the same loop. Obtain the owner's
      release decision, including unsigned distribution if applicable. Only then can
      merge/release/distribution/deployment proceed within that explicit authorization.
- [ ] Orchestrator writes a redacted durable result to VPS Gbrain, reads it back,
      runs `Invoke-VpsGbrainExport.ps1` without arguments, and publishes a PC receipt
      with the verified export SHA. Failed sync remains sync-pending, not complete.

**Exit:** App-ready, CLI-ready, and release-ready each have explicit evidence.
The project is closed only when all three are satisfied for the same candidate.

## Order, milestones, and completion decisions

Execution order: **1 -> 2 -> 3 -> 5 -> 4 -> 6 -> 7 -> 8 -> 9**. Tasks 3 and 5
come early because output correctness and preservation of user work dominate the
risk. Tasks 4/6 supply actual desktop proof; Task 7 uses the accepted render path.
Do not start paid workers until the standing pipeline/billing gates are verified.

Milestones: M1 reproducible baseline/fixtures; M2 trustworthy CLI delivery/data
safety; M3 packaged desktop journey/Windows lifecycle; M4 services/resources;
M5 two-pass candidate acceptance and external release approvals. Size later
milestones after M1 exposes actual failures rather than promising a calendar date.

Planning assumptions requiring confirmation before their dependent implementation:
fail closed for unsupported CLI media features; proposed new audio/performance
bounds; access to a disposable Windows lifecycle host; unsigned distribution
policy. Continue independent tests while a decision is pending. The existing
real-render feature itself is already present upstream; implementing it anew is
not a work package.

## Runner continuation — October 18 (export audio clock alignment)

- Exact candidate run `39116255432` at `135363834ab7d0a182fc85dbc44449bc8f731438` built the frozen Windows package successfully and passed the hosted bundle/smoke, both Linux real-service passes, and both P3 passes. Windows lifecycle pass 2 failed only the packaged editor's decoded-audio onset assertion: at the audio clip's 0.7 s start, a sample at 0.8 s measured RMS `5.57e-7` against the `>0.02` threshold; the other four editor acceptance tests passed. Teardown passed and the gate summary correctly failed; downstream acceptance/soak/restore jobs were skipped.
- The failure exposed a start-clock gap: `downloadBrowserMp4` waited for the asynchronous MediaRecorder `start` event before starting authored audio, although recording begins at the `start()` call. A unit regression failed before the change (`authored media start` followed the event) and passed after moving the callback into the synchronous post-`start()` turn. This aligns audio and scheduled video sources with the recorder origin.
- After the fix, `pnpm verify:ci` exited 0: 631 test files passed / 1 skipped, 5,610 tests passed / 28 skipped, workspace builds passed, and the production audit found no known vulnerabilities. `pnpm --filter @joy-media/desktop package:unpacked` succeeded; the rebuilt packaged-editor decoded-audio acceptance passed twice with retries disabled. This is local evidence and does not replace exact-candidate acceptance.
- The next candidate must run the existing hosted/self-hosted split on its exact SHA. The Windows Docker runner remains required for installer lifecycle; hosted Ubuntu remains in use for the portable bundle and responsive-only lane. Still open: exact two-pass candidate success and downstream acceptance/soak/restore, real-GPU qualification (0/4 model environments ready and no `JOY\\models` directory), independent review, owner release decision, and final redacted VPS Gbrain closeout. No GPT-6 Astra review or approval is permitted or claimed; no release is approved.

## Packaged MP4 download completion — October 18

- Exact candidate `39119170732` at `4836ecef9009a804b83c526aaaa3b63829d28dab` passed hosted validation/bundle/smoke, both Linux real-service passes, both P3 passes, and Windows package build. Windows lifecycle pass 1 failed in the packaged preset-matrix check: `ffprobe` saw `moov atom not found` immediately after the expected download file first appeared. The other four editor checks passed, teardown passed, and the exact-candidate gate correctly failed.
- The acceptance helper only waited for `existsSync(path)`, which can be true while Electron is still writing a download. A Playwright page-level `download` event did not fire for the packaged app because Electron handles downloads in its main process. The helper now subscribes to `session.defaultSession`'s `will-download` event and waits for that item's `done` state to be `completed` before probing the saved MP4; all three editor export/download scenarios use this gate.
- The first focused local preset-matrix attempt caught the unsupported page-event assumption. With the main-process completion wait, the preset matrix passed, then the full packaged editor suite passed 5/5 with retries disabled (playable export/audio, cancel/retry, all five encoded presets, 150% accessibility, and Monitor-to-decoded-frame comparison). Fresh `pnpm verify:ci` exited 0: 631 files passed / 1 skipped, 5,610 tests passed / 28 skipped, builds passed, and production audit reported no known vulnerabilities.
- The current test-harness fix needs a new exact-SHA two-pass workflow on the hosted/self-hosted runner split. No app release or candidate acceptance is claimed yet; GPU qualification, independent review, owner release decision, and final VPS Gbrain closeout remain open.

## Desktop-primary transition assertion — October 18

- Exact candidate `39121380239` at `6552db81e593499386624a9c18f515c07979e7bf` passed candidate validation, hosted renderer bundle and production smoke, both Linux real-service passes, both P3 passes, both responsive six-viewport passes, and the two-pass Windows Worker/desktop lifecycle. Both desktop-primary passes failed at the same WP-29 R5 CASE-74 assertion: the test expected `aria-pressed="true"` on the transition card wrapper `<div>`, which has only the `is-active` class. The actual nested `button.transition-card-select` already exposes `aria-pressed` for assistive technology. Gate summary failed and downstream real-service acceptance was skipped.
- Fixed the acceptance target to click and assert the nested interactive transition button. Focused CASE-74 passed, and the full WP-29 R5 batch-E file passed 6/6 with retries disabled. This is an acceptance-test selector correction; the app's selected-state accessibility attribute was already on the correct control.
- This source change needs a new exact-SHA release-candidate run before claiming the desktop-primary gate. Record prior candidate failures as evidence, do not erase them with the corrected rerun. Real-GPU qualification, independent review, owner release decision, and final VPS Gbrain closeout remain open; no release is approved.

## Real-service timeline selector — October 18

- Exact candidate `39124132645` at `da4a831bc1f6b01801cf468083de7a564a6fab87` passed candidate validation, the hosted editor bundle and shipped-bundle smoke, both Linux real-service and P3 passes, both Windows Worker/installed desktop lifecycle passes, both desktop-primary passes, and both responsive six-viewport passes. Both real-service acceptance passes failed while waiting for a selected HTML-scene clip using `aria-pressed`; gate-summary failed and downstream final source-bound evaluation was skipped.
- `TimelinePanel` exposes selected timeline groups with `aria-current="true"`. Corrected the two acceptance-harness checks (initial Motion clip lookup and post-reload reselection) to use that state. The focused local WP-35 selected-clip test passed 1/1; Node syntax and Prettier checks passed.
- The release workflow currently routes portable validation, web bundle/smoke, and responsive coverage to GitHub-hosted Ubuntu, and routes Docker-dependent Windows lifecycle plus isolated Linux service/acceptance lanes to the available self-hosted runners. The corrected harness requires another exact-SHA two-pass run through that split.
- Still open: exact-candidate two-pass success and downstream final gate, real-GPU/model qualification (0/4 model environments ready and no `JOY\\models` directory), calibrated soak/restore, authorized independent review, owner release decision, and final redacted VPS Gbrain write/read/export/receipt. No GPT-6 Astra review or approval is permitted or claimed; no release is approved.

## Two-pass acceptance and P3 gallery retention — October 18

- Exact candidate run `39128416727` at `3fff3745acfa45fc817230c394a2be746704f5fb` passed candidate validation, hosted editor build, both Linux real-service passes, both P3 passes, shipped-bundle smoke, the two-pass Windows Worker/installed desktop and CLI lifecycle, both desktop-primary passes, both six-viewport responsive passes, and both authenticated real-service acceptance passes.
- Final evidence binding failed at `Restore and bind both isolated evidence passes`: retained P3 pass 1 included `test-output/browser/p3-export-gallery/manifest.json`, intentionally copied by `retain-evidence.sh` with the gallery assets, while `restore-retained-evidence.mjs` allowed gallery MP4/PNG files only. The final source-bound readiness report was therefore skipped; the successful acceptance receipts remain evidence and are not discarded.
- Regression-first repair reproduced the same failure by adding the gallery manifest plus MP4/PNG entries to the retained P3 fixture. The restore allowlist now admits only the exact gallery `manifest.json` path in addition to its existing MP4/PNG rule. Gallery assets stay in durable pass storage and do not expand into the final workspace. Rejection diagnostics now include the unapproved path. Focused restore suite passed 7/7.
- This correction needs a new exact-SHA release-candidate run. Real-GPU/model qualification (0/4 model environments ready), independent review, owner release decision, and final VPS Gbrain write/read/export/receipt remain open; no release is approved.

## P3 sample-frame retention and local closeout verification — October 18

- Exact candidate `39137590603` at `57e55550d6096fbf7f0cac8106f0f0c3f2ab4ea5` passed both real-service acceptance passes and the preceding hosted/self-hosted lanes, then failed only when final evidence restore found the P3 gallery's generated `frame-0.10.ppm` sample. This is a retained-evidence allowlist failure; no application acceptance failure was reported.
- Added a regression that accepts only the three generated sample-frame names (`frame-0.10.ppm`, `frame-0.50.ppm`, `frame-0.90.ppm`) directly beneath one P3 case folder, while rejecting arbitrary PPM files. The prior exact `manifest.json` and MP4/PNG behavior remains intact. `restore-retained-evidence.test.mjs` passes 9/9; the full `pnpm test:harness` passes 39 with 11 platform-specific skips.
- The added hosted Node 22.17/24 matrix made the artifact-policy job count stale. Updated the contract to require both Node versions and 17 total job instances. The focused artifact-policy suite passes 10/10.
- Full `pnpm verify:ci` now exits 0, including typecheck, lint, formatting, the complete Vitest suite, workspace builds, and production dependency audit (no known vulnerabilities). A run before the final green run exposed a 30-second timeout in one real-binary provider-discovery test under full-suite load; the same provider suite passed 21/21 in isolation, so only that test's deadline was increased to 60 seconds. The CLI real-media tests independently probe playable output from the binary and bundle, exercise H.264/AAC plus WebM/ProRes, and validate image samples and recovery behavior.
- The PostgreSQL race test is skipped locally because `JOY_TEST_DATABASE_URL` is not configured; the hosted Node lane supplies an ephemeral PostgreSQL 16 service and runs the integration with ten synchronized contenders.
- No new exact-candidate workflow has run for these changes yet. Real-GPU/model qualification remains unavailable (0/4 model environments and no `JOY\\models` directory); generation features without those runtimes must remain explicitly unavailable or experimental. Independent review, owner release decision, and final redacted VPS Gbrain write/read/export/receipt remain open. AGY Gemini 3.8 returned no review text after the authorized sanitized 90-second attempt; no Astra review or approval was requested or used, and no release is approved.
