# Preview renderer and effect changes (v1.1.1, T-V02)

Scope: the Pixi effect and filter code that the preview builder renders, and the
behaviour it changes for saved projects. Each entry says whether the change fixes
output that rendered blank or wrong, or changes output that used to be right.

Saved projects that use the effects listed in section 5 will look different after this
release. Where the old output was blank, wrong or missing, the new output is the intended
result. Projects that do not use these effects are not affected.

Preview-only parameter overrides (`PREVIEW_PARAM_OVERRIDES` in
`tooling/previews/src/manifest.ts`) change the preview stills only. They do not change
the clip defaults or any saved project.

## 1. Shader precision headers (bug fix: blank output)

Files: `packages/renderer-pixi/src/creative-effects.ts` (`FILTER_VERT`,
`FRAGMENT_HEADER`), `packages/renderer-pixi/src/effects-pixi.ts` (`DEFAULT_FILTER_VERT`,
`EFFECT_FRAG_HEADER`, `VIGNETTE_FRAG`).

`precision highp float;` is now declared in every creative-effects shader and in the
shared effect headers. GLSL ES 3.00 fragment shaders have no default float precision, so
a fragment stage without it fails to compile or link.

- **Verified:** with the header removed from `FRAGMENT_HEADER`, the `pixelate` still
  logs `PixiJS Error: Could not initialize shader` and renders blank. With the header
  restored, it renders and passes the pixel gate.
- **Effects this fixes:** `pixelate`, `mosaic`, `radial-blur`, `tilt-shift`,
  `bayer-dither`, `halftone`, `contour-map`, `glyph-matrix`, `scatter-mosaic`,
  `tone-geometry`, `pixel-sort`. These rendered as the flat `#181818` background before
  (from the earlier T-V02 root-cause work). Only `pixelate` was re-tested with the header
  removed. The other ten are covered by the pixel gate, which now passes for all of them.
- **Not compared before and after:** `posterize`, `monochrome`, `zoom-blur` and `vignette`
  also got the qualifier. They were not in the blank list. Their pre-change output was not
  re-rendered, so no before/after comparison exists for them.

## 2. Halftone and tone-geometry antialiasing (kept: `1.5 / cellSize`)

Files: `packages/renderer-pixi/src/creative-effects.ts`, `HALFTONE_FRAG` and
`TONE_GEOMETRY_FRAG`.

The antialias width changed from `max(fwidth(distanceToShape), 0.006)` to
`max(1.5 / cellSize, 0.006)`.

- **Tested:** the `fwidth` version was restored and both stills were rebuilt with
  `node tooling/previews/build-previews.mjs --only=effects`. The preview renderer logged
  `'fwidth' : no matching overloaded function found`. Both stills came out as uniform
  `#181818` (64x48 stddev 0.00) and failed the pixel gate.
- **Decision:** the swap stays. The `fwidth` form does not compile in the preview renderer
  (Chromium with SwiftShader). Whether it compiles on a user's GPU was not tested.
- **Result:** the stills show the dot and circle patterns. A full rebuild reproduces the
  committed images byte for byte.
- **Possible difference:** on a machine where `fwidth` compiles, the edge softness would
  have followed screen-space derivatives. The fixed `1.5 / cellSize` width is a constant in
  cell units. Nothing was measured on such a machine.

## 3. Colour-matrix effects (bug fixes: wrong output)

Files: `packages/renderer-pixi/src/effects-pixi.ts` (`filterForEffect`),
`packages/visual-effects/src/factories/pixi/BrightnessContrastFilter.ts`.

Pixi's `saturate(a)` sets the saturation factor to `1 + a`. Its `brightness(b)` is a
multiplier, so `1` is neutral and `0` is black.

| Effect                | Before                                                                                                         | After                                                                                                                                                                                                                                                                         | Class                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `brightness-contrast` | `brightness(b)` is a multiplier, so 0 gives black. Contrast scaled the diagonal, pivoting at black.            | A matrix with `scale = 1 + c` and offset `b + 0.5 * (1 - scale)`. Contrast pivots at mid-grey and brightness is additive. At 0/0 the matrix is the exact identity.                                                                                                            | Neutral 0/0 was black (fix). Non-neutral values change output (section 5).                                   |
| `sepia`               | `matrix.sepia()` was then replaced by `matrix.brightness(amount)`, so the output was a dimmed grey, not sepia. | An amount-blended sepia matrix. Diagonal terms are `1 - k * amount` (k = 0.607, 0.314, 0.869). Off-diagonal terms are `k * amount` (0.769, 0.189, 0.349, 0.168, 0.272, 0.534). These are the coefficients in `renderer-headless` and in the ffmpeg `colorchannelmixer` graph. | Fix. All projects using sepia change.                                                                        |
| `hue-saturation`      | Saturation was passed as `s + 1`, which Pixi reads as a delta. The factor was `2 + s`. Headless uses `1 + s`.  | `saturate(s)`, factor `1 + s`. Hue is unchanged.                                                                                                                                                                                                                              | Fix for non-zero saturation.                                                                                 |
| `vibrance`            | `saturate(1 + 0.5a, true)`, factor `2 + 0.5a`. At the neutral 0 this over-saturated the image.                 | Skipped at 0. Otherwise `saturate(0.85a)`, factor `1 + 0.85a`.                                                                                                                                                                                                                | Fix for neutral. **Open:** headless uses `1 + 0.5a`, so Pixi and headless still differ for non-zero amounts. |

Only sepia has a numeric parity test (section 6). Hue-saturation and vibrance have none.
The headless and Pixi luma weights also differ (0.299/0.587/0.114 against Pixi's equal
weights), so those two can differ slightly even where the factor matches.

## 4. Effects that were no-ops in Pixi (behaviour change)

These effects had no Pixi filter. `createCreativeEffectFilter` returned `undefined`, so
they drew nothing. They are now GLSL filters in `effects-pixi.ts`. Saved projects that use
them change from unfiltered to filtered.

| Effect          | Shader               | Notes                                                                                                            |
| --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `color-overlay` | `COLOR_OVERLAY_FRAG` | Mixes toward the RGB colour by opacity.                                                                          |
| `curves`        | `CURVES_FRAG`        | Shadow, midtone and highlight offsets with quadratic weights.                                                    |
| `bulge`         | `BULGE_FRAG`         | Radial magnification. Negative amounts use a different falloff.                                                  |
| `twist`         | `TWIST_FRAG`         | Rotation that falls off to zero at the radius.                                                                   |
| `ripple`        | `RIPPLE_FRAG`        | Radial sine displacement.                                                                                        |
| `crt`           | `CRT_FRAG`           | Scanlines, a small RGB offset and grain.                                                                         |
| `edge-detect`   | `EDGE_DETECT_FRAG`   | Sobel on luma, mixed with the source.                                                                            |
| `emboss`        | `EMBOSS_FRAG`        | Difference of two offset taps, mapped to a grey relief.                                                          |
| `unsharp-mask`  | `UNSHARP_MASK_FRAG`  | Eight-tap ring blur at `max(1.5, 2 * radius)` texels. Detail is scaled by `amount * 3.2` and gated by threshold. |

**Not verified:** the shader maths for these nine effects has no reference renderer to
compare against. The only check is the 64x48 pixel gate. Each still differs from `before`
and is not blank. Whether each matches the intended look was not checked.

## 5. Behaviour changes for saved projects (summary)

- **Blank to rendered** (section 1): `pixelate`, `mosaic`, `radial-blur`, `tilt-shift`,
  `bayer-dither`, `halftone`, `contour-map`, `glyph-matrix`, `scatter-mosaic`,
  `tone-geometry`, `pixel-sort`.
- **Output changed for every project that uses the effect:** `sepia`, `vibrance`, and the
  nine no-op effects in section 4.
- **Output changed for non-neutral values:** `brightness-contrast` (old brightness was a
  multiplier, so `b = 0.5` halved the image; new brightness is additive and contrast pivots
  at mid-grey). At 0/0 the old output was black and the new output is identity.
- **Output changed for non-zero saturation:** `hue-saturation`.
- **Not compared before and after:** `posterize`, `monochrome`, `zoom-blur`, `vignette`.
  Only the precision qualifier was added. If their output was right before, it should be
  unchanged.
- **Not touched by this change:** `blur`, `gaussian-blur`, `bloom`, `glow`, `drop-shadow`,
  `sharpen`, `noise`, `grain`, and all transitions.

## 6. Tests added

- `packages/renderer-pixi/src/effect-shader-contracts.test.ts`
  - Precision: all 14 creative-effects kinds, and the 10 shader-backed Pixi kinds (the nine
    in section 4 plus `vignette`), declare `precision highp float;` in both the vertex and
    fragment stages.
  - `brightness-contrast` at brightness 0 and contrast 0 is the exact 5x4 identity matrix.
    A missing param is treated as 0.
  - At contrast +1 the mid-grey row maps to itself.
- `tooling/previews/src/color-parity.test.ts`
  - Sepia at amounts 0, 0.25, 0.5 and 1, over six colours (black, white, mid-grey and three
    saturated colours). The Pixi matrix matches the `renderer-headless` formula to within one
    8-bit level. It matches the ffmpeg `colorchannelmixer` coefficients to within 0.1 of a
    level. At amount 0 every path is the identity.
- `tooling/release/src/gate.test.ts`
  - `before.webp` is classified as `effect-preview-baseline` and is not counted as an effect
    preview. A fixture with 32 effect previews plus the baseline counts 32, below the floor.

## 7. Release gate and builder

- `MINIMUM_EFFECT_PREVIEW_COUNT` stays at 33, the number of built-in effects. `before.webp`
  is excluded from that count, so a missing effect preview now fails the gate.
- `tooling/previews/build-previews.mjs`
  - Every run, partial or full, fails on a page error or a `console.error` from the harness.
  - The manifest is rewritten only by an unfiltered run, and only after verification passes.
    It is then formatted with the repo's prettier so `format:check` stays clean.
- Root script: `pnpm build:previews` runs the builder.
- Deleted: `tooling/render-previews.mts` and `tooling/generate-effect-motion-previews.mts`.
  Both pointed at files that no longer exist, and nothing else referenced them.

## 8. Verification run

- `node tooling/previews/build-previews.mjs` (full run, no errors). It regenerated the 34
  effect stills and the 38 transition strips. The manifest is byte-identical to the committed
  one, and verification checks each file's SHA-256 against it.
- Budgets: stills 338,870 bytes against a 1,000,000 limit; largest transition 143,846 against
  150,000; total 1,872,876 against 2,000,000.
- Pixel gate: every effect still passes. The minimum mean difference from `before` is 2.60
  (`noise`), and the minimum standard deviation is 30.00 (`drop-shadow`).

## 9. Not addressed in this change

- `vibrance`: Pixi and headless factors differ (section 3).
- `effect-preview-coordinator.ts` and the `.effect-preview-media-*` CSS are dead code.
- Transition strips total about 1.5 MB and nothing consumes them yet.
- The shader digest covers four files. It does not cover the pixi, ffmpeg or libwebp versions.
- On the transitions sheet, `gl:CircleCrop` shows a solid black mid-frame. The review asked
  whether that is correct. It was not checked.
