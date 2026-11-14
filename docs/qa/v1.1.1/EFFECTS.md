# Effects library audit

The saved Effects harness run tested 18 panel items: 14 passed and 4 failed. The four failures were harness artefacts caused by neutral companion parameters or symmetric angle samples; the descriptor bindings and shader code use the affected parameters. No effect shader defect was found by this audit.

## Run 1 results

| Effect                | Result | Effect defect? | Decision                                              |
| --------------------- | ------ | -------------- | ----------------------------------------------------- |
| `brightness-contrast` | PASS   | No             | Keep the current probe.                               |
| `color-overlay`       | PASS   | No             | Keep the current probe.                               |
| `curves`              | PASS   | No             | Keep the current probe.                               |
| `drop-shadow`         | PASS   | No             | Keep the current probe.                               |
| `bulge`               | FAIL   | No             | Sweep `radius` with `amount: 0.65`.                   |
| `twist`               | FAIL   | No             | Sweep and keyframe `radius` with `angle: 1.25`.       |
| `ripple`              | PASS   | No             | Keep the current probe.                               |
| `pixel-sort`          | PASS   | No             | Keep the current probe.                               |
| `scatter-mosaic`      | PASS   | No             | Keep the current probe.                               |
| `tone-geometry`       | FAIL   | No             | Probe `angle` with Line shape and asymmetric samples. |
| `halftone`            | FAIL   | No             | Use asymmetric angles for the keyframe probe.         |
| `contour-map`         | PASS   | No             | Keep the current probe.                               |
| `glyph-matrix`        | PASS   | No             | Keep the current probe.                               |
| `edge-detect`         | PASS   | No             | Keep the current probe.                               |
| `emboss`              | PASS   | No             | Keep the current probe.                               |
| `unsharp-mask`        | PASS   | No             | Keep the current probe.                               |
| `crt`                 | PASS   | No             | Keep the current probe.                               |
| `mosaic`              | PASS   | No             | Keep the current probe.                               |

## Diagnosis

- `bulge.radius` is bound to `uRadius` and read by `BULGE_FRAG`. With `amount` at 0, the warp factor is 1 for every radius, so the radius sweep cannot change pixels.
- `twist.radius` is bound to `uRadius` and read by `TWIST_FRAG`. With `angle` at 0, the twist angle is 0 at every radius. The saved keyframe diagnostics show the radius values are evaluated at start, middle, and end; the missing pixel difference comes from the neutral angle.
- `tone-geometry.angle` is bound to `uAngle` and rotates the local shape coordinates in `TONE_GEOMETRY_FRAG`. The default Circle is rotationally invariant. The new Line context makes rotation visible, and asymmetric samples avoid the previous full-turn equivalence.
- `halftone.angle` is bound to `uAngle` and rotates the screen grid in `HALFTONE_FRAG`. The saved `-180` / `0` / `180` keyframe samples are equivalent by grid symmetry. The new values keep the middle image distinct from both endpoints.
- The keyframe failures do not show a missing animation application: the saved run reports the animation present and records the parameter value at all three sample times. The equivalent render states explain the zero pixel deltas.

## Harness changes for the next run

- `bulge`: use `amount: 0.65` as the context for the `radius` sweep.
- `twist`: use `angle: 1.25` as the context for the `radius` sweep and its keyframe check.
- `tone-geometry`: use `shape: 3` for the `angle` sweep and keyframes; sweep `-47 / 0 / 47`; keyframe `-68 → 50` with middle `-9`.
- `halftone`: sweep `-24.5 / 22.5 / 69.5`; keyframe `-68.5 → 50.5` with middle `-9`.

These changes keep the existing pixel-difference thresholds. The browser harness was not rerun in this task; CC should rerun it and replace the historical Run 1 outcomes with the new render evidence.

## Library count

The library has 33 distinct ids across 15 Filters and 18 Effects. T-V06 removed five duplicate panel appearances by keeping these ids in Effects: `halftone`, `scatter-mosaic`, `contour-map`, `glyph-matrix`, and `pixel-sort`. The registry ids remain unchanged.
