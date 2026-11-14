# Library test harness (T-V03)

`node tooling/qa/libraries/run-library-tests.mjs` renders library items (effects, filters) with the real Pixi renderer in headless Chromium, reads the pixels back and compares them per channel. It also exports through the app's own `exportOfflineMp4` and compares frame 1.0 s from the export with the preview.

## Known limits

- Only gaussian-blur, sepia and vignette are wired and proven (3 of 3 passed). The `--kind effects` smoke run reported a blank preview for brightness-contrast and no change for `contrast`; this may be a harness mismatch and is not yet resolved, so the effects kind is unproven.
- The ms-per-frame numbers at 1080p come from software GL (SwiftShader) and a 1x1 readback. They will not match what a user sees on a GPU.
- Pass thresholds are loose: export mean delta of at most 12 (vignette showed a max of 81), preview must differ from the Before frame by more than 0.1, and a keyframe passes if the middle frame differs from both ends by more than 0.01.
- Reset is simulated with `setParam` commands, not with the app's Reset action.
- `--face` and the full item lists have not been run.
- The committed accept report was made from a dirty tree; re-run it on the committed head.
