# Local GPU, export, persistence, and release-gate evidence (2026-10-24)

Scope: local work on `hadimoti/owner-binding-candidate`. Nothing was pushed, dispatched to CI, opened as a PR, frozen, released, or deployed. No driver, registry, or system setting was changed. Hardware encoding is unchanged for normal launches, and GPU sandboxing is never disabled.

Code commits in this note: `db0cb85e` (GPU fallback and security workstream, the basis of the validation below), `c64ad2fb` and `fb94c553` (documentation and test-count corrections), and `c449ef2d` (the export remux fix in the first section). Each validation result keeps the commit it was measured on.

## Export remux fix (`c449ef2d`)

Symptom: in some captured exports the decoded video is one frame late from frame 30 onward. In the two saved failing runs (`final-gates/failure-capture-loaded/run-3` and `run-5`), the red-to-blue hard cut lands at frame 31 instead of 30, the white flash at frames 91–92 instead of 90–91, and the dissolve at frame 127 instead of 128.

Where it comes from: the recorder output was already correct. `browser-source.mp4`, the MediaRecorder output before the server remux, has red for frames 0–29, blue from 30, the flash at 90–91, and the dissolve from 120, as authored. The shift is introduced by the remux. Running the previous production remux command on the saved recorder output reproduces the shifted export exactly, with frame 29 duplicated at index 30.

Cause: `remuxBrowserMp4` applied the output option `-r 30` after a `setpts` timeline. The output-stage frame-rate conversion duplicated one frame at a rounding boundary of the recorder's vsync-quantised timestamps (steps of about 50 ms and 17 ms alternate in the saved captures), and every later frame moved one slot. The exact arithmetic of that conversion was not traced further; the reproduction and the fix are what is verified.

Withdrawn: the earlier capture-side explanations (a stale canvas capture, a WebGL read-back before commit, and a schedule that arrives "2 to 3 frames late") are not supported by the saved evidence. A CPU-backed staging canvas was built and tested (20 runs, all passing, which could not discriminate) and then reverted.

Fix (`packages/export-core/src/index.ts`): frame N takes its authored slot with an in-graph `fps=<frameRate>:round=near` filter; the timeline is passed through with `-fps_mode passthrough`; the track timescale equals the frame rate, so short clips report the declared rate. The output-stage `-r` now applies only to the unnormalized path. Fractional frame rates are rejected when a frame count is fixed. The browser export sends a frame rate of 30 (`apps/editor-web/src/App.tsx`), so the rejection does not affect it.

Verification:
- Regression test `keeps every browser-capture frame at its authored index when capture timestamps jitter` (export-core): a 180-frame clip whose red channel encodes its index is retimed with vsync-quantised timestamps, and the remux output must match the constant-rate reference at every frame. On the previous remux, 162 of 180 frames are misaligned; on this one, 0.
- Reverse mutations: restoring the previous remux fails the jitter test; removing the in-graph fps filter fails `normalizes slow browser-capture timestamps` (container duration 1.033 s instead of 0.067 s). The file was restored byte-for-byte after each run.
- Saved failing captures through the fixed remux: `run-3` and `run-5` show red 0–29, blue 30–59, dark 60–89, white 90–91, dark 92–119; 180 frames at 30/1, duration 6.000 s.
- Packaged build of the fix, fallback configuration (the switch the relaunch applies): export spec 4 of 4 runs, 2 of 2 tests each (8 of 8); fresh-process render 1 of 1. The packaged `export-core` bundle contains the fix (`video_track_timescale`).
- Other suites: export-core 16 tests pass; worker 58 tests pass and 1 skipped; the API remux test passes; `tsc -b` exit 0; ESLint and Prettier clean on the changed files.

Not verified: the failure did not reproduce in this session on the previous build. That build passed 10 of 10 loaded runs under four busy-loop processes and 6 of 6 under twenty-four, on a 32-core host. The packaged runs therefore show no regression, but they do not show that the failure rate fell. The earlier failure counts (2 of 5 loaded runs and 3 of 34 unloaded runs, in earlier sessions) are explained by the saved-capture reproduction, not measured against the fix.

## Final validation on `db0cb85e`

- Unit suite: 692 files passed and 5 skipped (697); 6,285 tests passed and 31 skipped (6,316); exit 0.
- Typecheck (`tsc -b`): exit 0. ESLint and Prettier: clean on the changed files.
- Reverse mutations on the fallback module: exit-code guard, loop guard, and dropped quit call are each detected by the module tests.
- Seven-viewport audit: 875 passed, 7 skipped, 0 failed; exit 0. The 7 skips are CASE-66, which is blocked by design because it needs an external Worker running `audio.ml-denoise`.
- Packaged fallback configuration: export spec 2 of 2 in four runs (32.4 s, 33.6 s, 32.3 s, 33.6 s); editor acceptance 5 of 5; fresh-process render and stored-clip check 1 of 1. On `c64ad2fb`, the same spec then passed in 1 further chain run and in 10 consecutive repeats (32.2 s to 33.7 s, every run 2 of 2). Across the two builds that is 15 of 15 export runs and 30 of 30 tests. Fifteen passes bound the failure rate only loosely (roughly 20 percent at 95 percent confidence, by the rule of three). Earlier configurations failed intermittently: the global switch failed parity in 2 of 7 runs, and the narrow feature failed the picture check once on an earlier build. At that point the timing defect was unfixed; the remux fix above supersedes that statement.
- Shipped default build, export spec: fails, as designed. The first instance crashes and the relaunch replaces its window.

## GPU crash on the shipped build (fallback shipped; root cause open)

Host: NVIDIA GeForce RTX 5070 Ti, driver 617.42, ANGLE D3D11. The default packaged build's GPU process exits with `-1073740791` (0xC0000409) during media setup, and WebGL is lost for that session.

What was tested (each row is one run of `tests/desktop/export-semantics.spec.ts` on a scratch copy):

| Configuration | Result |
| --- | --- |
| Default | Fails: GPU crash, WebGL lost |
| `MediaRecorder.isTypeSupported` stubbed to true | Fails the same way: not the trigger |
| `--disable-accelerated-video-decode` | Fails the same way: not the trigger |
| `--disable-features=MediaFoundationVideoEncodeAccelerator` | Export completes. Picture check fails at 4 s and Monitor parity at 3 s and 4 s on that earlier build. Sound and timing check passes. |
| `--disable-accelerated-video-encode` (earlier series) | Five of seven runs pass both checks; two fail Monitor parity at 1 s. |

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
- Cross-runner rehearsal on the final SHA.
