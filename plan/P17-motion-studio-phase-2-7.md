# P17 — Motion Studio Phase 2–7 (direct manipulation → advanced authoring)

## Where this comes from

The owner supplied a Persian architecture doc, "Motion Studio — Professional
Direct-Manipulation & Animation Upgrade Plan" (7 phases), transcribed verbatim at
`plan/motion-studio-upgrade-plan-original.md`. **That doc's "Current Implementation
Baseline" section (§2) is stale — verify against the real code before trusting any
gap it describes.** Phase 0 and Phase 1 below are already done; this file is the
handoff for Phases 2–7.

Treat this file as a historical requirements handoff, not an executable
absence checklist. As of 2026-08-21 the current source already has resize and
rotate handles, alignment guides, marquee select, on-canvas text editing,
group/ungroup, capability-driven inspector wiring, keyframe evaluation, basic
keyframe property rows, and trim controls. The remaining unchecked items are
follow-on polish, missing depth, or broader authoring scope — not proof that
those shipped behaviors are absent.

## Read this first

- `apps/editor-web/src/motion-studio/` is the whole editor: `MotionStudioShell.tsx`
  (layout + save/publish orchestration), `MotionStudioCanvas.tsx` (render + drag),
  `MotionStudioInspector.tsx`, `MotionStudioLayersPanel.tsx`, `MotionStudioTimeline.tsx`,
  `MotionStudioTopBar.tsx`, and `state/` (`useSceneEditor.ts`, `sceneCommands.ts`,
  `layerFactory.ts`).
- `packages/motion-core/src/scene.ts` is the `MotionSceneDocument` schema — it
  already models fills/strokes/shadows/filters/blend-modes/masks/typography/
  per-keyframe bezier easing/variables/components/markers. **Read it before adding
  any new field** — most of what Phase 3/6/7 ask for already has a schema slot.
- `apps/editor-web/src/motion-scene-catalog.ts` is the Motion Library (Phase 1,
  done): catalog index + `LocalProjectPersistence` document store, both in
  `window.localStorage`. `MotionPanel.tsx`'s "My Motions" tab is the library UI.
- **Do not confuse this with two other systems that share the word "Motion":**
  `MotionPanel.tsx`'s "Presets"/"Spatial"/"Library" subtabs apply `MotionDescriptor`
  curve presets directly to Main-Timeline `VisualObjectV1` objects
  (`packages/motion-core/src/presets.ts`, `object.replaceAnimation` commands in
  `packages/motion-core/src/commands.ts`) — a different document model, different
  command layer, different undo stack. Motion Studio must never read or write
  `VisualObjectV1` directly, and Motion Presets/HTML Scenes must never open inside
  Motion Studio. This boundary is explicit in the plan's §3 and already respected
  by the current code — keep it that way.

## Already done (Phase 0 + Phase 1)

Run `git log --oneline -- apps/editor-web/src/motion-studio apps/editor-web/src/motion-scene-catalog.ts`
for the exact commits; as of this writing that's two commits on `main`, both
titled with a `fix(motion-studio):`/`feat(motion-studio):` prefix, dated
2026-07-28.

**Phase 0 — stabilize**: single source of truth (`useSceneEditor`), editor state
already separate from document state, selection already unified across
Layers/Canvas/Inspector/Timeline, layer IDs are `crypto.randomUUID()`, document
has `schemaVersion` + a migration function (`packages/motion-core/src/schema.ts`).
The one real bug: canvas drag pushed one undo entry per `pointermove`. Fixed with
a `beginTransaction`/`updateTransaction`/`commitTransaction`/`cancelTransaction`
API on `useSceneEditor` — study this before building resize/rotate (Phase 2),
since every continuous drag interaction must use the same pattern or it will
reintroduce the flooded-undo-stack bug.

**Load-bearing gotcha found via live testing, not typecheck**: `useSceneEditor`
keeps a `documentRef` that must be the *synchronous* source of truth for every
mutation path (`dispatch`/`undo`/`redo`/`updateTransaction`). A version that only
updated the ref at render time (`documentRef.current = document` in the component
body) went stale whenever two native `pointermove`/`pointerup` listeners fired
faster than React 18's batched re-render, silently dropping the transaction's
undo entry. If you add more transaction-style mutations (resize, rotate — Phase
2), route them through `updateTransaction`, don't invent a parallel path.

**Phase 1 — Library round-trip**: `motion-scene-catalog.ts` (catalog index +
`LocalProjectPersistence<MotionSceneDocument, SceneCommand>` + a separate
"published" store for finalized copies). `MotionStudioShell` now takes a real
`sceneId` prop, loads the document on mount, autosaves on a debounce, saves
immediately on Ctrl/Cmd+S, and Publish snapshots into the published store. "My
Motions" tab in `MotionPanel.tsx` lists/opens/renames/duplicates/deletes.
**Not done**: "Add to Main Timeline" (the other half of §13.4 Publish) — creating
a `MotionClipInstance` that places a published scene as a clip on the Main
Timeline. That needs `VisualObjectV1.kind` extended with a `'motion-scene'`
variant (currently `'image' | 'text' | 'shape' | 'null' | 'camera' | 'html-scene'`,
`packages/project-schema/src/v1.ts:169`), a matching `motionScene.create`/`remove`
command pair in `packages/property-system/src/index.ts` (mirror `htmlScene.create`
at `:117-125`/`:326-357`), and a render branch in
`packages/visual-object-renderer/src/index.ts` (mirror the `'html-scene'` branch
at `:86`). The "place on timeline" data flow to copy is
`addHtmlSceneToSelectedClip` in `apps/editor-web/src/App.tsx:1123-1234`. This is
naturally Phase 2/3 adjacent work (a clip needs *something* renderable before
placing it is useful) — pick it up whenever it fits, it doesn't have to be first.

**Icon library**: a Canva icon set was added to
`apps/editor-web/src/panel-icons/ui/` and registered in
`apps/editor-web/src/ui-icons.ts` under `UI_ICONS` (`analysis`, `background`,
`borderRadius`, `charts`, `cloudSaved`, `commentsCaption`, `createNew`,
`deleteTrash`, `down`/`downAlt`, `duplicateCanva`/`duplicateCanvaAlt`,
`folderAssets`, `fullscreenMode`, `help`, `hidden`, `home`, `music`, `opacity`,
`paint`, `proVip`, `refreshRetry`, `removeDelete`, `rightSidebar`, `saveView`,
`stickers`, `threeDots`, `timing`, `unlock`/`unlockAlt`, `up`, `uploadToCloud`,
`verticalView`, `videoCaptions`, `wideView`, plus `-Canva`/`-Alt` suffixed
variants where a same-concept icon already existed). To use one as a component,
add a one-line wrapper in `apps/editor-web/src/icons.tsx` next to the others:
`export function XIcon() { return <PngMaskIcon src={UI_ICONS.x} />; }` (see
`EditIcon` for the pattern this session added). These are useful candidates for
Phase 2's context menu (`three-dots`), Phase 3's inspector sections
(`opacity`, `borderRadius`, `paint`), Phase 5 timeline controls
(`hidden`/`unlock` for per-property visibility), and Phase 6 media pickers
(`folderAssets`, `videoCaptions`, `music`).

## Phases 2–7 — work packages

Copied from the owner's plan, §19, with file pointers added. Check off as you go;
this doc is meant to survive multiple agent sessions.

### Phase 2 — Canvas Direct Manipulation
- [ ] Real resize from corner/edge handles (`MotionStudioCanvas.tsx`'s
      `SelectionOverlay` currently wires **all 8 handles to the same move-drag** —
      grep `startDrag` there; every handle calls it identically, so "resize" today
      just moves the layer). Corner = both axes, edge = one axis, respecting
      §8.3's rules (Shift = aspect lock, Alt = resize from center).
- [ ] Rotate handle (none exists yet) — angle around layer center, Shift snaps to
      15° steps, soft-snap near 0/90/180/270.
- [ ] Alignment guides + snapping (scene center/edges, other layers' center/edges).
- [ ] Keyboard nudge (arrow keys, small/large step with Shift).
- [ ] Double-click text editing on canvas (caret, selection, commit on
      click-outside) — none of this exists; text is only editable via the
      Inspector textarea today.
- [ ] Right-click context menu (Cut/Copy/Paste/Duplicate/Delete/reorder/
      Group/Ungroup/Lock/Hide/Reset Transform/Fit/Center).
- [ ] Multi-selection: `selectedLayerIds` is already an array end-to-end
      (`useSceneEditor.ts`), but `MotionStudioCanvas.tsx` drags each selected
      layer's `SelectionOverlay` independently — group-drag doesn't move them
      together. Marquee-select on empty-space drag doesn't exist either.
- [ ] **All of the above must go through the transaction API** (`beginTransaction`/
      `updateTransaction`/`commitTransaction`) exactly like the move-drag fix in
      Phase 0, or you'll reintroduce one-undo-entry-per-pointermove.

### Phase 3 — Capability-Based Inspector
- [ ] Define a `LayerCapabilities` registry (transform/typography/fill/stroke/
      cornerRadius/shadow/glow/blur/blendMode/crop/mask/filters/editableText per
      `MotionLayerType`) and drive `MotionStudioInspector.tsx`,
      `MotionStudioTimeline.tsx`'s property list, and canvas interaction off it
      instead of the current fixed field set (currently: Transform always, plus
      Text/Typography only for `type === 'text'`, plus a single Fill color swatch
      — no Stroke/Shadow/Blur/Blend UI at all despite the schema already
      supporting them in `scene.ts`).
- [ ] Scene Inspector: Width/Height/Duration are read-only display text today
      (`MotionStudioInspector.tsx`'s no-layer-selected branch) — make them
      editable with validation + undo.
- [ ] Multi-selection Inspector (show only shared properties, "Mixed" for
      divergent values) — not possible yet since Inspector only renders when
      exactly one layer is selected (`MotionStudioShell.tsx`'s `selectedLayer`).
- [ ] Keyframe diamond buttons next to animatable properties (empty/filled/
      animated-but-no-keyframe-here), wired to Phase 4's evaluator once it exists.

### Phase 4 — Animation Engine
- [ ] Build the **evaluator**: `MotionSceneDocument → currentTimeMs → resolved
      per-layer property values`, pure and independent of React (so it's reusable
      for export/thumbnails later). `MotionLayer.animations: MotionAnimation[]`
      and `MotionKeyframeCurve`/`MotionKeyframe` already exist in `scene.ts` with
      bezier/hold/ease interpolation kinds — there is no reader for them yet.
      `MotionStudioCanvas.tsx` explicitly ignores the playhead today:
      `void playheadMs; // animation evaluation hook — expanded in Phase 6` (that
      comment's phase number is stale relative to this doc; it means here).
- [ ] Wire the evaluator into the canvas render path so moving the playhead
      shows animated values, not just the static base transform.
- [ ] Auto-key behavior (§10.6): editing a property with an existing track adds/
      updates a keyframe at the current time; decide the project-wide toggle.

### Phase 5 — Timeline Property Editor
- [ ] Expandable per-layer property rows (Transform/Style/Text sub-groups) in
      `MotionStudioTimeline.tsx` — it currently renders layer lanes only
      (play/seek/zoom/mute/lock), no property or keyframe rows.
- [ ] Keyframe add/delete/move/multi-select/duplicate/copy-paste, snapping to
      playhead and to other keyframes, ease/hold/linear presets.
- [ ] Layer trim (in/out point drag), timeline snapping, scene-duration bound.

### Phase 6 — Media & Group Layers
- [ ] Image layer already has a type + `layerFactory.createImageLayer` +
      canvas rendering (`MotionStudioCanvas.tsx`'s `LayerElement`,
      `layer.type === 'image'` branch) — **but there's no "Add Image" button in
      the toolbar and no asset picker**, and it points at
      `/api/assets/{assetId}` (`MotionStudioCanvas.tsx:108`), which is a **dead
      route** — grepped the whole repo, nothing serves `/api/...`, only
      `apps/api`'s `/v1/...` routes exist. Decide the real asset-serving path
      before wiring this up (probably reuse whatever `apps/api`'s
      `library/my-assets`/`library/cloud-assets` routes already do for the Main
      Editor's asset panel, not invent a new one).
- [ ] Video layer (type doesn't exist as a factory function yet, though
      `'video'` is a valid `MotionLayerType`), poster frame, in/out trim, muted
      preview, basic playback sync with the playhead.
- [ ] Group layer: parent-child transform (layers already have `parentId`/
      `children: MotionLayerId[]` in `scene.ts`, but nothing reads them for
      transform composition or grouping UI yet), group select/ungroup, nested
      hierarchy.
- [ ] SVG layer: import, scale, fill override, preserve-colors mode.

### Phase 7 — Advanced Authoring
- [ ] Editable Code Mode: today `MotionStudioShell.tsx`'s code-mode branch is a
      `readOnly` placeholder `<textarea>` with static placeholder text — no
      document serialization to text, no parse/apply, no sync with Visual Mode.
- [ ] Graph Editor (bezier handle drag for keyframe easing) — motion-core's
      sibling "Motion Presets" system already has one at
      `apps/editor-web/src/GraphEditor.tsx`, built for the *other* animation
      model (`AnimationCurveV1` on `VisualObjectV1`). Decide whether to adapt it
      or write a Motion-Studio-native one against `MotionKeyframeCurve`; the
      visual/interaction logic (drag handles, snapping) is reusable even though
      the data model isn't.
- [ ] Masks, gradient fills, multiple fills/effect stacks, motion paths,
      expressions, nested Motion Scenes, template parameters, an agent-facing
      editing API (§11.5 explicitly calls out "Agent editing API" as a consumer
      of the Phase 4 evaluator — keep the evaluator's API agent-friendly:
      plain data in, plain data out, no React).

## Environment notes for whoever picks this up

- **This machine has a local clone** at `C:\Users\HadiMoti\joy-media-work\repo`
  (Windows), separate from the stale `C:\Users\HadiMoti\joy-media`. Clone fresh
  with `git -c core.protectNTFS=false clone ssh://root@<vps-ip>/opt/joy-media.git`
  if working from a different machine — the repo carries
  `apps/editor-web/public/transitions/preview/gl:*.png` (colon in the filename),
  which NTFS can't materialize; `protectNTFS=false` lets checkout skip them
  instead of aborting. **Any `git reset`/`git stash pop` on this repo, on
  Windows, also needs `-c core.protectNTFS=false`** or the index rebuild fails
  outright and `git status` starts lying (shows unrelated tracked files as
  phantom-deleted). If that happens: don't trust `git status`, trust
  `git ls-files --stage` / `git hash-object` instead, and recover with
  `rm .git/index && git -c core.protectNTFS=false reset`.
- **To actually see it running**: `pnpm install` at the repo root, then
  `pnpm --filter @joy-media/visual-effects build` once (its `dist/` isn't
  checked in and Vite's dependency scanner fails to resolve the package until
  it's built), then `pnpm --filter @joy-media/editor-web dev` → `localhost:5173`
  or next free port. Reach Motion Studio via the "Motion" dockview panel → "My
  Motions" tab → "Create new motion", or "Open" an existing card.
- The VPS (`/opt/joy-media/repo`, origin at `/opt/joy-media.git`) has no pnpm/
  node_modules as of this writing — build and verify locally, then
  `git push origin main` + `ssh … "cd /opt/joy-media/repo && git pull"` to ship,
  same as this session did for Phase 0/1.
- `pnpm -w exec tsc -b apps/editor-web packages/motion-core` is noisy with
  **pre-existing, unrelated** errors (`@joy-media/visual-effects` module
  resolution in a few `.tsx` files, an `ArrayBuffer`/`Blob` mismatch in
  `joycode-opfs-assets.ts`, a stale `Set.length` access in
  `TimelineCanvas.tsx`) — grep the output for the files you actually touched
  rather than expecting a clean run.
