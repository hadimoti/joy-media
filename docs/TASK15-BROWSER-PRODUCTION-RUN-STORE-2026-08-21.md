# Task 15 Browser Production Run Store

Date: 2026-08-21

Scope:

- Added the browser-local production run store in `apps/editor-web/src/browser-production-run-store.ts`.
- Added focused coverage in `apps/editor-web/src/browser-production-run-store.test.ts`.
- Added additive production-run DTOs and routes to `apps/editor-web/src/control-plane-client.ts`.
- Extended `apps/editor-web/src/control-plane-client.test.ts` for route shape and payload hygiene.
- Followed up on the browser Task 15 TypeScript regression by requiring
  `cancelProductionRun(..., input)` to receive the typed authority payload instead of defaulting to
  an invalid empty object.

Behavior covered:

- Browser reopen/local offline persistence.
- Project and actor-role scoped local histories with paginated listing.
- Monotonic event validation and optimistic checkpoint revision conflicts.
- Duplicate local run id and local run key rejection.
- Approval wrong-sequence, expired, rejected, duplicate, and conflict handling.
- Local cancellation with actor-role and monotonic `updatedSeq` compare-and-swap checks.
- Rejection of local paths, raw media payloads, and oversized public logs before persistence.
- Control-plane-client create/list/respond/cancel DTOs aligned with the authenticated API routes:
  create sends `runKey` plus `authority`, list reads `{ runs, nextCursor }`, approval uses
  `/respond`, and cancel sends `authority` plus `expectedUpdatedSeq`.

Verification:

- `pnpm exec vitest run apps/editor-web/src/browser-production-run-store.test.ts apps/editor-web/src/control-plane-client.test.ts`
- `pnpm exec prettier --write apps/editor-web/src/control-plane-client.ts`
- `pnpm exec eslint apps/editor-web/src/browser-production-run-store.ts apps/editor-web/src/browser-production-run-store.test.ts apps/editor-web/src/control-plane-client.ts apps/editor-web/src/control-plane-client.test.ts`
- `pnpm exec tsc -b apps/editor-web`

Known external verification note:

- `pnpm exec tsc -b apps/editor-web` still fails in pre-existing files outside this slice, including
  `AssetLibraryPanel.tsx`, monitor media tests, render-plan capture target tests, timeline media intake
  tests, and `TimelinePanel.tsx`. The `cancelProductionRun` TS2741 regression is fixed; no Task 15
  browser-store or control-plane-client type errors remained after the local fixes.
