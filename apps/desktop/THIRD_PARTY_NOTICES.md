# Third-party notices for the JOY Media desktop package

The file paths in this notice are relative to the directory containing the packaged app's THIRD_PARTY_NOTICES.md.

## JOY Media

JOY Media source code is released under the MIT License. See the [project license](LICENSE).

## Bundled editor fonts

The packaged editor includes Inter Variable from `@fontsource-variable/inter` 5.2.6, Vazirmatn Variable from `@fontsource-variable/vazirmatn` 5.2.6, Noto Sans Arabic from `@fontsource/noto-sans-arabic` 5.2.6, and Noto Naskh Arabic from `@fontsource/noto-naskh-arabic` 5.2.6. These fonts are licensed under the SIL Open Font License 1.1. See the complete [OFL-1.1 license](renderer/licenses/fonts/OFL-1.1.txt) and [font attributions](renderer/licenses/fonts/FONT-ATTRIBUTIONS.md).

## Mediabunny

Mediabunny 1.55.7 is used by the browser editor media decoders and is licensed under the Mozilla Public License 2.0. See the complete [MPL-2.0 license](renderer/licenses/third-party/MPL-2.0.txt) and the [Mediabunny v1.55.7 source](https://github.com/Vanilagy/mediabunny/tree/v1.55.7).

## gl-transitions

The editor includes vendored transition shaders from [gl-transitions/gl-transitions](https://github.com/gl-transitions/gl-transitions), licensed under the MIT License. See the complete [gl-transitions license](renderer/licenses/third-party/GL-TRANSITIONS-LICENSE).

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

## playwright-core

The Worker imports `playwright-core` 1.62.1 for its GPU preview host. It is licensed under the Apache License 2.0. See its [license](node_modules/playwright-core/LICENSE) and [third-party notices](node_modules/playwright-core/ThirdPartyNotices.txt).
