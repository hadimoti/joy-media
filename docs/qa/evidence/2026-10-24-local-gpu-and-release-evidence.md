# Local GPU, export, persistence, and flake evidence (2026-10-24)

Scope: local work on `hadimoti/owner-binding-candidate`. Nothing was pushed, dispatched to CI, opened as a PR, frozen, released, or deployed. No driver, registry, or system setting was changed. Hardware encoding is unchanged for normal launches, and GPU sandboxing is never disabled.

## GPU crash on the packaged build (open)

Host: NVIDIA GeForce RTX 5070 Ti, driver 617.42, ANGLE D3D11. The default packaged build still fails here: the GPU process exits with `-1073740791` (0xC0000409) during media setup, and WebGL is lost for the session.

Each row is one run of `tests/desktop/export-semantics.spec.ts` on a scratch copy of the unchanged build, unless marked otherwise.

| Configuration (scratch copy)                               | Result                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Default                                                    | Fails: "This browser does not support WebGL"                                                                                                  |
| `MediaRecorder.isTypeSupported` stubbed to true            | Fails the same way: not the trigger                                                                                                           |
| `--disable-accelerated-video-decode`                       | Fails the same way: not the trigger                                                                                                           |
| `--disable-features=MediaFoundationVideoEncodeAccelerator` | Export completes. Picture check fails at 4 s (dissolve endpoint not red). Monitor parity fails at 3 s and 4 s. Sound and timing check passes. |
| `--disable-accelerated-video-encode` (earlier series)      | Five of seven runs pass both checks. Two fail Monitor parity at 1 s.                                                                          |

Standalone reproduction: a page with no WebGL, using `MediaStreamTrackGenerator` and an H.264 `MediaRecorder`, also logs exit `-1073740791`. Earlier standalone probes that used `captureStream` did not crash. The root cause is not established. The leading hypothesis (medium confidence) is that the Media Foundation encoder's NVIDIA component aborts inside the sandbox when the media pipeline initializes GPU video services.

Committed fallback (`apps/desktop/src/main/gpu-encode-fallback.ts`): after a GPU exit of `-1073740791`, the app relaunches once with `MediaFoundationVideoEncodeAccelerator` disabled. The relaunch is not persisted. A fallback session that crashes again is not relaunched. The relaunch path is covered by unit tests and two reverse mutations (exit-code guard, loop guard), but not by an end-to-end relaunch test.

## Export timing defect (open)

On the standalone switch run, the first captured frame arrives about 82 ms after the recording starts, and the rest follow about 33 ms apart. The offset never recovers. The capture loop requests a frame after painting it, and the first paint is slow. The final MP4 is remuxed by frame index, so content lands about 2.5 frames late. This matches the observed failures: red still showing at 1 s, and the flash at 3.033 s instead of 3.000 s. No validated fix exists yet. Candidate fixes (authored `VideoFrame` timestamps, or warm-up before recording) are not verified.

## Persistence after a fresh-profile import (verified)

`project.persistence.fresh-process`: after import, the fresh profile's `joy-media.timeline-project-log.v1` holds the imported clip by asset id. The asset record with its display name is in `joy-media.visual-object-project-log.v1`. The spec previously searched the timeline text for the display name, which an imported project does not carry, so it now follows the clip's asset reference to the asset record. Result on the packaged build with the feature off: 1 passed.

## Flakes (fixed)

- CASE-15 (`desktop-1440` audit failure): the import helper now waits for the upload's acceptance, then gives the card a separate 60 s budget. The card assertion is unchanged. Result: 6 of 6 passed under three workers.
- API account routes (`fetch failed: bad port`): this host's dynamic TCP range is 1024–65534, and `listen(0)` can return a port that fetch refuses (for example 6000, 6665, or 10080). The test servers now listen again until they hold a fetchable port. The refused-port set was checked against undici: all 80 listed ports fail, and none of 3,997 random unlisted ports do. Result: six API test files, 87 tests, passed.

## Release gates still open

- `desktop.windows.installed-lifecycle`: needs an elevated session for a disposable account or Windows Sandbox. Not run.
- `release.exact-candidate-two-pass`: needs a push and a CI dispatch, which were not authorized. Not run.
- `desktop.export-media-semantics`: open. Default build blocked by the GPU crash. Fallback configuration has frame drift.
- `desktop.app.restart-save-export`: open on the default build for the same reason.
