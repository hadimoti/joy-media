# Task 15 API Production Runs

Date: 2026-08-21

Base commit:

- API slice review started from `752c5b8`.

Scope:

- Hardened `apps/api/src/production-runs.ts` against mixed-authority production run histories.
- Reordered approval response idempotency handling so exact retries resolve as duplicates before stale
  `expectedUpdatedSeq` conflicts.
- Expanded public-log/payload rejection to block `file://`, absolute Unix/Windows paths, and raw media
  payload strings.
- Added focused regressions in `apps/api/src/production-runs.test.ts` and
  `apps/api/src/http-server.test.ts`.

Behavior covered:

- Production run creation now rejects later event actors or approval authorities that diverge from the
  explicit authenticated authority.
- Public production run strings reject `file://` URIs, slash-rooted Unix paths, Windows paths, and
  base64-like raw media payloads.
- Exact approval retries return `{ duplicate: true }` even when the caller repeats the original
  `expectedUpdatedSeq`.

Verification:

- `pnpm exec vitest run apps/api/src/production-runs.test.ts apps/api/src/http-server.test.ts apps/api/src/postgres-control-plane.test.ts`
- `pnpm --filter ./apps/api build`
- `pnpm exec prettier --write apps/api/src/production-runs.ts apps/api/src/production-runs.test.ts apps/api/src/http-server.test.ts docs/TASK15-API-PRODUCTION-RUNS-2026-08-21.md`
- `git diff --check`
