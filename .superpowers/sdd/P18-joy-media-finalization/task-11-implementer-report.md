### Task 11 implementer report

Implemented Worker-side real bundle export through a new shared render-host package.

What changed:

- Added `apps/render-host` with protocol types, an offline browser page entry, and a Worker-driven export driver.
- Switched Worker export from `renderFixture` to `RenderBundleV1` planning via `planRenderFrame`.
- Added Worker-private opaque media resolution and missing-required-asset rejection.
- Added streaming RGBA frame export to FFmpeg in `packages/export-core`, avoiding whole-project frame buffering.
- Review fix: render-host now resolves planned video samples, still bitmap captures, HTML scene captures, and audio samples through the opaque media resolver for each exported frame.
- Review fix: resolved media inputs are consumed while producing frame pixels, and planned audio samples stream as signed 16-bit stereo PCM into FFmpeg instead of using `anullsrc` on the Worker/render-host export path.
- Review fix: Worker export now calls an explicit render-host driver protocol; tests inject a driver and assert it is invoked.
- Re-review fix: the default render-host driver now crosses the offline render-page transport boundary, and regression tests assert the default path invokes it.
- Re-review fix: resolved Worker-private file contents are read and hashed inside the host boundary; frame captures and audio PCM are derived from content digests, not opaque refs. Missing resolved files fail closed before export completion.
- Final-review fix: the default Worker/render-host path now creates an offline render page, paints frame/media inputs through that page, exports through the transport runtime, and destroys the page after export. Node/offline runs use a deterministic local page adapter when a DOM/Chromium canvas is unavailable.
- Final-review fix: private media content probing is now async and chunked via file streams or resolver-supplied streams, with an export-scoped digest cache. Production export streams frame inputs incrementally instead of collecting every planned frame input before FFmpeg starts.
- Returned `RenderExportReceiptV1` with opaque output ref, hash, bytes, manifest, codecs, and tool versions. No local output path is serialized in the receipt.
- Kept `renderFixture` in export-core as an explicit test helper only; Worker export tests spy on it and assert it is not called.

Verification run:

```powershell
pnpm exec vitest run apps/worker/src/export-job.test.ts apps/worker/src/worker-media-resolver.test.ts apps/worker/src/reference-e2e.test.ts
pnpm exec vitest run apps/render-host/src/index.test.ts apps/worker/src/export-job.test.ts
pnpm --filter @joy-media/render-host build
pnpm --filter @joy-media/worker build
pnpm --filter @joy-media/export-core build
pnpm exec prettier --check apps/worker/src/export-job.ts apps/worker/src/export-job.test.ts apps/worker/src/worker-media-resolver.ts apps/worker/src/worker-media-resolver.test.ts apps/worker/src/runtime.ts apps/worker/src/reference-e2e.test.ts apps/worker/src/control-plane.integration.test.ts apps/render-host/package.json apps/render-host/tsconfig.json apps/render-host/src/protocol.ts apps/render-host/src/render-page.ts apps/render-host/src/index.ts apps/render-host/src/index.test.ts apps/render-host/README.md packages/export-core/src/index.ts tsconfig.json apps/worker/package.json apps/worker/tsconfig.json
pnpm exec vitest run apps/worker/src/runtime.test.ts apps/worker/src/control-plane.integration.test.ts
pnpm exec vitest run packages/export-core/src/index.test.ts
git diff --check
```

All commands exited 0.

Notes:

- The render-host resolves required opaque media as frame/audio streams are consumed and uses resolved content digests to produce deterministic captured pixels/audio. Local source paths remain behind the Worker resolver boundary.
- Final-review verification also covered Worker default page creation/paint/destroy, render-host default page creation/paint/destroy, content-sensitive frame pixels/audio PCM, missing-content fail-closed behavior, and bounded stream probing for large resolver sources.
- Existing unrelated dirty workspace files were left untouched; the SDD ledger was not edited.
