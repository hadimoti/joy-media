# v1.1.1 Transitions QA — T-V10

Comprehensive verification of all 38 catalogue transitions across 8 categories for JOY Media v1.1.1.
Closes **OB-09d** (Transitions: every one tested).

- **Generated**: 2026-11-14T12:51:16.552Z
- **Git commit**: `8ef929d5`
- **Transitions tested**: 38 / 38 (35 passed, 3 failed)
- **Preview resolution**: 960x540
- **Benchmark resolution**: 1920x1080
- **Known test clips**: two pictures supplied with --pic1 (Left) and --pic2 (Right)
- **Export frames**: extracted with ffmpeg from the encoded MP4 (not from the renderer's own pixels)
- **Audio crossfade**: Equal-power cosine/sine curve (48 kHz, 1.0s window)

## 1. Transitions Summary Matrix

| ID | Category | Label | Preview (0%, 25%, 50%, 75%, 99%) | Encoded MP4 vs Preview (5 pts) | Options (Dur/Dir/Col/Progress/Params) | Audio Crossfade | 1080p ms/f | Status |
|---|---|---|---|---|---|---|---|---|
| `gl:fade` | basic-fades | Dissolve | PASS (ΔA@0=0.00, ΔB@75=4.01, ΔB@99=0.15, mid=8.04) | PASS (5/5 pts, mean Δ=1.66) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 44.22 ms | **PASS** |
| `gl:fadegrayscale` | basic-fades | Fade Grayscale | PASS (ΔA@0=0.00, ΔB@75=6.58, ΔB@99=0.18, mid=10.98) | PASS (5/5 pts, mean Δ=1.44) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 47.15 ms | **PASS** |
| `joy:dipToBlack` | basic-fades | Dip to Black | PASS (ΔA@0=0.00, ΔB@75=23.85, ΔB@99=0.26, mid=28.58) | PASS (5/5 pts, mean Δ=1.23) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 44.87 ms | **PASS** |
| `joy:dipToWhite` | basic-fades | Dip to White | PASS (ΔA@0=0.00, ΔB@75=111.29, ΔB@99=1.90, mid=194.11) | PASS (5/5 pts, mean Δ=1.24) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 44.33 ms | **PASS** |
| `joy:dipToColour` | basic-fades | Dip to Colour | PASS (ΔA@0=0.00, ΔB@75=50.00, ΔB@99=0.90, mid=86.88) | PASS (5/5 pts, mean Δ=3.78) | dur:PASS, col:PASS, prog:PASS, params:4/4 | PASS (jump<0.01, power=1.0) | 45.18 ms | **PASS** |
| `gl:wipeLeft` | wipes | Wipe Left | PASS (ΔA@0=0.00, ΔB@75=0.22, ΔB@99=0.00, mid=7.85) | PASS (5/5 pts, mean Δ=1.69) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 44.60 ms | **PASS** |
| `gl:wipeRight` | wipes | Wipe Right | PASS (ΔA@0=0.00, ΔB@75=0.81, ΔB@99=0.00, mid=7.85) | PASS (5/5 pts, mean Δ=1.69) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 44.50 ms | **PASS** |
| `gl:wipeUp` | wipes | Wipe Up | PASS (ΔA@0=0.00, ΔB@75=2.92, ΔB@99=0.00, mid=7.84) | PASS (5/5 pts, mean Δ=1.69) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 45.62 ms | **PASS** |
| `gl:wipeDown` | wipes | Wipe Down | PASS (ΔA@0=0.00, ΔB@75=0.00, ΔB@99=0.00, mid=7.84) | PASS (5/5 pts, mean Δ=1.70) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 44.78 ms | **PASS** |
| `gl:RadialWipe` | wipes | Radial Wipe | PASS (ΔA@0=0.01, ΔB@75=1.57, ΔB@99=0.00, mid=7.45) | PASS (5/5 pts, mean Δ=1.71) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 44.48 ms | **PASS** |
| `gl:BrushWipe` | wipes | Brush Wipe | PASS (ΔA@0=0.00, ΔB@75=0.54, ΔB@99=0.00, mid=6.63) | PASS (5/5 pts, mean Δ=1.66) | dur:PASS, prog:PASS, params:4/4 | PASS (jump<0.01, power=1.0) | 86.13 ms | **PASS** |
| `gl:Directional` | slides-pushes | Slide | PASS (ΔA@0=0.00, ΔB@75=32.33, ΔB@99=10.67, mid=26.02) | PASS (5/5 pts, mean Δ=1.69) | dur:PASS, dir:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 44.40 ms | **PASS** |
| `gl:SlideAwayRight` | slides-pushes | Slide Away | PASS (ΔA@0=0.00, ΔB@75=4.62, ΔB@99=0.15, mid=15.52) | PASS (5/5 pts, mean Δ=1.62) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 44.43 ms | **PASS** |
| `gl:LeftRight` | slides-pushes | Push from Right | PASS (ΔA@0=0.00, ΔB@75=34.20, ΔB@99=10.76, mid=27.90) | PASS (5/5 pts, mean Δ=1.74) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 43.52 ms | **PASS** |
| `gl:TopBottom` | slides-pushes | Push from Bottom | PASS (ΔA@0=0.00, ΔB@75=35.02, ΔB@99=5.92, mid=26.74) | PASS (5/5 pts, mean Δ=1.77) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 42.33 ms | **PASS** |
| `gl:CrossZoom` | zooms-spins | Cross Zoom | PASS (ΔA@0=0.00, ΔB@75=16.90, ΔB@99=0.07, mid=26.01) | PASS (5/5 pts, mean Δ=1.69) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 184.33 ms | **PASS** |
| `gl:SimpleZoom` | zooms-spins | Simple Zoom | PASS (ΔA@0=0.00, ΔB@75=15.42, ΔB@99=0.00, mid=113.97) | PASS (5/5 pts, mean Δ=1.99) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 46.45 ms | **PASS** |
| `gl:ZoomInCircles` | zooms-spins | Zoom Circles | PASS (ΔA@0=0.00, ΔB@75=16.09, ΔB@99=0.00, mid=4.60) | PASS (5/5 pts, mean Δ=1.52) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 45.48 ms | **PASS** |
| `gl:Pinwheel` | zooms-spins | Pinwheel | PASS (ΔA@0=0.00, ΔB@75=0.74, ΔB@99=0.00, mid=7.98) | PASS (5/5 pts, mean Δ=1.77) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 46.47 ms | **PASS** |
| `gl:WhipSpin` | zooms-spins | Whip Spin | PASS (ΔA@0=0.00, ΔB@75=24.09, ΔB@99=0.00, mid=30.17) | PASS (5/5 pts, mean Δ=1.81) | dur:PASS, prog:PASS, params:4/4 | PASS (jump<0.01, power=1.0) | 135.95 ms | **PASS** |
| `gl:CircleCrop` | shapes-masks | Circle Crop | PASS (ΔA@0=0.00, ΔB@75=35.77, ΔB@99=0.00, mid=31.36) | PASS (5/5 pts, mean Δ=0.89) | dur:PASS, col:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 43.58 ms | **PASS** |
| `gl:HorizontalOpen` | shapes-masks | Horizontal Open | PASS (ΔA@0=0.00, ΔB@75=0.00, ΔB@99=0.00, mid=7.88) | PASS (5/5 pts, mean Δ=1.76) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 44.13 ms | **PASS** |
| `gl:VerticalOpen` | shapes-masks | Vertical Open | PASS (ΔA@0=0.00, ΔB@75=0.00, ΔB@99=0.00, mid=7.75) | PASS (5/5 pts, mean Δ=1.75) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 44.23 ms | **PASS** |
| `gl:Chessboard` | shapes-masks | Chessboard | PASS (ΔA@0=0.00, ΔB@75=5.01, ΔB@99=0.09, mid=7.75) | PASS (5/5 pts, mean Δ=1.69) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 44.22 ms | **PASS** |
| `gl:windowslice` | glitch-digital | Window Slice | PASS (ΔA@0=0.00, ΔB@75=0.30, ΔB@99=0.00, mid=7.90) | PASS (5/5 pts, mean Δ=1.69) | dur:PASS, prog:PASS, params:2/2 | PASS (jump<0.01, power=1.0) | 44.70 ms | **PASS** |
| `gl:GlitchDisplace` | glitch-digital | Glitch Displace | PASS (ΔA@0=0.00, ΔB@75=2.19, ΔB@99=0.00, mid=30.45) | PASS (5/5 pts, mean Δ=1.47) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 50.45 ms | **PASS** |
| `gl:GlitchMemories` | glitch-digital | Glitch Memories | PASS (ΔA@0=0.00, ΔB@75=14.36, ΔB@99=0.42, mid=14.36) | PASS (5/5 pts, mean Δ=2.03) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 51.30 ms | **PASS** |
| `gl:TvStatic` | glitch-digital | TV Static | PASS (ΔA@0=0.00, ΔB@75=103.87, ΔB@99=0.00, mid=103.92) | FAIL (Export comparison exceeded delta threshold on one or more points) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 45.25 ms | **FAIL** |
| `gl:Dreamy` | light-glow | Dreamy | PASS (ΔA@0=0.00, ΔB@75=6.41, ΔB@99=0.28, mid=10.62) | PASS (5/5 pts, mean Δ=1.66) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 47.75 ms | **PASS** |
| `gl:LinearBlur` | light-glow | Linear Blur | PASS (ΔA@0=0.00, ΔB@75=9.85, ΔB@99=0.49, mid=12.47) | PASS (5/5 pts, mean Δ=1.54) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 175.07 ms | **PASS** |
| `gl:Overexposure` | light-glow | Overexposure | PASS (ΔA@0=0.00, ΔB@75=22.35, ΔB@99=1.25, mid=30.62) | PASS (5/5 pts, mean Δ=1.41) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 44.92 ms | **PASS** |
| `gl:EdgeGlow` | light-glow | Edge Glow | PASS (ΔA@0=0.00, ΔB@75=25.64, ΔB@99=1.40, mid=28.71) | PASS (5/5 pts, mean Δ=0.90) | dur:PASS, prog:PASS, params:2/2 | PASS (jump<0.01, power=1.0) | 105.73 ms | **PASS** |
| `gl:morph` | creative | Morph | PASS (ΔA@0=0.00, ΔB@75=13.22, ΔB@99=0.93, mid=17.50) | PASS (5/5 pts, mean Δ=1.87) | dur:PASS, prog:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 48.27 ms | **PASS** |
| `gl:crosswarp` | creative | Cross Warp | PASS (ΔA@0=0.00, ΔB@75=11.89, ΔB@99=0.00, mid=34.41) | PASS (5/5 pts, mean Δ=1.98) | dur:PASS, prog:PASS | PASS (jump<0.01, power=1.0) | 45.17 ms | **PASS** |
| `gl:ButterflyWaveScrawler` | creative | Butterfly Wave | PASS (ΔA@0=0.00, ΔB@75=22.92, ΔB@99=2.60, mid=19.12) | PASS (5/5 pts, mean Δ=2.13) | dur:PASS, prog:PASS, params:3/3 | PASS (jump<0.01, power=1.0) | 53.58 ms | **PASS** |
| `gl:Kaleidoscope` | creative | Kaleidoscope | PASS (ΔA@0=0.00, ΔB@75=18.96, ΔB@99=1.48, mid=15.94) | PASS (5/5 pts, mean Δ=1.55) | dur:PASS, prog:PASS, params:2/3 | PASS (jump<0.01, power=1.0) | 54.20 ms | **FAIL** |
| `gl:Ripple` | creative | Ripple | PASS (ΔA@0=0.00, ΔB@75=3.81, ΔB@99=0.00, mid=8.14) | PASS (5/5 pts, mean Δ=1.63) | dur:PASS, prog:PASS, params:1/2 | PASS (jump<0.01, power=1.0) | 46.85 ms | **FAIL** |
| `gl:InkBleed` | creative | Ink Bleed | PASS (ΔA@0=0.00, ΔB@75=0.87, ΔB@99=0.00, mid=8.99) | PASS (5/5 pts, mean Δ=1.73) | dur:PASS, prog:PASS, params:4/4 | PASS (jump<0.01, power=1.0) | 93.33 ms | **PASS** |

## 2. Category Edge Cases (8 Categories)

| Category | Rep ID | Clip < Duration | First & Last Clip | Mixed Bitmap Size | Lifecycle (simulated object edits + JSON round trip) | Status |
|---|---|---|---|---|---|---|
| basic-fades | `gl:fade` | PASS | PASS | PASS | PASS | **PASS** |
| wipes | `gl:wipeLeft` | PASS | PASS | PASS | PASS | **PASS** |
| slides-pushes | `gl:Directional` | PASS | PASS | PASS | PASS | **PASS** |
| zooms-spins | `gl:CrossZoom` | PASS | PASS | PASS | PASS | **PASS** |
| shapes-masks | `gl:CircleCrop` | PASS | PASS | PASS | PASS | **PASS** |
| glitch-digital | `gl:GlitchDisplace` | PASS | PASS | PASS | PASS | **PASS** |
| light-glow | `gl:LinearBlur` | PASS | PASS | PASS | PASS | **PASS** |
| creative | `gl:ButterflyWaveScrawler` | PASS | PASS | PASS | PASS | **PASS** |

## 3. Shader Defects and Failures Detail

### `gl:TvStatic` (TV Static)
- Export comparison failed: Export comparison exceeded delta threshold on one or more points

### `gl:Kaleidoscope` (Kaleidoscope)
- Parameter variation did not alter rendering for: speed

### `gl:Ripple` (Ripple)
- Parameter variation did not alter rendering for: speed


## Known limits of this audit (read before trusting the rows)

- **What a pass means.** The first frame equals clip A; the last frame inside the window (99 percent, because the window is [start, end) and the frame at exactly the end is plain clip B) is close to clip B (mean difference at most 25 percent of the A-to-B difference, floor 3); the distance to clip B does not grow between 50, 75 and 99 percent (slack 15 percent of the A-to-B difference); one of 19 sweep frames differs from both clips. The thresholds were chosen by hand, not from a measured baseline. Slides and pushes use 75 percent instead of 25 percent because at 99 percent they are still 1 percent of the frame away from clip B.
- **Export versus preview** compares five preview frames (0, 25, 50, 75 and 99 percent) with frames that ffmpeg extracts from the encoded MP4 of the same composition (mean difference at most 12, which allows for H.264 loss). If WebCodecs is not available the frames are encoded with ffmpeg x264 instead; the report says which mode ran.
- **Progress** (`prog`) checks the progress value the renderer put on the transition node at 0, 25, 50, 75 and 99 percent against linear progress. A transition has no easing option in the project format, so linear is the definition.
- **Params** counts float uniforms whose changed value alters the picture at 50 percent; a failing one fails the transition. Vector and colour options use the direction and colour checks.
- **Known failures kept visible.** TvStatic: its noise is random per frame, so the preview and export frames at 25, 50 and 75 percent cannot match (by design; not a defect). Kaleidoscope and Ripple: the speed option did not change the 50 percent frame in the harness (open question: weak signal in the harness or a parameter that does not reach the shader; logged in the defect list).
- Edge cases ("clip shorter than the duration", "first and last clip", "mixed bitmap size") only check that a non-empty frame renders, once per category on one representative item. No frame rate is set anywhere.
- Add, replace, remove, drag onto a cut, undo and redo are plain object edits inside the harness. They do not use the real property-system commands or the TimelinePanel drop handler (T-H04 covers the drop live). Save and reopen is a JSON round trip, not the app save, load and validate path.
- The audio crossfade check runs `applyCrossfade` on constant signals; no real mixed or exported audio is measured, and the power check recomputes the formula it tests.
- Time per frame is software GL (SwiftShader), is reported and has no budget.
- One renderer fix came out of this work: `sampleTransitionParams` clamps the range start at 0 when the right clip starts earlier than the transition is long (it used to throw a RangeError). It has a unit test. The animated-parameter clock then starts at 0 while the progress value still uses the unclamped window start.
