# Task 17 Implementer Report

Date: 2026-08-22

Scope:

- Added the read-oriented JOY Production Board panel in
  `apps/editor-web/src/ProductionBoardPanel.tsx`.
- Added the pure projection model in `apps/editor-web/src/production-board-model.ts`.
- Registered the durable `production` dock panel in workspace preferences, dock seed layout, panel
  labels/icons, and App panel routing.
- Styled the board as a dense editor panel with status groups, keyboard-selectable run rows, action
  controls, conflict states, and section tabs for Brief/Input, Scenes/Candidates, Assets/B-roll,
  Jobs/Providers/Cost, Approvals, QA/Delivery, and Events.

Behavior covered:

- Empty, loading, and error states.
- Status-grouped durable runs with newest-updated ordering.
- Monotonic event rendering by sequence.
- Approval, rejection, retry, and cancellation availability computed from durable run state.
- Stale project revision conflicts disable mutating actions and stay visible.
- Authority badges derive from stored production-run event actors.
- Links project to existing asset catalog entries, `CreativeArtifactV2` records, data-lane items,
  provider run ids, job ids, and report ids.
- Panel actions route through injected production run store/API callbacks; the board does not execute
  workflow nodes.

Verification:

- `pnpm exec vitest run apps/editor-web/src/production-board-model.test.ts apps/editor-web/src/ProductionBoardPanel.test.tsx`
- `pnpm --filter @joy-media/editor-web build`
- `pnpm exec prettier --write apps/editor-web/src/production-board-model.ts apps/editor-web/src/production-board-model.test.ts apps/editor-web/src/ProductionBoardPanel.tsx apps/editor-web/src/ProductionBoardPanel.test.tsx apps/editor-web/src/workspace.ts apps/editor-web/src/dock-layout.ts apps/editor-web/src/panel-tab-icons.ts apps/editor-web/src/App.tsx apps/editor-web/src/app.css`

Known external verification note:

- The editor build still emits the pre-existing large chunk warning from Vite; the build completes
  successfully.
