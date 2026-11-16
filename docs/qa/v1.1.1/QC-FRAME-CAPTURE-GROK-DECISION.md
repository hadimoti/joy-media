# Frame capture for the quality check: approach chosen by Grok CLI (16 Nov 2026)

The owner asked Grok CLI to choose again, with the rule that the app must not degrade. Grok read the code in read-only mode. Its answer, unchanged:

> I'll read the design notes and the capture, preview, and export paths, then recommend one way to sample frames that leaves the editor unchanged.The capture can be a separate check-only renderer. Preview and export already build frames from shared functions, so the check can call those without joining their paint loops. I’ll write that up as the decision.Use a check-only off-screen renderer. Build each frame from the saved project with the same functions export already calls, and decode video with the export decoder on a private video element. Do not read the live monitor, and do not add a dry-run branch inside export.
>
> Preview and export stay as they are. A failed capture reports unavailable. It does not throw into the editor.
>
> ## Where the frames come from
>
> Choice (a). A new module owns one short-lived Pixi renderer, created with `createBrowserPixiRenderer({ resolution: 1 })` and no parent. It exists only while a quality check is sampling, then it is destroyed. It never calls `setView` or `setPixelScale`.
>
> The code already allows this without editing the export or preview paint:
>
> - `createBrowserPixiRenderer` takes an optional parent. Export already opens a second renderer with no parent for the length of an export. A check can do the same, on its own instance.
> - The frame is not trapped inside that loop. Both paints call exported functions: `buildRenderFrameIR`, `renderFrameOptions`, `withCaptionBurnInNodes`, `isBoundObjectActive`, `evaluateCameraExpressionTransform`, `withVideoFrameNodes`, and `videoFrameNodeFromDecoded`.
> - `readPixels(width, height)` already returns the full frame when the caller passes the frame size. The 640×360 default stays. Do not change it. While a monitor view is set, `readPixels` moves the live stage, draws a fit copy, and draws the view again. The check must not call it.
> - The observer already requires an isolated read-back and rejects editor overlays. Nothing implements `renderAndReadback` yet. This module is that adapter.
>
> Not (b). A dry mode would edit `paintFrame` inside `App.tsx`. That function is the export hot path. Any branch there can change export pixels or timing. There is no dry flag today.
>
> Not (c). The monitor is the wrong picture. It draws at quarter, half, or full quality, with zoom and pan, and it can show an unsaved drag or a live grade. It only has the current playhead, from the preview video element, and it does not wait for fonts.
>
> Not `buildRenderFrameIRFromProject`. That helper evaluates the camera differently and does not take hidden clips. Export and the monitor both call `buildRenderFrameIR` plus `evaluateCameraExpressionTransform` and `hiddenClipIds`. The check must call that same set. Do not switch either paint over to one shared function.
>
> The check reads the saved session, cloned when the check starts. It does not read the monitor drag preview or the live grade.
>
> ## How video pictures are decoded
>
> Reuse `openExportFrameSource` as it is. It is the export decoder: forward decode, its own canvas, a 16 MB compressed cache, and `close()` on cancel. `frameAt` returns `undefined` when the clip seeks backwards, the gap is over 8 seconds, or the decode stalls, and it rejects when the signal aborts. Export already treats `undefined` as "seek a detached video instead".
>
> Do not use `browser-sample-decoder.ts`. It only wraps a sample that something else already decoded, and it makes a small thumbnail. It does not seek and it does not draw a composition.
>
> Do not use `final-encoded-export-decoder.ts`. It decodes a finished MP4. The timeline check has no export file.
>
> For each sample time, only the clips that are on screen:
>
> 1. Prefer `openExportFrameSource` on a blob from the existing `loadProjectAssetBlob`. A reversed clip, or a reverse time remap, skips this and seeks, as export does.
> 2. When `frameAt` returns `undefined`, seek a new video element with the existing `seekDetachedVideo` and `seekUsForSource`, then `createHtmlMediaDecoder` on a private canvas. This is not the preview element.
> 3. Stills and animated images use the same split export uses.
> 4. One decoder at a time. Copy the pixels, then drop that bitmap before the next sample. Close the decoder and clear the private video when the check ends or the signal aborts.
> 5. No audio decode.
>
> If the picture cannot be decoded, fail that capture. Do not draw text on an empty or black frame. A missing custom LUT does not fail the frame: export already continues with the rest of the grade. Use a private LUT resolver, not the preview's.
>
> Stickers and HTML scenes use private caches, loaded through `loadProjectAssetBlob`. Do not call the shared sticker cache or the monitor scene cache. The shared cache returns the same pixel arrays the monitor is drawing, and a check that writes them, or that reloads them while the monitor loads, can change the preview. If a visible sticker or HTML scene cannot be captured, fail the frame.
>
> Fonts: `waitForContentFonts` on the check only. A missing font blocks the capture. Do not draw with a fallback font, and do not add this wait to preview.
>
> Caps stay as they are. The sampler allows one 1920×1080 read-back at a time. A larger frame fails closed. Do not raise the cap and do not silently scale.
>
> ## May App.tsx or MonitorPanel.tsx be touched?
>
> `MonitorPanel.tsx`: no.
>
> `App.tsx`: one existing prop, no new function, and not the export loop. `loadProjectAssetBlob` is already on the dock context. The agent panel does not receive it today. Pass `context.loadProjectAssetBlob` into the existing `AgentPanel` element. The dock only re-renders from context, so the loader must come from `context`.
>
> That cannot change preview or export pixels. Nothing in those paints reads the new prop. The function is the one stickers already use. If it is absent, the check stays `composition-unavailable`.
>
> Do not export `videoClipSpecAt` out of `App.tsx`. Copy that short glue into the new module. It only calls helpers that are already exported (grade, effects, camera transform, mask map). Moving it would edit the export file, and a bad move would change export. The cost is drift: if export's private glue changes later, the check can disagree until the copy is updated. A unit test locks the copy's fields on a fixture.
>
> ## Steps
>
> 1. **Add the capture module, unwired.** New file `apps/editor-web/src/media-observation/isolated-composition-capture.ts`. It returns the composition request the adapter already accepts, plus a `release()`. `release()` destroys the Pixi renderer with the renderer's own `destroy()` (not Pixi's boolean `destroy(true)`), closes decoders, and drops the private caches. The renderer is created on the first sample and destroyed in `release()`. Do not put `release` on the observer request: extra keys are rejected. Dynamic-import this module and `export-frame-source` only when a check runs, so startup does not load the decoder library.
>    - Could break: a second WebGL context for the length of a check. Leaving it alive, or destroying shared Pixi pools, would change preview text or exhaust contexts.
>    - Proof: `browser-node-bounds.test.ts` and `browser-monitor-view.test.ts` stay green. A new test feeds a fake bitmap and asserts full-size pixels, a thrown render becomes a failed result rather than a rejection, and `release()` runs after success, failure, and abort.
>
> 2. **Build the frame the export way, still unwired.** Hidden clips, bound objects, camera transform, `renderFrameOptions` from the private sticker sizes (not `imageSizesFromCache`), captions, video nodes under the overlays, transition partners, clip grades on copies of the transition bitmaps, HTML scenes. Clone the saved projects at the start. If the observer cannot freeze the snapshot, return no composition request.
>    - Could break: nothing in preview or export, because those files are not edited. A wrong check picture must fail closed rather than look clean.
>    - Proof: a fixture test with no GPU checks the render description: a hidden clip is absent, a title and a caption are present, a video node carries the fixture's transform, grade, and effects, and a failed decode does not produce a frame. `qc-sampler.test.ts` and `composition-observer.test.ts` stay green.
>
> 3. **Call it only from a quality check, and always release it.** In `qc-host-adapter.ts`, an optional `releaseComposition` runs in a `finally` around the existing sample, and its throw is swallowed. `getComposition` stays optional. In `AgentPanel.tsx`, pass both only inside the two existing `createEditorQcAdapter` blocks (the check request, and the recipe check). Each adapter releases its own session. In `App.tsx`, pass `context.loadProjectAssetBlob` only.
>    - Could break: the agent panel and the check adapter. Playback and export are not on this path. A throw from `getComposition` must be caught so the result stays `composition-unavailable`.
>    - Proof: `qc-host-adapter.test.ts` still refuses with `composition-unavailable` when no composition is passed, and a throwing loader does not reject. `qc-repair.e2e.test.ts` and `export-mp4-contract.test.ts` stay green. A new test shows `release` after a successful sample and after a failed one.
>
> 4. **Fonts and media failure stay fail-closed.** Readiness uses `waitForContentFonts`. Any throw in evaluate or render is the observer's existing failure. Do not catch those inside preview or export.
>    - Could break: a font wait on the preview path, if someone shares it. Do not.
>    - Proof: `font-readiness.test.ts` stays green. A new test: a missing font yields a blocked capture and no pixels.
>
> Then run the new tests plus `qc-host-adapter.test.ts`, `composition-observer.test.ts`, `qc-sampler.test.ts`, `export-mp4-contract.test.ts`, and `font-readiness.test.ts`. The full `apps/editor-web/src` vitest run is the proof that existing tests did not move.
>
> ## What to drop
>
> - A dry mode, or any edit, inside export's `paintFrame` or `buildFrame`.
> - Reading pixels from the live monitor, during playback or during export.
> - Moving the two paint sites into one function, and adding the font wait to preview.
> - Sharing the sticker cache, the monitor scene cache, the preview video element, or the export renderer.
> - Using the sample-thumbnail decoder or the finished-MP4 decoder as this frame source.
> - Changing `readPixels` defaults, sampler caps, or the sample planner.
> - Decoding audio, keeping every clip's decoder open, or creating the renderer at startup or on each playhead tick.
> - A silent downscale for frames over 1920×1080. Those stay unavailable.
> - Title and caption box measurement in this change. Boxes stay empty until this capture is real. Wiring boxes to a partial picture would mark them trusted when they are not.
>
> ## Risks
>
> While a check runs, one extra WebGL context and one video decoder exist. That can hitch playback for those seconds. It is not on the playback tick, and `release()` removes it. Running a check during an export contends for the same decoder and GPU export is using. Do not add an export lock in `App.tsx`. The check simply stays off the export function.
>
> The copied clip-spec glue can drift from `App.tsx` later. The fixture test locks the copy. It does not watch the private function.
>
> A project the observer cannot freeze, a missing font, a missing picture, or a frame over 1920×1080 makes the whole check unavailable. That is the safe result. It must not look like a clean report.
