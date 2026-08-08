# JOY Media — Editor Design System

Owner direction (DECISIONS.md **D-UI-GRAY**, 2026-07-23; **D-UI-FONT**, 2026-07-25): a professional, Adobe-class editing surface — icon-driven, neutral-gray, dockable panels, with **Modam Pro** for Eng/Fa/Arabic UI type. Every panel and every new control follows this file. Source of truth for values is [app.css](apps/editor-web/src/app.css); for UI fonts, [public/assets/fonts/modam-pro/](apps/editor-web/public/assets/fonts/modam-pro/) + §4f; for toolbar/action icons, [icons.tsx](apps/editor-web/src/icons.tsx); for dockview panel-tab glyphs, [panel-tab-icons.ts](apps/editor-web/src/panel-tab-icons.ts) + PNGs under `apps/editor-web/public/assets/icons/`. If a change is needed, change it here and in those files together.

## 1. Color tokens

Neutral grays only. **No blue anywhere.** One amber accent. Semantic green/red are reserved for status. The shell follows a **CapCut-like tile layout** (§3b): pure-black canvas (`#000`) with medium-gray panel surfaces (`#252525`) separated by 2px black gaps and 16px outer corner radius on dock tiles.

**The `:root` block of [app.css](apps/editor-web/src/app.css) is the only place a hex may be declared.** Every other rule references `var(--joy-*)`. A literal hex outside `:root` is a defect, not a style choice — that is how the ramp drifted to 103 distinct values and three competing yellows.

| Token                  | Hex                      | Use                                                            |
| ---------------------- | ------------------------ | -------------------------------------------------------------- |
| `--joy-bg-app`         | `#000000`                | Root/page background, dock canvas, gap bleed                   |
| `--joy-bg-panel`       | `#252525`                | Dockview group + content background, panel tile fill           |
| `--joy-bg-chrome`      | `#2d2d2d`                | Dock tab strips, nested toolbars (app header/menubar are `--joy-bg-app`) |
| `--joy-bg-elevated`    | `#333333`                | Dropdowns, popovers, active dock tab tile                      |
| `--joy-bg-raised`      | `#383838`                | Cards, list rows (history entries, workflow rows, asset cards) |
| `--joy-bg-inset`       | `#1e1e1e`                | Sunken sections, inactive dock tab tile                        |
| `--joy-bg-control`     | `#3a3a3a`                | Buttons, lanes, interactive fills                              |
| `--joy-bg-hover`       | `#323232`                | Hovered controls, hovered dock tab                             |
| `--joy-bg-active`      | `#404040`                | Pressed / selected control fill                                |
| `--joy-bg-input`       | `#1a1a1a`                | Text inputs, selects                                           |
| `--joy-bg-deep`        | `#000000`                | Canvases, code/expression fields, preview wells                |
| `--joy-border-subtle`  | `rgb(255 255 255 / 7%)`  | Hairlines inside a surface                                     |
| `--joy-border`         | `#3a3a3a`                | Default borders/dividers                                       |
| `--joy-border-strong`  | `#484848`                | Control borders                                                |
| `--joy-border-hover`   | `#5a5a62`                | Hovered control borders, clip borders                          |
| `--joy-gap`            | `#000000`                | Dockview separators, workspace gaps (same as canvas)            |
| `--joy-shell-gap`      | `2px`                    | Outer dock padding + split separator width + groupview border    |
| `--joy-radius-panel`   | `16px`                   | Outer dock group / panel tile corners (tab rail + body)        |
| `--joy-radius-inner`   | `10px`                   | Inner wells, dock icon-tab corners, import zones               |
| `--joy-text`           | `#ececef`                | Primary text                                                   |
| `--joy-text-secondary` | `rgb(255 255 255 / 64%)` | Supporting text inside a row                                   |
| `--joy-text-muted`     | `#a8a8b0`                | Secondary text, inactive tabs                                  |
| `--joy-text-faint`     | `#96969f`                | Hints, timestamps, metadata; still AA-readable on panel gray   |
| `--joy-text-disabled`  | `rgb(255 255 255 / 28%)` | Text inside an inactive panel body (§3c)                       |
| `--joy-accent`         | `#f4b72f`                | **The** accent — see the scarcity list below                   |
| `--joy-accent-hover`   | `#ffc94f`                | Accent under hover only                                        |
| `--joy-accent-dim`     | `rgb(244 183 47 / 22%)`  | Accent washes: drag-over fill, active-tab underline            |
| `--joy-ok`             | `#6fcf97`                | Success/connected status only                                  |
| `--joy-danger`         | `#ef6a6a`                | Failure/revoked status and error text only                     |

**Retired.** `--joy-accent-soft` (`#d4b06a`) and the hardcoded `#e9b949` are removed. Three yellows within one surface is why the editor reads mustard rather than Adobe-amber. Anything that used `accent-soft` for a "secondary active" state now uses `--joy-text` (active but not special) or `--joy-accent` (genuinely the current thing).

### 1a. Accent scarcity (binding)

Amber is the rarest ink in the app. It is permitted **only** on:

1. the selection outline of the selected clip / keyframe / card,
2. the playhead,
3. the label of the active tab (text color, plus a 2px underline in `--joy-accent-dim`),
4. the primary **Export** button,
5. an engaged toggle (favorites-on, solo, record),
6. drag-over drop targets, and warning/`in-progress` status dots.

It is forbidden on: resting clip fills, resting borders, card frames, panel headers, section rules, scrollbars, icon glyphs at rest, and any surface larger than roughly a 40px square. **Timeline clips are neutral** — `--joy-bg-control` fill, `--joy-border-hover` border, warm tint only via the 3px left rail and only on the outline when selected. A timeline where every clip is amber has no way left to show which clip is selected.

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
- **Panel tabs are icon-only.** Dockview uses [PanelTab.tsx](apps/editor-web/src/PanelTab.tsx) as `defaultTabComponent`: black-on-transparent PNGs from `public/assets/icons/` are CSS-masked with `currentColor` so active/inactive `--dv-*-tab-color` tints them. The human label stays on `title` + `aria-label` in the rail, and becomes visible only inside Dockview's overflow menu when a group is too narrow to show every tab. Never disable that overflow menu or leave a panel unreachable. New panels add a matching PNG + entry in [panel-tab-icons.ts](apps/editor-web/src/panel-tab-icons.ts).
- Dockview chrome is themed via the `--dv-*` variables in the `#root .workspace` block of app.css, plus the **CapCut shell tile rules** in §3b. Tab glyph styling uses our own `.panel-tab` / `.panel-tab-icon` classes — do not restyle other `.dv-*` internals ad hoc.
- Panel root: `<article className="joy-panel-root <name>-panel">` built from the shell in §3a. The `<name>-panel` class carries only what is genuinely unique to that panel — never its header, tabs or scroll behaviour. `.joy-panel-root` is **background-transparent**; the gray tile comes from the dock group (§3b).
- Toolbars: `display:flex; align-items:center; gap:0.4rem` (see `.timeline-toolbar`). Lists of records use `bg-raised` rows with `--joy-radius-inner` (see `.history-entry`, `.workflow-row`).
- **History panel** is Photoshop-style: one linear list of restore points (Document → edits). Click a row to jump; future states after the cursor are dimmed. Undo/redo buttons live in the header/menubar only — not inside the History panel.

## 3b. CapCut shell (binding — dock workspace)

Owner direction, 2026-07-28: the editor workspace reads like CapCut's Media tab — **black canvas**, **gray panel tiles**, **2px black gaps**, **16px rounded outer corners** on each dock group (tab rail + panel body as one tile). The app header and menubar sit on the same pure-black canvas (`--joy-bg-app`), not gray chrome. Gaps are not borders painted on panels; they are the canvas showing between separated tiles.

| Rule | Implementation |
| ---- | -------------- |
| Canvas | `#root .workspace`, `.app-header`, `.app-menubar`, and `--joy-bg-app` are `#000000`. Workspace gets `padding: var(--joy-shell-gap)` (2px). `--dv-group-view-background-color` must stay black too — dockview paints `.dv-dockview` with that variable; gray there shows through rounded tile corners. |
| Panel tile | Each `.dv-groupview` is `--joy-bg-panel` (`#252525`), `border-radius: var(--joy-radius-panel)` (16px), `overflow: hidden`. Apply radius on `.dv-groupview` itself (not only under `.dv-resize-container` — docked groups live in `.dv-view`). Tab rail + `.dv-content-container` share the same outer radius as one tile. |
| Gap rhythm | `--dv-separator-border` and split `::before` separators use `--joy-gap` at `--joy-shell-gap` width. Each groupview also carries a `2px solid var(--joy-bg-app)` border so adjacent tiles never touch. |
| Tab rail | `.dv-tabs-and-actions-container` / `.dv-void-container` / `.dv-tab` / `.panel-tab` are **transparent** — no gray chips behind icons. Active tab icon tint stays amber (§1a); inactive stays `--joy-text-muted`. |
| Panel content | `.dv-content-container` / `.dv-react-part` fill `--joy-bg-panel`. `.joy-panel-root` does not repaint its own background — content sits inside the dock tile. Timeline, Dual Lens, and Monitor stay flush (`padding: 0`) inside their tile. |
| Inner wells | Import zones, category rails, nested lists use `--joy-bg-inset` / `--joy-bg-elevated` with `--joy-radius-inner`. |

**Forbidden:** full-bleed dock groups with no outer gap, transparent tab rails that float on the canvas, card-style `article` padding around panel roots, or reintroducing charcoal `#0d0e10` / `#111216` shell fills.

## 3a. The panel shell contract (binding — every panel, no exceptions)

Owner direction, 2026-07-26: **every** panel is built from one shell, so that moving between Effects, Motion, Inspector and Assets feels like moving between tabs of one Adobe application rather than between five apps. This section is a contract, not a suggestion. A panel that does not use these classes is not finished.

### Vertical order — fixed

```
┌──────────────────────────────────────────────┐
│  ⬆  ↻      ⬦ Title            ☆  ⌕  +        │  .joy-panel-header   (fixed)
├──────────────────────────────────────────────┤
│  ⌕ search…                                   │  .joy-panel-search   (collapsed by default)
├──────────────────────────────────────────────┤
│         Library   Scenes   Motion            │  .joy-panel-tabs     (fixed, centered)
├──────────────────────────────────────────────┤
│   ┌────┐ ┌────┐ ┌────┐ ┌────┐                │  .joy-panel-body     (scrolls)
│   │ ▣  │ │ ▣  │ │ ▣  │ │ ▣  │   ← previews   │
│   └────┘ └────┘ └────┘ └────┘                │
└──────────────────────────────────────────────┘
```

Nothing may be inserted above the header or between the header and the tabs except the collapsed search bar. No panel gets its own toolbar row.

### The six parts

| Class                                | Rule                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.joy-panel-root`                    | Panel root, always `<article>`. `display:flex; flex-direction:column; height:100%; overflow:hidden; container-type:inline-size`. Background transparent (§3b); padding lives here, once. |
| `.joy-panel-header`                  | 3-column grid `1fr auto 1fr`, `flex-shrink:0`. The center column never moves; the two outer columns balance each other so the title stays optically centered. Height is one control (`--control-sm`).                                                                              |
| `.joy-panel-leading-actions`         | Optional icon-button group in column 1, `justify-self:start`. Use only when a panel has a meaningful start-edge action group; Assets uses Import, Filter/Sort, and Refresh here. It must not become a second toolbar.                                                              |
| `.joy-panel-title`                   | `<h3>` in column 2, `justify-self:center`. `--joy-type-sm` (13px), `--joy-text`, weight 600, no letter-spacing tricks. Carries a 16×16 leading glyph — the **same** icon as the panel's dockview tab, read from `PANEL_TAB_ICONS`. Never duplicate the icon file per panel.                       |
| `.joy-panel-actions`                 | Column 3, `justify-self:end`, `gap:0.1rem`. Ordered inline-end-ward: **create (+) · favorites (☆) · filter · search (⌕)**. Only `icon-button`s. Two to four buttons; more than four means the panel needs tabs or a justified `.joy-panel-leading-actions` split, not more chrome. |
| `.joy-panel-tabs` / `.joy-panel-tab` | Centered flex row, `role="tablist"`, `flex-shrink:0`. Tabs are plain text (`--joy-type-xs`, 12px) — muted at rest, `--joy-text` + 2px `--joy-accent-dim` underline when `aria-selected`. No pills, no boxes, no borders.                                                                         |
| `.joy-panel-body`                    | The only scrolling element: `flex:1 1 0; min-height:0; overflow-y:auto; overscroll-behavior:contain`. Holds the item grid or the settings stack.                                                                                                                                   |

A panel with a single view still renders `.joy-panel-tabs` — with one tab, or omitted entirely if the panel genuinely has one view (Monitor, Timeline). It never renders a _different_ structure.

### Item cards inside `.joy-panel-body`

Small, uniform, preview-first — the Motion library card is the reference. Grid of `repeat(auto-fill, minmax(6rem, 1fr))`; each card is a preview well (`--joy-bg-deep`, 1:1) with a one-line name under it and its per-item actions revealed on hover/focus. Cards carry no amber at rest (§1a).

### Forbidden

- A left-aligned panel title, or a title in the same row as a text toolbar.
- An always-visible search box. Search is a `⌕` toggle that reveals `.joy-panel-search` beneath the header and auto-focuses; Escape closes and clears.
- Per-panel header CSS. `.effects-panel-header`, `.motion-panel-header` and friends are **deleted**, not aliased — they were byte-identical duplicates.
- Text buttons for repeated actions (§2), and emoji as icons anywhere.

## 3c. Panels are always mounted (binding)

Owner direction, 2026-07-26: **a panel must never swap its structure for a sentence.** Today Inspector, Motion → Presets, Motion → Spatial and Audio early-return `Select a clip…` and the user loses the header, the tabs and every control — so the app looks broken rather than idle, and there is nothing to learn from while nothing is selected.

The rule:

1. Header, tabs and body render **at every point in the lifecycle**, selection or not.
2. When the panel's inputs need a selection it does not have, mark the body `.joy-panel-body is-inactive` and set `aria-disabled="true"` on it. Every control inside takes the real `disabled` attribute — dimming alone is not enough, a disabled-looking control must also be unclickable.
3. `.is-inactive` renders at `opacity: 0.4` with `pointer-events: none` and text at `--joy-text-disabled`. Previews stay visible at that opacity; they are the affordance that tells the user what the panel will do.
4. The reason goes in **one** `.joy-panel-note` strip directly under the tabs — one short line ("Select a clip to edit its properties"), `aria-live="polite"`, never a centered paragraph occupying the panel.
5. Tabs stay live even when the body is inactive. A user must be able to browse Motion → Spatial to see what it offers before committing to a selection.

Panels whose content is genuinely independent of selection (Effects, Transitions, Motion → Library, Assets, History, Jobs, Workflows, Plugins, Diagnostics) never go inactive — their catalog is always browsable, and applying an item is what surfaces the "select a clip first" toast.

## 3d. Compliance matrix

Every panel, and what it owes. `✔` = already conforms.

| Panel            | Root       | Centered title | Actions (inline end)              | Tabs                             | Inactive state          |
| ---------------- | ---------- | -------------- | --------------------------------- | -------------------------------- | ----------------------- |
| Effects          | ✔          | ✔              | ⌕                                 | ✔ categories                     | never                   |
| Motion           | ✔          | ✔              | + ☆ ⌕                             | ✔ Library/Scenes/Presets/Spatial | ✔ on Presets + Spatial  |
| Transitions      | ✔          | ✔              | ☆ ⌕                               | ✔ Browse (no Applied tab)        | never                   |
| Assets (`media`) | ✔          | ✔              | start: ⬆ filter ↻ · end: ☁ view ⌕ | ✔ All/Video/Audio/Images         | never                   |
| Captions         | ✔          | ✔              | burn-in ⌕                         | ✔ Transcript/Preview             | ✔ when no caption track |
| Inspector        | ✔          | ✔              | —                                 | ✔ Transform/Effects/Audio        | ✔                       |
| Camera           | ✔          | ✔              | +                                 | ✔ Rig/Transform                  | ✔                       |
| Audio            | ✔          | ✔              | —                                 | ✔ Master/Clips                   | ✔                       |
| Color            | ✔          | ✔              | ↻ reset                           | ✔ Grade/LUT/Scopes               | never                   |
| History          | ✔          | ✔              | —                                 | none                             | never                   |
| Diagnostics      | ✔          | ✔              | —                                 | none                             | never                   |
| Jobs             | ✔          | ✔              | + thumb ↻                         | ✔ Workers/Queue/Pair             | never                   |
| Agent            | ✔          | ✔              | policy segment                    | ✔ Compose/Activity               | never                   |
| Workflows        | ✔          | ✔              | ↻                                 | ✔ Saved/System                   | never                   |
| Plugins          | ✔          | ✔              | safe-mode lock                    | none                             | never                   |
| Monitor          | **exempt** | —              | its own transport bar             | —                                | —                       |
| Timeline         | **exempt** | —              | NLE tool row (§4b)                | —                                | —                       |

**The two exemptions are deliberate.** Monitor and Timeline are viewports, not
browsers: they have no item grid, their entire job is pixels and time, and a
title row would cost preview height that the picture needs. Their dockview tab
already names them, and both carry purpose-built chrome (transport + zoom,
tool row + ruler) that the shell would only get in the way of. Every other
panel uses the shell — these two are the only permitted exceptions, and adding
a third needs an owner decision recorded here.

## 3e. Order of work

1. `:root` accent ramp — drop `accent-soft`, add `accent-dim`, retire `#e9b949` (§1).
2. Shell primitives into app.css; delete the duplicated `.effects-panel-header` / `.motion-panel-header` blocks (§3a).
3. Neutralise timeline clip fills (§1a).
4. Panels, in the matrix order above, one commit per group.
5. Sweep the remaining literal hexes in app.css onto tokens (§1).
6. Browser verification before any claim of done (§6.6).

## 3f. Panel decisions (binding — do not reverse without an ADR)

Captions panel row layout (2026-07-31): each caption segment renders on two lines — line 1 = clickable timestamp + confidence percentage; line 2 = raw source text + undo icon + trash icon. Confidence is shown for every segment, not only low-confidence.

Captions preview (2026-07-31): the live preview of caption burn-in appears on the Monitor's **Live** tab, not inside the Captions panel. The Captions panel shows only the transcript/segment list.

Transitions panel (2026-07-31): the panel has **no Applied tab**. Transitions are visible only in the timeline after they are added. The Browse tab shows the available transition types.

Panel header minimalism convention (2026-07-31): every panel header uses a 3-column CSS grid — center column holds the title, end column holds action buttons. Search is accessed via a magnifier icon that reveals the search bar on click and dismisses it on Escape.

Favorite icons (2026-准则): effects and transitions panels show a minimal SVG star icon for favorites — no text labels alongside the icon.

## 4. Interaction standards

- **Keyboard**: all global shortcuts live in [keyboard-shortcuts.ts](apps/editor-web/src/keyboard-shortcuts.ts) (pure resolver + tests). Space play/pause · S split · Del/Backspace ripple delete · **Ctrl/Cmd+D duplicate** · Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo/redo · Ctrl+K palette · Esc close · ←/→ seek 1s (Shift = 100 ms) · Home/End. New shortcuts are added to the resolver (with a test) — never as ad-hoc listeners in panels. Shortcuts never fire while typing (`isEditableTarget`).
- **Drag**: pointer events (`setPointerCapture`), 4 px click-vs-drag threshold, 100 ms snap grid, invalid drops snap back silently. `touch-action: none` on draggables.
- **Selection**: amber 2px outline (`aria-pressed='true'`), single accent everywhere.
- Async/busy buttons set `aria-busy` and a disabled state; status text goes in an adjacent `aria-live="polite"` element, not inside the button.

## 4a. Project library gate (CapCut-like entry)

- **First paint is the projects library**, not the Dockview editor. [`ProjectLibrary.tsx`](apps/editor-web/src/ProjectLibrary.tsx) lists catalog entries; **Open** / **New project** set the active id and mount [`EditorWorkspace`](apps/editor-web/src/App.tsx). **File → Projects Library…** on the Adobe-style menubar under the header clears the active id and returns to the library.
- Catalog keys: `joy-media.project-catalog.v1` (titles + paired timeline/visual ids), `joy-media.active-project.v1`. Creative docs remain in timeline/visual persistence logs; blank projects use one shared id for both slices ([`project-factory.ts`](apps/editor-web/src/project-factory.ts)).
- Library chrome uses the same neutral-gray tokens as the editor (no purple themes, no emoji decoration). Cards are interactive surfaces (open on click); delete is an icon-only hover control.

## 4b. Timeline NLE strip

- Timeline panel fills Dockview height (`.timeline-panel` flex column; tracks scroll; zoom bar pinned). Zoom uses `TimelineViewport.pixelsPerSecond` (5–200) with fit-to-width via `ResizeObserver` and Ctrl/Cmd+wheel.
- Dual Lens Time View shares the same `TimelineViewport` and shows the same zoom controls (out / slider / in / fit) pinned to the right of the heading after the data-lanes disclosure.
- **Dockview note:** `timelineViewport` / autoFit / track flags live on `EditorPanelContext`, not Panel closure props — Dockview caches the first `Panel` component and stale closures break Fit/zoom.
- Clip actions: icon row (split / duplicate / ripple delete) + **right-click context drawer** ([`TimelineContextMenu.tsx`](apps/editor-web/src/TimelineContextMenu.tsx)) for select, split, duplicate, delete, speed presets (`0.5×…2×`), freeze frame (1s hold). No second text-heavy toolbar.
- Durable ops: `timeline.duplicateClip`, `timeline.setClipRate`, `timeline.freezeFrame` (+ `restoreTrackClips` undo). Video clips may carry `playbackRate` (`0` = freeze, else `0.1…8`; omit = 1×). Non-1× / freeze show a compact clip badge.

## 4c. Header chrome

- Brand lockup on the left (logo + **JOY Studio**). Immediately after the title: inline application menu ([`AppMenuBar.tsx`](apps/editor-web/src/AppMenuBar.tsx) + [`app-menu.ts`](apps/editor-web/src/app-menu.ts)) — **File · Edit · Clip · Joy Code · View · Window** as plain-text triggers with dropdowns. No separate menubar row under the header.
- Center/right edit cluster: Undo · Redo · command palette · shortcuts (icon-only + shortcuts in tooltips).
- Right deliver cluster: export-preset menu · primary **Export** accent button · processes · account.
- Groups use `.header-group` spacing only — no separator hairlines. Accent is reserved for Export / selection / playhead — not every border.
- `.app-header` has no bottom border; it sits flush on the black canvas. `.app-menubar` is an inline flex child of the brand group (transparent, no full-width strip).
- Primary Export (`.header-export-btn`) is an accent fill with `--joy-radius-inner` corners and no outline border.
- File → Projects Library… returns to the library; View lists every Dockview panel by name.

## 3. Layout & panels (seed)

Default dock seed key `joy-media.dockview.v7`: **Timeline** full-width bottom; above it **Assets | Inspector | Monitor (right)**. Creative/utility tools stack as tabs on the inspector side. Clear older `v1`–`v6` layout keys on load. Default composition / blank project: **1080×1920**.

Monitor chrome: resolution · timecode, Fit/50/100/200 zoom, fullscreen, transport under the canvas. Preview canvas is absolutely contained so intrinsic frame size cannot inflate the dock.

## 4e. Stickers / overlays (P15)

- Image assets: **Add as sticker** creates a `VisualObjectV1` `kind: 'image'`, places a Spike timeline clip for timing, and binds clip→object via `pluginData['joy.clipObjects']` ([`sticker-bindings.ts`](apps/editor-web/src/sticker-bindings.ts)). Seed `TIMELINE_OBJECT_IDS` remain defaults when pluginData is empty.
- Real pixels: OPFS originals decode through [`sticker-image-cache.ts`](apps/editor-web/src/sticker-image-cache.ts) into Monitor/export bitmaps (PNG/WebP alpha preserved). Crop insets (0–0.49) apply in the cache; Inspector exposes crop for image objects.
- Motion presets (Fade/Pop/Slide) and Effects apply to the selected sticker via the clip↔object map.
- **Remove background**: Assets action queues `image.comfy` / RemBG when a paired Worker advertises `image.comfy`; otherwise disabled with an honest tooltip. Matte alpha can bind via `pluginData['joy.imageMatte']`.

## 4d. Persian explainer copy (centered and layout-neutral)

Visible panel titles, menu labels, tab labels, action labels, technical names, and
product/domain identifiers stay English. Explanatory paragraphs, guidance,
empty states, live status messages, and text-entry placeholders are Persian.

Persian explainer elements carry `lang="fa"` and inherit `--joy-font-ui`
(Modam Pro). The shared `[lang='fa']` rule centers the copy and applies
`unicode-bidi: plaintext`; it does **not** set `direction`. Do not put explicit
`dir="rtl"` or `dir="ltr"` on explainer blocks: those direction overrides have
broken otherwise neutral panel layouts. Inline filenames, ids, API names, and
code tokens stay isolated with `<bdi>` or `<code>` when embedded in Persian.

Text fields that hold user content (`input[type=text]`, untyped inputs, search,
textarea) keep `unicode-bidi: plaintext` so the user's own text remains
readable. Explainers and empty states use `.empty-hint` or their panel-specific
equivalent (centered, muted, line-height 1.5); never leave a bare left-aligned
guidance paragraph floating in a panel.

## 4f. Typography (Eng / Fa / Arabic)

**UI chrome face is Fontiran Modam Pro** for English, Persian (Farsi), and Arabic UI strings — same licensed webfont pack as JOY Agent.

| Token / face            | Value                                               | Use                                                                    |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `--joy-font-ui`         | `'Modam Pro', Tahoma, system-ui, sans-serif`        | Root, body, buttons, inputs, selects, textareas, panel chrome          |
| `--joy-font-mono`       | `ui-monospace, SFMono-Regular, Consolas, monospace` | Timecode, expressions, diagnostic/code wells only                      |
| `--joy-type-2xs`        | `0.6875rem` (11px)                                  | Dense metadata, badges, IDs; the minimum normal UI text size           |
| `--joy-type-xs`         | `0.75rem` (12px)                                    | Tabs, inputs, secondary labels                                         |
| `--joy-type-sm`         | `0.8125rem` (13px)                                  | Panel titles and primary compact labels                                |
| `--joy-type-md`         | `0.875rem` (14px)                                   | Dialog headings and emphasized controls                                |
| `'Modam Pro Condensed'` | Optional condensed weights in `modam-pro.css`       | Dense labels only when explicitly requested — not the default UI stack |

Text below 11px is reserved for non-textual diagram annotations inside a fixed SVG. It is not permitted for buttons, metadata, empty states, timeline labels, or studio controls.

- Source files: [`apps/editor-web/public/assets/fonts/modam-pro/`](apps/editor-web/public/assets/fonts/modam-pro/) (`modam-pro.css` + WOFF2/WOFF). Preload Regular in [`index.html`](apps/editor-web/index.html); stack is applied in [`app.css`](apps/editor-web/src/app.css) `:root`.
- Persian explainer copy follows §4d: centered, layout-neutral, and tagged
  `lang="fa"` so Modam Pro is applied without changing panel direction.
- **Do not** use Inter, Roboto, Arial, Segoe UI, or Helvetica as the editor UI family.
- **HTML scene packages** (ADR-0006) keep package-local / system faces declared in each scene `source` for deterministic goldens — they are not the editor UI stack. Do not load Modam over the network inside a sandboxed scene.
- License: Fontiran Modam Pro (commercial). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## 5. Accessibility non-negotiables

Icon-only buttons always have `aria-label` + `title`. Toggles always have `aria-pressed`. Live status regions use `aria-live="polite"`. Interactive targets ≥ 1.9rem square. Text contrast: `text` on `bg-control` and lighter surfaces must stay ≥ 4.5:1.

## 6. Adding a new panel — checklist

1. Register id in `workspace.ts` (`PANEL_IDS` + `DEFAULT_WORKSPACE`) and `PANEL_LABELS` / `PANEL_TAB_ICONS` in `panel-tab-icons.ts`.
2. Add a black-on-transparent panel-tab PNG under `public/assets/icons/` and map it in `panel-tab-icons.ts` (§3).
3. Root `<article className="joy-panel-root …-panel">` built from the §3a shell — header, tabs, body, in that order. Tokens from §1 only; a literal hex outside `:root` fails review.
4. Common actions as `icon-button`s (§2) in `.joy-panel-actions`; new toolbar icons into `icons.tsx`.
5. Shortcuts through the resolver (§4).
6. If the panel needs a selection, implement the inactive state from §3c — never an early return.
7. Verify in the browser (light smoke: mount, console clean, icon tab reachable via tooltip label, panel renders its full shell with nothing selected) before claiming done.
