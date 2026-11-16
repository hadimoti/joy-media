# T-B06 decision (16 Nov 2026, made by Grok CLI on the owner's request)

The owner asked Grok CLI to choose the approach, with the rule that the app must not degrade. Grok read the design note and the code in read-only mode. Its answer, unchanged:

> I'll read the design note and the text-bounds path first, then decide which approach stays off the preview and export hot path.The design note and the projection are in place. Next I’ll check whether preview and export actually share the text path, and what the capture port would touch.Preview and export already share the Pixi text draw. The unsafe part is changing that path. I’ll write the decision as a plan: measure on a separate check-only renderer, and leave preview and export alone.Use renderer-reported bounds (option 1), measured on a short-lived off-screen copy of the export renderer, and only while a quality check is running. Do not build a shared text layout, and do not move the preview and export frame code into one function. A failed measurement, or a font that is not ready, is "unavailable". It never guesses a box and never throws into the editor.
>
> Preview and export already draw text the same way. Both use `createBrowserPixiRenderer`, both build the frame with `buildRenderFrameIR`, `renderFrameOptions`, and `withCaptionBurnInNodes`, and both get the drawn box from `nodeBounds` after Pixi has measured the text (plate included). Titles do not wrap. Captions wrap in the renderer. That measured box is the one to trust. The live preview is the wrong source: it draws at quarter, half, or full quality with zoom, and it does not wait for fonts, so a fallback font would be a guess. Export is scale 1 and waits for fonts. Measure that way, on the saved project, not on the monitor.
>
> ## Steps
>
> 1. **Add the composition capture port, and do not wire it to playback or export.** New file `apps/editor-web/src/media-observation/isolated-composition-renderer.ts`. It builds `IsolatedCompositionRendererAdapter` on `createBrowserPixiRenderer({ resolution: 1 })` with no parent. `renderAndReadback` renders, then reads pixels at the frame size. The same render keeps `nodeBounds` for the text nodes, tagged with that frame's time. Bounds come from that, not from the pixels. One renderer per quality-check run, destroyed when the run ends, including on cancel. Paint the full frame, including that one time's video bitmap, then release it before the next sample. If the picture cannot be decoded, fail the capture and leave text unavailable. A text-only frame would make the contrast check lie against an empty background. Do not change `readPixels` defaults, and do not call the monitor paint or the export paint loop.
>    - **Could break:** a second Pixi renderer shares the process text cache. Export already opens one for the length of an export. This one must live only for the length of a check. If it is attached to the monitor, created at startup, or called from playback, preview pixels or memory will change.
>    - **Proof:** `composition-observer.test.ts` and `browser-node-bounds.test.ts` stay green. A new test shows a known text frame returns pixels and a box, a thrown render does not escape, and `destroy` runs.
>
> 2. **Map those bounds to clips in a pure function, with no renderer.** New file `apps/editor-web/src/media-observation/text-layout-bounds-collect.ts`, next to the projection that already exists. A title's id is the object id. Its time range is the bound clip, or the whole composition when nothing is bound. A hidden clip is unavailable. A caption id is already `caption:<clipId>:<segmentId>:lineN`. One record per drawn line, over the cue's time range. A missing box, a zero box, an id that does not map, or bounds from another time or project revision is unavailable. Cap the boxes so the sample plan stays within 48 frames (it also adds the even samples and the cuts). Overflow is "not checked", not a failed check. Do not change `planTimelineQcSampling` or `normalizeTextBoxes`. One bad box must not fail the whole run.
>    - **Could break:** any edit to the sampler. Do not make one.
>    - **Proof:** `text-layout-bounds.test.ts` and `qc-sampler.test.ts` stay green. New tests cover rotation, plate padding, bad input, a stale revision, two caption lines, two overlapping titles, and 60 cues that do not throw.
>
> 3. **Connect it only inside a quality check.** `getTextBoxes` today is synchronous and runs even when the check then refuses. Real measurement has to wait (fonts, renderer). Await one collector call inside `runCheck` in `qc-host-adapter.ts`, only after the run is still current and a composition request exists. On any throw, record unavailable and go on with no boxes. In `AgentPanel.tsx`, pass this only inside the existing quality-check block. The repair path must reuse that same result, not render again. Measure again when the revision changes. Use the saved project, not a drag preview or a live grade. An empty list with no note looks like "there is no text" and the check looks clean. The report must say the text was not measured.
>    - **Could break:** the rest of `AgentPanel`, playback, and export.
>    - **Proof:** `qc-host-adapter.test.ts` still refuses with `composition-unavailable` when no composition is supplied, and a throwing collector does not reject the promise. Update the one test that expects the sync call on a check that refuses: that path must not start a renderer. `qc-repair.e2e.test.ts` and `font-readiness.test.ts` stay green. A new test shows a missing font yields unavailable and no box.
>
> 4. **Wait for fonts on the collector only, then render once, then read bounds.** Use the same font list export already uses. If any required font is missing, do not measure and do not fall back. Then read `nodeBounds` for that frame only.
>
> ## Risks and what to drop
>
> Do not build a shared layout and switch preview or export to it. That can change drawn pixels. A layout they do not draw with is not the drawn box.
>
> Do not find boxes by searching pixels. Overlapping titles and plates merge, and it adds work on every sample.
>
> Do not do design step 5. Leave `App.tsx` and `MonitorPanel.tsx` as they are. Do not add the font wait to preview. That can delay or stop playback when a font is missing. The shared frame helpers already exist. The collector calls the same functions export's frame builder calls. It does not replace those two call sites.
>
> Do not make preview and export ask the image cache at the same time. That changes one of the two pictures. Do not add title wrap. That is a visible draw change.
>
> Do not add corners onto the QC box type, and do not send raw records through `normalizeTextBoxes`. One bad box then fails the whole check.
>
> Do not read bounds on the live monitor during playback, or inside the export frame loop. Do not add a caption-overlap finder in this pass. Nothing reports that fault today, and there is no repair command for it. Two lines of the same caption overlapping is normal.
>
> Do not return an empty box list with no note when measurement fails.
