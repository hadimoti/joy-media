# Local GPU, export, persistence, and release-gate evidence (2026-10-24)

Scope: local work on `hadimoti/owner-binding-candidate`. Nothing was pushed, dispatched to CI, opened as a PR, frozen, released, or deployed. No driver, registry, or system setting was changed. Hardware encoding is unchanged for normal launches, and GPU sandboxing is never disabled.

The validated code commit is `db0cb85e`. Later commits in this note change documentation only.

## Final validation on `db0cb85e`

- Unit suite: 692 files passed and 5 skipped (697); 6,285 tests passed and 31 skipped (6,316); exit 0.
- Typecheck (`tsc -b`): exit 0. ESLint and Prettier: clean on the changed files.
- Reverse mutations on the fallback module: exit-code guard, loop guard, and dropped quit call are each detected by the module tests.
- Seven-viewport audit: 875 passed, 7 skipped, 0 failed; exit 0. The 7 skips are CASE-66, which is blocked by design because it needs an external Worker running `audio.ml-denoise`.
- Packaged fallback configuration (the switch the relaunch applies): export spec 2 of 2 in four runs (32.4 s, 33.6 s, 32.3 s, 33.6 s); editor acceptance 5 of 5; fresh-process render and stored-clip check 1 of 1. That is 4 of 4 export runs passing on `db0cb85e`. On `c64ad2fb`, the same spec then passed in 1 further chain run and in 10 consecutive repeats (32.2 s to 33.7 s, every run 2 of 2). Across the two final builds that is 15 of 15 export runs and 30 of 30 tests. Fifteen passes bound the failure rate only loosely (roughly 20 percent at 95 percent confidence, by the rule of three). Earlier configurations failed intermittently: the global switch failed parity in 2 of 7 runs, and the narrow feature failed the picture check once on an earlier build. The timing defect is therefore unfixed, and this is a measurement, not a guarantee.

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

Consequences of the fallback that a user should know: the relaunch restarts the app, so the first session's in-flight work is lost (the GPU exit had already broken WebGL). Reliability beyond the 4 runs above is not established.

## Export timing defect (open, documented as blocked)

Measured on the packaged build: the first captured frame arrives about 82 ms after recording starts, and later frames follow about 33 ms apart. The offset never recovers. The cause is structural: each frame waits for one `requestAnimationFrame` tick before `requestFrame()`, and the schedule has no catch-up. The final MP4 is remuxed by frame index, so content lands about 2 to 3 frames late. Failing runs show red still on screen at 1 s, and the flash at 3.033 s instead of 3.000 s.

Attempted and rejected:

- `MediaStreamTrackGenerator` with authored `VideoFrame` timestamps, in a standalone page on the fallback configuration. The first attempt awaited the recorder's start event before writing frames and timed out after 90 s: `MediaRecorder` defers its start until its first frame arrives. The second attempt wrote frame 0 before start. The recording then kept only 12 of 90 frames (1,401 bytes) with wall-clock timestamps, so authored timestamps are not honored in this build.

Not attempted: a WebCodecs `VideoEncoder` with its own MP4 muxer. That needs a new dependency and a different mux path. Painting frames ahead of `requestFrame()` is not viable, because the capture samples canvas content at the next composition.

Consequence: export timing is not fixed. GPU export is not reliably validated, and this is documented as blocked on the encode and mux pipeline.

## Persistence after a fresh-profile import (verified)

`project.persistence.fresh-process`: after import, the fresh profile's `joy-media.timeline-project-log.v1` holds the imported clip by asset id. The asset record with its display name is in `joy-media.visual-object-project-log.v1`. The spec previously searched the timeline text for the display name, which an imported project does not carry. It now follows the clip's asset reference to the asset record. Result on the packaged fallback build: 1 passed.

## Flakes (fixed, with evidence)

- CASE-15 (`desktop-1440` audit failure): the import helper waits for the upload's acceptance, then gives the card a separate 60 s budget. The card assertion is unchanged. Result: 6 of 6 passed under three workers.
- API account routes (`fetch failed: bad port`): this host's dynamic TCP range is 1024 to 65534, and `listen(0)` can return a port that fetch refuses (for example 6000, 6665, or 10080). The test servers now listen again until they hold a fetchable port. All 80 listed ports fail with "bad port", and none of 3,997 random unlisted ports do. Result: six API test files, 87 tests, passed.

## Release gates and external blocks

- `desktop.windows.installed-lifecycle`: externally blocked. `net session` exits 2, so this session is not an administrator. `Get-WindowsOptionalFeature` for `Containers-DisposableClientVM` and `Microsoft-Hyper-V-All` fails with "The requested operation requires elevation." The owner must run the lifecycle from an elevated session or approve a disposable account. Not run.
- `release.exact-candidate-two-pass`: externally blocked. It needs a push and a CI dispatch, which were not authorized. Not run.
- `desktop.export-media-semantics`: open. The shipped default build crashes; the fallback configuration passed 15 of 15 measured runs on the final builds, and the timing defect above is unfixed.
- `desktop.app.restart-save-export`: open on the default build for the same reason.

## Artifact integrity and cross-runner requirements

- Release tooling tests: 15 vitest files, 289 tests passed and 1 skipped (`tooling/release`), covering write-once retention, manifest checks, checksum listing, and fail-closed refusals. Re-run on the final tree.
- Requirements the tooling enforces: the evidence root sits outside the checkout, `_work`, and `_temp`; each retention is write-once per candidate, run, and attempt; `SHA256SUMS.txt` must appear in the manifest; the retained manifest must match the staged manifest; and folders are flushed after copy. On Windows, directory flushes are no-ops, so file flushes are the durable step.
- The synthetic cross-runner rehearsal ran for `b8ea8444`, before the retention changes in `46d6e3e2`. It has not been repeated on `db0cb85e`.

## Approved skips

- Seven-viewport audit: the 7 CASE-66 skips, blocked by design (see above).
- Unit suite: 5 skipped files and 31 skipped tests, recorded by the suite itself.

## Unverified or open

- GPU root cause (unproven); export timing defect (blocked); reliability of the fallback beyond 4 runs.
- Installed lifecycle (needs elevation). Exact-candidate two-pass receipts (needs push and CI, not authorized).
- Cross-runner rehearsal on the final SHA.
