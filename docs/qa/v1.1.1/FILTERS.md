# T-V04 — Filters audit

Run on integration `10e53cec` (plus the two changes below) with `node tooling/qa/libraries/run-library-tests.mjs --kind filters`: real Pixi renderer in headless Chromium (software GL), pixels read back and compared per channel, a 2 s export through the app's own `exportOfflineMp4` compared with the preview, parameter sweeps, reset / undo / redo, and a keyframe check. Raw reports are in the evidence folder (`T-V04\run1`, `run3f`, `run3e`, `run4`).

## Result

- 15 Filters are in the panel (`apps/editor-web/src/library-homes.ts`). The task text says 20: five former Filters doubles (halftone, scatter-mosaic, contour-map, glyph-matrix, pixel-sort) now live only in Effects (T-V06), so they are covered in `EFFECTS.md` (T-V05). Their first live run is below.
- **15 of 15 pass** after the two changes below: run3f (all 15 after the harness change) passed 14 and its one failure, Bloom, passes in run4 (Bloom and Glow only, after the shader fix). Run1, before both changes, passed 12 of 15. A final single run of all 15 is part of the T-A10 regression.

## Defects found and fixed

1. **Bloom's Threshold slider did nothing**, and Bloom blurred the whole picture instead of adding a glow around bright areas (`packages/renderer-pixi/src/effects-pixi.ts`: blur plus brightness, the `threshold` parameter was never read). Fixed with a single-pass bright-pass bloom shader: only pixels brighter than the threshold feed a 7 by 7 Gaussian-weighted blur that is added back onto the sharp picture; Intensity widens and strengthens it. Saved projects that use Bloom will look different (they were wrong before; see `PREVIEW-RENDER-CHANGES.md`). Cost: about 190 ms per 1080p frame in software GL (the other filters measure 40 to 115 ms); on a GPU it is far cheaper but the 49 taps are the most expensive filter in the list.
2. **Harness: neutral defaults counted as failure.** Hue / Saturation and Vibrance default to 0, so their default preview is correctly identical to the Before frame. The harness now accepts a non-blank neutral default when some adjusted parameter value visibly changes the picture, and says "neutral default, visible when adjusted" in the report. This does not loosen any threshold for the other items.

## Per filter (run3f and run4)

| ID               | Preview vs Before      | Export vs preview    | Params             | Reset / undo / redo | Keyframes | Decision                                                                       |
| ---------------- | ---------------------- | -------------------- | ------------------ | ------------------- | --------- | ------------------------------------------------------------------------------ |
| `monochrome`     | pass                   | pass                 | 4 of 4             | pass                | pass      | Correct                                                                        |
| `bayer-dither`   | pass                   | pass                 | 5 of 5             | pass                | pass      | Correct                                                                        |
| `gaussian-blur`  | pass                   | pass (ffmpeg native) | 1 of 1             | pass                | pass      | Correct                                                                        |
| `zoom-blur`      | pass                   | pass                 | 1 of 1             | pass                | pass      | Correct                                                                        |
| `radial-blur`    | pass                   | pass                 | 1 of 1             | pass                | pass      | Correct                                                                        |
| `tilt-shift`     | pass                   | pass                 | 3 of 3             | pass                | pass      | Correct                                                                        |
| `noise`          | pass                   | pass                 | 1 of 1             | pass                | pass      | Correct                                                                        |
| `pixelate`       | pass                   | pass                 | 1 of 1             | pass                | pass      | Correct                                                                        |
| `bloom`          | pass                   | pass                 | 2 of 2 (after fix) | pass                | pass      | Fixed (defect 1)                                                               |
| `glow`           | pass                   | pass                 | 1 of 1             | pass                | pass      | Passes; note below                                                             |
| `hue-saturation` | pass (neutral default) | pass (ffmpeg native) | 2 of 2             | pass                | pass      | Correct                                                                        |
| `vibrance`       | pass (neutral default) | pass                 | 1 of 1             | pass                | pass      | Passes; the Pixi and headless formulas differ (open, see the build-state page) |
| `sepia`          | pass                   | pass (ffmpeg native) | 1 of 1             | pass                | pass      | Correct                                                                        |
| `posterize`      | pass                   | pass                 | 1 of 1             | pass                | pass      | Correct                                                                        |
| `vignette`       | pass                   | pass                 | 1 of 1             | pass                | pass      | Correct                                                                        |

## Moved to Effects (first live run, `run3e`)

`scatter-mosaic`, `contour-map`, `glyph-matrix` and `pixel-sort` pass. **`halftone` fails only the keyframe check**: keyframing `angle` leaves the middle frame identical to both ends (the static parameter sweep passes 6 of 6). This is open and belongs to T-V05.

## Limits of this audit

- "Different from Before" and "export matches preview" are measured; "looks good" for each filter was judged on the harness before/after renders, not by the owner. The loose thresholds are listed in `tooling/qa/libraries/README.md`.
- Glow still blurs the whole picture and brightens it rather than glowing around highlights; it passes the harness because it changes the picture and exports identically. Whether to rebuild it like Bloom is a product call for the owner (OA-21) and was not changed.
- Timings are software GL, not a GPU.
