# T-B06: trusted title and caption bounds

## What exists today

- `apps/editor-web/src/joy-agent/qc-host-adapter.ts`: `QcTimelineSource` carries `textBoxes` (lines 83–88). `qcTimelineSourceFromTimeline` accepts them, but defaults to an empty list (111–114). `createEditorQcAdapter` passes `[]` (668–685). The adapter filters boxes by re-check range (330) and gives them to the sampler.
- `apps/editor-web/src/media-observation/qc-sampler.ts`: `TimelineQcTextBox` holds a normalized rectangle, time range, kind, color, and optional plate color (29–41). `planTimelineQcSampling` adds each box midpoint to the sample plan (191–242). `analyzeTimelineTextBoxes` (259–282) only loops and calls `analyzeTextBoxOnFrame`; the safe-area check (`inside90Percent`) and the contrast check are inside `analyzeTextBoxOnFrame` (648–702). `normalizeTextBoxes` (586–630) already rejects non-finite values, bad intervals, zero-size boxes, duplicate ids and ids outside `^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,255}# T-B06: trusted title and caption bounds

## What exists today

- `apps/editor-web/src/joy-agent/qc-host-adapter.ts`: `QcTimelineSource` carries `textBoxes` (lines 83–88). `qcTimelineSourceFromTimeline` accepts them, but defaults to an empty list (111–114). `createEditorQcAdapter` passes `[]` (668–685). The adapter filters boxes by re-check range (330) and gives them to the sampler.
- . There is no overlap check.
- Titles are converted to Render IR by `visualObjectToRenderNode` in `packages/visual-object-renderer/src/index.ts` (145–220). The node carries text and style but no measured width or height, and titles set no `maxWidth`: a title is one line unless its text has line breaks (only captions set `maxWidth`). `TextNode` in `packages/render-ir/src/model.ts` (128–154) has a `maxWidth` constraint, not final layout bounds.
- Captions are laid out by `layoutCaptionNodes` (`packages/captions-core/src/index.ts:301–342`) or `layoutTemplatedCaptionNodes` (`packages/captions-core/src/styling.ts:150–258`). They return positioned text nodes. Line breaks use a character budget (`breakCaptionLines`, `styling.ts:116–135`), then the renderer wraps again at `maxWidth` (`browser.ts:450`), so line count and box height are estimates until the renderer measures them. The layout determines line position, font size, plate color, and safe-area placement. `captionBurnInNodes` calls the templated layout for preview and export (`apps/editor-web/src/caption-burn-in.ts:29–43`).
- The Pixi browser renderer makes a `Text` object (`packages/renderer-pixi/src/browser.ts:466–470`) and applies alignment (`applyTextAlignment`, 386–391), font, wrap and style (`updateTextVisual`, 393–464). Plate sync is at 483–501. It gets the drawn local box from that object's `width` and `height`, includes plate padding, then `nodeBounds` transforms the box (`533–540`, `826–831`). This is a useful renderer-owned source of bounds. The CPU Pixi and headless test renderers use approximate character widths instead.
- `universal-placement.ts` keeps visual objects bound to timeline items (`upsertUniversalTimelineBinding`, lines 32–63) and updates those bindings with timeline transactions (80 onward). It can supply which title clip owns a visual object and its active time range; it does not measure its rendered text.
- T-B06 asks QC to move titles into the safe area and re-check changed ranges (task card lines 247–251). T-B09 expects the title-outside-safe-area fault to be found (265–269).

## Prerequisite (found in review)

Nothing implements `IsolatedCompositionRendererAdapter.renderAndReadback` (`apps/editor-web/src/media-observation/composition-observer.ts:117–123`), and no caller passes `getComposition` (`qc-host-adapter.ts:658`; the `createEditorQcAdapter` calls in `AgentPanel.tsx` do not pass it). The check therefore refuses with `composition-unavailable` before any box is read. This port (`composition-observer.ts:98–131`, which already sets `includeEditorOverlays: false`) must be implemented over `createBrowserPixiRenderer` and wired first. Use it as Option 1's seam; do not invent a new one.

## Does export use the same text path as preview? (owner question 1, answered from the code)

Partly. Both create the renderer with `createBrowserPixiRenderer` (`browser.ts:221`), build nodes with `buildRenderFrameIR` (`visual-object-renderer/src/index.ts:274`) and burn captions in with `layoutTemplatedCaptionNodes` (`caption-burn-in.ts:39`). They differ in: pixel scale (preview uses `previewQualityResolution`, 0.25, 0.5 or 1; export is fixed at 1), the font gate (export calls `waitForContentFonts` and fails on a missing font; preview has none), and frame building (copied inline in `App.tsx` and `MonitorPanel.tsx`, not shared). Trust in preview bounds for export is therefore not established today.

## The gap

QC already accepts rectangles, but no editor projection produces them. The editor adapter explicitly supplies no boxes. Reading clip position or object transform alone cannot recover the drawn rectangle: text can wrap, shrink, use a font, rotate, or have a plate. Captions also create one or more line nodes from active cues. Guessing from text length will disagree with the renderer. Without geometry, QC cannot reliably check safe area or title-to-title overlap.

The projection should remain pure: give it detached, validated geometry and time ranges; let it report safe-area and overlap findings without measuring text, reading UI state, or rendering pixels itself.

## Options

### 1. Ask the active renderer for bounds

- **Shape:** one record per drawn text node: stable node/object id, title or caption kind, `startUs`/`endUs`, four frame-space corners, and text/plate colors. Keep corners or a polygon for rotation; derive a normalized axis-aligned rectangle for the existing sampler.
- **Who and when:** the host evaluates the normal frame at each text layout change or at bounded check sample times. After updating the Pixi renderer, it reads `nodeBounds(id)` and joins bounds to the owning clip and its active interval.
- **Trust and determinism:** this is the actual preview renderer's box. It is trustworthy for export only if export uses the same renderer, font availability, and layout settings. Capture from a revision-bound, detached frame; reject missing bounds and stale revisions.
- **Cost:** low to medium. Reuses `nodeBounds`; needs host wiring, ownership/time mapping, and geometry normalization.
- **Risk:** current Pixi bounds depend on browser text metrics and loaded fonts. They may vary across machines or differ from a separate export renderer. Renderer bounds describe its text box, not exact non-transparent glyph pixels.

### 2. Make layout return shared measured geometry

- **Shape:** a pure layout result containing the final `TextNode` and local box (including wrapping and plate), plus transformed corners. Use the same new `TextLayout` type (it does not exist in the repo today) in preview, export, and QC. `NodeBounds` already has `corners`, `aabb` and `origin` (`packages/render-ir/src/node-geometry.ts:53–68`), and `textPlateBounds` (`packages/render-ir/src/text-layout.ts:98–126`) is a shared plate helper: reuse both. The projection converts its corners to normalized composition coordinates and attaches ids and active intervals.
- **Who and when:** the shared text-layout/render layer measures and positions text. The host calls that layer for each relevant composition time, then passes detached layout results to the pure QC projection.
- **Trust and determinism:** strongest if one deterministic layout implementation and the same resolved font metrics feed preview, export, and QC. Include a layout version and composition dimensions in the snapshot; bind it to the project revision. If a renderer uses different metrics, it must not claim these bounds as exact.
- **Cost:** medium to high. Requires factoring measurement out of the Pixi-only path and making title and caption layout use it. It creates the cleanest contract for collision checks too.
- **Risk:** browser font shaping and fallback can still differ unless fonts are pinned or the renderer supplies authoritative metrics. Changes to text layout can affect existing render output.

### 3. Find text pixels in a rendered frame

- **Shape:** per-node pixel mask or connected-component bounds with sample time and node id, then normalized rectangles.
- **Who and when:** a renderer or image-analysis pass measures after rendering each sample.
- **Trust and determinism:** reflects actual pixels in that frame, including clipping and effects. Determinism depends on the render backend and segmentation method. Overlapping text and plates may merge, so object ownership is unclear.
- **Cost:** high. Needs a tagged render pass or masks, then image analysis and temporal aggregation.
- **Risk:** cannot robustly assign merged pixels to individual titles; antialiasing and effects make results backend-dependent. This is excessive for safe-area and box-overlap checks.

## Recommendation

Choose option 2 as the target contract. Start by exposing renderer-owned bounds through option 1 if the preview and export paths can be shown to share the same layout and fonts. Keep the API at the host boundary: the host supplies detached geometry; the pure QC projection does not call Pixi or inspect the project. Extend the QC box shape with corners (and an optional plate rectangle) while retaining a derived normalized AABB for the existing safe-area and contrast code. Run overlap checks only when two boxes' time ranges intersect.

Do not mark a box trusted when layout or a font is unavailable. Return an explicit unavailable result for that text node and skip geometry findings for it. Never substitute character-count estimates for rendered title bounds.

## Helper steps and tests

0. Implement and wire the composition capture port (see Prerequisite).
1. Define a validated text-layout bounds record with stable node id, kind, active interval, composition dimensions, corners, text color, and optional plate color. Reuse `normalizeTextBoxes` (`qc-sampler.ts:586–630`) instead of a second validator, and make ids match its id pattern (title ids are object ids).
2. Add a pure projection from title/caption layout records to normalized QC boxes. Preserve rotated corners and take the `aabb` that `NodeBounds` already carries. Test scaling, rotation, alignment, plate padding, invalid input, and stable ordering.
3. Add one host collector that builds the same evaluated frame used by preview/export, gets final bounds, maps node ids to timeline clips/caption intervals, and binds the result to project revision. Render the frame for the exact time first, then read bounds, and reject bounds from any other frame or revision. Test stale revision, missing font/bounds, captions with multiple lines, and two overlapping title intervals.
4. Add `readonly getTextBoxes?: () => readonly TimelineQcTextBox[]` to `EditorQcAdapterInput` and pass `input.getTextBoxes?.() ?? []` where the adapter now passes `[]` (`qc-host-adapter.ts:681`). Test that safe-area, contrast, and overlap findings cite the right title ids and times, and that a range re-check includes only intersecting boxes.
5. Move the frame assembly (`App.tsx:4619–4650`, `MonitorPanel.tsx:5998–6042`) into one shared function and apply `waitForContentFonts` to both paths. Add a frame budget test: 60 caption cues plus one title must not fail the whole run (`planTimelineQcSampling` throws `invalid-plan` over `maxFrames`, 48): merge boxes that share a time window, or reserve frames for text and report the rest as not checked. Then add a parity fixture rendered by preview and export at quarter, half, full and 1 scale with a title with explicit line breaks (titles do not wrap today; adding a title wrap width is a separate, owner-visible change), a rotated title, and a caption plate. Assert both paths report the same geometry within a documented pixel tolerance. If the paths do not share metrics, keep bounds unavailable until they do.

## Owner questions

- Does the production export path use the same Pixi text engine and resolved font set as preview? This decides whether renderer-reported bounds can be trusted before shared layout work lands.
- Should QC define a title box as the full text layout box, or as visible glyph pixels? The recommendation uses the layout box and plate, which is stable and actionable for safe-area checks.
