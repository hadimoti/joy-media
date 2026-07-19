# P00 gate-review evidence

Reviewed: 2026-07-19
Status: evidence complete; owner UX approval remains required before P01 opens.

## Evidence reviewed

| Exit criterion                                        | Evidence                                                                                                                                                                                                                                          | Review result         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Required ADRs accepted                                | ADR-0002 through ADR-0010 cover time, persistence, command semantics, rendering, HTML sandbox, browser/desktop roles, asset identity, and Worker protocol.                                                                                        | Pass                  |
| Reopen reproduces reference output                    | Serialized command logs replay to identical projects; a serialized RenderFrameIR has identical preview/headless output; a serialized PCM fixture has identical waveform and WAV SHA-256.                                                          | Pass                  |
| No renderer/path/provider leakage into project schema | `project-schema` holds structural creative data only. Its source imports only local time primitives; no Pixi/DOM/FFmpeg/provider import exists. Physical paths are private to `LocalAssetBridge`, while public records expose opaque tokens only. | Pass                  |
| Preview/export differences documented                 | See the measured scope below.                                                                                                                                                                                                                     | Pass within P00 scope |
| Owner approval of vertical-slice UX                   | Requires an explicit owner decision after reviewing the P00 direction.                                                                                                                                                                            | Pending owner         |

## Measured preview/export scope

The P00.3 fixture is a 32×18 deterministic synthetic scene containing image, resolved video-frame, bitmap text, and an evaluated translate/scale animation. At 0, 500,000, and 1,000,000 µs, the fixed-setting preview adapter and headless reference rasterizer have **0 differing pixels**; their pinned FNV-1a frame digests are identical.

Known non-parity areas are deliberately not hidden by that result:

| Area                                  | P00 status                                                                                 | Required follow-up                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Real PixiJS/GPU compositing           | Not measured; P00 uses a deterministic Pixi-facing test-mode adapter.                      | P02 retained Pixi implementation + golden comparison |
| Media decode/codecs, fonts, color/HDR | Not implemented/measured.                                                                  | P02 render/asset pipeline fixtures                   |
| HTML scene browser capture            | Contract-only Node harness, not Chromium capture.                                          | P04 isolated runtime/capture validation              |
| Audio output                          | Deterministic PCM WAV and one-hour 48 kHz clock drift ≤21 µs, but no codec/mix parity yet. | P02/P05 audio graph/export parity                    |

## Gate conclusion

All evidence controlled by implementation is present and `pnpm check` is green. P01 remains intentionally closed until the owner explicitly approves the vertical-slice UX direction; that approval is a product authority, not a self-review item.
