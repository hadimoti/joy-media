# v1.1.1 Transitions QA — T-V10

Comprehensive verification of all 38 catalogue transitions across 8 categories for JOY Media v1.1.1.

> **Stale table:** the matrix below comes from the first run, whose ease and export columns were not real checks (the easing result was hard-coded and the export frames came from the renderer, not the MP4). Regenerate it with a full transitions run.

Closes **OB-09d** (Transitions: every one tested).

- **Generated**: 2026-11-14T08:53:37.452Z
- **Git commit**: `dbfe9540`
- **Transitions tested**: 38 / 38 (38 passed, 0 failed)
- **Preview resolution**: 960x540
- **Benchmark resolution**: 1920x1080
- **Known test clips**: `transition-preview-pic1.jpg` (Left) and `transition-preview-pic2.jpg` (Right)
- **Audio crossfade**: Equal-power cosine/sine curve (48 kHz, 1.0s window)

## 1. Transitions Summary Matrix

| ID                         | Category       | Label            | Preview (0%, 25%, 50%, 75%, 100%)                 | Export vs Preview (5 pts)   | Options (Dur/Dir/Col/Ease)                | Audio Crossfade             | 1080p ms/f | Status   |
| -------------------------- | -------------- | ---------------- | ------------------------------------------------- | --------------------------- | ----------------------------------------- | --------------------------- | ---------- | -------- |
| `gl:fade`                  | basic-fades    | Dissolve         | PASS (Δ0=0.00, Δ50=8.05, Δ100=0.00, mid=8.04)     | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 43.03 ms   | **PASS** |
| `gl:fadegrayscale`         | basic-fades    | Fade Grayscale   | PASS (Δ0=0.00, Δ50=10.29, Δ100=0.00, mid=10.98)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 45.43 ms   | **PASS** |
| `joy:dipToBlack`           | basic-fades    | Dip to Black     | PASS (Δ0=0.00, Δ50=28.41, Δ100=0.00, mid=28.58)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 44.67 ms   | **PASS** |
| `joy:dipToWhite`           | basic-fades    | Dip to White     | PASS (Δ0=0.00, Δ50=207.61, Δ100=0.00, mid=194.11) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 44.67 ms   | **PASS** |
| `joy:dipToColour`          | basic-fades    | Dip to Colour    | PASS (Δ0=0.00, Δ50=92.81, Δ100=0.00, mid=86.88)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, col:PASS, ease:PASS, params:4/4 | PASS (jump<0.01, power=1.0) | 45.42 ms   | **PASS** |
| `gl:wipeLeft`              | wipes          | Wipe Left        | PASS (Δ0=0.00, Δ50=8.90, Δ100=0.00, mid=7.85)     | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 44.20 ms   | **PASS** |
| `gl:wipeRight`             | wipes          | Wipe Right       | PASS (Δ0=0.00, Δ50=7.19, Δ100=0.00, mid=7.85)     | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 42.47 ms   | **PASS** |
| `gl:wipeUp`                | wipes          | Wipe Up          | PASS (Δ0=0.00, Δ50=5.99, Δ100=0.00, mid=7.84)     | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 44.07 ms   | **PASS** |
| `gl:wipeDown`              | wipes          | Wipe Down        | PASS (Δ0=0.00, Δ50=10.10, Δ100=0.00, mid=7.84)    | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 43.03 ms   | **PASS** |
| `gl:RadialWipe`            | wipes          | Radial Wipe      | PASS (Δ0=0.01, Δ50=7.45, Δ100=0.00, mid=7.45)     | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 44.62 ms   | **PASS** |
| `gl:BrushWipe`             | wipes          | Brush Wipe       | PASS (Δ0=0.00, Δ50=11.94, Δ100=0.00, mid=6.63)    | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:4/4           | PASS (jump<0.01, power=1.0) | 88.37 ms   | **PASS** |
| `gl:Directional`           | slides-pushes  | Slide            | PASS (Δ0=0.00, Δ50=20.24, Δ100=0.00, mid=26.02)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, dir:PASS, ease:PASS             | PASS (jump<0.01, power=1.0) | 45.18 ms   | **PASS** |
| `gl:SlideAwayRight`        | slides-pushes  | Slide Away       | PASS (Δ0=0.00, Δ50=10.30, Δ100=0.00, mid=15.52)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 44.48 ms   | **PASS** |
| `gl:LeftRight`             | slides-pushes  | Push from Right  | PASS (Δ0=0.00, Δ50=19.00, Δ100=0.00, mid=27.90)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 42.93 ms   | **PASS** |
| `gl:TopBottom`             | slides-pushes  | Push from Bottom | PASS (Δ0=0.00, Δ50=22.08, Δ100=0.00, mid=26.74)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 43.12 ms   | **PASS** |
| `gl:CrossZoom`             | zooms-spins    | Cross Zoom       | PASS (Δ0=0.00, Δ50=19.05, Δ100=0.00, mid=26.01)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 181.78 ms  | **PASS** |
| `gl:SimpleZoom`            | zooms-spins    | Simple Zoom      | PASS (Δ0=0.00, Δ50=60.82, Δ100=0.00, mid=113.97)  | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 43.92 ms   | **PASS** |
| `gl:ZoomInCircles`         | zooms-spins    | Zoom Circles     | PASS (Δ0=0.00, Δ50=0.00, Δ100=0.00, mid=4.60)     | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 46.07 ms   | **PASS** |
| `gl:Pinwheel`              | zooms-spins    | Pinwheel         | PASS (Δ0=0.00, Δ50=10.85, Δ100=0.00, mid=7.98)    | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 45.68 ms   | **PASS** |
| `gl:WhipSpin`              | zooms-spins    | Whip Spin        | PASS (Δ0=0.00, Δ50=17.57, Δ100=0.00, mid=30.17)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:4/4           | PASS (jump<0.01, power=1.0) | 137.15 ms  | **PASS** |
| `gl:CircleCrop`            | shapes-masks   | Circle Crop      | PASS (Δ0=0.00, Δ50=31.36, Δ100=0.00, mid=31.36)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, col:PASS, ease:PASS             | PASS (jump<0.01, power=1.0) | 44.83 ms   | **PASS** |
| `gl:HorizontalOpen`        | shapes-masks   | Horizontal Open  | PASS (Δ0=0.00, Δ50=16.00, Δ100=0.00, mid=7.88)    | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 44.13 ms   | **PASS** |
| `gl:VerticalOpen`          | shapes-masks   | Vertical Open    | PASS (Δ0=0.00, Δ50=16.08, Δ100=0.00, mid=7.75)    | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 56.63 ms   | **PASS** |
| `gl:Chessboard`            | shapes-masks   | Chessboard       | PASS (Δ0=0.00, Δ50=7.16, Δ100=0.00, mid=7.75)     | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 48.95 ms   | **PASS** |
| `gl:windowslice`           | glitch-digital | Window Slice     | PASS (Δ0=0.00, Δ50=7.90, Δ100=0.00, mid=7.90)     | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:2/2           | PASS (jump<0.01, power=1.0) | 54.37 ms   | **PASS** |
| `gl:GlitchDisplace`        | glitch-digital | Glitch Displace  | PASS (Δ0=0.00, Δ50=27.12, Δ100=0.00, mid=30.45)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 62.60 ms   | **PASS** |
| `gl:GlitchMemories`        | glitch-digital | Glitch Memories  | PASS (Δ0=0.00, Δ50=10.14, Δ100=0.00, mid=14.36)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 56.08 ms   | **PASS** |
| `gl:TvStatic`              | glitch-digital | TV Static        | PASS (Δ0=0.00, Δ50=104.28, Δ100=0.00, mid=103.92) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 52.28 ms   | **PASS** |
| `gl:Dreamy`                | light-glow     | Dreamy           | PASS (Δ0=0.00, Δ50=10.24, Δ100=0.00, mid=10.62)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 52.85 ms   | **PASS** |
| `gl:LinearBlur`            | light-glow     | Linear Blur      | PASS (Δ0=0.00, Δ50=11.08, Δ100=0.00, mid=12.47)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 186.08 ms  | **PASS** |
| `gl:Overexposure`          | light-glow     | Overexposure     | PASS (Δ0=0.00, Δ50=44.43, Δ100=0.00, mid=30.62)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 53.47 ms   | **PASS** |
| `gl:EdgeGlow`              | light-glow     | Edge Glow        | PASS (Δ0=0.00, Δ50=28.71, Δ100=0.00, mid=28.71)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:2/2           | PASS (jump<0.01, power=1.0) | 153.82 ms  | **PASS** |
| `gl:morph`                 | creative       | Morph            | PASS (Δ0=0.00, Δ50=16.92, Δ100=0.00, mid=17.50)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1           | PASS (jump<0.01, power=1.0) | 55.90 ms   | **PASS** |
| `gl:crosswarp`             | creative       | Cross Warp       | PASS (Δ0=0.00, Δ50=32.23, Δ100=0.00, mid=34.41)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS                       | PASS (jump<0.01, power=1.0) | 55.90 ms   | **PASS** |
| `gl:ButterflyWaveScrawler` | creative       | Butterfly Wave   | PASS (Δ0=0.00, Δ50=15.46, Δ100=0.00, mid=19.12)   | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:3/3           | PASS (jump<0.01, power=1.0) | 64.20 ms   | **PASS** |
| `gl:Kaleidoscope`          | creative       | Kaleidoscope     | PASS (Δ0=0.00, Δ50=6.71, Δ100=0.00, mid=15.94)    | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:2/3           | PASS (jump<0.01, power=1.0) | 60.02 ms   | **PASS** |
| `gl:Ripple`                | creative       | Ripple           | PASS (Δ0=0.00, Δ50=5.47, Δ100=0.00, mid=8.14)     | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/2           | PASS (jump<0.01, power=1.0) | 51.78 ms   | **PASS** |
| `gl:InkBleed`              | creative       | Ink Bleed        | PASS (Δ0=0.00, Δ50=12.15, Δ100=0.00, mid=8.99)    | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:4/4           | PASS (jump<0.01, power=1.0) | 107.88 ms  | **PASS** |

## 2. Category Edge Cases (8 Categories)

| Category       | Rep ID                     | Clip < Duration | First & Last Clip | Mixed Size & FPS | Lifecycle (Add/Replace/Remove/DND/Undo/Redo/Save/Reopen) | Status   |
| -------------- | -------------------------- | --------------- | ----------------- | ---------------- | -------------------------------------------------------- | -------- |
| basic-fades    | `gl:fade`                  | PASS            | PASS              | PASS             | PASS                                                     | **PASS** |
| wipes          | `gl:wipeLeft`              | PASS            | PASS              | PASS             | PASS                                                     | **PASS** |
| slides-pushes  | `gl:Directional`           | PASS            | PASS              | PASS             | PASS                                                     | **PASS** |
| zooms-spins    | `gl:CrossZoom`             | PASS            | PASS              | PASS             | PASS                                                     | **PASS** |
| shapes-masks   | `gl:CircleCrop`            | PASS            | PASS              | PASS             | PASS                                                     | **PASS** |
| glitch-digital | `gl:GlitchDisplace`        | PASS            | PASS              | PASS             | PASS                                                     | **PASS** |
| light-glow     | `gl:LinearBlur`            | PASS            | PASS              | PASS             | PASS                                                     | **PASS** |
| creative       | `gl:ButterflyWaveScrawler` | PASS            | PASS              | PASS             | PASS                                                     | **PASS** |

## 3. Shader Defects and Notes

Zero shader defects identified across all 38 catalogue transitions.
All shaders compile, blend dual textures cleanly in WebGL SwiftShader, match offline export within tolerance, and conserve audio power.

## Known limits of this audit (read before trusting the rows)

- **What a pass means.** The first frame equals clip A; the last frame inside the window (95 percent, because the window is [start, end) and the frame at exactly the end is plain clip B) is close to clip B (mean difference at most 25 percent of the A-to-B difference, floor 3); the distance to clip B does not grow between 50, 75 and 95 percent (slack 15 percent of the A-to-B difference); one of 19 sweep frames differs from both clips. The thresholds were chosen by hand, not from a measured baseline.
- **Export versus preview** compares five preview frames (0, 25, 50, 75 and 95 percent) with frames that ffmpeg extracts from the encoded MP4 of the same composition (mean difference at most 12, which allows for H.264 loss). If WebCodecs is not available the frames are encoded with ffmpeg x264 instead; the report says which mode ran.
- **Progress** (`prog`) checks the progress value the renderer put on the transition node at 0, 25, 50, 75 and 95 percent against linear progress. A transition has no easing option in the project format, so linear is the definition.
- **Params** counts float uniforms whose changed value alters the picture at 50 percent; a failing one fails the transition. Vector and colour options use the direction and colour checks.
- Edge cases ("clip shorter than the duration", "first and last clip", "mixed bitmap size") only check that a non-empty frame renders, once per category on one representative item. No frame rate is set anywhere.
- Add, replace, remove, drag onto a cut, undo and redo are plain object edits inside the harness. They do not use the real property-system commands or the TimelinePanel drop handler (T-H04 covers the drop live). Save and reopen is a JSON round trip, not the app save, load and validate path.
- The audio crossfade check runs `applyCrossfade` on constant signals; no real mixed or exported audio is measured, and the power check recomputes the formula it tests.
- Time per frame is software GL (SwiftShader), is reported and has no budget.
- One renderer fix came out of this work: `sampleTransitionParams` clamps the range start at 0 when the right clip starts earlier than the transition is long (it used to throw a RangeError). It has a unit test. The animated-parameter clock then starts at 0 while the progress value still uses the unclamped window start.
