# v1.1.1 Transitions QA — T-V10

Comprehensive verification of all 38 catalogue transitions across 8 categories for JOY Media v1.1.1.
Closes **OB-09d** (Transitions: every one tested).

- **Generated**: 2026-11-14T08:37:04.003Z
- **Git commit**: `bdc45ffc`
- **Transitions tested**: 38 / 38 (37 passed, 1 failed)
- **Preview resolution**: 960x540
- **Benchmark resolution**: 1920x1080
- **Known test clips**: `transition-preview-pic1.jpg` (Left) and `transition-preview-pic2.jpg` (Right)
- **Audio crossfade**: Equal-power cosine/sine curve (48 kHz, 1.0s window)

## 1. Transitions Summary Matrix

| ID | Category | Label | Preview (0%, 25%, 50%, 75%, 100%) | Export vs Preview (5 pts) | Options (Dur/Dir/Col/Ease) | Audio Crossfade | 1080p ms/f | Status |
|---|---|---|---|---|---|---|---|---|
| `gl:fade` | basic-fades | Dissolve | PASS (Δ0=0, Δ50=8.05, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 52.85 ms | **PASS** |
| `gl:fadegrayscale` | basic-fades | Fade Grayscale | PASS (Δ0=0, Δ50=10.29, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 57.28 ms | **PASS** |
| `joy:dipToBlack` | basic-fades | Dip to Black | PASS (Δ0=0, Δ50=28.41, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 54.58 ms | **PASS** |
| `joy:dipToWhite` | basic-fades | Dip to White | PASS (Δ0=0, Δ50=207.61, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 51.22 ms | **PASS** |
| `joy:dipToColour` | basic-fades | Dip to Colour | PASS (Δ0=0, Δ50=92.81, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, col:PASS, ease:PASS, params:4/4 | PASS (jump<0.01, power=1.0) | 54.12 ms | **PASS** |
| `gl:wipeLeft` | wipes | Wipe Left | PASS (Δ0=0, Δ50=8.90, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 51.88 ms | **PASS** |
| `gl:wipeRight` | wipes | Wipe Right | PASS (Δ0=0, Δ50=7.19, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 48.23 ms | **PASS** |
| `gl:wipeUp` | wipes | Wipe Up | PASS (Δ0=0, Δ50=5.99, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 50.80 ms | **PASS** |
| `gl:wipeDown` | wipes | Wipe Down | PASS (Δ0=0, Δ50=10.10, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 52.05 ms | **PASS** |
| `gl:RadialWipe` | wipes | Radial Wipe | PASS (Δ0=0, Δ50=7.45, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 53.85 ms | **PASS** |
| `gl:BrushWipe` | wipes | Brush Wipe | PASS (Δ0=0, Δ50=11.94, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:4/4 | PASS (jump<0.01, power=1.0) | 103.42 ms | **PASS** |
| `gl:Directional` | slides-pushes | Slide | PASS (Δ0=0, Δ50=20.24, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, dir:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 54.12 ms | **PASS** |
| `gl:SlideAwayRight` | slides-pushes | Slide Away | PASS (Δ0=0, Δ50=10.30, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 50.65 ms | **PASS** |
| `gl:LeftRight` | slides-pushes | Push from Right | PASS (Δ0=0, Δ50=19.00, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 53.23 ms | **PASS** |
| `gl:TopBottom` | slides-pushes | Push from Bottom | PASS (Δ0=0, Δ50=22.08, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 49.18 ms | **PASS** |
| `gl:CrossZoom` | zooms-spins | Cross Zoom | PASS (Δ0=0, Δ50=19.05, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 214.25 ms | **PASS** |
| `gl:SimpleZoom` | zooms-spins | Simple Zoom | PASS (Δ0=0, Δ50=60.82, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 53.03 ms | **PASS** |
| `gl:ZoomInCircles` | zooms-spins | Zoom Circles | FAIL | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 51.65 ms | **FAIL** |
| `gl:Pinwheel` | zooms-spins | Pinwheel | PASS (Δ0=0, Δ50=10.85, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 54.82 ms | **PASS** |
| `gl:WhipSpin` | zooms-spins | Whip Spin | PASS (Δ0=0, Δ50=17.57, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:4/4 | PASS (jump<0.01, power=1.0) | 166.22 ms | **PASS** |
| `gl:CircleCrop` | shapes-masks | Circle Crop | PASS (Δ0=0, Δ50=31.36, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, col:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 53.15 ms | **PASS** |
| `gl:HorizontalOpen` | shapes-masks | Horizontal Open | PASS (Δ0=0, Δ50=16.00, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 55.90 ms | **PASS** |
| `gl:VerticalOpen` | shapes-masks | Vertical Open | PASS (Δ0=0, Δ50=16.08, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 52.95 ms | **PASS** |
| `gl:Chessboard` | shapes-masks | Chessboard | PASS (Δ0=0, Δ50=7.16, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 53.75 ms | **PASS** |
| `gl:windowslice` | glitch-digital | Window Slice | PASS (Δ0=0, Δ50=7.90, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:2/2 | PASS (jump<0.01, power=1.0) | 56.63 ms | **PASS** |
| `gl:GlitchDisplace` | glitch-digital | Glitch Displace | PASS (Δ0=0, Δ50=27.12, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 60.37 ms | **PASS** |
| `gl:GlitchMemories` | glitch-digital | Glitch Memories | PASS (Δ0=0, Δ50=10.14, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 62.13 ms | **PASS** |
| `gl:TvStatic` | glitch-digital | TV Static | PASS (Δ0=0, Δ50=104.28, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 52.53 ms | **PASS** |
| `gl:Dreamy` | light-glow | Dreamy | PASS (Δ0=0, Δ50=10.24, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 55.88 ms | **PASS** |
| `gl:LinearBlur` | light-glow | Linear Blur | PASS (Δ0=0, Δ50=11.08, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 198.93 ms | **PASS** |
| `gl:Overexposure` | light-glow | Overexposure | PASS (Δ0=0, Δ50=44.43, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 51.52 ms | **PASS** |
| `gl:EdgeGlow` | light-glow | Edge Glow | PASS (Δ0=0, Δ50=28.71, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:2/2 | PASS (jump<0.01, power=1.0) | 128.70 ms | **PASS** |
| `gl:morph` | creative | Morph | PASS (Δ0=0, Δ50=16.92, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/1 | PASS (jump<0.01, power=1.0) | 57.48 ms | **PASS** |
| `gl:crosswarp` | creative | Cross Warp | PASS (Δ0=0, Δ50=32.23, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS | PASS (jump<0.01, power=1.0) | 55.43 ms | **PASS** |
| `gl:ButterflyWaveScrawler` | creative | Butterfly Wave | PASS (Δ0=0, Δ50=15.46, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:3/3 | PASS (jump<0.01, power=1.0) | 64.28 ms | **PASS** |
| `gl:Kaleidoscope` | creative | Kaleidoscope | PASS (Δ0=0, Δ50=6.71, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:2/3 | PASS (jump<0.01, power=1.0) | 63.87 ms | **PASS** |
| `gl:Ripple` | creative | Ripple | PASS (Δ0=0, Δ50=5.47, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:1/2 | PASS (jump<0.01, power=1.0) | 52.92 ms | **PASS** |
| `gl:InkBleed` | creative | Ink Bleed | PASS (Δ0=0, Δ50=12.15, Δ100=0) | PASS (5/5 pts, mean Δ=0.00) | dur:PASS, ease:PASS, params:4/4 | PASS (jump<0.01, power=1.0) | 112.38 ms | **PASS** |

## 2. Category Edge Cases (8 Categories)

| Category | Rep ID | Clip < Duration | First & Last Clip | Mixed Size & FPS | Lifecycle (Add/Replace/Remove/DND/Undo/Redo/Save/Reopen) | Status |
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

### `gl:ZoomInCircles` (Zoom Circles)
- Preview frames did not properly transition from clip A to clip B

