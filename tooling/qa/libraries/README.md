# Library test harness (T-V03)

`node tooling/qa/libraries/run-library-tests.mjs` renders library items (effects, filters) with the real Pixi renderer in headless Chromium, reads the pixels back and compares them per channel. It also exports through the app's own `exportOfflineMp4` and compares frame 1.0 s from the export with the preview.

## Transitions (T-V10)

`node tooling/qa/libraries/run-library-tests.mjs --kind transitions --out <dir> --pic1 <left picture> --pic2 <right picture>` (or set `JOY_TRANSITION_PIC1` and `JOY_TRANSITION_PIC2`; there is no built-in picture path). The export frames are extracted with ffmpeg from the encoded MP4. A full run writes `docs/qa/v1.1.1/TRANSITIONS.md`; a run with `--items` or `--limit` only writes into `--out`. `JOY_HARNESS_VERBOSE=1` prints the browser console. The limits of the transition checks are listed in the generated report.

## Known limits

- Full filters and effects runs were completed on the current harness. The reports in the run output are the evidence; the current known reproducible export mismatches are drop-shadow and CRT.
- The ms-per-frame numbers at 1080p come from software GL (SwiftShader) and a 1x1 readback. They will not match what a user sees on a GPU.
- Export comparison permits a mean absolute channel delta of at most 12 after MP4 encoding. A high maximum delta can come from a small number of codec-affected channels; the mean remains the acceptance metric.
- Preview change and parameter change require a mean RGB delta greater than 1.0; keyframes require the middle frame to differ from both endpoints by more than 0.4. These floors are above the lowest passing measurements in the full current run (1.15 for a parameter and 0.47 for a keyframe).
- The harness tests reset-to-default parameter values with history undo/redo, then removes the effect and checks that the rendered pixels return to Before within 0.5 mean delta. It exercises project commands, not the app's Reset button UI.
- The full run uses the built-in four-quadrant chart, including a generated portrait. `--face` can substitute a portrait photo, but a supplied photo was not used in this run.
- The committed accept report was made from a dirty tree; re-run it on the committed head.
