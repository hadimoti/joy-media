# ADR-0046: The Monitor is a viewport over the frame, not a scaled picture

Status: Proposed (sent to Opus 5.5 for a plan-mode consult on 12 Nov 2026; a reviewer's point-by-point answer is appended below when it lands)
Date: 2026-11-12
Owner of this note: MC (mcode CLI), worktree `v111-ui`, branch `v111/monitor-ui`
Closes: part of REQ-04 (all rows of the owner's Monitor request, `BUGS-from-owner.md:170-190`)
Task: T-M01 of `07a-NEW-TASK-CARDS-part1.md:42-57`

## Context

The Monitor is the surface the owner edits on and he calls it the biggest change of v1.1.1. Today it is a picture of a picture.

What the code actually does (verified 12 Nov 2026, read-only, in `v111-ui` at `ddb586be`):

- The Monitor is one component, `MonitorPanelContent`, inside `apps/editor-web/src/App.tsx:7446-8280`. The wrapper `MonitorPanel` is at `App.tsx:7426-7444`; the component is mounted as dockview panel id `monitor` at `App.tsx:6597-6598`.
- Zoom is a **CSS transform on a container that is `position: absolute; inset: 0; overflow: hidden`** (`App.tsx:8106-8110`, CSS at `app.css:1659-1674`). The scale factor is derived at `App.tsx:7958-7959` from a four-value state `viewerZoom` (`App.tsx:7483`): `fit | 50 | 100 | 200`. Because the container clips, "200 %" is a **centre crop**, not a magnification the user can move through.
- The picture is drawn by PixiJS at the **authored** size: `renderer.setResolution(previewQualityResolution(previewQuality))` then `renderer.render(frame, videoBitmaps)` (`App.tsx:7677-7678`). `previewQualityResolution` returns 0.25 / 0.5 / 1 (`apps/editor-web/src/preview-quality.ts:1-30`), and the default is `quarter` (`preview-quality.ts:3`, `apps/editor-web/src/ui-preferences.ts:61`). So the backing store is a quarter of the authored pixels and the browser then scales that bitmap up. **This is the blur the owner reported.**
- The rendered frame is a `RenderFrameIR` (`packages/render-ir/src/model.ts:231-240`), built by `buildRenderFrameIR` (`packages/visual-object-renderer/src/index.ts:274`) and kept in a ref, not in state (`App.tsx:7656`).
- The bottom bar has: skip back 1 s, play/pause, skip forward 1 s (`App.tsx:8187-8216`); a Quality select (`App.tsx:8218-8231`); a Renderer select Auto/GPU Worker/Local (`App.tsx:8232-8245`); a status pill that shows the orange word "Local fallback" (`App.tsx:8246-8257`); a zoom drawer with Fit/50/100/200 chips (`App.tsx:8128-8186`); and the aspect-ratio selector (`App.tsx:8270-8275`). **There is no time readout, no stop button, no frame stepping, no J K L, no in/out points, no typed timecode, no audio meter.** The transport grid's first column is empty and its CSS class `.monitor-transport-start` (`app.css:1698`) is dead.
- The "empty bars" the owner photographed are **letterboxing**: `.monitor-canvas-wrap` is painted with a checkerboard (`app.css:1635-1653`) and the canvas is sized by `max-width: 100%; max-height: 100%` (`app.css:1667-1672`), so the area outside the composition shows the checkerboard. The wrap is the Monitor's background, not dead space — but it is not explained anywhere in the UI, which is why it reads as a bug.
- Selection exists but only in the timeline. The single source of truth is `state.selectedIds: readonly string[]` of **timeline clip ids** (`apps/editor-web/src/editor-panel-context.ts:33-37`), held in `App.tsx:1081`, written by `selectClips` / `toggleSelection` / `clearSelection` (`App.tsx:7192-7198`). The clip id is mapped to a visual object id by `resolveObjectIdForSelection` (`apps/editor-web/src/sticker-bindings.ts:88-98`). **The Monitor has no pointer handlers at all**, so there is no hit testing, no marquee, no selection box, and no tool model.
- Space is bound globally to `playback.toggle` (`apps/editor-web/src/keyboard-shortcuts.ts:76-77`). `isInteractiveTarget` (`keyboard-shortcuts.ts:38-54`) is the only guard that stops a text field from stealing it.
- The element transform is a flat record: `x, y, scaleX, scaleY, rotationDeg, opacity, positionZ?, crop{left,top,right,bottom}` (`packages/project-schema/src/v1.ts:77-96`), exposed to the Inspector through the property registry `x, y, scaleX, scaleY, rotationDeg, opacity, crop` (`packages/property-system/src/index.ts:41-47`). **There is no anchor point in the schema.**
- One undo step for a multi-part change is `session.dispatchCompound(label, { document?, artifacts?, timeline? })` (`App.tsx:8009` for the aspect-ratio change, `App.tsx:3019-3026`, `App.tsx:3099-3102`).
- `EditorOverlayIR` already exists and is explicitly "editor-only affordances; deliberately excluded from RenderFrameIR/export" (`packages/render-ir/src/model.ts:242-252`), and `renderer.readPixels()` documents that "overlays are not painted into it" (`packages/renderer-pixi/src/browser.ts:117`). These two facts are the seam that keeps the transform box out of the export.
- The Monitor's pixels are read back for the scopes through a **module-level singleton** (`apps/editor-web/src/monitor-readback.ts:1-11`), registered at `App.tsx:7716` and backed by `BrowserPixiRenderer.readPixels` (`packages/renderer-pixi/src/browser.ts:542-555`), which downscales to 640x360.

Three facts make the current design unrepairable by patching, and force the decisions below:

1. A CSS `scale()` on a clipped container cannot be a viewport. Magnification has to move into the render resolution and the layout, not into a transform.
2. Pixi couples the logical size, the CSS size and the backing store: `app.renderer.resize(width, height, resolution)` (`packages/renderer-pixi/src/browser.ts:186-191`) sets the canvas CSS box to `width` x `height` px and the backing store to `width*resolution` x `height*resolution` device px, and **clamps the resolution to [0.1, 2]** (`browser.ts:189`). A zoom of 400 % at full quality needs a resolution of 4, so the current clamp would silently re-introduce the blur this ADR exists to remove.
3. The renderer is reused by the export path through the same `RenderFrameIR`, so the zoom must never leak into the frame itself (ADR-0004 holds).

## Decision

### 1. Two transforms, one conversion pair

The Monitor keeps **two** separate transformations and they are never mixed:

| | **View transform** | **Element transform** |
|---|---|---|
| What | zoom and pan of the viewport | x, y, scaleX, scaleY, rotationDeg, opacity, crop of one element |
| Owner | the user, per session | the document |
| Saved in the project | **no** | **yes** |
| Undoable | **no** | **yes** |
| Lives in | `MonitorViewState` (React state in the Monitor) | `VisualObjectTransformV1` (`packages/project-schema/src/v1.ts:77-96`) |
| Applied by | the Monitor layout (CSS size of the canvas, the pan offset) | the renderer, through `RenderFrameIR` |

Rules:

1. The view transform is `{ zoom: number; panX: number; panY: number }`, in **CSS pixels of the Monitor viewport**. It is not written to the project, not to the command log, and not to the undo stack. It is a per-user preference of the Monitor surface; the persisted UI-preference slot may store it under `monitorPreview.view` alongside the existing `monitorPreview.quality` / `monitorPreview.renderer` (`App.tsx:7749-7755`), and that is a preference, not project data.
2. **Exactly one pair of functions converts between screen and canvas coordinates, and every other module must call them.** They are defined in the new `apps/editor-web/src/monitor/monitor-view-state.ts`:

   ```ts
   export interface MonitorViewState {
     readonly zoom: number;      // 0.1 .. 8, 1 = 100 %
     readonly panX: number;      // CSS px, offset of the canvas origin inside the viewport
     readonly panY: number;
   }

   /** Screen (client) point -> canvas point in authored pixels. */
   export function screenToCanvasPoint(view: MonitorViewState, point: { x: number; y: number }): { x: number; y: number };
   /** Canvas point in authored pixels -> screen (client) point. */
   export function canvasToScreenPoint(view: MonitorViewState, point: { x: number; y: number }): { x: number; y: number };
   ```

   `screenToCanvasPoint` is `(point - pan) / zoom` in the canvas's own coordinate space, and the canvas's own coordinate space **is the authored frame space** (the IR viewport is the authored width and height), so the result is directly comparable to `VisualObjectTransformV1.x/y` and to the node rectangles in `RenderFrameIR`.
3. The **element transform is a third thing** and is not part of the view transform. To test whether a screen point is inside an element, the point must be taken from screen space to the element's **local** space by applying the inverse of that element's transform (rotation about the anchor, then scale, then translation). This inverse is a named function, `elementLocalPoint(transform, canvasPoint)`, in `monitor-transform-maths.ts`, and it is the only place rotation maths appears. The renderer and the hit test must use the same maths, otherwise a rotated element selects differently from how it is drawn.
4. Zoom range is **10 % to 800 %**, with 100 % meaning "one authored pixel is one CSS pixel" (before the screen's own device pixel ratio). Fit is not a zoom value; it is a derived value computed from the viewport size and the authored size, and it is stored as a mode flag so that the zoom control can show "Fit" while the effective zoom is a number.
5. The pan is clamped so the canvas cannot be lost: at least 64 CSS px of the canvas must remain inside the viewport. `double-click` on the background or `Ctrl+0` returns to Fit.

### 2. The frame is drawn at the zoom level

The Monitor stops scaling a small bitmap and starts **rendering at the size the user is looking at**.

1. The IR viewport stays the authored size. `RenderFrameIR.viewport` (`packages/render-ir/src/model.ts:231-240`) is untouched, so the export path, `buildRenderFrameIRFromProject` (`packages/visual-object-renderer/src/index.ts:81`) and the preview frame stay the same document, and ADR-0004 keeps holding.
2. The Monitor computes one number:

   ```ts
   /** Device pixels per authored pixel. */
   export function monitorPixelScale(quality: PreviewQuality, zoom: number, devicePixelRatio: number): number;
   ```

   `monitorPixelScale = qualityScale(quality) * zoom * devicePixelRatio`, where `qualityScale` is `quarter -> 0.25`, `half -> 0.5`, `full -> 1` (`apps/editor-web/src/preview-quality.ts:5-14`).
   - At `full` quality, 100 % zoom and a 1x screen, the scale is 1: **one authored pixel is one device pixel, so the frame is sharp.** This is the acceptance the owner asked for.
   - At `full` quality and 200 % zoom, the scale is 2: the text is drawn at its real size on screen, not a magnified bitmap.
   - At `quarter` quality the scale is 0.25 x zoom: the picture is deliberately soft, which is the point of the setting, and the tooltip must say so.
3. **The renderer clamp must change.** `resize()` clamps the resolution to `[0.1, 2]` (`packages/renderer-pixi/src/browser.ts:189`). A 400 % zoom at full quality needs 4, and 800 % needs 8. The browser renderer must accept the monitor's pixel scale up to a cap. The cap is a **backing-store budget, not a magic number**: the Monitor refuses to ask for a backing store larger than 4096 x 4096 device pixels, and above that it renders at the largest scale that fits and shows the honest note "resolution reduced at this zoom" next to the zoom value. Concretely, `packages/renderer-pixi/src/browser.ts` gains:

   ```ts
   /** Device pixels per logical pixel. Not clamped to [0.1, 2]; the caller caps the backing store. */
   setPixelScale(pixelScale: number): void;
   ```

   replacing the current meaning of `setResolution` (`browser.ts:537-541`), which is used for exactly one thing today: the quality knob (`App.tsx:7677`). `setResolution` is removed, not aliased, so that no other caller can silently keep the old semantics.
4. **The canvas CSS box carries the zoom; no CSS transform is used.** Pixi sets the canvas CSS size to the logical size inside `resize()`. The Monitor therefore owns the displayed size and must re-apply it after every resize, because Pixi overwrites the style on each call:

   ```ts
   // monitor/MonitorViewport.tsx
   const displayWidth = frame.viewport.width * view.zoom;   // CSS px
   const displayHeight = frame.viewport.height * view.zoom;
   canvas.style.width = `${displayWidth}px`;
   canvas.style.height = `${displayHeight}px`;
   ```

   The `transform: scale(...)` at `App.tsx:8109` and the `transform-origin: center center` at `app.css:1665` are deleted. The canvas is positioned by the pan offset inside a clipping viewport.
5. **The device pixel ratio is part of the state.** `window.devicePixelRatio` changes when the window moves to a screen with a different scaling. The Monitor listens for it (a `matchMedia('(resolution: …)')` change) and re-renders. A zoom change re-renders too, but **only the pixels, not the frame**: the IR is not rebuilt for a zoom change. The current paint effect depends on `viewerZoom` (`App.tsx:7942`) and rebuilds the whole frame for a purely visual change; that dependency is removed.
6. **Fit** is computed from the viewport size: `fitZoom = min(viewportWidth / authoredWidth, viewportHeight / authoredHeight)`, clamped to the zoom range, and the canvas is centred when it is smaller than the viewport. This replaces the CSS that letterboxes the frame today, and the checkerboard background becomes an explicit **background choice** (checkerboard, black, grey) rather than an accident of the wrap.

### 3. Tools: Select and Hand, and the Space rule

The Monitor has exactly two tools: **Select** (default) and **Hand**. The tool is part of the view state, not the document.

1. The Space rule is a small, testable state machine, not a set of `if`s scattered through the key handler. It lives in `monitor/monitor-tools.ts`:

   ```ts
   export type MonitorTool = 'select' | 'hand';
   export type SpaceIntent = 'tap' | 'hold' | 'type';

   /** Decides what a Space press means. `textEditing` wins over everything. */
   export function resolveSpaceIntent(input: {
     readonly textEditing: boolean;
     readonly heldMs: number;
     readonly pointerDown: boolean;
   }): SpaceIntent;
   ```

   - `type` — a text field or an in-place text edit has focus. Space types a space and nothing else happens. The existing `isInteractiveTarget` (`keyboard-shortcuts.ts:38-54`) is the guard; it is extended to cover the in-place text editor of T-M07.
   - `tap` — Space was held for less than 250 ms and no pointer went down. On **key-up**, it toggles playback, exactly like today (`keyboard-shortcuts.ts:76-77`), so nothing regresses for a user who just taps Space.
   - `hold` — Space is held. The cursor becomes an open hand, the active tool becomes Hand, and a drag pans. Playback does **not** start.
2. Releasing Space restores the tool that was active before the hold. The hand is a **temporary override**, never a sticky mode.
3. The middle mouse button always pans, at any tool, at any zoom.
4. When zoomed in past 100 %, the viewport shows thin scrollbars and a small **navigator** picture with a draggable frame that shows where the visible region is.
5. A right-click or a `Space` hold inside the Monitor must not start a browser drag or a text selection: `user-select: none` on the viewport, and `preventDefault()` on the middle button.

### 4. Hit testing and selection

1. A **pure function** does the hit test. It takes a canvas point and an ordered list of elements and returns the ordered list of element ids under that point. It is pure, has no DOM and no React, so it can be unit-tested with rotated, scaled and overlapping boxes.

   ```ts
   // monitor/monitor-hit-test.ts
   export function hitTestElements(
     canvasPoint: { x: number; y: number },
     elements: readonly HitTestElement[],   // ordered, topmost first
   ): readonly string[];

   export function marqueeSelect(
     start: { x: number; y: number },
     end: { x: number; y: number },
     elements: readonly HitTestElement[],
   ): readonly string[];
   ```

2. **Order is topmost first** and the caller supplies that order. The Monitor takes it from the render order of `RenderFrameIR.nodes` (which already carries `zIndex`; ADR-0035 says the front visual layer is the top visible Timeline row). Locked and hidden tracks are skipped. A picture with a fully transparent area still counts as its box.
3. Rules: click selects the topmost; **Alt+click** selects the next one below; **Shift+click** adds or removes; a drag on empty canvas draws a marquee; a click on empty canvas deselects.
4. **Selection stays one shared state.** The Monitor does not keep its own selection. It reads `state.selectedIds` and writes through `selectClips` / `toggleSelection` / `clearSelection` (`App.tsx:7192-7198`), so the timeline and the Monitor always show the same thing, in both directions, with no new plumbing.
5. Because `selectedIds` are **clip ids** and the Monitor works in **visual object ids**, the mapping is `resolveObjectIdForSelection` (`apps/editor-web/src/sticker-bindings.ts:88-98`). The hit test returns visual object ids; the selection setters take clip ids. The mapping lives in one place, `monitor/monitor-selection.ts`, with one function each way, and the Monitor must not guess.
6. It works for every element kind: video, picture, text, caption, shape and the 3D element. The element list the hit test consumes is built from the same `RenderFrameIR` that is drawn, so what the user clicks is what the user sees.

### 5. The selection box (free transform on the Monitor)

The transform box is an **overlay above the canvas**, in HTML/SVG, never drawn into the picture. It therefore cannot appear in an export (ADR-0004 boundary; `readPixels` does not include overlays, `packages/renderer-pixi/src/browser.ts:117`).

1. **Where the overlay lives.** A new layer is a sibling of the canvas inside the viewport. It is fed by the editor-only `EditorOverlayIR` idea (`packages/render-ir/src/model.ts:242-252`), but that type is too small for a transform box (it carries only id and a rectangle). The Monitor's overlay layer therefore carries its own richer, editor-only model in `monitor/monitor-overlay-model.ts`:

   ```ts
   export interface MonitorOverlay {
     readonly elementId: string;
     readonly localToCanvas: readonly number[];  // 2x3 affine, from the element transform
     readonly handles: readonly MonitorHandle[];
   }
   ```

   and the box reads the same element transform the renderer uses, so the box cannot drift from the picture.
2. **Handles.** Eight scale handles (four corners, four edge midpoints), one rotate handle above the top edge, one anchor point. The corner handles scale, the edge handles scale on one axis, the rotate handle rotates, the anchor point is dragged to the element's pivot.
3. **Modifier rules.** `Shift` keeps the proportions while scaling; `Alt` scales from the centre instead of the opposite corner; `Shift` while rotating snaps to **15 degree** steps; `Shift+Alt` rotates about the centre.
4. **Nudge.** Arrow keys move the selection 1 CSS pixel, `Shift+Arrow` moves it 10. Nudge is an undoable step.
5. **One drag is one undo step.** A drag does not write to the document on every pointer move. The drag accumulates an in-memory preview, the picture updates live from the preview, and on release **one** `session.dispatchCompound` writes the final transform (`App.tsx:3019-3026` is the pattern to copy). The Inspector numbers follow the preview live and settle on the committed values.
6. **Keyframes.** When the property's stopwatch is on, the release writes a keyframe at the playhead instead of (or as well as) the value. The animatable channels are the ones the schema already declares (`packages/project-schema/src/v1.ts:98-99`); a drag must not create a keyframe on a property that is not animated, and must not clear one that exists.
7. **Group.** Several selected elements move and scale as a group. The property registry already carries `multiEditPolicy` per property (`packages/property-system/src/index.ts:41-47`: `relative` for position and scale, `shared` for opacity), so the group maths follows that policy instead of inventing its own.
8. **The anchor point needs a schema decision.** `VisualObjectTransformV1` (`packages/project-schema/src/v1.ts:77-96`) has **no anchor field**; `motion-core` has an unrelated `transformOriginX` (`packages/motion-core/src/scene.ts:136`). T-M05b therefore needs a **schema addition** (an optional `anchorX`/`anchorY` in the transform, defaulting to the element centre) and a migration that leaves existing projects unchanged. This is the one part of Track M that touches the project schema, and it needs its own review. Until that lands, the anchor handle may be drawn but must not be persisted.
9. **Undo and the Inspector stay in step.** The Inspector's Visual tab is the same document, so the numbers move because the document moved. The Monitor never writes a value the Inspector does not show.

### 6. Guides and snapping

Smart guides are a **v1.1.2** item (T-M06), and the ADR fixes the shape so that M05 can ship without being blocked by it and M06 can add to it.

1. Snap targets, in priority order: the canvas centre lines; the canvas edges; the title-safe and action-safe margins (the safe-area percentages already live in `packages/captions-core/src/styling.ts`); user guides dragged from the rulers; and the edges and centres of the other elements on the canvas.
2. The snap distance is **6 screen pixels**, measured in screen space, so it feels the same at every zoom.
3. The nearest candidate wins per axis, and a target that is already exactly on the axis wins over one that is merely near.
4. `Ctrl` held while dragging turns snapping off for that drag.
5. The guide line is drawn while snapped, in the overlay layer only.
6. The live readout (X, Y, width, height, angle) sits next to the cursor during a drag.

### 7. Overlays, the quality control, the transport and the right-click menu

**Overlays** (T-M08). A "View" menu in the Monitor bar with switches, saved per user: title-safe and action-safe areas, grid, centre marks, rulers with draggable user guides, canvas border, and a pixel grid that appears from 800 % zoom. The background choice (checkerboard, black, grey) sits next to them. A separate entry, **"Preview overlay (does not change your project)"**, draws aspect guides (9:16, 1:1, 4:5, 16:9) as a shaded mask; this replaces the "Preview — view only" group (`MonitorAspectRatioSelector.tsx:258-280`), which mixes a view-only aspect with the real, undoable canvas change (`App.tsx:7983-8049`).

**The quality control** (T-M09). One control, "Preview quality": **Auto** (default), Full, Half, Quarter, each option showing the real pixel size it will draw. The Renderer select and the orange "Local fallback" text are removed from the user interface (`App.tsx:8232-8257`), and the word "Worker" is removed from every visible string. `Auto` picks the highest quality that holds the frame rate and is **always Full when paused**, so the frame the user is working on is sharp. A tooltip on Quarter says why the picture is soft. The saved preference migrates: a project that stored `quarter` becomes `auto`.

**The transport** (T-M10). The bottom bar becomes: frame step back and forward, play/pause, stop, the time readout, a **typed timecode field** (`mm:ss:ff` and plain frames), J K L (repeat J or L to double the speed up to eight times, K stops), loop on/off, set in point (I) and out point (O), clear both, play in to out, and a small audio meter with a clip mark. Full-screen preview is F, Esc leaves it. Every new shortcut goes into the shortcuts dialog and the palette.

**The right-click menu** (T-M07). Reset transform, Fit to frame, Fill frame, Centre, Bring forward, Send backward, Crop, and Relink (only on a missing clip, see T-R03). Every item must map to an **existing command**. Anything missing is filed as a defect, not invented.

### 8. The file split

The Monitor moves out of `App.tsx` so that two helpers can work at the same time without colliding in one 800-line function.

`App.tsx` today holds the Monitor at `7446-8280` — 835 lines, of which `MonitorPanelContent` is one function with 40 state variables and 11 effects. It is the single worst merge-conflict surface in the editor.

**Target layout:**

```
apps/editor-web/src/monitor/
  MonitorPanel.tsx            # the dockview panel wrapper (was App.tsx:7426-7444)
  MonitorViewport.tsx         # the viewport frame: canvas host, overlay layer, pointer routing
  monitor-view-state.ts       # S1  MonitorViewState, screenToCanvasPoint, canvasToScreenPoint, fitZoom, clampPan
  monitor-tools.ts            # S3  MonitorTool, resolveSpaceIntent, tool resolution
  monitor-hit-test.ts         # S4  hitTestElements, marqueeSelect
  monitor-selection.ts        # S4  clip id <-> visual object id mapping
  monitor-transform-maths.ts  # S5  elementLocalPoint, handle maths, group maths
  monitor-overlay-model.ts    # S5  MonitorOverlay, MonitorHandle
  monitor-guides.ts           # S6  snap targets, nearest-target choice
  monitor-quality.ts          # S7  monitorPixelScale, the Auto rule, real pixel size readout
  monitor-transport.tsx       # S7  transport bar, timecode field, JKL, in/out, audio meter
  monitor-view-menu.tsx       # S7  the View menu (overlays, background choice)
  monitor-menu.tsx            # S7  the right-click menu
  monitor.css                 # the styles that move out of app.css
```

The rules for the split:

- **The first commit is a move, not a change.** T-M02a moves `MonitorPanelContent` into `apps/editor-web/src/monitor/MonitorPanel.tsx` with **no behaviour change**, and the existing tests pass unchanged. Only after that does anything else move.
- **The monitor directory owns the monitor.** New monitor code goes in `apps/editor-web/src/monitor/`. It may import from `apps/editor-web/src` and from `packages/*`; it may not be imported by `packages/*` (the dependency rule in `docs/adr/README.md`: apps depend on packages, never the reverse).
- **The renderer change is the only change outside the editor.** `packages/renderer-pixi/src/browser.ts` gets `setPixelScale` and the raised clamp (S2.3). `packages/render-ir` is not touched: the IR keeps the authored viewport.
- **The styles move with the component.** The `.monitor-*` rules in `app.css` (lines 1582-1993) move into `monitor/monitor.css`, imported once by the monitor entry point. `app.css` keeps only what is shared.
- **`App.tsx` keeps only the wiring**: the panel registration (`App.tsx:6597-6598`), the context (`editor-panel-context.ts`), and the paint pipeline until T-M02c moves it.

### 9. What M02 to M12 may touch, and the function names they own

Each card below may create or change **only** the named functions, plus the files listed. Anything outside this list is a scope change and goes back to CC.

| Card | Owner | May own (function / symbol names) | Files |
|---|---|---|---|
| **T-M02a** | GB | `MonitorPanelContent` (move only), `MonitorPanel` | `apps/editor-web/src/monitor/MonitorPanel.tsx` |
| **T-M02b** | GB | `MonitorViewState`, `screenToCanvasPoint`, `canvasToScreenPoint`, `fitZoom`, `clampPan` | `monitor/monitor-view-state.ts`, `monitor/MonitorViewport.tsx` |
| **T-M02c** | GB | `setPixelScale`, the resolution clamp, `monitorPixelScale` | `packages/renderer-pixi/src/browser.ts`, `monitor/monitor-quality.ts` |
| **T-M03** | GB | `MonitorTool`, `resolveSpaceIntent`, the hand cursor states | `monitor/monitor-tools.ts` |
| **T-M04** | GB | `hitTestElements`, `marqueeSelect`, the clip/object mapping | `monitor/monitor-hit-test.ts`, `monitor/monitor-selection.ts` |
| **T-M05a** | GB | `MonitorOverlay`, `MonitorHandle`, the handle maths, the box component | `monitor/monitor-overlay-model.ts`, `monitor/monitor-transform-maths.ts` |
| **T-M05b** | GB | the anchor field on the transform (schema), the keyframe write, the group maths | `packages/project-schema/src/v1.ts` (needs a schema decision), `monitor/monitor-transform-maths.ts` |
| **T-M06** | CX | `snapTargets`, `nearestSnapTarget`, the guide drawing, the readout | `monitor/monitor-guides.ts` |
| **T-M07** | CX | the in-place text editor, the crop mode, the right-click menu items | `monitor/monitor-menu.tsx`, `monitor/MonitorViewport.tsx` |
| **T-M08** | MC | the View menu, the overlay switches, the background choice, the navigator | `monitor/monitor-view-menu.tsx`, `monitor/monitor.css` |
| **T-M09** | CX | the quality control, the Auto rule, the migration of the saved preference | `monitor/monitor-quality.ts`, `apps/editor-web/src/ui-preferences.ts` |
| **T-M10** | CX | the transport bar, the timecode parse/format, the JKL table, the audio meter | `monitor/monitor-transport.tsx` |
| **T-M11** | GB | the frame-time recorder, the paint throttle while the wheel moves | `monitor/MonitorViewport.tsx` (the paint path) |
| **T-M12** | MC | the focus ring, the tooltips, the screen-reader names, the keyboard map | `monitor/MonitorViewport.tsx`, `monitor/monitor.css` |

Two rules for the whole track:

- **Nobody edits `App.tsx:7446-8280` after T-M02a.** The Monitor is in its own directory from then on.
- **`packages/render-ir` is not touched by Track M.** The IR keeps the authored viewport; the zoom is a Monitor concern. If a card needs the IR to change, that card needs CC.

## Alternatives considered

1. **Keep the CSS scale and make the bitmap bigger.** Rejected: the container is `position: absolute; inset: 0; overflow: hidden` (`app.css:1659-1674`), so a CSS scale is always a crop, and scaling a bitmap never produces sharp text. The owner's complaint is exactly this.
2. **Render the whole Monitor in a canvas/WebGL of our own.** Rejected: the Pixi renderer, the IR and the export path already agree (ADR-0004). A second renderer would create the preview/export drift the plan is trying to remove, for a problem that a resolution change solves.
3. **Change the IR viewport to the zoomed size.** Rejected: the IR is the preview/export boundary and the export must be the authored size. Zoom must not enter the document.
4. **Let the zoom live in the project file.** Rejected: the view transform is per user and per session; saving it would make two people on the same project see different pictures and would put a non-undoable value into a document that must be undoable and replayable.
5. **One big "Monitor v2" component.** Rejected: it would put 14 cards in one file again and make the two-helper plan impossible. S8 exists so that GB and CX can work in parallel.
6. **Keep the GPU Worker renderer select.** Rejected by measurement-first decision in T-M09: if the GPU path never engages (`local-media-client.ts` throws "not available"), the control and the orange "Local fallback" text are noise for the user. The engine may be shown in a tooltip, never as a warning.
7. **Put the transform box into the rendered frame.** Rejected: it would end up in the export. The overlay layer is editor-only by construction (`packages/render-ir/src/model.ts:242-252`).

## Consequences

- The Monitor stops being one 835-line function and becomes thirteen small modules with named functions, which is what makes T-M02 to T-M13 deliverable in parallel.
- The picture becomes sharp at 100 % zoom, which is the single most visible change for the owner. It costs GPU time at high zoom, which is why the backing store is capped and why `Auto` exists.
- The view transform is not part of the document, so "what the user saw" cannot be reproduced from the project file. That is deliberate and matches Photoshop and After Effects.
- The `packages/renderer-pixi` resolution clamp is raised. This is a shared package: the export path and the golden-frame tests use the same renderer, so the change must be additive and must not change the default (the export keeps resolution 1).
- The anchor point needs a schema field and a migration. Until that decision is made and reviewed, the anchor handle may be shown but not persisted.
- The "Preview — view only" group in the aspect-ratio selector and the "Preview zoom" group in the zoom drawer currently have confusingly similar names and different meanings; S7 gives each one a distinct name and a distinct place.
- The empty bars above and below the frame are explained: they are the Monitor's background, and they become an explicit background choice.

## Validation and rollback

- **Unit**: `monitor-view-state.ts` (the two conversions are exact inverses; zoom toward a point keeps that point still; Fit maths; pan clamping), `monitor-hit-test.ts` (rotated, scaled, overlapping boxes; marquee; Alt and Shift), `monitor-transform-maths.ts` (every handle, with rotation, anchor and group), `monitor-tools.ts` (tap versus hold with fake timers), `monitor-quality.ts` (the pixel scale formula, the Auto rule, the saved-preference migration).
- **Driver** (`tooling/qa/live`): real wheel events zoom toward the cursor within 1 pixel; holding Space and dragging pans and does not start playback; tapping Space plays; typing "a b" into a title keeps the space; clicking an element on the Monitor selects the same clip on the timeline and the reverse; each handle drags on a video, a picture, a text and a shape at 50 % and 200 %; one undo restores the whole drag; the Inspector numbers equal the document; the right-click menu items work; every overlay can be switched on; a quality change shows the real pixel size.
- **Sharpness**: a text frame is measured at Fit, 100 %, 200 % and 400 %. The sharpness at 200 % must not be lower than at 100 %, and at 100 % with `full` quality a one-pixel checker frame must read back exactly (T-M02's acceptance, unchanged).
- **Export parity**: one export after a move, a scale and a rotate is compared with the preview frame. The transform box and every overlay must be absent from the export.
- **Performance** (T-M11): on the owner's PC, playback at 30 fps drops under 2 % of frames at `Auto`; zoom, pan and handle drag stay under 20 ms per frame at the 95th percentile. If a target cannot be met, the numbers and the reason go to CC.
- **Rollback**: every card is one branch and one merge into `integration/v1.1.1`. The Monitor split is the only structural change and it is a pure move, so reverting it is a revert of one commit. The renderer change is additive behind a new method name, so the old `setResolution` path can be restored by reverting one commit.

## Related contracts/tests

`apps/editor-web/src/App.tsx:7426-8280` (the Monitor today) · `apps/editor-web/src/monitor/` (the Monitor after this ADR) · `apps/editor-web/src/preview-quality.ts:1-43` · `apps/editor-web/src/ui-preferences.ts:55-170` · `apps/editor-web/src/keyboard-shortcuts.ts:38-77` · `apps/editor-web/src/monitor-readback.ts:1-11` · `apps/editor-web/src/editor-panel-context.ts:33-164` · `apps/editor-web/src/sticker-bindings.ts:88-98` · `apps/editor-web/src/MonitorAspectRatioSelector.tsx:87-97,258-280` · `packages/renderer-pixi/src/browser.ts:117,140-191,537-578` · `packages/render-ir/src/model.ts:231-252` · `packages/project-schema/src/v1.ts:77-99` · `packages/property-system/src/index.ts:41-47` · `packages/visual-object-renderer/src/index.ts:81,274` · `packages/captions-core/src/styling.ts` (safe areas) · `docs/adr/0004-render-ir-preview-export-boundary.md` · `docs/adr/ADR-0035-universal-timeline-gpu-preview.md` · `docs/adr/0032-universal-property-animation-binding.md` · owner request REQ-04 in `BUGS-from-owner.md:170-190`.

**Open questions for the Opus consult (CC to send once, plan mode, read-only):**

1. S2.3 — is a 4096 x 4096 device-pixel backing store the right cap for this PC, and should the cap be a constant or a user preference?
2. S5.8 — should the anchor point be a new field on `VisualObjectTransformV1`, or should it reuse an existing convention from `motion-core`?
3. S7 — the transport is getting wide: is the timecode field, the J K L group and the in/out points one row or two in a narrow panel?
4. S6 — is 6 screen pixels the right snap distance, and should the safe-area margins be snap targets or only guides?
5. S1.4 — should the zoom range really reach 800 %, given the backing-store cap of S2.3?
