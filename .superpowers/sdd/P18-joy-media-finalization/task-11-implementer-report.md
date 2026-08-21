### Task 11 implementer report

Implemented Worker-side real bundle export through a new shared render-host package.

What changed:

- Added `apps/render-host` with protocol types, an offline browser page entry, and a Worker-driven export driver.
- Switched Worker export from `renderFixture` to `RenderBundleV1` planning via `planRenderFrame`.
- Added Worker-private opaque media resolution and missing-required-asset rejection.
- Added streaming RGBA frame export to FFmpeg in `packages/export-core`, avoiding whole-project frame buffering.
- Returned `RenderExportReceiptV1` with opaque output ref, hash, bytes, manifest, codecs, and tool versions. No local output path is serialized in the receipt.
- Kept `renderFixture` in export-core as an explicit test helper only; Worker export tests spy on it and assert it is not called.

Verification run:

```powershell
pnpm exec vitest run apps/worker/src/export-job.test.ts apps/worker/src/worker-media-resolver.test.ts apps/worker/src/reference-e2e.test.ts
pnpm --filter @joy-media/render-host build
pnpm --filter @joy-media/worker build
pnpm exec prettier --check apps/worker/src/export-job.ts apps/worker/src/export-job.test.ts apps/worker/src/worker-media-resolver.ts apps/worker/src/worker-media-resolver.test.ts apps/worker/src/runtime.ts apps/worker/src/reference-e2e.test.ts apps/worker/src/control-plane.integration.test.ts apps/render-host/package.json apps/render-host/tsconfig.json apps/render-host/src/protocol.ts apps/render-host/src/render-page.ts apps/render-host/src/index.ts apps/render-host/README.md packages/export-core/src/index.ts tsconfig.json apps/worker/package.json apps/worker/tsconfig.json
pnpm exec vitest run apps/worker/src/runtime.test.ts apps/worker/src/control-plane.integration.test.ts
pnpm exec vitest run packages/export-core/src/index.test.ts
git diff --check
```

All commands exited 0.

Notes:

- The render-host preflights every planned frame's required opaque media before opening the export receipt path.
- The current host renders planned project frames through the deterministic renderer while the browser page entry is available for pinned Chromium/Pixi use. Local source paths remain behind the Worker resolver boundary.
- Existing unrelated dirty workspace files were left untouched; the SDD ledger was not edited.
