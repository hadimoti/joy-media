### Task 13 implementer report

Implemented evidence-based delivery gating in editor-web.

Changes:

- Added delivery report metadata to export history: quick browser export vs verified delivery, linked export job id, inspect job id, report ref, inspection state, and waiver actor/reason.
- Added `deliveryGate()` for pass, warning, blocking failure, authorized waiver, canceled inspection, failed inspection, pending inspection, and legacy/uninspected exports.
- Added `DeliveryReportPanel` to show report evidence, report refs, job links, warnings/failures, and waiver details.
- Separated the existing MediaRecorder/browser MP4 path as Quick browser export and added a separate Deliver action that queues `render.export` and `render.inspect` jobs with a shared `reportRef`.
- Updated Jobs panel and browser control-plane client to surface render export/inspection jobs and report refs.
- Added focused tests for the delivery gate/panel and render job envelope linking.

Verification:

- `pnpm exec vitest run apps/editor-web/src/delivery-gate.test.tsx apps/editor-web/src/export-history.test.ts` passed: 11 tests.
- `pnpm exec vitest run apps/editor-web/src/control-plane-client.test.ts` passed: 6 tests.
- `pnpm --filter @joy-media/editor-web build` passed. Vite reported only the existing large chunk warning.
- `pnpm exec prettier --check apps/editor-web/src/export-history.ts apps/editor-web/src/DeliveryReportPanel.tsx apps/editor-web/src/delivery-gate.test.tsx apps/editor-web/src/control-plane-client.ts apps/editor-web/src/control-plane-client.test.ts apps/editor-web/src/JobsPanel.tsx apps/editor-web/src/App.tsx apps/editor-web/src/app.css` passed.
- `pnpm exec tsc -p apps/editor-web/tsconfig.json --noEmit` still fails on pre-existing editor type drift outside Task 13 files, including `AssetLibraryPanel.tsx`, monitor media tests, render-plan capture tests, timeline media intake tests, and `TimelinePanel.tsx`. No Task 13 files remained in the compiler error list after local fixes.
