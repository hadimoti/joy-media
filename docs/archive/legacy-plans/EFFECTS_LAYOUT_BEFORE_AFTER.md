# JOY Media Editor — Effects & Layout: BEFORE / AFTER Specification

> **Purpose**: Complete context package for ChatGPT to produce a debugged implementation plan, then hand off to Hermes on VPS for execution.
>
> **Generated**: 2026-07-25  
> **Live Editor**: https://media.joyteam.ir/  
> **Local Repo**: `C:\Users\HadiMoti\joy-media` (pnpm monorepo, ~30 packages)  
> **VPS Deploy Target**: Sweden VPS (media.joyteam.ir, port 8790, systemd `joy-media@api`)

---

## 1. PROJECT OVERVIEW

### 1.1 What is JOY Media?

A **local-first creative operating system** for content production — video editing, motion graphics, HTML scenes, captions, audio, AI generation, automation — all sharing one project model and reversible command system.

- **Primary deployment**: Desktop (Tauri) + Browser (VPS-hosted)
- **Renderer**: PixiJS (preview) → Headless compositor / FFmpeg (export)
- **Architecture**: `Project Document → Evaluation Engine → Render IR → Render Adapter`
- **Key differentiator**: HTML scenes are first-class timeline objects; AI providers are swappable adapters; agent uses same command bus as human.

### 1.2 Current Phase (per `JOY_MEDIA_MASTER_PLAN.md`)

- **Completed**: P00–P10 (~1042 tests, 30+ packages)
- **Live on VPS**: Editor web app at `media.joyteam.ir` (HTML.Scene runtime, Pixi preview, timeline, dockview panels)
- **Next major gap**: **Live preview canvas wiring** (renderer-pixi/headless exist but not fully connected to React UI Monitor panel) + **Effects/Transitions/Color system** (tabs exist, content mostly stubbed)

---

## 2. CURRENT LIVE STATE (BEFORE)

### 2.1 Header / Top Bar (Exact)

```tsx
// apps/editor-web/src/AppHeader.tsx (mirrors live DOM)
<header className="app-header">
  <div className="brand">JOY Media</div>
  <div className="edit-group">
    <IconButton icon={UndoIcon} disabled={true} aria-label="Undo (Mod+Z)" />
    <IconButton icon={RedoIcon} disabled={true} aria-label="Redo (Mod+Shift+Z)" />
    <IconButton icon={CommandIcon} aria-label="Command Palette (Mod+K)" />
  </div>
  <div className="deliver-group">
    <DropdownButton label="Export Preset" items={exportPresets} />
    <IconButton icon={ExportIcon} aria-label="Export MP4" />
    <DropdownButton label="Recent Processes" items={recentJobs} />
    <DropdownButton label="JOY Account" items={accountMenu} />
  </div>
  <nav className="app-menu">
    <Menu label="File" items={fileMenu} />
    <Menu label="Edit" items={editMenu} />
    <Menu label="Clip" items={clipMenu} />
    <Menu label="View" items={viewMenu} />
    <Menu label="Window" items={windowMenu} /> // ← Focus shortcuts: Assets, Program Monitor,
    Timeline, Inspector
  </nav>
</header>
```

### 2.2 Dockview Panel Registry (16 Panels Registered)

**Source**: `apps/editor-web/src/panel-tab-icons.ts` + live DOM `.panel-tab` elements

| #   | Panel ID      | Title               | Icon Asset                               | Current Content (Live)                                                                                                                                       |
| --- | ------------- | ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `assets`      | **Assets**          | `/assets/icons/assets.png`               | **Active left** — Categories (All/Video/Audio/Images), Toolbar (Search, Import, Filter, Refresh, Cloud Backup), "Could not load asset catalog: unauthorized" |
| 2   | `inspector`   | **Inspector**       | `/assets/icons/ui/inspect_24x24.png`     | Tab exists, shows "Select a clip to edit its properties" when nothing selected                                                                               |
| 3   | `motion`      | **Motion**          | `/assets/icons/ui/motion_24x24.png`      | Tab exists, content unknown (likely stub)                                                                                                                    |
| 4   | `effects`     | **Effects**         | `/assets/icons/ui/effects-org_24x24.png` | **Tab exists, content empty/stub** — **PRIMARY TARGET**                                                                                                      |
| 5   | `audio`       | **Audio**           | SVG icon                                 | Tab exists, content unknown                                                                                                                                  |
| 6   | `transitions` | **Transitions**     | `/assets/icons/ui/blend_24x24.png`       | **Tab exists, content empty/stub** — **SECONDARY TARGET**                                                                                                    |
| 7   | `color`       | **Color**           | `/assets/icons/ui/contrast_24x24.png`    | Tab exists, content unknown                                                                                                                                  |
| 8   | `captions`    | **Captions**        | `/assets/icons/ui/voice-memo_24x24.png`  | Tab exists, content unknown                                                                                                                                  |
| 9   | `camera`      | **Camera**          | `/assets/icons/camera.png`               | Tab exists, shows Camera combobox + "Create camera" + Active Camera selector                                                                                 |
| 10  | `history`     | **History**         | `/assets/icons/history2.png`             | Tab exists, content unknown                                                                                                                                  |
| 11  | `agent`       | **Agent**           | `/assets/icons/ui/agent-ai_24x24.png`    | Tab exists, content unknown (AI chat/automation)                                                                                                             |
| 12  | `workflows`   | **Workflows**       | `/assets/icons/workflow.png`             | Tab exists, content unknown                                                                                                                                  |
| 13  | `jobs`        | **Jobs**            | `/assets/icons/job.png`                  | Tab exists, content unknown (export queue)                                                                                                                   |
| 14  | `plugins`     | **Plugins**         | `/assets/icons/plugin.png`               | Tab exists, content unknown                                                                                                                                  |
| 15  | `diagnostics` | **Diagnostics**     | `/assets/icons/diagnostic.png`           | Tab exists, content unknown                                                                                                                                  |
| 16  | `monitor`     | **Program Monitor** | `/assets/icons/monitor.png`              | **Active center** — 1080×1920 canvas, playback controls, scale dropdown                                                                                      |
| 17  | `timeline`    | **Timeline**        | `/assets/icons/timeline.png`             | **Active bottom** — Full width, 2 video tracks, trim/split/ripple tools, zoom slider                                                                         |

> **Note**: Panels 1–15 are in **left panel group** (tab strip). Panels 16–17 are separate groups (center, bottom).

### 2.3 Timeline (Live — Bottom Panel)

```tsx
// Toolbar (left to right)
PlayProxy | Back1s | Forward1s | +VideoTrack | +Marker | SelectTool | SplitTool | DuplicateClip(disabled) | RippleDelete(disabled)

// Time Ruler + Playhead Slider
0.00s | 0:00 0:02 0:04 ... 0:30

// Tracks (V1, V2)
V1: Main Video  [🔒 Lock] [🔇 Mute] [🔊 Solo]  Intro(10s) | Product(10s) | Outro(10s)
V2: B-roll      [🔒 Lock] [🔇 Mute] [🔊 Solo]  B Roll A(15s) | B Roll B(15s)

// Zoom Controls
[Zoom Out] [==========●==========] [Zoom In] [Fit]
```

### 2.4 Program Monitor (Live — Center Panel)

```tsx
// Header
"1080 × 1920  ·  00:00:00:00"  [Seek -1s] [Play] [Seek +1s] [Scale: Fit ▼]

// Canvas
<canvas width="1080" height="1920" />  // PixiJS rendering surface
```

### 2.5 HTML Scene Iframes (Embedded in Canvas Area)

| Iframe Name                   | Content                                          |
| ----------------------------- | ------------------------------------------------ |
| `joy-scene:scene-title`       | `<h1>JOY Media</h1><p>Make it memorable</p>`     |
| `joy-scene:scene-lower-third` | `<strong>Alex Morgan</strong> Creative Director` |

---

## 3. ARCHITECTURE CONTEXT (Critical for Implementation)

### 3.1 Package Map (Relevant to Effects/Layout)

```
packages/
├── render-ir/              # RenderIR types: SpriteNode, VideoFrameNode, TextNode, GroupNode
├── renderer-pixi/          # Node software rasterizer (parity test)
├── renderer-pixi-web/      # Browser PixiJS adapter (live preview)
├── renderer-headless/      # Headless compositor (export)
├── visual-object-renderer/ # Maps VisualObjectV1 → RenderIR nodes
├── motion-core/            # Keyframes, curves, parenting, presets (joy-fade-in, joy-pop-in, joy-slide-up)
├── project-schema/         # VisualObjectV1, AnimatablePropertyV1, ClipV1, TrackV1, CompositionV1
├── property-system/        # Universal Inspector property descriptors
├── ui-kit/                 # Design tokens, IconButton, PanelTab, Dockview wrapper
├── html-scene-runtime/     # Sandboxed HTML scene runtime (iframes)
├── adapter-comfyui/        # AI image/video generation
├── adapter-tts/            # Speech synthesis
├── audio-core/             # Audio graph, effects (EQ, compressor, limiter, gate)
├── captions-core/          # Caption document, style, animation
└── expression-core/        # Safe expression language (planned)
```

### 3.2 Render IR → Pixi Pipeline (Current)

```typescript
// packages/renderer-pixi/src/browser.ts (LIVE)
createBrowserPixiRenderer(options) → BrowserPixiRenderer {
  render(frame: RenderFrameIR, videoBitmaps?: Map<string, BrowserVideoFrameBitmap>): BrowserPixiRenderStats
}

// Mapping:
SpriteNode        → Graphics (rect filled with node.color)
VideoFrameNode    → Sprite (texture from videoBitmap via canvas.upload)
TextNode          → Pixi Text (fontSizePx, maxWidth, alignment, color)
GroupNode         → Flattened by render-ir/flattenRenderNodes (transform composed)
```

### 3.3 Effect/Filter Architecture (Planned, Not Implemented)

```typescript
// DESIGN.md §18.2 "Effects" group
// property-system/PropertyDescriptor.ts
{
  id: 'gaussianBlur',
  label: 'Gaussian Blur',
  group: 'Effects',
  type: 'number',
  animatable: true,
  renderImpact: 'paint',
  constraints: { min: 0, max: 100, step: 0.1, unit: 'px' }
}
```

### 3.4 Dockview Panel Registration

```typescript
// apps/editor-web/src/workspace.ts
export const PANEL_IDS = [
  'assets',
  'inspector',
  'motion',
  'effects',
  'audio',
  'transitions',
  'color',
  'captions',
  'camera',
  'history',
  'agent',
  'workflows',
  'jobs',
  'plugins',
  'diagnostics',
  'monitor',
  'timeline',
] as const;

export const DEFAULT_WORKSPACE = {
  // ... dockview layout JSON with groups, tabs, sizes
};
```

---

## 4. WHAT NEEDS TO CHANGE (AFTER)

### 4.1 Effects Panel — Full Implementation

**Target**: `packages/visual-effects` (new package) + `apps/editor-web/src/panels/EffectsPanel.tsx`

| Feature                 | Specification                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| **Effect Registry**     | Central `EffectRegistry` with categories: Color, Blur, Distort, Artistic, Depth, Stylize            |
| **Effect Descriptor**   | `{ id, label, category, params: ParamDescriptor[], glslFragment, wgslFragment, pixiFilterFactory }` |
| **Param Descriptor**    | `{ key, label, type: 'number'\|'color'\|'vector2'\|'enum', min, max, step, default, animatable }`   |
| **Pixi Filter Factory** | `(params) => PIXI.Filter` — uses `@pixi/filter-*` or custom GLSL/WGSL                               |
| **Drag & Drop**         | Drag effect from panel → clip on timeline or Inspector → adds to clip's effect stack                |
| **Effect Stack UI**     | In Inspector: reorderable list, enable/disable, delete, collapse/expand per effect                  |
| **Keyframe Support**    | Every animatable param → keyframeable in Motion panel / timeline                                    |
| **Search/Filter**       | Text search, category tabs, "Favorites" (starred)                                                   |
| **Presets**             | Save/load effect stacks as `.joyfx` JSON; ship built-in presets (Cinematic, Vintage, Glitch, etc.)  |

#### 4.1.1 Effect Library (MVP — 25 Effects)

| Category     | Effects (Priority)                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| **Color**    | BrightnessContrast, HueSaturation, Vibrance, Vignette, ColorOverlay, LUT/ColorMap, Curves, Sepia, ColorReplace |
| **Blur**     | GaussianBlur, ZoomBlur, RadialBlur, TiltShift, Bloom, AdvancedBloom                                            |
| **Distort**  | BulgePinch, Twist, Ripple, Shockwave, DisplacementMap                                                          |
| **Artistic** | CRT, ASCII, CrossHatch, Noise, UnsharpMask, Posterize, Halftone                                                |
| **Depth**    | DropShadow, Bevel, Glow                                                                                        |
| **Stylize**  | Pixelate, Mosaic, EdgeDetect, Emboss                                                                           |

#### 4.1.2 Integration Points

```typescript
// VisualObjectV1 (project-schema) extension
interface VisualObjectV1 {
  // ...existing
  effects?: EffectInstanceV1[]; // NEW
}

interface EffectInstanceV1 {
  effectId: string; // e.g. "gaussianBlur"
  enabled: boolean;
  params: Record<string, number | string | boolean>; // current values
  animations?: Partial<Record<string, AnimationCurveV1>>; // keyframed params
}
```

### 4.2 Transitions Panel — Full Implementation

**Target**: `apps/editor-web/src/panels/TransitionsPanel.tsx`

| Feature                   | Specification                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Source**                | `gl-transitions` (60+ GLSL transitions) + custom                                                        |
| **Transition Descriptor** | `{ id, label, category, glsl, params: ParamDescriptor[] }`                                              |
| **Timeline Integration**  | Overlap two clips on same track → transition auto-created (or drag transition between clips)            |
| **Transition UI**         | In timeline: transition rect with handles; in Inspector: duration, alignment (center/start/end), params |
| **Categories**            | Dissolve, Slide, Zoom, 3D (Cube, Flip, Morph), Glitch, Shape (Circle, Heart), Organic                   |

### 4.3 Color Panel — Grading Workspace

**Target**: `apps/editor-web/src/panels/ColorPanel.tsx`

| Feature            | Specification                                           |
| ------------------ | ------------------------------------------------------- |
| **Primary Wheels** | Lift/Gamma/Gain + Offset (3-wheel + master)             |
| **Curves**         | RGB + Hue vs Sat + Hue vs Hue + Hue vs Lum + Lum vs Sat |
| **HDR/Wide Gamut** | Support for P3/Rec2020 when export preset demands       |
| **LUT Support**    | `.cube` import, intensity slider, export with LUT baked |
| **Scopes**         | Waveform, Parade, Vectorscope, Histogram (canvas-based) |
| **Node Graph**     | Optional: DaVinci-style node graph for complex grades   |

### 4.4 Audio Panel — Mixer + Effects

**Target**: `apps/editor-web/src/panels/AudioPanel.tsx`

| Feature           | Specification                                                |
| ----------------- | ------------------------------------------------------------ |
| **Track Mixer**   | Faders, meters (peak/RMS), pan, mute, solo, record arm       |
| **Clip Effects**  | Gain, Pan, EQ (parametric 4-band), Compressor, Limiter, Gate |
| **Track Effects** | Same as clip + Send/Return for reverb/delay                  |
| **Master Bus**    | Limiter, Loudness meter (LUFS), True Peak                    |
| **Keyframeable**  | All params animatable                                        |

### 4.5 Motion Panel — Keyframe Graph Editor

**Target**: `apps/editor-web/src/panels/MotionPanel.tsx`

| Feature                | Specification                                                       |
| ---------------------- | ------------------------------------------------------------------- |
| **Dope Sheet**         | Timeline view of all keyframes for selected object                  |
| **Graph Editor**       | Value vs time curves, Bezier handles, auto-ease                     |
| **Motion Presets**     | UI for `joy-fade-in`, `joy-pop-in`, `joy-slide-up` + custom presets |
| **Per-Character Text** | Text animator: position/scale/rotation/opacity per char/word/line   |

### 4.6 Inspector Panel — Effect Stack Integration

**Current**: Shows "Select a clip to edit its properties"  
**After**: Dynamic property groups based on selection

```typescript
// When clip with effects selected:
Inspector Groups:
┌ Transform          (x, y, scaleX, scaleY, rotation, opacity, positionZ)
├ Appearance         (opacity, blendMode, crop)
├ Effects Stack      📦 Gaussian Blur (enabled)  [⋮] [▼]
│   └ params: blurX=5, blurY=5, quality=3
│   📦 Color Overlay (enabled)  [⋮] [▼]
│   └ params: color=#ff0000, opacity=0.3
├ Media              (sourceIn, speed, reverse, freeze, proxy)
├ Audio              (gain, pan, mute)
└ Captions           (styleRef, animationRef)
```

---

## 5. TECHNICAL IMPLEMENTATION PLAN (For ChatGPT → Hermes)

### 5.1 New Package: `packages/visual-effects`

```
packages/visual-effects/
├── src/
│   ├── EffectRegistry.ts          # Singleton, registerEffect(), getEffect(), getByCategory()
│   ├── EffectDescriptor.ts        # Types: EffectDescriptor, ParamDescriptor
│   ├── filters/
│   │   ├── index.ts               # Re-exports all filter factories
│   │   ├── color/
│   │   │   ├── BrightnessContrast.ts
│   │   │   ├── HueSaturation.ts
│   │   │   ├── Vibrance.ts
│   │   │   ├── Vignette.ts
│   │   │   ├── ColorOverlay.ts
│   │   │   ├── ColorMap.ts        # LUT support
│   │   │   ├── Curves.ts
│   │   │   ├── Sepia.ts
│   │   │   └── ColorReplace.ts
│   │   ├── blur/
│   │   │   ├── GaussianBlur.ts
│   │   │   ├── ZoomBlur.ts
│   │   │   ├── RadialBlur.ts
│   │   │   ├── TiltShift.ts
│   │   │   ├── Bloom.ts
│   │   │   └── AdvancedBloom.ts
│   │   ├── distort/
│   │   │   ├── BulgePinch.ts
│   │   │   ├── Twist.ts
│   │   │   ├── Ripple.ts
│   │   │   └── DisplacementMap.ts
│   │   ├── artistic/
│   │   │   ├── CRT.ts
│   │   │   ├── ASCII.ts
│   │   │   ├── CrossHatch.ts
│   │   │   ├── Noise.ts
│   │   │   ├── UnsharpMask.ts
│   │   │   └── Posterize.ts
│   │   ├── depth/
│   │   │   ├── DropShadow.ts
│   │   │   ├── Bevel.ts
│   │   │   └── Glow.ts
│   │   └── stylize/
│   │       ├── Pixelate.ts
│   │       └── EdgeDetect.ts
│   ├── presets/
│   │   ├── builtin-presets.json   # Cinematic, Vintage, Glitch, etc.
│   │   └── PresetManager.ts
│   └── transitions/
│       ├── TransitionRegistry.ts
│       ├── glTransitionsAdapter.ts  # Wraps gl-transitions GLSL
│       └── builtin-transitions.json
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 5.2 Panel Components (apps/editor-web/src/panels/)

```
EffectsPanel.tsx       # Left panel — searchable grid, categories, drag source
TransitionsPanel.tsx   # Left panel — transition browser, drag to timeline
ColorPanel.tsx         # Left panel — wheels, curves, scopes, LUT
AudioPanel.tsx         # Left panel — mixer strips, effect rack
MotionPanel.tsx        # Left panel — dope sheet + graph editor
InspectorPanel.tsx     # Right panel — dynamic groups, effect stack UI
```

### 5.3 Timeline Integration (apps/editor-web/src/Timeline/)

```typescript
// TimelineClip.tsx — onDrop(effect) → dispatch command
commands.effect.add({ clipId, effectId, index? })

// TimelineTransition.tsx — onDrop(transition) between clips
commands.transition.add({ trackId, atTime, transitionId, duration })

// TimelineTrack.tsx — render transition rects in overlap zones
```

### 5.4 Command Extensions (packages/commands/src/)

```typescript
// effectCommands.ts
effect.add({ clipId, effectId, params?, index? })
effect.remove({ clipId, effectInstanceId })
effect.reorder({ clipId, fromIndex, toIndex })
effect.setParam({ clipId, effectInstanceId, paramKey, value })
effect.toggle({ clipId, effectInstanceId, enabled })

// transitionCommands.ts
transition.add({ trackId, atTime, transitionId, duration, alignment })
transition.remove({ transitionId })
transition.setParam({ transitionId, paramKey, value })
```

### 5.5 Render IR Extension (packages/render-ir/src/model.ts)

```typescript
export interface SpriteNode extends RenderNodeBase {
  kind: 'sprite';
  // ...existing
  effects?: readonly EffectRenderSpec[]; // NEW
}

export interface EffectRenderSpec {
  effectId: string;
  params: Record<string, number | string | boolean>; // evaluated at frame time
}
```

### 5.6 Pixi Adapter (packages/renderer-pixi-web/src/browser.ts)

```typescript
// In paint() loop, after creating layer.visual:
if (node.effects && node.effects.length > 0) {
  const filters = node.effects.map(
    (spec) => createPixiFilter(spec.effectId, spec.params), // from visual-effects package
  );
  layer.visual.filters = filters;
}
```

### 5.7 Headless/Export Adapter (packages/renderer-headless/)

- Same effect specs → FFmpeg filter graph OR headless Pixi filter chain
- Ensure deterministic output (seeded noise, fixed filter order)

---

## 6. DESIGN TOKENS & UI SPECS (from DESIGN.md)

### 6.1 Colors (Use Exactly)

```css
:root {
  --bg-app: #1e1e1e;
  --bg-panel: #232324;
  --bg-chrome: #2b2b2d;
  --bg-raised: #2a2a2c;
  --bg-inset: #202022;
  --bg-control: #333335;
  --bg-hover: #3f3f42;
  --bg-input: #1a1a1b;
  --bg-deep: #101011;
  --border: #3d3d40;
  --border-strong: #4d4d51;
  --border-hover: #6b6b72;
  --gap: #141414;
  --text: #e4e4e6;
  --text-soft: #dcdcde;
  --text-muted: #9d9da1;
  --text-faint: #8c8c90;
  --accent: #e9b949; /* AMBER — selection, playhead, active keyframe */
  --accent-soft: #d4b06a;
  --ok: #64c48c;
  --danger: #d37a7a;
}
```

### 6.2 Panel Tab Icons

- **Format**: Black-on-transparent PNG, 24×24, CSS `mask-image` with `currentColor`
- **Location**: `apps/editor-web/public/assets/icons/`
- **Naming**: `assets.png`, `inspect_24x24.png`, `motion_24x24.png`, `effects-org_24x24.png`, `blend_24x24.png`, `contrast_24x24.png`, `voice-memo_24x24.png`, `camera.png`, `history2.png`, `agent-ai_24x24.png`, `workflow.png`, `job.png`, `plugin.png`, `diagnostic.png`, `monitor.png`, `timeline.png`

### 6.3 Button / Interaction Rules

- **Icon-only buttons**: `className="icon-button"` (16×16 SVG, `stroke="currentColor"`, `strokeWidth=1.5`)
- **Icon + label**: `className="icon-button icon-button-labeled"` (only when ambiguous)
- **Tooltips**: `title` + `aria-label` MUST include shortcut (e.g., `"Split (S)"`)
- **Toggles**: `aria-pressed` + CSS `:where([aria-pressed="true"])`
- **Destructive**: `TrashIcon` / `CloseIcon` — still icon-only

### 6.4 Dockview Theming

```css
/* apps/editor-web/src/app.css — only via --dv-* variables */
#root .workspace {
  --dv-panel-background: var(--bg-panel);
  --dv-panel-border: var(--border);
  --dv-tab-background: var(--bg-chrome);
  --dv-tab-color: var(--text-muted);
  --dv-tab-hover-color: var(--text);
  --dv-tab-active-color: var(--accent);
  --dv-sash-background: var(--gap);
  --dv-sash-hover-background: var(--border-hover);
}
```

**Never** style `.dv-*` internals directly.

---

## 7. ACCEPTANCE CRITERIA (Definition of Done)

| #   | Criterion                                                                           | Verification                                                                 |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Effects panel opens, shows 25+ effects in categorized grid                          | Manual: click Effects tab → scroll → search "blur"                           |
| 2   | Drag effect from panel → clip on timeline → effect appears in Inspector stack       | Manual: drag Gaussian Blur → Intro clip → see in Inspector                   |
| 3   | Effect params editable in Inspector (sliders, color pickers, inputs)                | Manual: change blurX → see preview update in real time                       |
| 4   | Effect params keyframeable (add keyframe, see in Motion panel)                      | Manual: add keyframe at 0s and 5s → open Motion panel → see curve            |
| 5   | Transitions panel shows 20+ transitions, drag between clips creates transition rect | Manual: drag Cross Dissolve between Intro/Product → see rect on V1           |
| 6   | Transition duration/alignment editable in Inspector                                 | Manual: click transition rect → Inspector shows duration, alignment dropdown |
| 7   | Color panel has 3-wheel corrector + curves + scopes (canvas)                        | Manual: open Color → adjust wheels → see Parade update                       |
| 8   | Audio panel shows mixer strips with meters, clip/track effect rack                  | Manual: play project → see peak meters move                                  |
| 9   | All panels persist in workspace layout (localStorage)                               | Manual: rearrange, refresh → layout restored                                 |
| 10  | Export (MP4) includes all effects, transitions, color grade                         | Automated: golden-frame test against reference PNG                           |
| 11  | No regression in existing panels (Assets, Inspector, Camera, etc.)                  | Test suite: `pnpm test --filter=editor-web`                                  |
| 12  | TypeScript strict mode passes, no `any` in new code                                 | `pnpm typecheck`                                                             |
| 13  | Bundle size increase < 200KB gzipped (tree-shaken filters)                          | `pnpm build && gzip-size dist/editor-web.js`                                 |

---

## 8. DEPLOYMENT & VPS CONTEXT

### 8.1 VPS Environment (Sweden)

```bash
# Server: <CONTROL_PLANE_IP> (joyteam.ir)
# App: media.joyteam.ir → Cloudflare → nginx :80/443 → localhost:8790
# Service: systemd joy-media@api
# Repo: /opt/joy-media (cloned from GitHub)
# Build: pnpm install --frozen-lockfile && pnpm build
# Deploy: systemctl restart joy-media@api
# Logs: journalctl -u joy-media@api -f
```

### 8.2 Build Pipeline

```yaml
# .github/workflows/deploy.yml (or manual)
- checkout
- setup-node (Node 20, pnpm 9)
- pnpm install --frozen-lockfile
- pnpm typecheck
- pnpm test
- pnpm build
- rsync dist/ to VPS:/opt/joy-media/apps/editor-web/dist
- systemctl reload nginx
- systemctl restart joy-media@api
```

### 8.3 Cache Busting

- `vite.config.ts` → `manifest.json` with hashed filenames
- `index.html` loads `/assets/index-<hash>.js` / `index-<hash>.css`
- **Must bump** on every deploy or browser caches stale JS

---

## 9. RISKS & MITIGATIONS

| Risk                                     | Likelihood | Impact            | Mitigation                                                                                                             |
| ---------------------------------------- | ---------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Pixi filter performance (many effects)   | High       | Preview lag       | Limit preview to 2 effects max; "Preview Quality" dropdown (Full/Half/Quarter); bypass expensive effects in proxy mode |
| WebGL context loss on filter compile     | Medium     | Crash             | Wrap filter creation in try/catch; fallback to CPU path; show error toast                                              |
| Effect stack order vs. blend modes       | High       | Visual bugs       | Document: effects apply **after** blend mode, in stack order; test matrix                                              |
| LUT memory (large .cube files)           | Low        | OOM               | Max 64×64×64; stream upload; warn on >32MB                                                                             |
| Timeline transition overlap logic        | High       | Wrong transitions | Unit tests for: adjacent, overlapping, nested, trimmed clips                                                           |
| Keyframe interpolation for effect params | Medium     | Jitter            | Reuse `motion-core` interpolation (hold/linear/eased/bezier)                                                           |
| Audio meter WebAudio context             | Medium     | No meters         | Create `AudioContext` on first play; resume on user gesture                                                            |

---

## 10. CHATGPT PROMPT TEMPLATE (Copy-Paste)

> **You are a senior full-stack engineer. Below is a complete BEFORE/AFTER specification for the JOY Media editor's Effects/Transitions/Color/Audio/Motion panels. The live editor is at https://media.joyteam.ir/ (Dockview + PixiJS + React). Local repo is a pnpm monorepo at `C:\Users\HadiMoti\joy-media` (~30 packages). Target deployment: Sweden VPS (systemd + nginx).**
>
> **Task**: Produce a **debugged, step-by-step implementation plan** (Phases 1–5, each with tasks, file paths, commands, verification steps) that Hermes (AI agent on VPS) can execute autonomously. The plan must:
>
> 1. Respect existing architecture (Render IR → Pixi adapter → headless export)
> 2. Use only approved dependencies (`@pixi/filter-*`, `gl-transitions`, `ffmpeg.wasm`)
> 3. Follow `DESIGN.md` tokens and `ui-kit` patterns exactly
> 4. Include TypeScript types, unit tests, golden-frame tests
> 5. Handle cache-busting, rollback, and VPS deploy steps
> 6. Flag any open questions before starting
>
> **Output format**: Markdown with phases, tasks, code snippets, shell commands, and acceptance checkboxes.

---

## 11. FILES TO CREATE / MODIFY (Checklist for Hermes)

### New Files

- [ ] `packages/visual-effects/` (entire package)
- [ ] `apps/editor-web/src/panels/EffectsPanel.tsx`
- [ ] `apps/editor-web/src/panels/TransitionsPanel.tsx`
- [ ] `apps/editor-web/src/panels/ColorPanel.tsx`
- [ ] `apps/editor-web/src/panels/AudioPanel.tsx`
- [ ] `apps/editor-web/src/panels/MotionPanel.tsx`
- [ ] `apps/editor-web/public/assets/icons/effects-org_24x24.png` (verify exists)
- [ ] `apps/editor-web/public/assets/icons/blend_24x24.png` (verify exists)
- [ ] `apps/editor-web/public/assets/icons/contrast_24x24.png` (verify exists)

### Modified Files

- [ ] `packages/project-schema/src/v1.ts` — add `effects?: EffectInstanceV1[]` to `VisualObjectV1`
- [ ] `packages/render-ir/src/model.ts` — add `effects?: EffectRenderSpec[]` to `SpriteNode`/`VideoFrameNode`
- [ ] `packages/renderer-pixi-web/src/browser.ts` — apply filters from `node.effects`
- [ ] `packages/renderer-headless/src/index.ts` — same for export
- [ ] `packages/commands/src/effectCommands.ts` (new) + `transitionCommands.ts` (new)
- [ ] `apps/editor-web/src/workspace.ts` — ensure panel IDs registered
- [ ] `apps/editor-web/src/panels/InspectorPanel.tsx` — effect stack UI
- [ ] `apps/editor-web/src/Timeline/TimelineClip.tsx` — drop handler for effects
- [ ] `apps/editor-web/src/Timeline/TimelineTrack.tsx` — transition rect rendering
- [ ] `apps/editor-web/src/app.css` — any new panel-scoped styles (use tokens only)
- [ ] `pnpm-workspace.yaml` — add `visual-effects` package
- [ ] `package.json` (root) — add `@pixi/filter-*`, `gl-transitions` dependencies

---

## 12. VERSION & HISTORY

| Version | Date       | Author                | Notes                                            |
| ------- | ---------- | --------------------- | ------------------------------------------------ |
| 1.0     | 2026-07-25 | Hermes (this session) | Initial BEFORE/AFTER spec from live editor audit |

---

**END OF SPECIFICATION**  
_Hand this file to ChatGPT → get debugged plan → give plan to Hermes on VPS → execute._
