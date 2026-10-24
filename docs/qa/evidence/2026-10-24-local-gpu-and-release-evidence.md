# Local GPU, export, persistence, and release-gate evidence (2026-10-24)

Scope: local work on `hadimoti/owner-binding-candidate`. Nothing was pushed, dispatched to CI, opened as a PR, frozen, released, or deployed. No driver, registry, or system setting was changed. Hardware encoding is unchanged for normal launches, and GPU sandboxing is never disabled.

Code commits in this note: `db0cb85e` (GPU fallback and security workstream, the basis of the validation below), `c64ad2fb` and `fb94c553` (documentation and test-count corrections), and `c449ef2d` and `2cce72bc` (the export remux fix in the first section). Each validation result keeps the commit it was measured on.

## Final candidate `9a43a66e` (local verification, 2026-10-24)

Code candidate: `9a43a66e` on `hadimoti/owner-binding-candidate`. Documentation-only commits follow it: `d010d27e`, and the commit that adds this section. Each result names the SHA it ran on. Nothing was pushed, dispatched to CI, opened as a PR, frozen, or released. No driver, registry, or GPU setting was changed.

Since `219a8120`, the only code change is `tooling/release/src/retain-release-artifacts.mjs` and its test (`0082f6cc`, `9a43a66e`). Nothing under `apps/` or `packages/` changed, so the packaged app is the same code on both SHAs. The `219a8120` results are kept separate below.

| Check                                   | Command                                                 | Result on `9a43a66e`                                                                                                             |
| --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                              | `node node_modules/typescript/bin/tsc -b`               | exit 0                                                                                                                           |
| ESLint                                  | `node node_modules/eslint/bin/eslint.js .`              | exit 0                                                                                                                           |
| Prettier                                | `node node_modules/prettier/bin/prettier.cjs --check .` | exit 1: two QA docs from `a2325802` were unformatted. Formatted in `d010d27e`                                                    |
| Unit suite                              | `node node_modules/vitest/vitest.mjs run`               | 692 files passed, 5 skipped (697); 6,290 tests passed, 33 skipped (6,323); exit 0. The 2 new skips are the POSIX-only FIFO cases |
| Mutation harness                        | `mut-run-final.sh` on the clean tree                    | 21 of 21 runs detected; every file restored to HEAD                                                                              |
| Seven-viewport audit                    | Playwright, `tests/e2e`, seven projects                 | 875 passed, 7 skipped (CASE-66, approved), 0 failed; exit 0; 17.2 min                                                            |
| Packaged build                          | `package-release.mjs --unpacked`                        | exit 0                                                                                                                           |
| Packaged export, fallback configuration | `export-semantics.spec.ts`                              | 11 runs, 22 of 22 tests (10 in the chain, and 1 more kept for its ffprobe evidence)                                              |
| Packaged persistence                    | `fresh-process-persistence.spec.ts`                     | 1 of 1                                                                                                                           |
| Packaged acceptance                     | `editor-acceptance.spec.ts`                             | 5 of 5                                                                                                                           |

Mutation runs: 19 unit mutations (M1–M6, M8–M12, M14–M16, M18–M22) were each caught by their targeted test file. M7a and M7 were caught by Playwright, with 8 and 1 failing tests. M13 is not defined in the harness. The harness also defines M24–M42, which were not run on this candidate.

Packaged measurements, from the kept run on `9a43a66e`:

- Video: MP4 of 54,566 bytes. H.264 High, 320×180, yuv420p, BT.709 primaries, transfer and matrix, limited range. `avg_frame_rate` 30/1, `r_frame_rate` 30/1, `nb_read_frames` 180, duration 6.000000 s.
- Audio: AAC, 2 channels, 48,000 Hz, 282 frames, duration 6.000000 s.
- Hard cut: red at 0.5 s and 0.967 s, blue at 1.0 s and 1.5 s. The pre-fix build showed red at 1.0 s.
- Sync: flashes at 3.000 s and 3.033 s, click onset at 3.000 s.
- Channels: 440 Hz on the left and 880 Hz on the right, each at RMS 0.353.
- Alpha and dissolve: alpha centre [121, 0, 122] against [127, 0, 127] expected; dissolve midpoint [121, 0, 120] against [127, 0, 127]. The spec asserts both, and it passed.
- Preview against export (normalised RGB mean absolute error, tolerance 0.2): 0.004 to 0.047 over 11 samples. The largest is at 3.0 s.

Fallback reliability, every packaged export run recorded in this note:

| Build                                              | Remux fix | Runs | Tests | Result                                                                      |
| -------------------------------------------------- | --------- | ---- | ----- | --------------------------------------------------------------------------- |
| `db0cb85e`                                         | no        | 4    | 8     | 8 of 8 pass                                                                 |
| `c64ad2fb`, first batch (chain run and 10 repeats) | no        | 11   | 22    | 22 of 22 pass                                                               |
| `c64ad2fb`, second batch (`x10b`)                  | no        | 10   | 20    | 17 of 20 pass; runs 5, 8 and 9 each fail one test with the timing signature |
| `219a8120`                                         | yes       | 4    | 8     | 8 of 8 pass                                                                 |
| `9a43a66e`                                         | yes       | 11   | 22    | 22 of 22 pass                                                               |

Before the remux fix, 22 of 25 runs passed both tests, and every failure is on `c64ad2fb` with the timing signature. Since the fix, 15 of 15 runs pass (30 of 30 tests) across two SHAs with identical app code. Fifteen passes bound the failure rate only loosely, at about 20 percent at 95 percent confidence by the rule of three. That is good evidence for the fallback export path, but the sample is small.

GPU fallback: accepted for the fallback path on this host, and the hardware path is open.

Accepted:

- Automatic. After a GPU fast-fail with exit code −1073740791, the app relaunches once with `--joy-media-gpu-encode-fallback`. `installGpuEncodeFallback` runs before `app.whenReady` (`apps/desktop/src/main/electron-entry.ts`).
- Observed once on the packaged default build, at 06:48. One fallback instance appeared at 06:48:26, stayed alive through 06:48:45, and was then stopped by PID.
- Safe. `window.ts` keeps `sandbox: true`. The module adds one Chromium feature switch and nothing else, and no GPU-sandbox-disable flag appears in the desktop source.
- Recoverable. One relaunch, never persisted. A fallback session that fails again is not relaunched, which the module tests cover. Saved projects survive, as the fresh-process test shows. Unsaved work in the crashed session is lost.

Not accepted:

- The default hardware path crashes on first GPU use on this host. Every default-configuration run recorded here failed.
- The root cause is not established. The leading hypothesis, at medium confidence, is that the NVIDIA encoder component aborts inside the GPU sandbox while media services start.
- The export spec cannot run against the shipped default, because the relaunch replaces its first window. The fallback runs use a scratch copy with the same switch added at startup. That tests the switch, not the relaunch path. The relaunch path has one observation and the decision-logic unit tests.
- Reliability on the real relaunch path is not measured.

What closes `desktop.export-media-semantics` (P0):

1. An exact-candidate two-pass receipt for this scenario, with first-try passes and zero retries. This needs a push and a CI dispatch.
2. An owner decision on the shipped configuration: accept the relaunch fallback and make the acceptance harness drive the relaunched session, or fix the default hardware path and rerun the default build.
3. One parity criterion, used everywhere. The spec's only numeric criterion is the preview-export tolerance of 0.2, and the release notes must use the same one.

Security closure: closed locally for the reviewed owner-binding findings. Each guard is in the code and has a test.

- `EnhanceInspector.tsx`: queue checks scope before enqueue (line 203), and cancel checks before cancel (line 227). Tests: `EnhanceInspector.session.test.tsx`.
- `MaskInspector.tsx`: queue (line 297) and cancel (line 327). Tests: `MaskInspector.session.test.tsx`.
- `App.tsx`: resolve passes the scope check (line 6356), and the jobs call passes it (lines 4815–4818).
- `AssetLibraryPanel.tsx`: the derivative fetch is checked before the call (line 207).
- `project-media-resolver.ts`: an unguarded caller cannot join a guarded lookup (line 68), and guarded lookups are not stored for joining (line 77). Tests: `project-media-resolver.test.ts`.

The unit suite and the audit pass on `9a43a66e`, and the mutation harness detects the removal of each guard it targets. The original security checklist was not reread in this pass, so the closure covers the reviewed findings, the guards, and their tests.

## Export remux fix (`c449ef2d`, refined in `2cce72bc` and `219a8120`)

Symptom: in captured exports the decoded video is one frame late from frame 30 onward. In the two saved failing runs (`run-3` and `run-5`, in the local scratch directory and not committed), frames 0–29 match the authored timeline. From frame 30 onward, every frame whose picture changes matches the fixed output one frame earlier. A per-frame comparison of the decoded probe pixel gives 145 frames that match the fixed output at the same index, 35 that match only the frame before, and none that match neither.

Where it comes from: the recorder output was already correct. `browser-source.mp4`, the MediaRecorder output before the server remux, has red for frames 0–29, blue from 30, the flash at 90–91, and the dissolve from 120, as authored. The shift is introduced by the remux. Running the previous production remux command on the saved recorder output reproduces the shifted export exactly, with frame 29 duplicated at index 30.

Cause: `setpts` gives frame N its authored time but keeps each recorder frame's own duration, and those durations are irregular (the saved captures alternate about 50 ms and 17 ms). The previous output-stage `-r 30` resample used those durations, duplicated one frame, and every later frame moved one slot. The earlier reproduction shows the duplicate as one red frame at index 30; identical red frames cannot show which source index it came from.

Withdrawn: the earlier capture-side explanations (a stale canvas capture, a WebGL read-back before commit, and a schedule that arrives "2 to 3 frames late") are not supported by the saved evidence. A CPU-backed staging canvas was built and tested (20 runs, all passing, which could not discriminate) and then reverted.

Fix (`packages/export-core/src/index.ts`, `2cce72bc` and `219a8120`): on the normalized path (a frame count is given), frame N takes time N / frameRate. The chain is `colour,setpts=N/(rate*TB),fps=rate:round=near,tpad` with the frame limit and duration, and `-r` is unchanged. The path without a frame count keeps the original timestamp chain (colour filter and `-r`), so a source at another rate keeps its duration. The first version, `c449ef2d`, added `-fps_mode passthrough`, a track timescale, and a rejection of fractional frame rates. Mutation checks showed those were not needed, so `2cce72bc` removed them, and fractional rates work again.

Known limit: the path without a frame count still duplicates a frame on a jittered capture, which is the original defect. No production caller takes this path. The worker always sends a frame count, which its payload validator requires (`apps/worker/src/export-job.ts`). The editor client sends the header whenever a count is given, and its method has no production callers. The only caller that omits the count is a test, `packages/export-core/src/wp29-step03-proof.test.ts:110`. The API route takes this path only when a request omits `x-joy-frame-count`. Whether the route should require the count is a decision for the owner; the assessment is in the final candidate section.

Review: two read-only Sonnet 5.5 reviews. The first found that the trigger is the recorder's per-frame durations rather than output rounding (corrected above), that fractional rates failed late (fixed by removing the rejection), and that the no-count path kept the original defect with a loose tolerance (both addressed). The second found that indexing the no-count path desynchronised audio for a source at another rate (reverted in `219a8120`), and that the 29.97 case reports 2997/100, not 30000/1001 (corrected above).

Verification:

- Regression test `keeps every browser-capture frame at its authored index when capture timestamps jitter` (export-core): a 180-frame clip whose red channel encodes its index is retimed with vsync-like timestamps, and the normalized remux output must match the constant-rate reference at every frame. The previous remux had 162 of 180 frames misaligned; the fix has 0. The tolerance is two code values: correct output differs by 0, and a one-frame shift moves the value by 5.
- `pads a jittered short capture by repeating its last frame`: 150 jittered frames padded to 180 match the padded constant clip at every frame.
- `keeps the recorder timestamps when no frame count is given`: 360 frames at 60 fps, remuxed at 30 without a count, stay within 5.9 to 6.2 s. Indexing them at 30 fps would give 12 s.
- `keeps the authored frame count at a fractional frame rate` (29.97): 180 frames, `r_frame_rate` 2997/100, duration 6.006 s.
- Reverse mutations at `219a8120`: indexing the no-count path fails the 60 fps test; removing the fps filter, removing `setpts`, and restoring `fb94c553`'s remux each fail both jitter tests. The file was restored byte-for-byte after each run. Earlier, removing `-fps_mode passthrough` or the track timescale from `c449ef2d` left every test passing, which is why those two were removed.
- Saved failing captures through the final normalized chain: `run-3` and `run-5` show red 0–29, blue 30–59, dark 60–89, white 90–91, dark 92–119; 180 frames at 30/1, duration 6.000 s.
- Packaged, from `c449ef2d` (the earlier design), fallback configuration (the switch the relaunch applies): export spec 4 of 4 runs, 2 of 2 tests each (8 of 8); fresh-process render 1 of 1; editor acceptance 5 of 5. Packaged results for `2cce72bc` are in the validation section after this one.
- Other suites at `219a8120`: export-core 18 tests (5 `it.each` cases and 13 tests); 15 test files across export-core, worker, and the API remux test pass (124 tests, 1 skipped); ESLint and Prettier clean on the changed files. Typecheck and the full unit suite for `219a8120` are in the validation section after this one.

Not verified: the failure did not reproduce in this session on the previous build. That build passed 10 of 10 loaded runs under four busy-loop processes and 6 of 6 under twenty-four, on a 32-core host. The packaged runs therefore show no regression, but they do not show that the failure rate fell. The earlier failure counts (2 of 5 loaded runs and 3 of 34 unloaded runs, in earlier sessions) are explained by the saved-capture reproduction, not measured against the fix.

## Bitrate and the GPU switch (decided 2026-10-24)

- Bitrate: the export path has no bitrate target. The browser recorder's `videoBitsPerSecond` is `max(2 Mbps, width × height × fps)`, and the remux re-encodes the final MP4 with libx264's default CRF 23, so the recorder setting does not set the final bitrate. The `high-bitrate` preset changes only the dimensions. The owner chose to keep this behaviour, so no bitrate change was made. The hardware path cannot be measured on this host, because the default build still crashes there.
- GPU switch: the Media Foundation video-encoder feature is switched off only by the relaunch after a GPU fast-fail. `applyGpuEncodeFallback` applies only when the relaunch argument is present, and that argument is passed only after a fast-fail. Normal launches keep hardware encoding, so the switch stays off by default.

## Final validation on `0082f6cc` (code) and `219a8120` (packaged and audit)

- Unit suite on `0082f6cc`: 692 files passed and 5 skipped (697); 6,290 tests passed and 31 skipped (6,321); exit 0.
- Seven-viewport audit on `219a8120`: 875 passed, 7 skipped, 0 failed; exit 0. The 7 skips are CASE-66, blocked by design. Web code is unchanged after `219a8120`, so the result still applies.
- Packaged fallback configuration on `219a8120`: export spec 4 of 4 runs, 2 of 2 tests each (8 of 8); fresh-process render 1 of 1; editor acceptance 5 of 5.
- Typecheck (`tsc -b`) on `219a8120`: exit 0.
- Release tooling on `0082f6cc`: 15 files, 289 passed, 1 skipped (the symlink case, which this host cannot create).
- The unit run that included `219a8120` failed 10 retention tests. That tree still copied with `cpSync`, which Node v24.22.1 refuses for an existing destination, and the write-once gate relied on it. `0082f6cc` copies one file at a time with exclusive creation, and the same tests pass.

## Final validation on `db0cb85e`

- Unit suite: 692 files passed and 5 skipped (697); 6,285 tests passed and 31 skipped (6,316); exit 0.
- Typecheck (`tsc -b`): exit 0. ESLint and Prettier: clean on the changed files.
- Reverse mutations on the fallback module: exit-code guard, loop guard, and dropped quit call are each detected by the module tests.
- Seven-viewport audit: 875 passed, 7 skipped, 0 failed; exit 0. The 7 skips are CASE-66, which is blocked by design because it needs an external Worker running `audio.ml-denoise`.
- Packaged fallback configuration: export spec 2 of 2 in four runs (32.4 s, 33.6 s, 32.3 s, 33.6 s); editor acceptance 5 of 5; fresh-process render and stored-clip check 1 of 1. On `c64ad2fb`, the same spec then passed in 1 further chain run and in two batches of 10 consecutive repeats. The first batch passed 10 of 10 (32.2 s to 33.7 s). The second batch (`fallback-reliability-c64ad2fb-x10b.log`) passed 7 of 10. Runs 5, 8 and 9 each failed the one test that checks the hard cut and Monitor parity, with the defect's signature: the picture is still red at 1 s, where blue is authored, and parity misses at 1, 3 and 4 s. `c64ad2fb` predates the remux fix (`c449ef2d`), so these failures are the defect the remux fix addresses, not a fallback failure. Across the pre-fix builds that is 25 export runs with 22 passing, and all 3 failures are on `c64ad2fb`. The earlier total of 15 of 15 omitted the second batch. Earlier configurations failed intermittently: the global switch failed parity in 2 of 7 runs, and the narrow feature failed the picture check once on an earlier build. At that point the timing defect was unfixed; the remux fix above supersedes that statement.
- Shipped default build, export spec: fails, as designed. The first instance crashes and the relaunch replaces its window.

## GPU crash on the shipped build (fallback shipped; root cause open)

Host: NVIDIA GeForce RTX 5070 Ti, driver 617.42, ANGLE D3D11. The default packaged build's GPU process exits with `-1073740791` (0xC0000409) during media setup, and WebGL is lost for that session.

What was tested (each row is one run of `tests/desktop/export-semantics.spec.ts` on a scratch copy):

| Configuration                                              | Result                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Default                                                    | Fails: GPU crash, WebGL lost                                                                                                         |
| `MediaRecorder.isTypeSupported` stubbed to true            | Fails the same way: not the trigger                                                                                                  |
| `--disable-accelerated-video-decode`                       | Fails the same way: not the trigger                                                                                                  |
| `--disable-features=MediaFoundationVideoEncodeAccelerator` | Export completes. Picture check fails at 4 s and Monitor parity at 3 s and 4 s on that earlier build. Sound and timing check passes. |
| `--disable-accelerated-video-encode` (earlier series)      | Five of seven runs pass both checks; two fail Monitor parity at 1 s.                                                                 |

The narrowest switch that avoids the crash is the Media Foundation video-encoder feature. The root cause is not established. The leading hypothesis (medium confidence) is that the encoder's NVIDIA component aborts inside the GPU sandbox while the media pipeline initializes GPU video services.

Shipped change (`apps/desktop/src/main/gpu-encode-fallback.ts`, wired in `electron-entry.ts`): after a GPU exit of `-1073740791`, the app relaunches once with the Media Foundation video-encoder feature disabled. The relaunch is not persisted. Normal launches keep hardware encoding. A fallback session that crashes again is not relaunched.

Verified on the packaged build: when the first instance exited, exactly one `electron.exe` carrying `--joy-media-gpu-encode-fallback` appeared (06:48:26), stayed alive through the sample window (06:48:45), and was then stopped by PID. The shipped-configuration export test therefore fails, because its window belonged to the first instance. An earlier count of relaunched instances matched its own command line and was discarded; this observation replaces it.

Consequences of the fallback that a user should know: the relaunch restarts the app, so the first session's in-flight work is lost (the GPU exit had already broken WebGL). Reliability beyond the runs above is not established.

## Persistence after a fresh-profile import (verified)

`project.persistence.fresh-process`: after import, the fresh profile's `joy-media.timeline-project-log.v1` holds the imported clip by asset id. The asset record with its display name is in `joy-media.visual-object-project-log.v1`. The spec previously searched the timeline text for the display name, which an imported project does not carry. It now follows the clip's asset reference to the asset record. Result on the packaged fallback build: 1 passed.

## Flakes (fixed, with evidence)

- CASE-15 (`desktop-1440` audit failure): the import helper waits for the upload's acceptance, then gives the card a separate 60 s budget. The card assertion is unchanged. Result: 6 of 6 passed under three workers.
- API account routes (`fetch failed: bad port`): this host's dynamic TCP range is 1024 to 65534, and `listen(0)` can return a port that fetch refuses (for example 6000, 6665, or 10080). The test servers now listen again until they hold a fetchable port. All 80 listed ports fail with "bad port", and none of 3,997 random unlisted ports do. Result: six API test files, 87 tests, passed.

## Release gates and external blocks

- `desktop.windows.installed-lifecycle`: externally blocked. `net session` exits 2, so this session is not an administrator. `Get-WindowsOptionalFeature` for `Containers-DisposableClientVM` and `Microsoft-Hyper-V-All` fails with "The requested operation requires elevation." The owner must run the lifecycle from an elevated session or approve a disposable account. Not run.
- `release.exact-candidate-two-pass`: externally blocked. It needs a push and a CI dispatch, which were not authorized. Not run.
- `desktop.export-media-semantics`: the export timing defect is fixed in the remux (`c449ef2d`), and the packaged fallback export passed 4 of 4 runs on that build. The gate stays open for the shipped default build, which still crashes on first GPU use.
- `desktop.app.restart-save-export`: open on the default build for the same GPU reason.

## Artifact integrity and cross-runner requirements

- Release tooling tests: 15 vitest files, 289 tests passed and 1 skipped (`tooling/release`), covering write-once retention, manifest checks, checksum listing, and fail-closed refusals. Re-run on the final tree.
- Requirements the tooling enforces: the evidence root sits outside the checkout, `_work`, and `_temp`; each retention is write-once per candidate, run, and attempt; `SHA256SUMS.txt` must appear in the manifest; the retained manifest must match the staged manifest; and folders are flushed after copy. On Windows, directory flushes are no-ops, so file flushes are the durable step.
- The synthetic cross-runner rehearsal ran for `b8ea8444`, before the retention changes in `46d6e3e2`. It has not been repeated on `db0cb85e`.

## Approved skips

- Seven-viewport audit: the 7 CASE-66 skips, blocked by design (see above).
- Unit suite: 5 skipped files and 31 skipped tests, recorded by the suite itself.

## Unverified or open

- GPU root cause (unproven). The default build still crashes on first GPU use, and the fallback relaunch is the mitigation. Fallback reliability beyond the recorded runs is not established.
- Export failure rate after the remux fix: not measured. The fix is verified by the saved-capture reproduction, the regression and mutation tests, and the packaged runs.
- Installed lifecycle (needs elevation). Exact-candidate two-pass receipts (need push and CI, not authorized).
- Cross-runner rehearsal on the final SHA. None has run on `9a43a66e`.
- Not run on `9a43a66e`: the packaged smoke test, the installed CLI acceptance, the staging package checks, the installed lifecycle, the real-service acceptance, the Windows worker lane, and the cross-runner rehearsal.

## Release-candidate CI for `9a43a66e` (dispatched 2026-10-24)

The owner approved a non-force push of `hadimoti/owner-binding-candidate` and the dispatch of `release-candidate-v2.yml` for `9a43a66e`. That approval did not cover the evidence store, the GPU shipping decision, a release, a merge, or a change to the candidate.

- Run `40074133129` (https://github.com/hadimoti/joy-media/actions/runs/40074133129), with `candidate_sha=9a43a66e9cef9a8e07fa008c6b621ae62dab796f`. The workflow ref is the branch tip, `444a3d9c`.
- Retrievability: `9a43a66e` is retrievable from origin, and `validate-candidate` succeeded, including its `Validate immutable candidate input` step. The dispatch went out before that separate check was run.
- Included: every commit up to and including `9a43a66e`, which is 89 commits since base `46b78e73` (86 files, +8,336 and −881).
- Excluded: `d010d27e` and `007023ba` (documentation), `f274316d` (a test-only launch-argument hook in three desktop specs), and `444a3d9c` (the retention checkout-rule fix and its test). No file under `apps/` or `packages/` differs between `9a43a66e` and `444a3d9c`, so the packaged app code is the same.

Job state when this section was written. These are not receipts.

| Job                                                                                       | State                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| validate-candidate                                                                        | success                                                 |
| editor-web-bundle                                                                         | success                                                 |
| node-contracts (Node 22.17.0), node-contracts (Node 24)                                   | in progress                                             |
| windows-p0-real-services                                                                  | in progress on `joy-media-worker-docker` (online, busy) |
| windows-worker-clean (two exact passes)                                                   | queued                                                  |
| prod-build-smoke, p3-real-services (passes 1 and 2), linux-real-services (passes 1 and 2) | queued                                                  |

Blockers: the self-hosted runners `joy-media-ci-acceptance` (label `joy-media-acceptance`) and `joy-media-ci-linux` (label `joy-media-ci`) are offline, so the Linux jobs cannot start. The evidence store is not configured, so retention fails closed when it is reached. The gate is closed, and no receipt exists for `9a43a66e`.

Local evidence on the candidate's app code. The build from `f274316d` has identical app code, and these are not receipts.

- The packaged smoke test (`test:smoke-packaged`) passed.
- With `--joy-media-gpu-encode-fallback` on the unmodified build: 10 of 10 export runs (20 of 20 tests), fresh-process 1 of 1, and editor acceptance 5 of 5. The ffprobe values matched the earlier candidate run. Click onset was 10 ms after the flash here and 0 ms in the earlier run, within one 33 ms frame.
- Relaunch observed on the unmodified default build. The first main process was seen and then exited about two seconds later. The relaunched process carried the fallback argument. Its debug endpoint answered 129 ms after it appeared. WebGL was available and not lost on the NVIDIA GeForce RTX 5070 Ti (ANGLE, Direct3D11), and a cleared pixel read back as `[255,0,0,255]`. The default export spec failed in the same run.
- Cross-runner stand-in rehearsal: two concurrent synthetic runners, one shared store, 15 cases. The candidate's tool passes 14 of 15. The one unexpected case is an evidence root inside the checkout with no `RUNNER_WORKSPACE`, which the candidate accepts. `444a3d9c` refuses it, and its tool passes 15 of 15.
- Independent read-only review of the candidate's change (claude-sonnet-5-5, effort high): no blocker or major findings. One minor point: the retain-mode FIFO test would still pass if the new `listFiles` refusal were removed, because the copy step refuses the FIFO with the same message. The verify-mode FIFO test does guard that line. Not changed in the candidate.

Skips and retries. On Windows, the POSIX-only FIFO tests and the symlink test are skipped, and the symlink test is also skipped wherever the host lacks the privilege. The two `win32`-only tests are skipped on Linux. The desktop Playwright configuration sets `retries: 0`. Retry behaviour in CI is not yet known.

## Decisions, external blocks and release verdict (2026-10-24)

**`x-joy-frame-count` (assessment).** The header is optional on `POST /v1/projects/{id}/export/remux`. Without it the route keeps the recorder's timestamps, and a jittered capture can duplicate a frame. No production path omits it. The worker's payload validator requires `frameCount` (`apps/worker/src/export-job.ts`), and the editor client sends the header whenever a count is known; its method has no production callers. The route and header appear in no API reference, only in the WP-29 step-03 note and this note. Making the header mandatory would turn any undocumented client that omits it into a 400. Recommendation: make it mandatory in the next API revision, with `REQUEST_INVALID` naming the header. Do not change it in this candidate without owner approval.

**Shared evidence store (owner approval; not provisioned).** The workflow has two retention points, and each reads its own variable. The Windows lane's retention step reads `JOY_MEDIA_WINDOWS_EVIDENCE_ROOT` (`.github/workflows/release-candidate-v2.yml`, line 661) and fails when it is empty. The Linux gate reads `JOY_MEDIA_CI_EVIDENCE_ROOT` (lines 1099–1104) and retains each pass under `JOY_MEDIA_CI_EVIDENCE_ROOT/<candidate>/<run>-<attempt>-p<pass>`. Both must name a writable directory outside the checkout, `_work` and `_temp`. The workflow sets `JOY_MEDIA_CI_EVIDENCE_ROOT` to an empty value (lines 772 and 955), and the 2026-10-23 proposal found the Windows container without `JOY_MEDIA_WINDOWS_EVIDENCE_ROOT`. Nothing was configured in this pass. The owner must decide the location, that it persists across runs, who can read and write it, its retention and backup, and that it is not a production or deploy target. This checkout cannot read the store, so no retained receipt is verified for any SHA after `1482aa7b`.

**Frozen-SHA two-pass acceptance (not run; needs approval).**

1. The owner approves the push of `hadimoti/owner-binding-candidate`, the CI dispatch, and the store path.
2. Choose the frozen SHA. Recommended: `9a43a66e`, the verified code, since the documentation commits after it change no code.
3. Push without force, then confirm `origin/hadimoti/owner-binding-candidate` equals the frozen SHA. The workflow's `validate-candidate` job rejects a SHA that origin cannot reach.
4. Dispatch: `gh workflow run release-candidate-v2.yml --ref hadimoti/owner-binding-candidate -f candidate_sha=<40-character SHA>`.
5. Require `windows-worker-clean (two exact passes)` to succeed in both passes, the acceptance jobs to succeed, and `gate-summary` to pass with no retries.
6. Verify each pass's retained evidence in the store with the retention tool's verify mode, as the workflow does.
7. Record the run ID and the per-scenario results in the matrix. If a gate-required row fails, do not edit the frozen candidate: commit a fix, then start again at step 2 with the new SHA.

**Verdict: NOT-READY.** All nine gate-required rows are open:

- `desktop.export-media-semantics`: the default build crashes on first GPU use, and there is no exact-candidate receipt.
- `desktop.app.restart-save-export`: the default build, and the fresh-profile reopen is open.
- `desktop.windows.installed-lifecycle`: not run. It needs an elevated session or an approved disposable account.
- `release.exact-candidate-two-pass`: no receipt for any SHA after `1482aa7b`.
- `cli.render.playable`, `cli.render.unsupported-features`, `cli.render.failure-recovery`, `cli.render.windows-entrypoints`, and `project.persistence.fresh-process`: local evidence exists for earlier candidates, with no exact-candidate receipt.

Owner decisions outstanding: approve the push and the CI dispatch; approve the shared evidence store; decide the shipped GPU configuration; decide one parity criterion; decide whether the remux route requires `x-joy-frame-count`; run the lifecycle elevated or approve a disposable account; and the owner gate on unsigned distribution, which the matrix records.

## Decisions taken on 2026-10-25

The owner told the orchestrator on 2026-10-25 to finish the v1.0.2 plan without further questions. These decisions follow from the evidence above and change no gate-required row by themselves.

1. **Shipped GPU configuration.** Keep the automatic relaunch fallback (`gpu-encode-fallback.ts`). Normal launches keep hardware encoding, and the Media Foundation video-encoder feature is switched off only after a GPU fast-fail. The known limit stays in the release notes: on a host that fast-fails, the app restarts once and in-flight work from the first session is lost, and the root cause on the RTX 5070 Ti with driver 617.42 is not established. The gate's export spec runs against the default build in the Windows container lane; a failure there is a real gate failure and is not waived.
2. **Parity criterion.** One criterion everywhere: normalized RGB mean absolute error of at most 0.2 between a Monitor sample and the matching decoded export frame, which is the criterion the spec already enforces.
3. **`x-joy-frame-count`.** The header stays optional in this candidate, because no production path omits it and a stricter route would turn an undocumented client's request into a 400. Making it mandatory, with `REQUEST_INVALID` naming the header, is the first change for the next API revision.
4. **P0-4 time budget.** The test budget in `p0-design.e2e.test.ts` goes from 300,000 ms to 600,000 ms. The same work took 296,040 ms in passing run 39644275784 and more than 300,000 ms in failing run 40094432303 on the Windows P0 runner, so the old budget had a 1.3 percent margin. No assertion changed. Run 40134385036 then failed the encoder-active case on its 30,000 ms readiness wait while the host also ran the Linux lanes, so that wait is now 120,000 ms (the cancel must still finish within 5 s). On an idle host the whole test passes in 210.9 s, the browser-active phase is reached after 4.9 s and the encoder-active phase after 22.9 s, so the old 30 s window used about three quarters of its budget with no load at all.

5. **Windows release files to the gate.** The Windows container and the Linux gate share no storage, and the runner contracts forbid a shared host folder. The owner approved a one-day GitHub artifact as transport only, accepting that the unsigned candidate binaries are downloadable from the run page meanwhile. The gate retains and re-verifies the files in its own store, and restores the verified copy for the readiness builder (see the outcome section of `2026-10-23-evidence-store-proposal.md`). It has not run yet.

6. **Canonical caption face at the Windows lifecycle.** The lifecycle had set `JOY_MEDIA_REQUIRE_CAPTION_FACE=1` for the CLI unsupported-feature acceptance since 2026-10-23. Rehearsal run 40134385036 was the first CI run to reach it, and it failed: the canonical face is a WOFF2 file, and every FFmpeg build available for Windows (the BtbN family that CI pins, FreeType 2.14.3 without brotli) logs `Error opening memory font` for it. Reproduced locally on the same build. The same face as WOFF1 opens, but on Windows libass uses DirectWrite, which logs no `fontselect` lines, so the probe would still read it as unusable. The owner had already decided on 2026-10-20 to accept the `SETUP_REQUIRED` refusal on such hosts and to run the caption render checks only where the face loads (commit `8add713d`). The step no longer sets the variable. The case still asserts the exact refusal and counts as passed, not skipped, and the draft release notes keep it as a known gap. Rendering the canonical face on Windows needs a product change (a loadable font format and a probe that does not depend on libass logging), which is out of scope for this candidate.

7. **Export audio sample rate.** Run 40136571482 passed every lane except the installed lifecycle, where the packaged export spec failed one assertion: the exported AAC track was 44,100 Hz and the spec expects 48,000 Hz. The recorder captures audio at the host's rate, and the Windows container has no 48 kHz audio device, while the remux re-encoded without fixing the output rate, so the deliverable depended on the machine. The product already treats 48 kHz as its standard (the silent-audio fallback is 48 kHz), so the remux now sets `-ar 48000`. A regression test feeds a 44.1 kHz recorder-style capture through the remux with and without a frame count and checks 48 kHz stereo and an unchanged length, and it fails without the flag. The spec was not relaxed. A host that already captures at 48 kHz is unaffected.

Still outstanding after these decisions: the exact-candidate two-pass receipt, which does not exist yet, the unsigned-distribution gate, and the release approval.
