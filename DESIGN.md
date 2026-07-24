# JOY Media — Editor Design System

Owner direction (DECISIONS.md **D-UI-GRAY**, 2026-07-23): a professional, Adobe-class editing surface — icon-driven, neutral-gray, dockable panels. Every panel and every new control follows this file. Source of truth for values is [app.css](apps/editor-web/src/app.css); source of truth for toolbar/action icons is [icons.tsx](apps/editor-web/src/icons.tsx); source of truth for dockview panel-tab glyphs is [panel-tab-icons.ts](apps/editor-web/src/panel-tab-icons.ts) + PNGs under `apps/editor-web/public/assets/icons/`. If a change is needed, change it here and in those files together.

## 1. Color tokens

Neutral grays only. **No blue anywhere.** Amber is the single accent. Semantic green/red are reserved for status. Gray ramp is intentionally dark (deeper than early editor drafts) so panels read as Adobe-class chrome, not washed mid-gray.

| Token          | Hex       | Use                                                            |
| -------------- | --------- | -------------------------------------------------------------- |
| `bg-app`       | `#121212` | Root/page background                                            |
| `bg-panel`     | `#18181a` | Panel/article surfaces, dockview group background               |
| `bg-chrome`    | `#1c1c1e` | Header, tab strips                                              |
| `bg-raised`    | `#1f1f21` | Cards, list rows (history entries, workflow rows, asset cards)  |
| `bg-inset`     | `#161618` | Sunken sections (register form, category rail)                  |
| `bg-control`   | `#252528` | Buttons, lanes, interactive fills                               |
| `bg-hover`     | `#323236` | Hovered controls                                                |
| `bg-input`     | `#0e0e10` | Text inputs, selects                                            |
| `bg-deep`      | `#0a0a0b` | Canvases, code/expression fields, preview wells                 |
| `border`       | `#2e2e32` | Default borders/dividers                                        |
| `border-strong`| `#3a3a3e` | Control borders                                                 |
| `border-hover` | `#55555c` | Hovered control borders, clip borders                           |
| `gap`          | `#0a0a0a` | Dockview separators, workspace gaps                             |
| `text`         | `#e4e4e6` | Primary text                                                    |
| `text-soft`    | `#dcdcde` | Icon/button glyphs                                              |
| `text-muted`   | `#9d9da1` | Secondary text, inactive tabs                                   |
| `text-faint`   | `#8c8c90` | Hints, timestamps, metadata                                     |
| `accent`       | `#e9b949` | Selection outlines, playhead, active keyframe, warnings, drag-over |
| `accent-soft`  | `#d4b06a` | Secondary accent (expression/fx active states)                  |
| `ok`           | `#64c48c` | Success/connected status only                                   |
| `danger`       | `#d37a7a` / `#ff8080` | Failure/revoked status and error text only          |

Timeline clips: `#4b4b50` fill, `#58585e` hover, `border-hover` border, `accent` outline when selected.

## 2. Buttons & iconography

**Rule: buttons show SVG icons, not text.** Every repeated, toolbar, or per-item action is an `icon-button` with an icon from [icons.tsx](apps/editor-web/src/icons.tsx) and **both** `aria-label` and `title` (tooltip must state the shortcut when one exists, e.g. `"Undo (Ctrl+Z)"`).

- `className="icon-button"` — square icon-only button. The default.
- `className="icon-button icon-button-labeled"` — icon **plus a short label**, allowed only where the icon alone is ambiguous between siblings (e.g. `SRT`/`VTT` export formats, `FA`/`EN` transcription languages) or for one-time setup/submit actions (Initialize project, Register media, Pair worker). Never a full sentence.
- Toggle buttons (lock/mute/solo, category tabs) carry `aria-pressed`; the pressed state is styled by CSS, never by swapping label text.
- Icons: 16×16 viewBox, `stroke="currentColor"`, `strokeWidth 1.5`, `aria-hidden` — add new icons to `icons.tsx` only; never inline one-off SVGs in a panel, never emoji as icons.
- Destructive per-item actions (delete/revoke) use `TrashIcon`/`CloseIcon` — still icon-only, tooltip says what is destroyed.

Current icon set: play, pause, skip back/forward, undo, redo, scissors (split), trim, trash, export, command (⌘), save, lock, mute, solo, check (approve), close (dismiss/cancel), plus (add), download, upload, mic (transcribe), image (thumbnail), refresh, cloud (backup).

## 3. Layout & panels

- Panels are dockview tabs (Adobe-style dockable windows). Every panel id must be registered in [workspace.ts](apps/editor-web/src/workspace.ts) `PANEL_IDS` + `DEFAULT_WORKSPACE` **and** given a label + tab icon in [panel-tab-icons.ts](apps/editor-web/src/panel-tab-icons.ts) — a panel that isn't registered does not exist.
- **Panel tabs are icon-only.** Dockview uses [PanelTab.tsx](apps/editor-web/src/PanelTab.tsx) as `defaultTabComponent`: black-on-transparent PNGs from `public/assets/icons/` are CSS-masked with `currentColor` so active/inactive `--dv-*-tab-color` tints them. The human label stays on `title` + `aria-label` (and in App's `labels` / panel `title` for overflow menus). Never put the panel name as visible tab text. New panels add a matching PNG + entry in [panel-tab-icons.ts](apps/editor-web/src/panel-tab-icons.ts).
- Dockview chrome is themed only via the `--dv-*` variables in the `#root .workspace` block of app.css. Never restyle `.dv-*` internals directly — tab glyph styling uses our own `.panel-tab` / `.panel-tab-icon` classes.
- Panel root: `<article className="<name>-panel">`, `display: grid; gap: 0.4–0.5rem; align-content: start`. Section headings are `<h3>` (0.8rem, `text-muted`).
- Toolbars: `display:flex; align-items:center; gap:0.4rem` (see `.timeline-toolbar`). Lists of records use `bg-raised` rows with 0.25rem radius (see `.history-entry`, `.workflow-row`).

## 4. Interaction standards

- **Keyboard**: all global shortcuts live in [keyboard-shortcuts.ts](apps/editor-web/src/keyboard-shortcuts.ts) (pure resolver + tests). Space play/pause · S split · Del/Backspace ripple delete · **Ctrl/Cmd+D duplicate** · Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo/redo · Ctrl+K palette · Esc close · ←/→ seek 1s (Shift = 100 ms) · Home/End. New shortcuts are added to the resolver (with a test) — never as ad-hoc listeners in panels. Shortcuts never fire while typing (`isEditableTarget`).
- **Drag**: pointer events (`setPointerCapture`), 4 px click-vs-drag threshold, 100 ms snap grid, invalid drops snap back silently. `touch-action: none` on draggables.
- **Selection**: amber 2px outline (`aria-pressed='true'`), single accent everywhere.
- Async/busy buttons set `aria-busy` and a disabled state; status text goes in an adjacent `aria-live="polite"` element, not inside the button.

## 4a. Project library gate (CapCut-like entry)

- **First paint is the projects library**, not the Dockview editor. [`ProjectLibrary.tsx`](apps/editor-web/src/ProjectLibrary.tsx) lists catalog entries; **Open** / **New project** set the active id and mount [`EditorWorkspace`](apps/editor-web/src/App.tsx). Header **Projects** (`ProjectsIcon`) clears active id and returns to the library.
- Catalog keys: `joy-media.project-catalog.v1` (titles + paired timeline/visual ids), `joy-media.active-project.v1`. Creative docs remain in timeline/visual persistence logs; blank projects use one shared id for both slices ([`project-factory.ts`](apps/editor-web/src/project-factory.ts)).
- Library chrome uses the same neutral-gray tokens as the editor (no purple themes, no emoji decoration). Cards are interactive surfaces (open on click); delete is an icon-only hover control.

## 4b. Timeline NLE strip

- Timeline panel fills Dockview height (`.timeline-panel` flex column; tracks scroll; zoom bar pinned). Zoom uses `TimelineViewport.pixelsPerSecond` (5–200) with fit-to-width via `ResizeObserver` and Ctrl/Cmd+wheel.
- Clip actions: icon row (split / duplicate / ripple delete) + **right-click context drawer** ([`TimelineContextMenu.tsx`](apps/editor-web/src/TimelineContextMenu.tsx)) for select, split, duplicate, delete, speed presets (`0.5×…2×`), freeze frame (1s hold). No second text-heavy toolbar.
- Durable ops: `timeline.duplicateClip`, `timeline.setClipRate`, `timeline.freezeFrame` (+ `restoreTrackClips` undo). Video clips may carry `playbackRate` (`0` = freeze, else `0.1…8`; omit = 1×). Non-1× / freeze show a compact clip badge.

## 4c. Header chrome

- Brand lockup + **project name** + save status on the left; **Projects** returns to the library.
- Center edit cluster: Undo · Redo · Cut · Split · Duplicate · command palette (icon-only + shortcuts in tooltips).
- Right deliver cluster: export-preset menu · primary **Export** text button (accent) · processes · account.
- Groups use `.header-group` separators. Accent is reserved for Export / selection / playhead — not every border.

## 3. Layout & panels (seed)

Default dock seed key `joy-media.dockview.v6`: **Timeline** full-width bottom; above it **Assets | LARGE Monitor | Inspector**. Creative/utility tools stack as tabs on the inspector side. Clear older `v1`–`v5` layout keys on load.

Monitor chrome: resolution · timecode, Fit/50/100/200 zoom, fullscreen, transport under the canvas.

## 4e. Stickers / overlays (P15)

- Image assets: **Add as sticker** creates a `VisualObjectV1` `kind: 'image'`, places a Spike timeline clip for timing, and binds clip→object via `pluginData['joy.clipObjects']` ([`sticker-bindings.ts`](apps/editor-web/src/sticker-bindings.ts)). Seed `TIMELINE_OBJECT_IDS` remain defaults when pluginData is empty.
- Real pixels: OPFS originals decode through [`sticker-image-cache.ts`](apps/editor-web/src/sticker-image-cache.ts) into Monitor/export bitmaps (PNG/WebP alpha preserved). Crop insets (0–0.49) apply in the cache; Inspector exposes crop for image objects.
- Motion presets (Fade/Pop/Slide) and Effects apply to the selected sticker via the clip↔object map.
- **Remove background**: Assets action queues `image.comfy` / RemBG when a paired Worker advertises `image.comfy`; otherwise disabled with an honest tooltip. Matte alpha can bind via `pluginData['joy.imageMatte']`.

## 3. Layout & panels (seed)

Default dock seed key `joy-media.dockview.v5`: Monitor center, Timeline below, Assets left, right stack **creative** (Inspector → Motion → Effects → Transitions → Color → Captions) then **utilities** (Audio → Camera → History → Agent → Workflows → Jobs → Plugins → Diagnostics). `DEFAULT_WORKSPACE.panels` includes all `PANEL_IDS` (including `transitions`).


## 4d. Bidirectional text (Persian-first)

Text fields that hold user content (`input[type=text]`, untyped inputs, search, textarea) carry `unicode-bidi: plaintext` so each field follows its own content direction — Persian is right-aligned, Latin filenames stay left-aligned, no global LTR forcing. Filenames/ids rendered in UI chrome get an explicit `dir="ltr"`. Explainers and empty states use `.empty-hint` (centered, muted, line-height 1.5); never leave a bare left-aligned paragraph floating in a panel.

## 5. Accessibility non-negotiables

Icon-only buttons always have `aria-label` + `title`. Toggles always have `aria-pressed`. Live status regions use `aria-live="polite"`. Interactive targets ≥ 1.9rem square. Text contrast: `text` on `bg-control` and lighter surfaces must stay ≥ 4.5:1.

## 6. Adding a new panel — checklist

1. Register id in `workspace.ts` (`PANEL_IDS` + `DEFAULT_WORKSPACE`) and `PANEL_LABELS` / `PANEL_TAB_ICONS` in `panel-tab-icons.ts`.
2. Add a black-on-transparent panel-tab PNG under `public/assets/icons/` and map it in `panel-tab-icons.ts` (§3).
3. Root `<article className="…-panel">`, tokens from §1 only — no new hex values without adding them to this file.
4. Common actions as `icon-button`s (§2); new toolbar icons into `icons.tsx`.
5. Shortcuts through the resolver (§4).
6. Verify in the browser (light smoke: mount, console clean, icon tab reachable via tooltip label) before claiming done.
