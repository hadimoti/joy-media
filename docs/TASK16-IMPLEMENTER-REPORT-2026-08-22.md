# Task 16 Implementer Report

Date: 2026-08-22

Scope:

- Replaced the editor workflow runner's in-memory parked-run registry with an injected
  `ProductionRunStore` for first-party workflow runs and resumes.
- Persisted queued records and checkpoint/dashboard projections before returning parked,
  failed, or succeeded outcomes.
- Added durable resume inputs to `ProductionRunRecordV1` and preserved safe checkpoint
  outputs/resolved human inputs so completed deterministic nodes can be reused after
  serialization/reopen.
- Preserved previous approval decisions when later checkpoints park on a new approval.
- Split first-party node libraries into explicit production and fixture constructors.
  Production ports fail closed for unavailable provider/render/output capabilities; fixture
  ports are opt-in for tests.
- Wired the editor Workflows panel to a browser-local production run store and threaded
  approval expiry metadata through resume.
- Defaulted recorded workflow time inputs from the selected clip and current playhead:
  clip identity/duration come from selection; `atUs` and `newStartUs` come from the playhead.

Behavior covered:

- Park, serialize, create a fresh store-backed runner, respond, and resume.
- Completed deterministic upstream nodes do not rerun after durable resume.
- Stale two-tab checkpoint updates fail with a production-run revision conflict.
- Canceled and expired approval requests do not resume.
- Production first-party runs do not accidentally use fixture success for unsupported ports.
- Existing fixture-backed first-party live-gate coverage remains opt-in.

Verification:

- `pnpm exec vitest run apps/editor-web/src/workflow-runner.test.ts apps/editor-web/src/wp17-first-party-live-gate.test.ts apps/editor-web/src/browser-production-run-store.test.ts packages/workflow-engine/src/production-run.test.ts apps/editor-web/src/wp19-normalize-port.test.ts apps/editor-web/src/wp22-denoise-port.test.ts apps/editor-web/src/wp22-loudness-port.test.ts apps/editor-web/src/wp22-silence-port.test.ts apps/editor-web/src/wp23-tts-port.test.ts`
- `pnpm exec tsc -b packages/workflow-engine`
- `pnpm --filter ./apps/editor-web build`
- `pnpm exec eslint apps/editor-web/src/workflow-runner.ts apps/editor-web/src/workflow-runner.test.ts apps/editor-web/src/first-party-handlers.ts apps/editor-web/src/WorkflowsPanel.tsx apps/editor-web/src/wp17-first-party-live-gate.test.ts apps/editor-web/src/browser-production-run-store.ts apps/editor-web/src/wp19-normalize-port.test.ts apps/editor-web/src/wp22-denoise-port.test.ts apps/editor-web/src/wp22-loudness-port.test.ts apps/editor-web/src/wp22-silence-port.test.ts apps/editor-web/src/wp23-tts-port.test.ts packages/workflow-engine/src/production-run.ts`
- `pnpm exec prettier --write ...` on Task 16 files
- `git diff --check`

Known external verification note:

- `pnpm exec tsc -b packages/workflow-engine apps/editor-web` still fails on the known
  editor-web baseline outside Task 16: `AssetLibraryPanel.tsx`, monitor media tests,
  render-plan capture target tests, timeline media intake tests, and `TimelinePanel.tsx`.
  No Task 16 file errors appeared in that run.
- Full scoped ESLint including `App.tsx` still reports pre-existing unused-symbol findings
  in `App.tsx`; the Task 16 ESLint subset above is clean.
