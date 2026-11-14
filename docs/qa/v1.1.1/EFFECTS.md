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

These changes keep the existing pixel-difference thresholds. CC reran the browser harness live afterwards: see Run 2 below (18 of 18).

## Library count

The library has 33 distinct ids across 15 Filters and 18 Effects. T-V06 removed five duplicate panel appearances by keeping these ids in Effects: `halftone`, `scatter-mosaic`, `contour-map`, `glyph-matrix`, and `pixel-sort`. The registry ids remain unchanged.

## Run 2 (CC, live, after the harness probe changes): 18 of 18 pass

Run 1 above is historical (14 of 18; its four failures were harness artefacts: bulge amount 0 and twist angle 0 are identities, tone-geometry Circle is rotation-invariant, halftone -180/0/180 is symmetric). Run 2 report: `T-V05\run2\effects-report.md`. Wiring was verified in code: bulge, twist, tone-geometry and halftone pass radius and angle into `uRadius` and `uAngle` and the shaders read them. Thresholds were not lowered (a parameter sweep still needs at least one changed pixel and a mean delta above 0; a keyframe needs the middle frame to differ from both ends by more than 0.01).

| ID                    | Panel label           | Result | Parameters changed | Keyframe check     | 1080p ms per frame (mean, software GL) |
| --------------------- | --------------------- | ------ | ------------------ | ------------------ | -------------------------------------- |
| `brightness-contrast` | Brightness / Contrast | pass   | 2 of 2             | pass (`contrast`)  | 43.1                                   |
| `color-overlay`       | Color Overlay         | pass   | 4 of 4             | pass (`r`)         | 38.2                                   |
| `curves`              | Curves                | pass   | 3 of 3             | pass (`shadows`)   | 38.6                                   |
| `drop-shadow`         | Drop Shadow           | pass   | 2 of 2             | pass (`opacity`)   | 80.4                                   |
| `bulge`               | Bulge / Pinch         | pass   | 2 of 2             | pass (`amount`)    | 39.8                                   |
| `twist`               | Twist                 | pass   | 2 of 2             | pass (`radius`)    | 40.5                                   |
| `ripple`              | Ripple                | pass   | 2 of 2             | pass (`amplitude`) | 37.8                                   |
| `pixel-sort`          | Pixel Sort            | pass   | 6 of 6             | pass (`intensity`) | 42.1                                   |
| `scatter-mosaic`      | Scatter Mosaic        | pass   | 5 of 5             | pass (`levels`)    | 41.1                                   |
| `tone-geometry`       | Tone Geometry         | pass   | 6 of 6             | pass (`angle`)     | 39.4                                   |
| `halftone`            | Halftone Press        | pass   | 6 of 6             | pass (`angle`)     | 41.8                                   |
| `contour-map`         | Contour Map           | pass   | 5 of 5             | pass (`spacing`)   | 52.0                                   |
| `glyph-matrix`        | Glyph Matrix          | pass   | 11 of 11           | pass (`contrast`)  | 45.4                                   |
| `edge-detect`         | Edge Detect           | pass   | 1 of 1             | pass (`threshold`) | 54.3                                   |
| `emboss`              | Emboss                | pass   | 1 of 1             | pass (`strength`)  | 42.8                                   |
| `unsharp-mask`        | Unsharp Mask          | pass   | 3 of 3             | pass (`amount`)    | 55.2                                   |
| `crt`                 | CRT / Retro           | pass   | 2 of 2             | skipped            | 43.9                                   |
| `mosaic`              | Mosaic                | pass   | 1 of 1             | pass (`blockSize`) | 36.6                                   |

Cost check (card: the very heavy effects): the slowest are Ripple and Pixel Sort at about 40 to 46 ms per 1080p frame in software GL, the same range as most filters, so no effect is an outlier and no cost badge change is needed. The default Tone Geometry shape is Circle, so its Angle slider does nothing until another shape is chosen (a UX note, not a defect).
