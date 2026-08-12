# WP-31 — WP-29/WP-30 UI Information Architecture and Workflow Polish

**Status:** Planned  
**Priority:** P1  
**Depends on:** WP-29 and WP-30 product behavior remaining intact  
**Repository:** `/opt/joy-media/repo`  
**Production root:** `/opt/joy-media`  
**Primary result:** The complete WP-29/WP-30 feature set is easier to find, better grouped, calmer at first glance, and still fully accessible at all three supported desktop sizes.

## Summary

WP-29 and WP-30 made the editor functionally complete across project lifecycle,
real-media import, animated assets, timeline editing, captions, audio processing,
Worker/Cloud execution, effects, motion, export, recovery, and nested timeline
editing. The next improvement should not add another large feature surface. It
should make the existing product read as one coherent editing workflow.

WP-31 reorganizes the UI around five user intents:

1. **Start** — Projects, recent work, Trash, and creation.
2. **Media** — Assets, import, preview, captions, and audio preparation.
3. **Edit** — Program Monitor, Timeline, Inspector, History, and Dual Lens.
4. **Enhance** — Effects, Transitions, Color, Motion, Camera, and Templates.
5. **Deliver** — Export presets, progress, Recent processes, Jobs, Workflows,
   Joy Code, Diagnostics, and Plugins.

The editor remains dockable. Existing panel IDs and creative document schemas
remain valid. The change is information architecture, progressive disclosure,
consistent component structure, responsive overflow behavior, and clearer
status communication.

## Why this work is needed

The current UI is capable but visually dense:

- Nineteen durable workspace panels currently appear with nearly equal visual
  weight, so users must remember implementation-specific locations instead of
  following a Media → Edit → Enhance → Deliver workflow.
- The Timeline toolbar, clip context menu, Inspector Speed tab, and Dual Lens
  repeat or scatter related timing controls.
- Narrow Timeline behavior is tied to the browser viewport instead of the
  actual Dockview panel width, and the CSS expects an overflow control that is
  not currently rendered. Actions can therefore wrap or disappear.
- Project, Asset, Caption, Audio, Job, and Export surfaces use different menu,
  confirmation, progress, failure, and recovery patterns for similar tasks.
- `app.css` contains multiple generations of Timeline and Asset styles. Visual
  polish must first remove duplicate/shadowed rules so source order does not
  decide which design wins.

- `workspace.ts` exposes 19 panels in one flat list.
- Dock tabs are icon-only, so users must learn many unrelated glyphs before they
  understand the product structure.
- Timeline transport, track creation, editing tools, clip actions, zoom, Fit,
  nested navigation, and Flow actions share one long toolbar.
- Export preset, Export, Cancel, Recent processes, and account state compete in
  the global header.
- Assets combines source switching, category tabs, import, refresh, filters,
  view density, bulk actions, cards, preview, and cloud state in one panel.
- Inspector has the correct Transform, Effects, Audio, and Speed tabs, but the
  selection summary and action hierarchy need stronger visual separation.
- Audio exposes Studio, Models, Master, Clips, runtime cards, workflows, three
  execution targets, device/cache settings, and consent in one panel.
- Success, progress, warnings, blocked integrations, retry, and recovery appear
  through several unrelated banners, notes, cards, and header menus.
- Compact widths rely heavily on shrinking rather than predictable overflow or
  task-oriented workspace presets.

This plan addresses those problems without changing the authored-media model or
reopening the proven WP-29/WP-30 backend paths.

## Product principles

### 1. Organize by intent, not subsystem

Users should choose what they are trying to do—Media, Edit, Enhance, Deliver—
without first knowing the internal package or runtime that implements it.

### 2. One visible primary action per surface

Each panel or menu has one visually dominant next action. Secondary and
destructive actions remain available but do not compete with it.

### 3. Progressive disclosure

Common controls stay visible. Advanced settings, destructive operations,
runtime diagnostics, and uncommon variants move into drawers, disclosure
sections, or overflow menus with stable keyboard access.

### 4. Context follows selection

Timeline selection drives Inspector, Effects, Audio, and Speed. Those panels
must clearly identify the current target and retain their structure when no
supported target is selected.

### 5. Status is consistent

The same visual vocabulary represents idle, saving, running, blocked,
interrupted, completed, warning, and failed states everywhere.

### 6. Preserve expert workflows

Docking, command palette, shortcuts, context menus, direct timeline actions,
drag/drop, Undo/Redo, and saved layouts remain first-class. Simplification must
not turn the editor into a step-by-step wizard.

## Proposed information architecture

| Intent  | Primary surfaces                     | Secondary surfaces                              |
| ------- | ------------------------------------ | ----------------------------------------------- |
| Start   | Project Library, New Project, Recent | Trash, lifecycle actions                        |
| Media   | Assets, Import, Preview              | Captions, Audio Studio                          |
| Edit    | Program Monitor, Timeline, Inspector | History, Dual Lens                              |
| Enhance | Effects, Transitions, Color          | Motion, Camera, Templates                       |
| Deliver | Export, Recent processes             | Jobs, Workflows, Joy Code, Diagnostics, Plugins |

### Workspace presets

Add a compact workspace switcher to the header or View menu with these presets:

- **Edit** — Assets left; Program Monitor upper center; Inspector right;
  Timeline full-width bottom. This remains the default.
- **Enhance** — Program Monitor center; Inspector/Effects/Transitions/Color right;
  Timeline bottom.
- **Audio & Captions** — Assets left; Program Monitor center; Audio/Captions
  right; Timeline bottom.
- **Automate** — Assets left; Program Monitor center; Joy Code/Workflows/Jobs
  right; Timeline bottom.
- **Custom** — the user's manually docked layout.

Switching a preset must not discard a saved Custom layout. Vertical and
widescreen variants remain available inside every preset.

Dock tab groups show icon plus text when their container has room. They collapse
to icon-only tabs only in compact groups, with tooltip/accessibility names and a
visible overflow affordance; users must not inspect nineteen anonymous icons to
discover a panel.

### Grouped panel discovery

Group the View menu and command-palette panel actions:

- Media: Assets, Captions, Audio.
- Edit: Program Monitor, Timeline, Inspector, History, Dual Lens.
- Enhance: Effects, Transitions, Color, Motion, Camera, Templates.
- Automation: Joy Code, Workflows, Jobs.
- System: Diagnostics, Plugins.

Keep every current durable panel ID so old Dockview layouts and deep links
continue to recover.

## UI system additions

Build a small set of shared primitives rather than another layer of panel-local
CSS:

- `WorkspaceSwitcher` — presets, Current/Custom state, keyboard navigation.
- `GroupedPanelMenu` — grouped View/palette presentation from one metadata map.
- `ActionOverflowMenu` — predictable More menu used when a toolbar exceeds its
  container.
- `StatusBadge` — idle, running, completed, warning, failed, blocked, offline.
- `InlineNotice` — actionable panel note with optional primary action.
- `EmptyState` — icon, title, one short explanation, one primary action.
- `FilterSummary` — active filter chips plus Clear all.
- `SelectionSummary` — selected target name, type, duration, and track.
- `ProcessCenter` — shared export/job/AI operation list and recovery actions.
- `Menu`, `Popover`, `Dialog`, and `ConfirmDialog` — one keyboard/focus model,
  pending state, inline error recovery, edge clamping, and focus return.
- `SegmentedControl` — labeled source, mode, direction, and status choices.
- `TransportControls` — shared transport used by Timeline and Dual Lens.
- `TimelineViewControls` — shared Zoom, Fit, Follow, and Data Lanes control.
- `TimelineBreadcrumbs` — root and nested compound navigation.
- `MonitorDisplayMenu` — preview-only scale and authored canvas format in one
  clearly separated surface.

Add these rules to `DESIGN.md` and use tokens from `app.css`. Do not introduce a
second visual theme.

Before surface polish, split the relevant portions of `app.css` into owned
feature styles (Panel shell, Timeline, Assets, Inspector, Audio, Captions,
Project Library, and Export), remove shadowed legacy rules after visual parity,
and establish shared density, touch-target, elevation, and container-query
tokens. This is a mechanical prerequisite, not a visual redesign by itself.

## Surface-by-surface changes

### A. Project Library — Start

1. Use explicit **Projects (N)** and **Trash (N)** tabs.
2. Render a labeled **New project** primary action rather than an icon-only
   action.
3. Add search, Grid/List view, and a single Sort control with:
   - Recently updated;
   - Recently created;
   - Name A–Z;
   - Name Z–A.
4. Present active projects as **Recent** followed by **All Projects** when more
   than one project exists.
5. Keep the always-visible three-dot menu and current Rename, Duplicate, and
   Move to Trash behavior.
6. Keep Trash visually secondary; sort it by deletion time and retain Restore and
   exact-name permanent deletion.
7. Standardize card metadata order: title → thumbnail/fallback → updated time →
   media/duration summary → local/cloud/sync status.
8. Keep pending rename/duplicate/trash/purge state on only the affected card or
   dialog. Keep the modal open during the request; on failure retain the original
   catalog order and show an inline actionable error.
9. Preserve keyboard menu navigation, focus return, typed deletion, API rollback,
   highlight-after-duplicate, and the current 260 px card width.

Primary files:

- `apps/editor-web/src/ProjectLibrary.tsx`
- `apps/editor-web/src/project-lifecycle.ts`
- `apps/editor-web/src/app.css`

### B. Assets — Media

Use this fixed control order:

1. Source: **My media / Cloud library** segmented control with counts.
2. Category: All, Video, Audio, Images.
3. Search.
4. Active filter chips.
5. Content grid/list.

Additional changes:

- Keep Import as the primary header action.
- Move Refresh, density, collection management, and uncommon bulk actions into
  secondary/overflow groups.
- Keep Filter visible only while active or opened; show a count badge when it
  changes the result set.
- Make sort choice explicit in the filter summary.
- Place selection count and bulk operations in one pinned selection bar that
  appears only while items are selected.
- Give every card the same metadata sequence: name, type/duration/dimensions,
  Animated/static status, source availability, then actions.
- Show an always-visible Animated/GIF/WebP badge in every density. Put frame
  count, cycle duration, loop state, and alpha in Preview; do not autoplay dozens
  of cards merely to prove animation.
- Distinguish `Local copy`, `Cloud original`, `Shared cloud`, and `Unavailable`
  through one status component rather than free-form card strings.
- Keep preview in a focused panel/sheet with source, dimensions, duration,
  animation state, Play/Pause for animated media, Add to Timeline, Edit with AI,
  and Close.
- Make card click open Preview and keep **Add to timeline** as the visible primary
  card action. Move AI, backup/share, locate, and delete into an accessible More
  menu that remains reachable by keyboard and coarse pointer.
- Replace browser-native confirmations with the shared pending/error-safe dialog.
- Preserve the WP-30 rule that cards, preview, Program Monitor, and export use
  the same decoded animation timing.

Primary files:

- `apps/editor-web/src/AssetLibraryPanel.tsx`
- `apps/editor-web/src/asset-library-state.ts`
- `apps/editor-web/src/asset-card-preview.ts`
- `apps/editor-web/src/PanelShell.tsx`
- `apps/editor-web/src/app.css`

### C. Program Monitor — Edit

Sort the footer into three stable zones:

- Start: current time / duration and source-quality indicator.
- Center: previous, Play/Pause, next.
- End: one Display control containing preview scale, canvas format, and
  fullscreen.

The Display popover must make the difference between view state and authored
project state explicit:

- **Preview — view only:** Fit, 50%, 100%, 200%, and Fullscreen.
- **Canvas format — changes project/export; undoable:**
  - Widescreen: 16:9 and 21:9;
  - Standard landscape: 4:3 and 3:2;
  - Square: 1:1;
  - Portrait: 9:16, 4:5, 3:4, and 2:3.

Show the selected ratio, actual composition dimensions, and orientation on the
closed trigger and inside the menu. Only one Monitor popover may be open; it must
flip/clamp inside the panel and return focus on Escape. Keep one atomic
visual+timeline composition transaction and ensure Undo, Redo, reload, and write
failures leave the selector synchronized with persisted dimensions.

Keep the disclosed limitation for reverse preview audio in one visible,
selection-aware notice—not only a tooltip.

Primary files:

- `apps/editor-web/src/App.tsx` (`MonitorPanel`)
- `apps/editor-web/src/MonitorAspectRatioSelector.tsx`
- `apps/editor-web/src/app.css`

### D. Timeline — Edit

Reorder the toolbar into stable groups:

1. **Navigation** — merged-timeline Back/breadcrumb and active composition name.
2. **Transport** — Play/Pause, previous, next, timecode.
3. **Tools** — Select, Split, marker.
4. **Edit** — Add track, Duplicate, Ripple Delete.
5. **View** — Zoom, Fit, follow mode, Dual Lens reveal.

Use Timeline panel container queries, not browser viewport media queries. At
compact panel widths:

- Navigation, Play/Pause, active tool, timecode, and Fit never disappear.
- Duplicate, Delete, Add Track, marker, and Flow move into `More` in that order.
- Tooltips and keyboard shortcuts remain identical whether an action is visible
  or in overflow.

Context-menu grouping:

- Edit: Split, Duplicate.
- Time: Playback speed…, Freeze, Reverse/Restore forward.
- Structure: Merge selected clips, Open merged timeline.
- Flow/Track: Reveal in Flow and move/track actions when supported.
- Destructive: Ripple Delete, separated last.

Additional behavior:

- Replace the single Back label with a breadcrumb such as
  `Main / Merged clip`, while keeping the Back icon/button.
- Show why Merge is unavailable for noncontiguous, cross-track, mixed, or locked
  selections.
- **Playback speed…** opens Inspector → Speed (or a genuine submenu). An
  ellipsis action must never silently apply an arbitrary `0.5×` rate.
- Context menus receive first-enabled focus, Arrow/Home/End/typeahead navigation,
  Escape/click-outside dismissal, focus return, viewport-edge clamping, checked
  state, destructive styling, and concise disabled reasons.
- Keep duration-changing nested operations disabled until parent-resize
  semantics exist, with one consistent explanation.
- Keep track headers, visibility/lock/solo controls, and scrub gutter sticky
  during paged follow.
- Display a small `Fit`/`Follow` state label rather than relying on button color
  alone.
- Use effective content duration everywhere, including Dual Lens.
- Replace duplicate/legacy Timeline menu implementations and CSS only after
  proving the active caller and visual parity.

Primary files:

- `apps/editor-web/src/TimelinePanel.tsx`
- `apps/editor-web/src/TimelineContextMenu.tsx`
- `apps/editor-web/src/ContextMenu.tsx`
- `apps/editor-web/src/DualLensPanel.tsx`
- `apps/editor-web/src/timeline-layout.ts`
- `apps/editor-web/src/app.css`

### E. Inspector — Edit

Keep four tabs, in this order:

1. Visual
2. Effects
3. Audio
4. Speed

`Visual` contains Transform and Crop as disclosure sections. Use the current
tab labels as migration aliases so persisted `transform` selection opens
`Visual`.

Tabs are capability-aware while retaining this fixed order: Audio appears only
for a clip with audio, and Speed only for a playable video. When selection
changes, retain the last valid tab and fall back predictably without landing on
an empty panel.

Add a pinned selection summary beneath the tabs:

- clip/object name;
- media kind;
- track;
- source duration and authored timeline duration;
- badges for Reversed, Frozen, Ramped, Muted, or Locked.

Speed organization:

- Direction (**Forward / Reverse**) first.
- Constant speed: draft numeric control with inline range validation and one
  commit on Apply, Enter, or blur; then compact common-rate presets.
- Speed ramps last as three selectable curve cards with their descriptions,
  three-segment consequence, and Undo hint.
- Show the visible silent-preview/export-audio explanation only while Reverse is
  active.
- Frozen or unsupported clips show the full tab structure with read-only state,
  not a replacement empty paragraph.

Preserve one-step Undo/Redo and presentation/audio bindings for Freeze and speed
ramps.

Primary files:

- `apps/editor-web/src/InspectorPanel.tsx`
- `apps/editor-web/src/speed-ramp.ts`
- `apps/editor-web/src/app.css`

### F. Captions and Audio — Media

Captions:

- Keep transcript list as the primary view.
- Put active track/language and cue count first when multiple caption documents
  exist.
- Keep **Add caption** as the visible primary edit action.
- Use one **Transcribe** menu with English and Persian; remove the duplicate
  English/Auto caption route.
- Put named templates under **Style** and SRT/VTT import/export under one
  **Import/Export** menu.
- Standardize each row: time/confidence → editable text → row actions.
- Show RTL/LTR direction from language/source metadata and retain keyboard edit,
  revert, delete, seek, and download behavior.

Audio:

- Use three task tabs: **Enhance**, **Mix**, and **Runtime**. Models and provider
  capability filters live inside Runtime instead of competing with the editing
  task.
- Reorder Enhance content to **Source → Workflow → Run target → Progress/Result**.
- Select exactly one run target, then show one primary `Run <workflow>` action.
- Collapse runtime cards into one summary row; expand for Worker, provider,
  device, cache, and model details.
- Show Browser DSP as the default no-setup path.
- Show Local Worker and Cloud Brain as enhanced targets with honest Ready,
  Pairing, Offline, Blocked, and Paid confirmation states.
- Move current Master/Clips controls into Mix and current Models controls into
  Runtime without changing their persistence or processing behavior.
- Route successful processing into one result-review surface: Preview,
  Replace/Keep, Undo, and provenance.

Primary files:

- `apps/editor-web/src/CaptionsPanel.tsx`
- `apps/editor-web/src/AudioPanel.tsx`
- `apps/editor-web/src/JobsPanel.tsx`
- `apps/editor-web/src/app.css`

### G. Enhance panels

Use the same order across Effects, Transitions, Motion, Color, Camera, and
Templates:

1. Search/category/favorites.
2. Browse library.
3. Current selection/applied state.
4. Parameters.
5. Remove/reset actions.

Specific rules:

- Effects and Transitions share card, favorite, warning, and apply affordances.
- Applied effect ordering lives in Inspector; library browsing stays in Effects.
- Motion sections use My Motions, Library, Scenes, Presets, Spatial in one
  predictable row with overflow at narrow widths.
- Camera exposes active camera and Create first; advanced parent/FOV/roll fields
  remain in a disclosure section.
- Templates separates Built-in and My Templates, with confirmation for delete.
- Color exposes current grade/LUT state before controls and keeps Reset visible.

Primary files:

- `apps/editor-web/src/EffectsPanel.tsx`
- `apps/editor-web/src/TransitionsPanel.tsx`
- `apps/editor-web/src/MotionPanel.tsx`
- `apps/editor-web/src/ColorPanel.tsx`
- `apps/editor-web/src/CameraPanel.tsx`
- `apps/editor-web/src/TemplatesPanel.tsx`

### H. Deliver, operations, and recovery

Keep Export as the global primary delivery action. Replace the separate icon-only
preset/export controls with a labeled split control that shows the active preset,
canvas dimensions, and effective duration. Arrange the delivery group as:

1. **Export MP4** split button and preset menu.
2. Cancel, only while this project has an active export.
3. Process Center with active-count/status badge.

Replace the export-only Recent processes dropdown with `ProcessCenter`, grouped
into:

- Running;
- Needs attention;
- Completed.

Each row shows operation type, target/project, status, progress or size,
timestamp, and only the actions valid for its state: Cancel, Retry, Review,
Download, or Dismiss.

Add filters/counts for **Active**, **Needs attention**, **Completed**, and **All**.
Within each group sort newest first, use text plus icon rather than color alone,
and retain multiple verified completed downloads—not only the newest hydrated
Blob URL. Errors expand in place without erasing durable history.

The first version may aggregate browser exports and link out to Jobs for Worker
and workflow records. It must not invent a unified backend record before one
exists.

Recovery states use these exact labels:

- `Interrupted — retry available`
- `Waiting for Worker`
- `Needs approval`
- `Failed — retry`
- `Completed`

Primary files:

- `apps/editor-web/src/App.tsx`
- `apps/editor-web/src/export-history.ts`
- `apps/editor-web/src/JobsPanel.tsx`
- `apps/editor-web/src/WorkflowsPanel.tsx`
- `apps/editor-web/src/AgentPanel.tsx`
- `apps/editor-web/src/app.css`

## Persistence and migration

Introduce a versioned UI-preference document, separate from creative data:

```ts
interface EditorUiPreferencesV2 {
  readonly version: 2;
  readonly workspacePreset: 'edit' | 'enhance' | 'audio-captions' | 'automate' | 'custom';
  readonly viewMode: 'vertical' | 'widescreen';
  readonly projectLibrary: {
    readonly view: 'grid' | 'list';
    readonly sort: 'updated-desc' | 'created-desc' | 'name-asc' | 'name-desc';
  };
  readonly assetLibrary: {
    readonly source: 'user' | 'cloud';
    readonly category: 'all' | 'video' | 'audio' | 'image';
    readonly view: 'large' | 'medium' | 'list';
    readonly sort: string;
    readonly collectionByCategory: Readonly<Record<string, string>>;
  };
  readonly audioStudio: {
    readonly workflowId?: string;
    readonly target?: 'browser' | 'worker' | 'cloud';
    readonly deviceId?: string;
    readonly cachePath?: string;
  };
  readonly processFilter: 'active' | 'attention' | 'completed' | 'all';
  readonly jobsFilter: string;
  readonly panelTabs: Readonly<Record<string, string>>;
  readonly disclosures: Readonly<Record<string, boolean>>;
}
```

Migration rules:

- Preserve existing Dockview JSON and all durable panel IDs.
- Map old Inspector `transform` tab to `visual`.
- Preserve Asset density and vertical/widescreen preferences.
- Preserve library sorts/views, Audio target/workflow, and Jobs/Process filters;
  do not persist transient search queries or an in-progress destructive action.
- Persist active caption-document and panel selection as project-scoped UI state,
  separate from authored caption data.
- A failed or unknown preference falls back to Edit without touching project data.
- Reset Workspace resets UI preferences only.
- Account-wide UI preferences must never be purged with a project.

## Responsive behavior

Viewport checkpoints remain acceptance gates, but individual panels respond to
their Dockview **container width**, not only the browser viewport. A wide browser
with a 320 px Timeline or Inspector must receive the same compact affordances as
a compact browser.

### 1639 × 1066

- Full workspace switcher and toolbar groups may remain visible.
- Inspector selection summary can show two metadata rows.
- Asset grid defaults to large cards when space permits.

### 1366 × 768

- Workspace switcher may collapse to icon + current name.
- Timeline secondary actions move into More before transport or Fit compresses.
- Panel tabs use horizontal overflow with visible scroll affordance.
- Header menus remain within viewport edges.

### 1024 × 768

- Use a compact Edit preset with Assets/Inspector as tabs instead of simultaneous
  narrow columns.
- Keep Program Monitor and Timeline usable without page-level horizontal scroll.
- Text labels collapse before icons; every icon retains tooltip and accessible
  name.
- Dialogs and drawers fit the viewport and own their internal scrolling.
- Timeline uses Back/breadcrumb, Play/Pause, active tool, Fit, and More; every
  collapsed command remains reachable.

Touch-width/coarse-pointer checks must keep three-dot menus, asset actions,
timeline context access, and project lifecycle controls reachable without hover.

## Accessibility requirements

- Workspace switcher, grouped View menu, all overflows, and context menus support
  initial focus, Arrow keys, Home/End, typeahead where applicable, Escape,
  click-outside, edge clamping, and focus return.
- Tab lists use roving keyboard focus and announce selected state.
- Toolbars expose group names and do not duplicate keyboard handling.
- No global Space shortcut fires from inputs, native controls, menus, sliders, or
  shortcut-owned overlays.
- Status changes use one polite live region; destructive/failed states may use
  assertive announcements only when immediate action is required.
- Color is never the sole state signal.
- Every visible disabled state uses the native `disabled` attribute or accurate
  `aria-disabled` semantics and exposes a concise reason nearby.
- Dialogs trap focus, remain open while an asynchronous operation is pending,
  disable only affected controls, and preserve entered values on actionable
  failure.
- Zoom at 200% retains all primary actions and avoids page-level overflow.
- Persian/RTL content keeps logical alignment without reversing editor chrome.

## Implementation plan

### WP-31.0 — Baseline and UI inventory

- Capture signed-in screenshots and interaction maps at all three viewports.
- Record panel/action counts, overflow, focus order, console errors, and current
  Dockview/localStorage keys.
- Add a WP-31 browser spec skeleton and screenshot naming convention.

Gate: baseline is reproducible without changing user projects.

### WP-31.1 — Shared IA metadata and primitives

- Create one panel metadata registry containing label, icon, intent group,
  command, and default preset placement.
- Make View menu, command palette, Dockview labels, and workspace presets consume
  that registry.
- Add shared Menu/Popover/Dialog/ConfirmDialog, SegmentedControl, StatusBadge,
  InlineNotice, EmptyState, FilterSummary, and overflow menu.
- Extract the affected feature styles and remove duplicate legacy Timeline/Asset
  rules only after screenshot parity.
- Add container-query and density/touch tokens.
- Extend `DESIGN.md` with the new hierarchy rules.

Gate: no duplicated panel map; unit and keyboard tests pass.

### WP-31.2 — Workspace presets and header

- Add Edit, Enhance, Audio & Captions, Automate, and Custom presets.
- Preserve both vertical and widescreen saved layouts per preset.
- Reorder global header into Brand/Project, Edit, and Deliver groups.
- Add grouped panel discovery and Reset Workspace.

Gate: switching/restoring presets preserves project, selection-safe state, and
Custom layout.

### WP-31.3 — Project Library and Assets

- Implement Project search/sort/Recent/All organization.
- Reorder Asset source/category/search/filter/content controls.
- Add standardized selection bar, source badges, card metadata, and preview
  actions.
- Surface animated-media status and metadata in every card density and Preview.

Gate: lifecycle and WP-30 cross-browser/animated-media suites remain green.

### WP-31.4 — Monitor, Timeline, Dual Lens, and Inspector

- Add shared transport/view/breadcrumb controls and a real container-responsive
  Timeline overflow.
- Combine Monitor preview scale and authored canvas formats in the sectioned
  Display menu.
- Add nested breadcrumb and clearer Fit/Follow state.
- Add Inspector selection summary and Visual tab alias.
- Reorder Speed into Direction, Constant speed, and Speed ramp; commit a valid
  manual draft once rather than on every keystroke.
- Consolidate the active Timeline context menu, group actions, and add its full
  focus/keyboard/disabled-reason behavior.

Gate: all current timeline-editing, loop/Space, Fit/follow, nested merge, aspect,
reverse, speed, and export parity tests remain green.

### WP-31.5 — Captions, Audio, and Enhance panels

- Standardize Captions into Track, Add, Transcribe, Style, and Import/Export;
  remove the duplicate English route.
- Reorganize Audio into Enhance, Mix, and Runtime, with
  source/workflow/one-target/one-run-action ordering.
- Apply consistent browse/applied/parameters hierarchy to Enhance panels.

Gate: WP-29 R2/R5 browser cases and audio/caption persistence tests remain green.

### WP-31.6 — Process Center and recovery UX

- Introduce Process Center for export history and linked operations.
- Normalize retry, interrupted, approval, Worker, and completion labels.
- Preserve OPFS export recovery, identical re-download, operation IDs, and
  no-duplicate guarantees.

Gate: export recovery, Worker lifecycle, Cloud consent/idempotency, and reload
during operation tests pass.

### WP-31.7 — Responsive, accessibility, and visual polish

- Finish three-viewport overflow behavior.
- Run keyboard/focus/zoom/RTL/coarse-pointer review.
- Add screenshot checkpoints and bounding-box assertions.
- Remove obsolete panel-local CSS after parity is proven.

Gate: no horizontal page overflow, inaccessible action, focus escape, or new
console/page/request error at any supported viewport.

### WP-31.8 — Deployment and live acceptance

- Run full CI and browser audit from an exact candidate SHA.
- Create immutable API/editor releases only if API changes are actually needed;
  otherwise deploy an editor-only immutable release.
- Test in one exact disposable live project.
- Verify protected user project/upload remains unchanged.
- Clean the disposable project and all run-created state.
- Update QA, STATE, and GBrain after evidence passes.

Gate: public bytes match the immutable release, health is green, live UI passes,
and cleanup returns to baseline.

## Test plan

### Component and unit tests

- Panel metadata registry completeness and unique IDs.
- Workspace preset creation, Custom preservation, reset, and migration.
- Grouped menus, overflow ordering, initial focus, Home/End/typeahead, focus
  return, and viewport-edge placement.
- Dialog focus trap, pending state, cancel safety, and inline error recovery.
- Project sort/search, Grid/List persistence, and Trash isolation.
- Asset filter summary, source status, animated badge/metadata, selection bar,
  preference migration, and Preview actions.
- Timeline toolbar priority by panel width, context-menu sections/disabled
  reasons, nested breadcrumbs, and shared transport/view controls.
- Monitor Display grouping, canvas-format transaction, and focus return.
- Inspector capability-aware tab migration, selection badges, Speed draft
  validation, and one-command commit.
- Captions exposes one English transcription route and compact keyboard menus.
- Audio workflow → target → run hierarchy and Jobs priority grouping.
- Process status normalization, multiple cache-ready downloads, filter
  persistence, and valid action availability.

### Browser specifications

Add:

- `tests/e2e/wp31-workspace-navigation.spec.ts`
- `tests/e2e/wp31-project-assets-ui.spec.ts`
- `tests/e2e/wp31-editing-ui.spec.ts`
- `tests/e2e/wp31-audio-enhance-ui.spec.ts`
- `tests/e2e/wp31-process-recovery-ui.spec.ts`
- `tests/e2e/wp31-responsive-a11y.spec.ts`

Run at:

- `1639×1066`;
- `1366×768`;
- `1024×768`.

Reuse and retain:

- `timeline-editing-features.spec.ts`;
- all WP-29 R2/R5 and export-recovery specs;
- WP-30 cross-browser and animated timeline/export specs.

### Browser assertions

- No page-level horizontal overflow.
- Critical controls remain within panel/viewport bounds.
- Resizing a Dockview panel independently of the viewport moves every collapsed
  action into More; no command becomes unreachable at panel widths ≥320 px.
- One primary action per panel is visually identifiable.
- Every feature is reachable through a labeled panel group or contextual path.
- Focus order is stable before and after overflow/layout changes.
- No ErrorBoundary, page error, unexpected console error, or failed same-origin
  request.
- Saved workspace/panel/filter state survives refresh.
- Axe scans pass for Projects, Assets, Edit workspace, dialogs, Monitor Display,
  Audio, Captions, and Process Center; reduced-motion disables nonessential
  progress animation.
- Project and Asset actions remain reachable without hover under coarse-pointer
  emulation.
- UI reorganization does not alter project JSON, media hashes, job IDs, or
  export bytes unless the user performs an authored edit.

## Acceptance criteria

- All WP-29/WP-30 capabilities remain reachable and functionally unchanged.
- A new user can identify Media, Edit, Enhance, and Deliver without inspecting
  icon tooltips one by one.
- View menu and command palette use the same grouped panel taxonomy.
- Project Library and Assets have explicit, persistent sorting and filtering.
- Timeline primary controls never disappear at supported widths.
- Monitor aspect ratio, Timeline context actions, nested Back/breadcrumb, and
  Inspector Speed are visually ordered and synchronized with persisted state.
- Audio execution targets clearly distinguish default local browser processing,
  paired Worker enhancement, and paid/remote Cloud execution.
- Running, interrupted, blocked, failed, completed, and downloadable operations
  use consistent status and recovery actions.
- All menus, tabs, disclosures, dialogs, and overflow controls pass keyboard and
  focus tests.
- All three viewports pass functional and UI/accessibility verdicts.
- Existing WP-29/WP-30 browser suites remain green.
- The final live disposable project is removed, protected user state is
  unchanged, and no P0/P1 or cleanup discrepancy remains.

## Non-goals

- No new media engine, codec, AI provider, Worker protocol, or export format.
- No redesign of creative project schemas merely for UI organization.
- No replacement of Dockview or removal of custom docking.
- No mobile phone editor; 1024×768 remains the supported minimum workspace.
- No silent execution of paid Cloud or licensed-model operations.
- No modification of the user's surviving project or manually uploaded assets
  during audit/deployment.

## Execution protocol

For every work package:

1. Record candidate SHA, affected surfaces, viewport, and baseline screenshots.
2. Implement only that package.
3. Run focused unit/component tests.
4. Run affected WP-29/WP-30 browser regressions.
5. Review screenshot, overflow, keyboard, focus, console, page-error, and request
   evidence.
6. Reproduce every apparent defect once before classifying it.
7. Commit and push an additive change only after its gate passes.
8. Continue to the next package only after review.

## Completion checklist

- [ ] WP-31.0 — Baseline and UI inventory approved.
- [ ] WP-31.1 — Shared IA metadata and primitives green.
- [ ] WP-31.2 — Workspace presets and header green.
- [ ] WP-31.3 — Project Library and Assets green.
- [ ] WP-31.4 — Monitor, Timeline, Dual Lens, and Inspector green.
- [ ] WP-31.5 — Captions, Audio, and Enhance panels green.
- [ ] WP-31.6 — Process Center and recovery UX green.
- [ ] WP-31.7 — Responsive/accessibility/visual matrix green.
- [ ] WP-31.8 — Immutable deployment, signed-in acceptance, cleanup, QA, and
      GBrain closeout green.
- [ ] WP-31 marked `FINISHED` only after every gate passes.
