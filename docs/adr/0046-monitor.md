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
- The shortcut registry is **not a table**. `resolveShortcut` is a modifier branch plus a `switch (event.key)` on raw DOM key values (`keyboard-shortcuts.ts:66-98`), and the handlers live in one global listener with a second switch (`App.tsx:3684-3816`). Two rules in it matter for Track M: **any combo with `Alt` returns `undefined`** (`keyboard-shortcuts.ts:74`), and **any combo with `Ctrl` other than Z, Y, K and D returns `undefined`** (`keyboard-shortcuts.ts:65-73`). So `Ctrl+0`, `Ctrl+1`, `Ctrl++`, `Ctrl+-`, `J`, `K`, `L`, `Tab` and `Alt+arrow` are **not bound today** and each must be added to that switch. `J`, `K` and `L` are unbound on their own, but `Ctrl+K` is already the palette (`keyboard-shortcuts.ts:70`). The guard for `playback.toggle` also ignores key repeat (`App.tsx:3695-3698`), which is what stops a held Space from scrubbing.
- The element transform is a flat record: `x, y, scaleX, scaleY, rotationDeg, opacity, positionZ?, crop{left,top,right,bottom}` (`packages/project-schema/src/v1.ts:77-96`), exposed to the Inspector through the property registry `x, y, scaleX, scaleY, rotationDeg, opacity, crop` (`packages/property-system/src/index.ts:41-47`). **There is no anchor point in the schema, and no width or height** — the on-canvas size of a picture comes from the intrinsic asset size passed in at render time (`packages/visual-object-renderer/src/index.ts:145-149`).
- **`rotationDeg` is stored but never drawn.** `transformToRenderTransform` converts the document transform to the render transform by carrying only `translateX`, `translateY`, `scaleX`, `scaleY` (`packages/visual-object-renderer/src/index.ts:452-460`), and the renderer hard-zeroes the rotation: `layer.rotation = 0;` with the comment that `Transform2D` "does not currently carry rotation" (`packages/renderer-pixi/src/browser.ts:358-365`). The IR says the same (`packages/render-ir/src/browser.ts:18-20`). **A rotate handle on the Monitor is therefore impossible without an IR and renderer change.** This is the single largest dependency the Monitor rework has, and S5.10 settles it.
- The animation marker is **not a "stopwatch" field**. A property is animated when a curve exists for its channel (`animations?: Readonly<Partial<Record<AnimatablePropertyV1, AnimationCurveV1>>>` — `packages/project-schema/src/v1.ts:193-194`, read by `isAnimated` — `packages/motion-core/src/transform.ts:20-25`), and the Inspector shows a **diamond** with three states `none | between | keyed` (`apps/editor-web/src/InspectorPanel.tsx:310`). There is no boolean to read, so "the stopwatch is on" must be implemented as "a curve exists for this channel at this playhead".
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
4. **The hit test works from the drawn frame, not from the document.** The element's rectangle comes from the node in the `RenderFrameIR` that is on screen (its size plus its `transform`), not from the schema, because the schema carries no size for a picture. That makes the hit test automatically agree with what the user sees, including anything the renderer does with crop or opacity. Until S5.10 lands, `elementLocalPoint` must use the **render** transform (translation and scale only, no rotation), because that is what is drawn; using the document rotation would select a rotated shape that is not drawn rotated.
5. Zoom range is **10 % to 800 %**, with 100 % meaning "one authored pixel is one CSS pixel" (before the screen's own device pixel ratio). Fit is not a zoom value; it is a derived value computed from the viewport size and the authored size, and it is stored as a mode flag so that the zoom control can show "Fit" while the effective zoom is a number.
6. The pan is clamped so the canvas cannot be lost: at least 64 CSS px of the canvas must remain inside the viewport. `double-click` on the background or `Ctrl+0` returns to Fit.

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
6. **The shortcut resolver must grow, and the `Alt` rule must change for the Monitor.** `resolveShortcut` returns `undefined` for every combo containing `Alt` (`keyboard-shortcuts.ts:74`), which would silently kill `Alt+click` (select the element below) and `Alt+arrow` (scale). The Monitor needs the resolver to return a Monitor-scoped action for those, without changing the behaviour of the rest of the editor. The Monitor's shortcuts are added to the same switch, so that the shortcuts dialog and the palette have one list to show.

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
5. **One drag is one undo step, using the mechanism that already exists.** The Inspector already solves this and the Monitor must not invent a second answer. `TransientPropertyInteraction` (`apps/editor-web/src/property-interaction.ts:25-77`) has exactly the right shape: `begin()` snapshots the value, `update()` only previews in memory, `commit()` emits **exactly one** durable command and skips when nothing changed, and `cancel()` restores the snapshot and writes **no** history entry. The canvas drag uses the same four calls: pointer-down is `begin`, pointer-move is `update` (the picture repaints from the preview), pointer-up is `commit`, Escape is `cancel`. The committed write goes through the existing command `object.setTransformProperty` (`packages/property-system/src/index.ts:89-96`) applied via `dispatchVisualObjects` (`apps/editor-web/src/editor-session.ts:571-580`), or through `dispatchCompound` (`apps/editor-web/src/editor-session.ts:633-648`) when the drag touches the timeline and the document together. The Inspector numbers follow the preview live and settle on the committed values.
6. **Keyframes.** The rule is "the property is animated", and that is decided by the **curve**, not by a stored boolean: `isAnimated` (`packages/motion-core/src/transform.ts:20-25`) checks whether `object.animations` holds a curve for the channel, and the Inspector's diamond shows `none | between | keyed` (`apps/editor-web/src/InspectorPanel.tsx:310`). On release, if the channel has a curve, the drag writes a keyframe at the playhead with `setKeyframe(curve, keyframe)` (`packages/motion-core/src/curve.ts:47-54`), dispatched as `object.replaceAnimation` (`packages/motion-core/src/commands.ts:23-31`) and applied at `packages/motion-core/src/commands.ts:317-332`; if the channel has no curve, the drag writes the static value instead. A drag must never create a curve that did not exist, and must never clear a key that exists. The interpolation used is the channel's existing one (`hold | linear | eased | bezier` — `packages/project-schema/src/v1.ts:113`), not a new default.
7. **Group.** Several selected elements move and scale as a group. The property registry already carries `multiEditPolicy` per property (`packages/property-system/src/index.ts:41-47`: `relative` for position and scale, `shared` for opacity), so the group maths follows that policy instead of inventing its own.
8. **The anchor point needs a schema decision.** `VisualObjectTransformV1` (`packages/project-schema/src/v1.ts:77-96`) has **no anchor field**, and there is no anchor concept anywhere in the schema, the property system, the IR or the Inspector; the only "anchor" hits in the repo are text alignment (`packages/render-ir/src/text-layout.ts:18`). `motion-core` has an unrelated `transformOriginX` (`packages/motion-core/src/scene.ts:136`), and `motion-core`'s `MotionTransform` is a **different model** from the visual-object transform, so it is not a drop-in. T-M05b therefore needs a **schema addition** (an optional `anchorX`/`anchorY` in the transform, defaulting to the element centre) and a migration that leaves existing projects unchanged. Until that lands, the anchor handle may be drawn but must not be persisted.
9. **The element rectangle comes from the drawn node, not from the schema.** The transform carries no width or height, and a picture's size comes from the intrinsic asset size passed at render time (`packages/visual-object-renderer/src/index.ts:145-149`). The transform box must therefore take its rectangle from the node in the `RenderFrameIR` that is on screen, exactly like the hit test (S1.4). Two consequences: a transform box on an element with no rendered size (an audio clip, an empty adjustment layer) is not drawn, and the box can never be a different size from the picture.
10. **Rotation needs an IR and renderer change, and this is the prerequisite for the rotate handle.** `rotationDeg` is stored in the document but dropped on the way to the screen (S "Context", and `packages/visual-object-renderer/src/index.ts:452-460`, `packages/renderer-pixi/src/browser.ts:358-365`). A rotate handle that moves a number the picture does not show would be worse than no rotate handle. So the rotate handle is gated on an IR revision that carries rotation, and the renderer honours it. Options, for CC to pick:
    - **(a) IR revision now, rotate in v1.1.1.** `Transform2D` gains `rotationDeg`, the Pixi renderer applies it (`layer.rotation = rotationDeg * Math.PI / 180`), and the Monitor's rotate handle ships with M05b. This is the honest route and it also fixes a real product defect (rotation is stored but invisible today). Cost: an IR change touches the export path and the golden-frame tests.
    - **(b) No IR change, rotate moves to v1.1.2.** The transform box ships with move, scale, anchor, nudge and group, and the rotate handle is drawn disabled with the note "coming in v1.1.2". The owner is told in plain words, as he was for smart guides.
    - **(c) Monitor-only rotation.** The Monitor draws the element rotated on its own layer while the export keeps it unrotated. **Rejected**: preview and export would disagree, which is exactly what the whole Track M is meant to stop.
    The ADR recommends **(a)**, because the owner named rotation in his request and because a stored-but-invisible value is a defect on its own. This decision is CC's, and it is the first thing the Opus consult should look at.
11. **Undo and the Inspector stay in step.** The Inspector's Visual tab is the same document, so the numbers move because the document moved. The Monitor never writes a value the Inspector does not show. The Inspector's Visual tab fields are `x, y, scaleX, scaleY, rotationDeg, opacity` (`packages/property-system/src/index.ts:39-47`, rendered at `apps/editor-web/src/InspectorPanel.tsx:609-676`), and they are controlled inputs whose `onChange` only previews and whose `onBlur`/Enter commits (`apps/editor-web/src/components/PropertyControlAdapters.tsx:103-137`) — the Monitor must use the same commit path, not a private one. Note for T-M07: the Crop inputs in the Inspector bypass the transient adapter and dispatch on every keystroke (`apps/editor-web/src/InspectorPanel.tsx:696-714`), which makes one undo step per keystroke. That is a defect; the Monitor's crop must not copy it.

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
- **The renderer change is the only change outside the editor.** `packages/renderer-pixi/src/browser.ts` gets `setPixelScale` and the raised clamp (S2.3). `packages/render-ir` keeps the authored viewport: the zoom never enters the IR.
- **One exception, if CC picks option (a) in S5.10:** `packages/render-ir` gains rotation in `Transform2D`, and `packages/visual-object-renderer` and `packages/renderer-pixi` carry it through. That is a separate branch and a separate review, because it touches the export path and the golden-frame tests. It is not part of the Monitor split and it does not block the Monitor split.
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
| **T-M05b** | GB | the anchor field on the transform (schema), the keyframe write through `setKeyframe`, the group maths | `packages/project-schema/src/v1.ts` (needs a schema decision), `monitor/monitor-transform-maths.ts` |
| **T-M05c** | CX, needs an IR revision | `Transform2D.rotationDeg`, the `layer.rotation` write, `transformToRenderTransform` | `packages/render-ir/src/model.ts`, `packages/visual-object-renderer/src/index.ts:452-460`, `packages/renderer-pixi/src/browser.ts:358-365` |
| **T-M06** | CX | `snapTargets`, `nearestSnapTarget`, the guide drawing, the readout | `monitor/monitor-guides.ts` |
| **T-M07** | CX | the in-place text editor, the crop mode, the right-click menu items | `monitor/monitor-menu.tsx`, `monitor/MonitorViewport.tsx` |
| **T-M08** | MC | the View menu, the overlay switches, the background choice, the navigator | `monitor/monitor-view-menu.tsx`, `monitor/monitor.css` |
| **T-M09** | CX | the quality control, the Auto rule, the migration of the saved preference | `monitor/monitor-quality.ts`, `apps/editor-web/src/ui-preferences.ts` |
| **T-M10** | CX | the transport bar, the timecode parse/format, the JKL table, the audio meter | `monitor/monitor-transport.tsx` |
| **T-M11** | GB | the frame-time recorder, the paint throttle while the wheel moves | `monitor/MonitorViewport.tsx` (the paint path) |
| **T-M12** | MC | the focus ring, the tooltips, the screen-reader names, the keyboard map | `monitor/MonitorViewport.tsx`, `monitor/monitor.css` |

Two rules for the whole track:

- **Nobody edits `App.tsx:7446-8280` after T-M02a.** The Monitor is in its own directory from then on.
- **`packages/render-ir` is not touched by Track M — with one exception.** The IR keeps the authored viewport; the zoom is a Monitor concern. The only exception is the rotation change of S5.10 (card T-M05c), and only if CC chooses option (a). Any other card that needs the IR to change needs CC.

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
- **Rotation is stored but invisible.** The document keeps `rotationDeg` for every element and the renderer throws it away, so a user who rotates an element today sees nothing move. That is a product defect in its own right, and it is the reason the rotate handle is gated on an IR change rather than a UI change (S5.10). Fixing it in v1.1.1 also touches the export path and the golden-frame tests, so it must be a reviewed branch of its own.
- The "Preview — view only" group in the aspect-ratio selector and the "Preview zoom" group in the zoom drawer currently have confusingly similar names and different meanings; S7 gives each one a distinct name and a distinct place.
- The empty bars above and below the frame are explained: they are the Monitor's background, and they become an explicit background choice.

## Validation and rollback

- **Unit**: `monitor-view-state.ts` (the two conversions are exact inverses; zoom toward a point keeps that point still; Fit maths; pan clamping), `monitor-hit-test.ts` (rotated, scaled, overlapping boxes; marquee; Alt and Shift), `monitor-transform-maths.ts` (every handle, with rotation, anchor and group), `monitor-tools.ts` (tap versus hold with fake timers), `monitor-quality.ts` (the pixel scale formula, the Auto rule, the saved-preference migration).
- **Driver** (`tooling/qa/live`): real wheel events zoom toward the cursor within 1 pixel; holding Space and dragging pans and does not start playback; tapping Space plays; typing "a b" into a title keeps the space; clicking an element on the Monitor selects the same clip on the timeline and the reverse; each handle drags on a video, a picture, a text and a shape at 50 % and 200 %; one undo restores the whole drag; the Inspector numbers equal the document; the right-click menu items work; every overlay can be switched on; a quality change shows the real pixel size.
- **Sharpness**: a text frame is measured at Fit, 100 %, 200 % and 400 %. The sharpness at 200 % must not be lower than at 100 %, and at 100 % with `full` quality a one-pixel checker frame must read back exactly (T-M02's acceptance, unchanged).
- **Export parity**: one export after a move, a scale and a rotate is compared with the preview frame. The transform box and every overlay must be absent from the export. If option (a) of S5.10 is chosen, the rotated export must match the rotated preview; if option (b) is chosen, the rotate handle is absent and this test does not apply.
- **One drag is one undo step**: a driver test drags an element across the canvas and then presses Undo **once**; the element must be back where it started, and the history must hold exactly one entry for the drag (not one per pointer move). The same test for a group drag and for a drag that writes a keyframe.
- **Performance** (T-M11): on the owner's PC, playback at 30 fps drops under 2 % of frames at `Auto`; zoom, pan and handle drag stay under 20 ms per frame at the 95th percentile. If a target cannot be met, the numbers and the reason go to CC.
- **Rollback**: every card is one branch and one merge into `integration/v1.1.1`. The Monitor split is the only structural change and it is a pure move, so reverting it is a revert of one commit. The renderer change is additive behind a new method name, so the old `setResolution` path can be restored by reverting one commit.

## Related contracts/tests

`apps/editor-web/src/App.tsx:7426-8280` (the Monitor today) · `apps/editor-web/src/monitor/` (the Monitor after this ADR) · `apps/editor-web/src/preview-quality.ts:1-43` · `apps/editor-web/src/ui-preferences.ts:55-170` · `apps/editor-web/src/keyboard-shortcuts.ts:38-98` · `apps/editor-web/src/monitor-readback.ts:1-11` · `apps/editor-web/src/editor-panel-context.ts:33-164` · `apps/editor-web/src/editor-session.ts:571-580,633-648` · `apps/editor-web/src/property-interaction.ts:25-77` · `apps/editor-web/src/sticker-bindings.ts:88-98` · `apps/editor-web/src/InspectorPanel.tsx:284-310,461-499,609-676,696-714` · `apps/editor-web/src/MonitorAspectRatioSelector.tsx:87-97,258-280` · `packages/renderer-pixi/src/browser.ts:117,140-191,358-365,537-578` · `packages/render-ir/src/model.ts:231-252` · `packages/project-schema/src/v1.ts:77-153` · `packages/property-system/src/index.ts:39-100,637-640` · `packages/motion-core/src/transform.ts:20-25` · `packages/motion-core/src/curve.ts:42-66` · `packages/motion-core/src/commands.ts:23-40,317-332` · `packages/visual-object-renderer/src/index.ts:81,145-149,274,452-460` · `packages/captions-core/src/styling.ts` (safe areas) · `docs/adr/0004-render-ir-preview-export-boundary.md` · `docs/adr/ADR-0035-universal-timeline-gpu-preview.md` · `docs/adr/0032-universal-property-animation-binding.md` · owner request REQ-04 in `BUGS-from-owner.md:170-190`.

**Open questions for the Opus consult (CC to send once, plan mode, read-only):**

1. **S5.10 — the rotation decision.** `rotationDeg` is stored in the document and dropped before the picture is drawn. The rotate handle cannot work without an IR and renderer change. Should v1.1.1 carry that change (option a), or does the rotate handle move to v1.1.2 (option b)? This is the biggest fork in Track M and it changes the plan, so it should be answered first.
2. S5.8 — should the anchor point be a new field on `VisualObjectTransformV1`, or should it reuse an existing convention from `motion-core`? The two models are different types today.
3. S2.3 — is a 4096 x 4096 device-pixel backing store the right cap for this PC, and should the cap be a constant or a user preference?
4. S7 — the transport is getting wide: is the timecode field, the J K L group and the in/out points one row or two in a narrow panel?
5. S6 — is 6 screen pixels the right snap distance, and should the safe-area margins be snap targets or only guides?
6. S1.5 — should the zoom range really reach 800 %, given the backing-store cap of S2.3?
7. S5.5 — the Monitor's canvas drag reuses `TransientPropertyInteraction` (`apps/editor-web/src/property-interaction.ts:25-77`). Is that the right authority for a canvas gesture, or should canvas gestures get their own undo bus? Today `VisualObjectTransaction` has no `coalesceKey` (`packages/property-system/src/index.ts:637-640`), so the transient gesture is the only thing standing between a canvas drag and one undo entry per pointer move.

## Review by Opus 5.5 (12 Nov 2026, read-only, one of the two Opus uses) and what we decide

Status after the review: **Accepted with the changes below.** Where this section and the text above disagree, this section wins. The sections above are kept so the reasoning stays visible.

### A. Corrections to the facts above (checked by the reviewer against `v111-ui` at `08ccae88`)

1. Pixi does not set the canvas CSS size on resize (no `autoDensity` in `packages/renderer-pixi/src/browser.ts:141-152`); the canvas shows at its backing-store size, capped by `app.css:1668-1673`. So "Fit" today can only shrink, never enlarge. This is what the empty bars are, and part of the blur.
2. The Quality select has no effect after the Monitor first loads: the renderer is created once with `options.resolution` (`App.tsx:7706-7709`) and `render()` prefers `options.resolution` (`browser.ts:563`) over `setResolution`. Any new setter must win over `options.resolution`.
3. Quarter quality is 0.25 per side, which is 1/16 of the pixels, not a quarter.
4. `packages/render-ir/src/browser.ts` does not exist; `Transform2D` is at `model.ts:23-29`.
5. The editor never calls `buildRenderFrameIRFromProject`; the Monitor (`App.tsx:7637`) and the export (about `4063`) both use `buildRenderFrameIR` with `evaluateCameraExpressionTransform`.
6. The text-field guard is `isEditableTarget` (`keyboard-shortcuts.ts:29-35`), and `App.tsx:3692` checks both; Space acts on key-down with key repeat ignored (`App.tsx:3695`).
7. The Monitor already has handlers: effect drag-and-drop (`App.tsx:8051-8104`). The move must keep them. The bottom bar also has a Fullscreen button (`8171-8183`) and there is a GPU `<img>` overlay (`8111-8119`).
8. `resolveObjectIdForSelection` maps one way and returns only the first match; video nodes are keyed by clip id (`App.tsx:663`), not by object id.
9. The quality setting is a per-user preference (`ui-preferences.ts:61`), not project data. The component has 14 `useState`, about 13 refs and 10 effects (not "40 and 11").

### B. Design changes (decisions)

1. **Panel-sized canvas, zoom and pan inside the renderer.** The ADR section 2 plan (resize the whole frame by zoom, backing store up to 4096) is **replaced**. A 9:16 frame at 200 % on a 1.25 screen needs 2700x4800 and a 4K frame needs 4800x2700 already at 100 %: over the cap, and about 64 MB per buffer. Instead: the canvas stays the size of the panel; the Monitor gives the renderer a **Monitor-only view** (`setView({ zoom, panX, panY })`, outside the IR, never in the export). The backing store is panel size x screen pixel ratio x quality. No cap is needed; 800 % and the pixel grid come free. The scopes use a separate Fit read-back. `setView` and the pixel scale must win over `options.resolution`. (T-M02b and T-M02c follow this.)
2. **Rotation.** `Transform2D` has no rotation and its origin is the top-left corner (for text it moves with alignment, `browser.ts:246-251`). New card **T-M15**: add rotation and origin to the IR, the browser renderer and the Node rasteriser, and let the renderer report `nodeBounds(id)`, before the rotate handle ships. If T-M15 is late, the box ships without the rotate handle and the owner is told.
3. **Hit testing** uses `nodeBounds(id)` from the renderer (text has no width or height in the IR, shapes are fixed 100x100, html-scene is hard-coded 1080x1920) plus one id converter in each direction (clip id, object id, caption id). Both live in T-M15 and T-M04.
4. **Drags** convert world movement back into the parent's space before writing the local value, and handles are disabled when the value comes from a camera or an expression. Editing is blocked while an agent's staged preview is on screen (`App.tsx:7509-7514`).
5. **Keys.** Left and Right are global 1 s seek keys (`keyboard-shortcuts.ts:80-83`); nudge (arrow keys with a selection) and frame step (T-M10) must use a **focus-based key table** written into this ADR's task cards: pointer over or focus in the Monitor wins, otherwise the global seek applies. **T-M03 owns `keyboard-shortcuts.ts` and the Space handler at `App.tsx:3685`;** T-M10 and T-M12 add entries through it.
6. **Collisions.** `MonitorViewport.tsx` becomes a pointer router plus one file per tool (hand, select, transform, guides). `monitorPixelScale` moves into its own file `monitor-pixel-scale.ts` (T-M02c, read by T-M09). `ui-preferences.ts` is shared by T-M08 and T-M09: T-M09 goes first. Helpers extracted in T-M02a (`preview-frame-helpers.ts`, `editor-runtime-singletons.ts`) are the shared ones. **Freeze `App.tsx:7426-8280` (now the monitor folder) for OB-17, T-R03, OB-12 work until T-M02a is merged.**
7. **Export safety.** The export builds its own renderer with resolution 1 (`App.tsx:4501`) and encodes `renderer.canvas` (`4538`). Conditions: the override applies only to the renderer instance it is called on; a test checks the export canvas width equals the composition width after another instance calls `setPixelScale(4)`; keep the 0.1 floor; fall back if the browser shrinks the buffer (`drawingBufferWidth < canvas.width`).

### C. Not covered yet (assigned)

Drop a file on the Monitor (T-H02), the offline frame for missing media (T-R03), frame-accurate scrubbing and fps/dropped-frames readout (T-M10, T-M11), mask handles (T-M07, v1.1.2), where the aspect control lives once the Format control exists (T-N01), how captions and the 3D element are hit (T-M04 reads T-M15), a second screen (not in v1.1.1).
