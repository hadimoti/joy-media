# LIBRARY-AUDIT.md — the Filter or Effect decision (T-V01)

**How to read this**
1. This file lists every filter, effect and transition that ships in JOY Media v1.1.1, and says which panel each one belongs in.
2. Table 1 is the whole effect registry (33 rows). Table 2 is the whole transition catalogue (20 rows). Table 3 is only the 20 items that appear in **both** panels today, and shows where each one moves.
3. Every id in Table 1 and Table 2 appears exactly once in this file. Table 3 repeats the 20 doubles and adds no new ids.

Written 12 Nov 2026 by MC (the UI and document helper) on branch `v111/libs-ui`, worktree `v111-ui`.
Read from the code, not from memory: `apps/editor-web/src/FiltersPanel.tsx`, `apps/editor-web/src/EffectsPanel.tsx`, `apps/editor-web/src/EffectsPanel.tsx` categories, `packages/visual-effects/src/builtin/registerBuiltins.ts`, `packages/visual-effects/src/builtin/creativePixel.ts`, `packages/transition-shaders/src/catalog.json`, `apps/editor-web/src/effect-preview-url.ts`, `apps/editor-web/src/EffectPreviewMedia.tsx`, `apps/editor-web/src/TemplatesPanel.tsx`, `apps/editor-web/src/TransitionPreviewCard.tsx`.

---

## 1. The rule

> **A Filter changes the look of the picture.** Colour, tone, softness, grain, glow, the shape of the light.
> **An Effect changes the picture itself.** It bends or moves the pixels, breaks the image, or draws new marks over it.

The test to apply to any one item, in this order:

1. **Do the pixels stay where they are?** If yes, it is a Filter.
2. **Are new marks drawn over the picture** (dots, lines, glyphs, print screens)? If yes, it is an Effect.
3. **Are pixels moved, stretched, scattered or broken?** If yes, it is an Effect.
4. Anything still unclear goes to the owner as a one-line question, not a silent choice.

This rule is the one named in the task card T-V01. It is applied below to every one of the 20 doubles.

**What "cost" means in this file:** `low`, `medium`, `high` — the value already stored in the effect registry. It is the app's own speed flag, not a measurement. The heavy badges (T-V05) use it.

**What "Export" means in this file:** whether the effect has an ffmpeg export path (`backend.ffmpeg: true`). If it says **no**, the effect works in the preview but does **not** appear in the exported video. This is the largest single finding in this audit and it is not part of the Filter/Effect decision — it is a defect list for CX (T-V04, T-V05) and for the owner.

**What "Keyframes" means:** whether animating this item over time makes sense. "Partly" means only some of its sliders can be animated (the enum switches cannot).

---

## 2. What the code says today (the facts this audit rests on)

| Fact | Where | Plain words |
|---|---|---|
| 20 filter ids in 4 groups | `FiltersPanel.tsx:13-18` | Blur 6, Texture 5, Creative 5, Looks 4 |
| 33 effect ids in the registry | `registerBuiltins.ts` (25) + `creativePixel.ts` (8) | All 20 filter ids are in here too |
| 20 transition ids | `packages/transition-shaders/src/catalog.json` | 17 different shaders, some listed twice |
| Every one of the 20 filters also appears in the Effects registry | `effectRegistry` | **That is the doubling the owner reported** |
| 11 of the 33 effects are shown **twice inside the Effects panel** | `EffectsPanel.tsx:47-63` | The `Pixel / B&W` group matches on tags, so those effects also appear under their own real category |
| 34 preview PNG files | `public/effects/preview/` | One for every effect, plus one spare `effects-test.png` |
| 19 motion preview loops | `public/effects/preview-motion/joy-motion-01..19.webm` | Only the first 19 effects have a matching loop |
| 14 of 33 effects show the **wrong** motion loop | `effect-preview-url.ts:32-37` | Any id outside the fixed list of 19 gets a loop picked by a hash of its name, so it shows an unrelated video |
| Only 4 of 33 effects can be exported | `backend.ffmpeg` across the registry | brightness-contrast, hue-saturation, sepia, gaussian-blur. **The other 29 never reach the exported video** |
| 18 of 33 effects render in the headless renderer | `backend.headless` | 15 do not |
| Transition cards are drawn by a 2D sketch from two SVG files | `TransitionPreviewCard.tsx` | No transition shows the real transition |
| Templates show a live render of the real scene on hover | `TemplatesPanel.tsx:307-317` | Templates are **not** broken in the same way |

---

## 3. Table 1 — the effect registry (33 rows)

Column **Home** is the decision this audit recommends. `Filters` means it should live only in the Filters panel; `Effects` means it should live only in the Effects panel. Today every row shows in the Effects panel; the 20 rows marked "doubles" also show in the Filters panel.

| # | Id | Name | Home | New category | Parameters (default, range) | Cost | Export | Keyframes | Today |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `brightness-contrast` | Brightness / Contrast | Effects | Colour & Light | brightness 0 (-1 to 1), contrast 0 (-1 to 1) | low | **yes** | Yes | Effects only |
| 2 | `hue-saturation` | Hue / Saturation | **Filters** | Tone & Colour | hue 0 (-1 to 1 turn), saturation 0 (-1 to 1) | low | **yes** | Yes | double |
| 3 | `vibrance` | Vibrance | **Filters** | Tone & Colour | amount 0 (-1 to 1) | low | no | Yes | double |
| 4 | `vignette` | Vignette | **Filters** | Tone & Colour | amount 0.35 (0 to 1) | medium | no | Yes | double |
| 5 | `sepia` | Sepia | **Filters** | Tone & Colour | amount 0.5 (0 to 1) | low | **yes** | Yes | double |
| 6 | `gaussian-blur` | Gaussian Blur | **Filters** | Blur & Focus | strength 4 (0 to 40) | medium | **yes** | Yes | double |
| 7 | `bloom` | Bloom | **Filters** | Light & Glow | intensity 0.4 (0 to 1), threshold 0.6 (0 to 1) | medium | no | Yes | double |
| 8 | `drop-shadow` | Drop Shadow | Effects | Depth & Shadow | opacity 0.5 (0 to 1), distance 8 (0 to 40) | medium | no | Yes | Effects only |
| 9 | `glow` | Glow | **Filters** | Light & Glow | intensity 0.4 (0 to 1) | medium | no | Yes | double |
| 10 | `noise` | Film Grain / Noise | **Filters** | Grain & Texture | amount 0.2 (0.01 to 1) | medium | no | Amount only; the grain is random every frame, not deterministic | double |
| 11 | `posterize` | Posterize | **Filters** | Tone & Colour | levels 8 (2 to 32) | low | no | Yes | double |
| 12 | `pixelate` | Pixelate | **Filters** | Grain & Texture | block size 8 (2 to 64) | medium | no | Yes | double |
| 13 | `color-overlay` | Color Overlay | Effects | Colour & Light | red 255, green 0, blue 0 (each 0 to 255), opacity 0.3 (0 to 1) | low | no | Yes | Effects only |
| 14 | `curves` | Curves | Effects | Colour & Light | shadows 0, midtones 0, highlights 0 (each -0.5 to 0.5) | medium | no | Yes | Effects only |
| 15 | `zoom-blur` | Zoom Blur | **Filters** | Blur & Focus | strength 6 (0 to 20) | medium | no | Yes | double |
| 16 | `radial-blur` | Radial Blur | **Filters** | Blur & Focus | strength 5 (0 to 20) | medium | no | Yes | double |
| 17 | `tilt-shift` | Tilt Shift | **Filters** | Blur & Focus | blur 8 (0 to 20), focus Y 0.5 (0 to 1), focus height 0.3 (0.05 to 1) | high | no | Yes | double |
| 18 | `bulge` | Bulge / Pinch | Effects | Distort & Move | strength 0 (-1 to 1), radius 0.4 (0.05 to 1) | medium | no | Yes | Effects only |
| 19 | `twist` | Twist | Effects | Distort & Move | angle 0 (-2 to 2), radius 0.5 (0.05 to 1) | medium | no | Yes | Effects only |
| 20 | `ripple` | Ripple | Effects | Distort & Move | amplitude 0.02 (0 to 0.1), frequency 10 (1 to 30) | high | no | Yes | Effects only |
| 21 | `crt` | CRT / Retro | Effects | Retro & Screen | scanlines 0.5 (0 to 1), static 0.08 (0 to 0.5) | medium | no | **No** (both sliders are fixed) | Effects only |
| 22 | `edge-detect` | Edge Detect | Effects | Edge & Detail | threshold 0.3 (0.05 to 0.8) | low | no | Yes | Effects only |
| 23 | `emboss` | Emboss | Effects | Edge & Detail | strength 1 (0.1 to 5) | low | no | Yes | Effects only |
| 24 | `mosaic` | Mosaic | Effects | Retro & Screen | block size 16 (4 to 64, step 4) | low | no | Yes | Effects only |
| 25 | `unsharp-mask` | Unsharp Mask | Effects | Edge & Detail | amount 0.5 (0 to 2), radius 1 (0.5 to 5), threshold 0.05 (0 to 0.5) | medium | no | Partly (amount only) | Effects only |
| 26 | `monochrome` | Monochrome Lab | **Filters** | Black & White | threshold 0.5 (0 to 1), softness 0.04 (0 to 0.5), contrast 0.2 (-1 to 2), invert Off/On | low | no | Partly | double |
| 27 | `bayer-dither` | Bayer Dither | **Filters** | Black & White | pixel scale 2 (1 to 12), tone levels 2 (2 to 8), pattern strength 1 (0 to 1), colour Monochrome/Source, invert Off/On | low | no | Partly | double |
| 28 | `halftone` | Halftone Press | **Effects** | Drawn & Printed | screen size 10 (3 to 40), screen angle 22.5 (-180 to 180 deg), ink spread 1 (0.25 to 1.8), shape Dots/Diamonds/Lines, ink Black/Source, invert Off/On | medium | no | Partly | double |
| 29 | `contour-map` | Contour Map | **Effects** | Drawn & Printed | contour count 9 (2 to 24), line weight 0.16 (0.02 to 0.45), edge detail 0.75 (0 to 2), sample radius 1 (1 to 4), invert Off/On | medium | no | Partly | double |
| 30 | `glyph-matrix` | Glyph Matrix | **Effects** | Drawn & Printed | cell width 10 (4 to 32), cell height 14 (6 to 40), glyph density 1 (0.2 to 2), source contrast 0.3 (-1 to 2), glyph style Dots/Pixels/Segments, vertical flow 0 (0 to 1), ink red 110, green 255, blue 155 (each 0 to 255), colour Custom Ink/Source, invert Off/On | medium | no | Partly | double |
| 31 | `scatter-mosaic` | Scatter Mosaic | **Effects** | Distort & Move | tile size 12 (4 to 48), scatter 0.75 (0 to 2), colour levels 8 (2 to 24), colour Monochrome/Source, pattern seed 3 (0 to 20) | low | no | Partly | double |
| 32 | `tone-geometry` | Tone Geometry | Effects | Drawn & Printed | cell size 14 (5 to 48), shape scale 1 (0.25 to 1.8), angle 0 (-180 to 180 deg), shape Circle/Diamond/Cross/Line, ink Black/Source, invert Off/On | medium | no | Partly | Effects only |
| 33 | `pixel-sort` | Pixel Sort | **Effects** | Distort & Move | direction Horizontal/Vertical, shadow gate 0.18 (0 to 1), highlight gate 0.9 (0 to 1), sort length 72 (4 to 240 px), intensity 1 (0 to 1.5), colour Monochrome/Source | high | no | Partly | double |

**Counts after this decision: Filters 15, Effects 18.**

### Export column — read this before running any test

Only **4 of 33** effects can reach the exported video today: `brightness-contrast`, `hue-saturation`, `sepia`, `gaussian-blur`. The other **29** have `backend.ffmpeg: false`, so they draw in the preview and are missing from the export.

This is the same defect the owner reported about the colour tools (the master plan, item 12 of "Where we are"). It is **not** the Filter/Effect question and this card does not fix it. But it breaks the test plan of T-V04 and T-V05 as written: the library harness (T-V03) compares "the preview frame" with "the exported frame" for every item, so 29 of 33 rows will fail for a reason that has nothing to do with the filter itself. **CX needs to know this before T-V03 is written**, so the harness can mark those rows "no export path yet" instead of "broken".

---

## 4. Table 2 — the transition catalogue (20 rows)

Category names are the eight categories T-V08 must fill. Cost is not in the catalogue today; the values here are this audit's proposal, for GB to confirm in T-V08.

| # | Id | Name (label) | Shader | Author | Category | Parameters (default) | Cost | Keyframes | Decision |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `dissolve` | Dissolve | `fade.glsl` | gre | Basic and fades | none | low | No | **remove** (double of `gl:fade`) |
| 2 | `gl:fade` | Dissolve | `fade.glsl` | gre | Basic and fades | none | low | No | **keep** (label changed to "Dissolve") |
| 3 | `wipe` | Wipe Left | `wipeLeft.glsl` | gre | Wipes | none | low | No | **remove** (double of `gl:wipeLeft`) |
| 4 | `gl:wipeLeft` | Wipe Left | `wipeLeft.glsl` | gre | Wipes | none | low | No | **keep** |
| 5 | `slide` | Slide | `Directional.glsl` | lth | Slides and pushes | direction (1, 0) | low | Partly | **remove** (double of `gl:Directional`) |
| 6 | `gl:Directional` | Slide | `Directional.glsl` | lth | Slides and pushes | direction (0, 1) | low | Partly | **keep** (label changed to "Slide") |
| 7 | `gl:fadegrayscale` | Fade Grayscale | `fadegrayscale.glsl` | gre | Basic and fades | intensity 0.3 | low | Yes | keep |
| 8 | `gl:wipeRight` | Wipe Right | `wipeRight.glsl` | gre | Wipes | none | low | No | keep |
| 9 | `gl:wipeUp` | Wipe Up | `wipeUp.glsl` | gre | Wipes | none | low | No | keep |
| 10 | `gl:wipeDown` | Wipe Down | `wipeDown.glsl` | gre | Wipes | none | low | No | keep |
| 11 | `gl:CircleCrop` | Circle Crop | `CircleCrop.glsl` | bampakoa | Shapes and masks | background colour (0,0,0,1) | low | Partly | keep |
| 12 | `gl:morph` | Morph | `morph.glsl` | panrafal | Creative | strength 0.1 | medium | Yes | keep |
| 13 | `gl:Dreamy` | Dreamy | `Dreamy.glsl` | mikolalysenko | Light and glow | none | medium | No | keep |
| 14 | `gl:CrossZoom` | Cross Zoom | `CrossZoom.glsl` | rectalogic | Zooms and spins | strength 0.4 | medium | Yes | keep |
| 15 | `gl:windowslice` | Window Slice | `windowslice.glsl` | gre | Glitch and digital | count 10, smoothness 0.5 | medium | Yes | keep |
| 16 | `gl:SimpleZoom` | Simple Zoom | `SimpleZoom.glsl` | 0gust1 | Zooms and spins | zoom_quickness 0.8 | medium | Yes | keep |
| 17 | `gl:crosswarp` | Cross Warp | `crosswarp.glsl` | Ekeo | Creative | none | high | No | keep |
| 18 | `gl:LinearBlur` | Linear Blur | `LinearBlur.glsl` | gre | Light and glow | intensity 0.1 | low | Yes | keep |
| 19 | `gl:ButterflyWaveScrawler` | Butterfly Wave | `ButterflyWaveScrawler.glsl` | mandragoraS | Creative | amplitude 1, waves 30, colour separation 0.3 | high | Yes | keep |
| 20 | `gl:GlitchDisplace` | Glitch Displace | `GlitchDisplace.glsl` | n3r4zzurr0 | Glitch and digital | none | high | No | keep |

All 20 entries carry the licence **MIT** and an author. `packages/transition-shaders/GL-TRANSITIONS-LICENSE` exists. No transition needs a licence fix before it can ship.

### The three doubles to remove

The three removals the card asks for are rows 1, 3 and 5 above. The rule used:

- **Keep the id that matches the shader's own GL name** (that is the canonical upstream entry), **and give it a plain name in the label**. The label is what the owner reads; the id is what the project stores.
- So `gl:fade` is kept and labelled "Dissolve", `gl:wipeLeft` is kept as "Wipe Left", `gl:Directional` is kept and labelled "Slide".
- Removed ids map to their kept partner so old projects still open: `dissolve` → `gl:fade`, `wipe` → `gl:wipeLeft`, `slide` → `gl:Directional`. The mapping must be applied wherever a transition id is read (T-V08).

### Category check for T-V08

The eight categories are all filled by the 17 kept transitions: Basic and fades 2, Wipes 4, Slides and pushes 1, Zooms and spins 2, Shapes and masks 1, Glitch and digital 2, Light and glow 2, Creative 3. T-V08 needs 30 or more, so 13 or more more must be added; the eight rails above are the ones that already have a home.

---

## 5. Table 3 — the 20 doubles: one home each

"Home today" is the Filters group and the Effects category where the item appears now. "New home" is this audit's decision. "What moves in the picture" is the reason, in the owner's words.

| # | Id | Home today | New home | What moves in the picture | Reason |
|---|---|---|---|---|---|
| 1 | `gaussian-blur` | Filters: Blur | **Filters** | Nothing moves; the picture only turns soft | A filter |
| 2 | `zoom-blur` | Filters: Blur | **Filters** | Nothing moves; the blur radiates from the middle | A filter (a blur look) |
| 3 | `radial-blur` | Filters: Blur | **Filters** | Nothing moves; the blur radiates from the middle | A filter |
| 4 | `tilt-shift` | Filters: Blur | **Filters** | Nothing moves; the top and bottom only turn soft | A filter (the miniature look) |
| 5 | `bloom` | Filters: Blur | **Filters** | Nothing moves; bright parts glow | A filter (light) |
| 6 | `glow` | Filters: Blur | **Filters** | Nothing moves; a halo is drawn around the object | A filter (light) |
| 7 | `noise` | Filters: Texture | **Filters** | Nothing moves; grain is added over the picture | A filter (grain) |
| 8 | `pixelate` | Filters: Texture | **Filters** | The pixels stay; the picture turns into blocks | A filter (texture). *Borderline: flip if you want blocks to count as a drawn style* |
| 9 | `bayer-dither` | Filters: Texture | **Filters** | Nothing moves; tones are turned into an ordered dot pattern | A filter (texture). *Borderline: flip if you want dot patterns to count as a drawn style* |
| 10 | `halftone` | Filters: Texture | **Effects** | **New marks are drawn over the picture**: print dots, diamonds or lines | An effect (a drawn style) |
| 11 | `scatter-mosaic` | Filters: Texture | **Effects** | **The tiles are broken apart and offset** | An effect (the picture moves) |
| 12 | `posterize` | Filters: Creative | **Filters** | Nothing moves; the colour levels are cut down | A filter (tone) |
| 13 | `monochrome` | Filters: Creative | **Filters** | Nothing moves; the tones become black and white | A filter (tone) |
| 14 | `contour-map` | Filters: Creative | **Effects** | **New lines are drawn over the picture**: contour bands and edge lines | An effect (a drawn style) |
| 15 | `glyph-matrix` | Filters: Creative | **Effects** | **The picture is rebuilt** from glyph cells | An effect (a drawn style) |
| 16 | `pixel-sort` | Filters: Creative | **Effects** | **Pixels are stretched into bands** — a deliberate break | An effect (a glitch) |
| 17 | `vignette` | Filters: Looks | **Filters** | Nothing moves; the edges darken | A filter |
| 18 | `sepia` | Filters: Looks | **Filters** | Nothing moves; the tone turns warm | A filter (colour) |
| 19 | `hue-saturation` | Filters: Looks | **Filters** | Nothing moves; the colour changes | A filter (colour) |
| 20 | `vibrance` | Filters: Looks | **Filters** | Nothing moves; dull colour comes back | A filter (colour) |

**Result: 15 stay in Filters, 5 move to Effects.**

### The one thing CC must decide

The card T-V05 says the Effects panel will hold "13 after the Filter or Effect decision", because it assumed all 20 doubles would go to Filters. Applying the rule honestly moves **5** of them the other way, so Effects holds **18**, not 13.

Two ways forward:

- **List A (recommended, this file):** 5 move to Effects. Filters 15, Effects 18. Halftone, Scatter Mosaic, Contour Map, Glyph Matrix and Pixel Sort are shown as Effects, because each one draws marks over the picture or moves the pixels.
- **List B (matches the T-V05 label):** all 20 doubles stay in Filters. Filters 20, Effects 13. Five rows in Table 3 change one word each (`halftone`, `scatter-mosaic`, `contour-map`, `glyph-matrix`, `pixel-sort` move back to Filters).

Both lists are complete. **CC signs off one of them** (the card's acceptance rule). Until then, T-V06 should not start, because it applies the list.

---

## 6. New category names (sorted)

### Filters — 5 categories, 15 items

| Category | Items |
|---|---|
| Black & White | monochrome, bayer-dither |
| Blur & Focus | gaussian-blur, zoom-blur, radial-blur, tilt-shift |
| Grain & Texture | noise, pixelate |
| Light & Glow | bloom, glow |
| Tone & Colour | hue-saturation, vibrance, sepia, posterize, vignette |

`vignette` sits in Tone & Colour because it changes tone only; if the owner prefers it under Light & Glow, that is a one-line move.

### Effects — 6 categories, 18 items

| Category | Items |
|---|---|
| Colour & Light | brightness-contrast, color-overlay, curves |
| Depth & Shadow | drop-shadow |
| Distort & Move | bulge, twist, ripple, pixel-sort, scatter-mosaic |
| Drawn & Printed | tone-geometry, halftone, contour-map, glyph-matrix |
| Edge & Detail | edge-detect, emboss, unsharp-mask |
| Retro & Screen | crt, mosaic |

Two categories are dropped and one is added compared with today:

- Today the Effects panel has `Pixel / B&W`, `Color`, `Stylize`, `Artistic`, `Blur`, `Distort`, `Depth`, plus the two fake groups `Recipes` and `Favorites`.
- **Dropped:** `Pixel / B&W` (it matched on tags, so 11 effects were shown twice inside the panel), `Color`, `Stylize`, `Artistic`, `Blur` (the Blur items are all Filters now).
- **Kept as a group:** `Depth` becomes Depth & Shadow; `Distort` becomes Distort & Move.
- `Recipes` and `Favorites` stay as they are (they are not content categories; Favourites is what the owner saved).

---

## 7. The preview problem, and whether Templates and Animate have it

### Filters and Effects

The still preview is a single PNG per id: `/effects/preview/<id>.png`. There are 34 files and all 33 effects have one, plus one spare (`effects-test.png`). So the **still** preview is present for everything. The problem is the **moving** preview: `EffectPreviewMedia` plays `/effects/preview-motion/joy-motion-NN.webm` on top of the still. Only 19 effects have a matching loop; for the other 14 the file is picked by a hash of the effect name, so those cards play an unrelated video. The 14 are: `ripple`, `crt`, `edge-detect`, `emboss`, `mosaic`, `unsharp-mask`, `monochrome`, `bayer-dither`, `halftone`, `contour-map`, `glyph-matrix`, `scatter-mosaic`, `tone-geometry`, `pixel-sort`.

T-V02 (CX) replaces all of this with one builder script and one preview per id, so this list is the check: after T-V02, no card may show a preview that belongs to a different id.

### Transitions

There is **no preview file** for any transition. Every card draws the same 2D sketch from two SVGs (`/assets/transition-preview-frame-a.svg` and `-b.svg`), so all 20 cards look alike and none of them shows the transition it will really play. T-V08 adds the real transitions and T-V02b builds the strips.

### Templates — no, they are fine

`TemplatesPanel` shows a thumbnail (`getFirstPartySceneThumbUrl`) and, when the pointer goes over the card, mounts a **live render of the real scene** (`createScenePreviewHost`). The template therefore shows what it really is. **No fix needed**, and the Templates panel is the pattern the other three panels should copy.

### Animate (the Motion panel) — part of the same problem

The Animate surface is `MotionPanel.tsx`; there is no `AnimatePanel.tsx`. It animates the properties of elements already on the timeline rather than showing a library of pictures, so it has no picture previews of its own to be wrong. It does share the same two asset folders (`public/effects/preview` and `public/effects/preview-motion`), so anything that borrows the effect previews inherits the wrong-loop problem above. *UNVERIFIED:* I did not check every thumbnail inside `MotionPanel.tsx` line by line; I checked the file names and the shared helpers.

---

## 8. Coverage check

| Registry | Count | In this file |
|---|---|---|
| Effect ids (`registerBuiltins.ts` + `creativePixel.ts`) | 33 | 33, each exactly once in Table 1 |
| Filter ids (`FiltersPanel.tsx:13-18`) | 20 | 20, each exactly once in Table 3, all also in Table 1 as the 20 doubles |
| Transition ids (`catalog.json`) | 20 | 20, each exactly once in Table 2 (17 kept, 3 marked for removal) |
| Transition categories filled | 8 of 8 | yes, in Table 2 |

**No owner item is left unmapped, and no id is invented.** All 73 registry ids (33 effects + 20 transitions + the 20 filter ids that are a subset of the 33) appear here.

---

## 9. What this card does not fix, and who owns it next

| # | Finding | Owner |
|---|---|---|
| 1 | Only 4 of 33 effects reach the export (`backend.ffmpeg: false` for 29) | CX, before T-V03 writes the harness; needs an owner decision on how many are fixed for v1.1.1 |
| 2 | 14 of 33 effect cards play the wrong motion loop | CX, T-V02 |
| 3 | 11 effects are shown twice inside the Effects panel (`Pixel / B&W` matches on tags) | MC, T-V06 |
| 4 | 20 items appear in both panels | MC, T-V06 (after the list is signed off) |
| 5 | No transition has a real preview | GB, T-V08 (the 30 or more) + CX, T-V02b |
| 6 | The cost badges are a lightning bolt and a warning triangle with no words | CX, T-V05 |
| 7 | `brightness-contrast`, `curves` and `color-overlay` are "look" items but sit in Effects, because only the 20 doubles were in scope for this card | **CC**: either accept, or widen T-V06 to move them too |
| 8 | `vignette` could sit under Light & Glow instead of Tone & Colour | owner, one word |

## 10. Evidence

- This file, `docs/qa/v1.1.1/LIBRARY-AUDIT.md`, on branch `v111/libs-ui`.
- Counts were read from the code and re-counted here: 33 effects (25 + 8), 20 filters (6+5+5+4), 20 transitions, 34 preview PNGs, 19 motion loops, 4 effects with `ffmpeg: true`.
- No code was changed by this card. No app was launched. Nothing was deployed.

---

## 7. Sign-off (CC, 12 Nov 2026)

- **Decision: List A** (the strict rule). Filters 15, Effects 18. Five doubles move to Effects: `halftone`, `scatter-mosaic`, `contour-map`, `glyph-matrix`, `pixel-sort`. T-V06 applies this list; T-V05 therefore tests 18 effects that stay in Effects (not 13).
- **Caution on "only 4 of 33 effects reach the export":** this reads the `backend.ffmpeg` flag. The editor's export draws through the same Pixi renderer as the preview (`App.tsx` export path, resolution 1), so the flag may only describe a second, ffmpeg-based path. **UNVERIFIED.** T-V03 settles it with a preview-against-export compare for every row (tool: T-A10a). If an effect really is missing from the export, it is a blocker defect and T-V05 fixes it.
- Findings 2 and 3 of the result (wrong motion loops on 14 effect cards; 11 effects shown twice inside the Effects panel) go to T-V07 (card design) and T-V06.
