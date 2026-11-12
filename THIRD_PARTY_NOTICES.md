# Third-party notices

## Repository code

Unless a file or directory is listed below with its own terms, JOY Media
source code is released under the MIT License in [`LICENSE`](LICENSE).

## JOY Agent Engine dependencies

- `ai` 7.0.92 — Apache-2.0; provider-neutral AI SDK Core used behind the JOY
  Agent Engine package boundary
- `@ai-sdk/openai-compatible` 3.0.43 — Apache-2.0; OpenAI-compatible provider
  adapter used for session-only BYOK transport
- `zod` 4.1.8 — MIT; runtime schema validation for agent boundaries

## Self-hosted editor fonts

The editor ships the following Fontsource packages at pinned versions in
`apps/editor-web/package.json`. Each package is licensed under the SIL Open
Font License 1.1 (OFL-1.1), and the package's `LICENSE` file remains available
in the installed dependency for audit and release attribution:

- `@fontsource-variable/inter` 5.2.6 — Inter Variable, Latin / Greek / Cyrillic
- `@fontsource-variable/vazirmatn` 5.2.6 — Vazirmatn Variable, Persian / Arabic / Latin
- `@fontsource/noto-sans-arabic` 5.2.6 — Noto Sans Arabic, Arabic / Persian / Latin
- `@fontsource/noto-naskh-arabic` 5.2.6 — Noto Naskh Arabic, Arabic / Persian / Latin

The CSS is imported by `apps/editor-web/src/main.tsx`, so font files are
bundled into the application build rather than fetched from a CDN. The
complete license text and release attribution are shipped in
`apps/editor-web/public/licenses/fonts/OFL-1.1.txt` and
`apps/editor-web/public/licenses/fonts/FONT-ATTRIBUTIONS.md`. The catalog
metadata and compatibility aliases are code-owned in
`packages/project-schema/src/content-fonts.ts`.

Projects written before the migration may still contain retired Fontiran
family identifiers. They are treated as compatibility aliases and resolved to
the open local faces at render/export time; no retired font binaries ship in
the editor.

The former `apps/editor-web/public/fonts/` login-gate files were removed. The
login gate now uses the same bundled Fontsource Inter/Vazirmatn stack as the
editor, so there are no separate unverified font binaries in the artifact and
the Fontiran-specific asset redistribution gate is closed. Whole-artifact
owner/legal review remains a separate release decision.

## gl-transitions

- Project: [gl-transitions/gl-transitions](https://github.com/gl-transitions/gl-transitions)
- License: MIT (see `packages/transition-shaders/GL-TRANSITIONS-LICENSE`)
- Use: curated GLSL transition shaders vendored under `packages/transition-shaders/src/shaders/`
- Authors of included shaders are also recorded in `packages/transition-shaders/src/catalog.json` (`author` and `credit`)

Included shaders (35 from gl-transitions; author and licence as written in each file's own header):

- `fade.glsl` (Dissolve): gre, MIT
- `fadegrayscale.glsl` (Fade Grayscale): gre, MIT
- `wipeLeft.glsl` (Wipe Left): Jake Nelson, MIT
- `wipeRight.glsl` (Wipe Right): Jake Nelson, MIT
- `wipeUp.glsl` (Wipe Up): Jake Nelson, MIT
- `wipeDown.glsl` (Wipe Down): Jake Nelson, MIT
- `RadialWipe.glsl` (Radial Wipe): Xaychru, MIT
- `BrushWipe.glsl` (Brush Wipe): gre, MIT
- `Directional.glsl` (Slide): Gaëtan Renaudeau, MIT
- `SlideAwayRight.glsl` (Slide Away): lizhongjian, MIT
- `LeftRight.glsl` (Push from Right): zhmy, MIT
- `TopBottom.glsl` (Push from Bottom): zhmy, MIT
- `CrossZoom.glsl` (Cross Zoom): rectalogic, MIT
- `SimpleZoom.glsl` (Simple Zoom): 0gust1, MIT
- `ZoomInCircles.glsl` (Zoom Circles): dycm8009, MIT
- `Pinwheel.glsl` (Pinwheel): Mr Speaker, MIT
- `WhipSpin.glsl` (Whip Spin): gre, MIT
- `CircleCrop.glsl` (Circle Crop): fkuteken, MIT
- `HorizontalOpen.glsl` (Horizontal Open): martiniti, MIT
- `VerticalOpen.glsl` (Vertical Open): martiniti, MIT
- `Chessboard.glsl` (Chessboard): lql, MIT
- `windowslice.glsl` (Window Slice): gre, MIT
- `GlitchDisplace.glsl` (Glitch Displace): Matt DesLauriers, MIT
- `GlitchMemories.glsl` (Glitch Memories): Gunnar Roth, MIT
- `TvStatic.glsl` (TV Static): Brandon Anzaldi, MIT
- `Dreamy.glsl` (Dreamy): mikolalysenko, MIT
- `LinearBlur.glsl` (Linear Blur): gre, MIT
- `Overexposure.glsl` (Overexposure): Ben Zhang, MIT
- `EdgeGlow.glsl` (Edge Glow): Woohyun Kim, MIT
- `morph.glsl` (Morph): paniq, MIT
- `crosswarp.glsl` (Cross Warp): Eke Péter <peterekepeter@gmail.com>, MIT
- `ButterflyWaveScrawler.glsl` (Butterfly Wave): mandubian, MIT
- `Kaleidoscope.glsl` (Kaleidoscope): nwoeanhinnogaehr, MIT
- `Ripple.glsl` (Ripple): gre, MIT
- `InkBleed.glsl` (Ink Bleed): gre, MIT

JOY Media's own shaders (3), MIT, adapted from gl-transitions `FadeColor.glsl` by gre (MIT):

- `dipToBlack.glsl` (Dip to Black): JOY Media contributors, MIT
- `dipToWhite.glsl` (Dip to White): JOY Media contributors, MIT
- `dipToColour.glsl` (Dip to Colour): JOY Media contributors, MIT

`CrossZoom.glsl` and `GlitchDisplace.glsl` are changed for JOY Media: redundant `in` parameter qualifiers were removed so they compile in the editor. The shaders added in T-V08 come from gl-transitions commit `1fe42183109f1585efb7a282c9b6b1c459cd548f`; `InvertedPageCurl.glsl` (BSD 3 Clause) and `StereoViewer.glsl` (BSD 2 Clause) are not MIT and are not included.

## HTML overlay layout inspiration

Lower-third / title layout ideas were **re-authored** into ADR-0006 `joy-html-scene-1` packages (no OBS control panels, no wall-clock CSS, no remote fonts):

- [noeal-dac/Animated-Lower-Thirds](https://github.com/noeal-dac/Animated-Lower-Thirds) (MIT)
- [rse/lowerthird](https://github.com/rse/lowerthird) (MIT)
- Template ideas from [tomastimelock/web-overlay](https://github.com/tomastimelock/web-overlay)

## Optional Local Worker masking integrations

These projects are not vendored into the web application or VPS artifact.
Owners may install them on a paired Local Worker through the runner boundary
defined by ADR-0033.

- [facebookresearch/sam3](https://github.com/facebookresearch/sam3) — optional
  SAM 3.1 prompt/tracking adapter; gated checkpoint and custom SAM License.
- [facebookresearch/sam2](https://github.com/facebookresearch/sam2) — optional
  image/video segmentation adapter; Apache-2.0.
- [IDEA-Research/Grounded-SAM-2](https://github.com/IDEA-Research/Grounded-SAM-2)
  and [GroundingDINO](https://github.com/IDEA-Research/GroundingDINO) — optional
  text grounding for SAM 2; Apache-2.0.
- [ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet) — optional
  high-resolution matte model; MIT.
- [danielgatis/rembg](https://github.com/danielgatis/rembg) — used by the
  included image runner adapter; MIT. The package/model is installed and
  cached only on the Local Worker.

## Production runtime dependencies (current candidate)

- `mediabunny` 1.55.7 — MPL-2.0; used by the browser editor decoders under
  `apps/editor-web/src/media-observation/`. The full MPL-2.0 license text is
  shipped at `apps/editor-web/public/licenses/third-party/MPL-2.0.txt`. See
  `docs/reviews/joy-observation-decoder-selection.md` for the package-selection
  and source record.
- `nodemailer` 10.0.12 — MIT-0; API production dependency. This package is not
  bundled in the browser application.
