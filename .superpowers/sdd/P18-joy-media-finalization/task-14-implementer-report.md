### Task 14 implementer report

Implemented durable production-run contracts for `@joy-media/workflow-engine` without adding a second executor.

Changes:

- Added `ProductionRunRecordV1`, `ProductionRunEventV1`, `ProductionApprovalV1`, `ProductionRunAuthority`, and the async `ProductionRunStore` port in `packages/workflow-engine/src/production-run.ts`.
- Added an in-memory store implementation for contract coverage, including compare-and-swap checkpoint revision updates and stale revision rejection.
- Added production state projection for queued, running, parked, failed, canceled, and succeeded runs from the existing `RunCheckpoint` state model.
- Added monotonic event append/assertion helpers and idempotent approval response recording. Duplicate matching approval responses return the existing record; conflicting responses are rejected.
- Added board snapshot projection from production records, with per-node counts, approval summaries, sanitized logs, and linked job/provider/report/artifact IDs.
- Bounded public per-node logs and artifact IDs during production projection. Public logs omit structured `data`; production artifacts use supplied artifact IDs and do not expose dashboard artifact refs.
- Sanitized production checkpoints to retain resume/state metadata while dropping node outputs, resolved inputs, and human request payloads from the public record.
- Exported the new production-run API from `index.ts`, plus small runtime state helpers and operations bounding helpers.

Verification:

- TDD red check: `pnpm exec vitest run packages/workflow-engine/src/production-run.test.ts` initially failed because `./production-run.js` did not exist.
- `pnpm exec vitest run packages/workflow-engine/src/production-run.test.ts packages/workflow-engine/src/runtime.test.ts packages/workflow-engine/src/operations.test.ts` passed: 3 files, 25 tests.
- `pnpm --filter @joy-media/workflow-engine build` passed.
- `pnpm exec prettier --check packages/workflow-engine/src/production-run.ts packages/workflow-engine/src/production-run.test.ts packages/workflow-engine/src/operations.ts packages/workflow-engine/src/runtime.ts packages/workflow-engine/src/index.ts` passed.
- `git diff --check -- packages/workflow-engine/src/production-run.ts packages/workflow-engine/src/production-run.test.ts packages/workflow-engine/src/operations.ts packages/workflow-engine/src/runtime.ts packages/workflow-engine/src/index.ts` passed.

Notes:

- Existing unrelated dirty files were preserved and not staged.
- No ledger files were edited.
