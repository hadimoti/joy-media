# JOY Media — Editor Design System

Owner direction (DECISIONS.md **D-UI-GRAY**, 2026-07-23): a professional, Adobe-class editing surface — icon-driven, neutral-gray, dockable panels. Every panel and every new control follows this file. Source of truth for values is [app.css](apps/editor-web/src/app.css); source of truth for toolbar/action icons is [icons.tsx](apps/editor-web/src/icons.tsx); source of truth for dockview panel-tab glyphs is [panel-tab-icons.ts](apps/editor-web/src/panel-tab-icons.ts) + PNGs under `apps/editor-web/public/assets/icons/`. If a change is needed, change it here and in those files together.

## 1. Color tokens

Neutral grays only. **No blue anywhere.** Amber is the single accent. Semantic green/red are reserved for status.

| Token          | Hex       | Use                                                            |
| -------------- | --------- | -------------------------------------------------------------- |
| `bg-app`       | `#1e1e1e` | Root/page background                                            |
| `bg-panel`     | `#232324` | Panel/article surfaces, dockview group background               |
| `bg-chrome`    | `#2b2b2d` | Header, tab strips                                              |
| `bg-raised`    | `#2a2a2c` | Cards, list rows (history entries, workflow rows, asset cards)  |
| `bg-inset`     | `#202022` | Sunken sections (register form, category rail)                  |
| `bg-control`   | `#333335` | Buttons, lanes, interactive fills                               |
| `bg-hover`     | `#3f3f42` | Hovered controls                                                |
| `bg-input`     | `#1a1a1b` | Text inputs, selects                                            |
| `bg-deep`      | `#101011` | Canvases, code/expression fields, preview wells                 |
| `border`       | `#3d3d40` | Default borders/dividers                                        |
| `border-strong`| `#4d4d51` | Control borders                                                 |
| `border-hover` | `#6b6b72` | Hovered control borders, clip borders                           |
| `gap`          | `#141414` | Dockview separators, workspace gaps                             |
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

- **Keyboard**: all global shortcuts live in [keyboard-shortcuts.ts](apps/editor-web/src/keyboard-shortcuts.ts) (pure resolver + tests). Space play/pause · S split · Del/Backspace ripple delete · Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo/redo · Ctrl+K palette · Esc close · ←/→ seek 1s (Shift = 100 ms) · Home/End. New shortcuts are added to the resolver (with a test) — never as ad-hoc listeners in panels. Shortcuts never fire while typing (`isEditableTarget`).
- **Drag**: pointer events (`setPointerCapture`), 4 px click-vs-drag threshold, 100 ms snap grid, invalid drops snap back silently. `touch-action: none` on draggables.
- **Selection**: amber 2px outline (`aria-pressed='true'`), single accent everywhere.
- Async/busy buttons set `aria-busy` and a disabled state; status text goes in an adjacent `aria-live="polite"` element, not inside the button.

## 4b. Header chrome

- The header owns global state surfaces: undo/redo, command palette, export, then at the inline end a **processes menu** (`ListIcon`, export history from [export-history.ts](apps/editor-web/src/export-history.ts)) and the **account menu** (`UserIcon` + status dot: green ready / amber no-access / red signed-out, session from [identity.ts](apps/editor-web/src/identity.ts)).
- Long-running encodes show a 3px amber `.export-progress` bar pinned to the header's top edge with `role="progressbar"`. Status text lives in a centered `.export-toast` pinned under that bar (absolute, not in the icon row); the toast clears as soon as the file has downloaded (errors linger briefly). Durable history stays in the processes menu.
- Dropdowns use `.header-menu` > `.header-dropdown` (bg-raised, border, 0.4rem radius, shadow, `inset-inline-end: 0`); Escape closes them via the shortcut resolver.

## 4c. Bidirectional text (Persian-first)

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
