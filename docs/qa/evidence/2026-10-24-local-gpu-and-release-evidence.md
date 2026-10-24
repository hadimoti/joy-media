# Local GPU, export, persistence, and release-gate evidence (2026-10-24)

Scope: local work on `hadimoti/owner-binding-candidate`. Nothing was pushed, dispatched to CI, opened as a PR, frozen, released, or deployed. No driver, registry, or system setting was changed. Hardware encoding is unchanged for normal launches, and GPU sandboxing is never disabled.

Code commits in this note: `db0cb85e` (GPU fallback and security workstream, the basis of the validation below), `c64ad2fb` and `fb94c553` (documentation and test-count corrections), and `c449ef2d` and `2cce72bc` (the export remux fix in the first section). Each validation result keeps the commit it was measured on.

## Export remux fix (`c449ef2d`, refined in `2cce72bc` and `219a8120`)

Symptom: in captured exports the decoded video is one frame late from frame 30 onward. In the two saved failing runs (`run-3` and `run-5`, in the local scratch directory and not committed), frames 0–29 match the authored timeline. From frame 30 onward, every frame whose picture changes matches the fixed output one frame earlier. A per-frame comparison of the decoded probe pixel gives 145 frames that match the fixed output at the same index, 35 that match only the frame before, and none that match neither.

Where it comes from: the recorder output was already correct. `browser-source.mp4`, the MediaRecorder output before the server remux, has red for frames 0–29, blue from 30, the flash at 90–91, and the dissolve from 120, as authored. The shift is introduced by the remux. Running the previous production remux command on the saved recorder output reproduces the shifted export exactly, with frame 29 duplicated at index 30.

Cause: `setpts` gives frame N its authored time but keeps each recorder frame's own duration, and those durations are irregular (the saved captures alternate about 50 ms and 17 ms). The previous output-stage `-r 30` resample used those durations, duplicated one frame, and every later frame moved one slot. The earlier reproduction shows the duplicate as one red frame at index 30; identical red frames cannot show which source index it came from.

Withdrawn: the earlier capture-side explanations (a stale canvas capture, a WebGL read-back before commit, and a schedule that arrives "2 to 3 frames late") are not supported by the saved evidence. A CPU-backed staging canvas was built and tested (20 runs, all passing, which could not discriminate) and then reverted.

Fix (`packages/export-core/src/index.ts`, `2cce72bc` and `219a8120`): on the normalized path (a frame count is given), frame N takes time N / frameRate. The chain is `colour,setpts=N/(rate*TB),fps=rate:round=near,tpad` with the frame limit and duration, and `-r` is unchanged. The path without a frame count keeps the original timestamp chain (colour filter and `-r`), so a source at another rate keeps its duration. The first version, `c449ef2d`, added `-fps_mode passthrough`, a track timescale, and a rejection of fractional frame rates. Mutation checks showed those were not needed, so `2cce72bc` removed them, and fractional rates work again.

Known limit: the path without a frame count still duplicates a frame on a jittered capture, which is the original defect. No in-repo caller reaches it. The worker always sends a frame count, the app's client method has no callers, and only API requests that omit `x-joy-frame-count` take this path. Whether the route should require the count is a decision for the owner.

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
- The unit run on `219a8120` failed 10 retention tests. Node v24.22.1 refuses an existing destination for `cpSync`, and the write-once gate relied on it. `0082f6cc` copies one file at a time with exclusive creation, and the same tests pass.

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
