# Library test harness (T-V03)

`node tooling/qa/libraries/run-library-tests.mjs` renders library items (effects, filters) with the real Pixi renderer in headless Chromium, reads the pixels back and compares them per channel. It also exports through the app's own `exportOfflineMp4` and compares frame 1.0 s from the export with the preview.

## Transitions (T-V10)

`node tooling/qa/libraries/run-library-tests.mjs --kind transitions --out <dir> --pic1 <left picture> --pic2 <right picture>` (or set `JOY_TRANSITION_PIC1` and `JOY_TRANSITION_PIC2`; there is no built-in picture path). The export frames are extracted with ffmpeg from the encoded MP4. A full run writes `docs/qa/v1.1.1/TRANSITIONS.md`; a run with `--items` or `--limit` only writes into `--out`. `JOY_HARNESS_VERBOSE=1` prints the browser console. The limits of the transition checks are listed in the generated report.

## Known limits

- Only gaussian-blur, sepia and vignette are wired and proven (3 of 3 passed). The `--kind effects` smoke run reported a blank preview for brightness-contrast and no change for `contrast`; this may be a harness mismatch and is not yet resolved, so the effects kind is unproven.
- The ms-per-frame numbers at 1080p come from software GL (SwiftShader) and a 1x1 readback. They will not match what a user sees on a GPU.
- Pass thresholds are loose: export mean delta of at most 12 (vignette showed a max of 81), preview must differ from the Before frame by more than 0.1, and a keyframe passes if the middle frame differs from both ends by more than 0.01.
- Reset is simulated with `setParam` commands, not with the app's Reset action.
- `--face` and the full item lists have not been run.
- The committed accept report was made from a dirty tree; re-run it on the committed head.
