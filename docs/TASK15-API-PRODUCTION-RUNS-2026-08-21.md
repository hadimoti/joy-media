# Task 15 API Production Runs

Date: 2026-08-21

Base commit:

- Remaining API findings were addressed from `62f226a`.

Scope:

- Hardened `apps/api/src/production-runs.ts` against mixed-authority production run histories.
- Tightened approval response authority checks so the caller must match the stored run authority's
  principal and role, not only the authenticated principal.
- Reordered approval response idempotency handling so exact retries resolve as duplicates before stale
  `expectedUpdatedSeq` conflicts.
- Expanded public-log/payload rejection to block `file://`, absolute Unix/Windows paths, and raw media
  payload strings, including nested base64-like values under arbitrary keys.
- Closed the remaining alphanumeric-only base64/base64url gap so long raw media blobs such as
  `'A'.repeat(128)` no longer bypass `SAFE_TOKEN`.
- Added focused regressions in `apps/api/src/production-runs.test.ts` and
  `apps/api/src/http-server.test.ts`.

Behavior covered:

- Production run creation now rejects later event actors or approval authorities that diverge from the
  explicit authenticated authority.
- Approval responses now reject same-principal callers that claim a different role than the production
  run's explicit authority.
- Public production run strings reject `file://` URIs, slash-rooted Unix paths, Windows paths, and
  base64-like raw media payloads, including long alphanumeric-only variants, even when they appear
  under non-forbidden nested keys.
- Exact approval retries return `{ duplicate: true }` even when the caller repeats the original
  `expectedUpdatedSeq`.

Verification:

- `pnpm exec vitest run apps/api/src/production-runs.test.ts apps/api/src/http-server.test.ts apps/api/src/postgres-control-plane.test.ts`
- `pnpm --filter ./apps/api build`
- `pnpm exec prettier --write apps/api/src/production-runs.ts apps/api/src/production-runs.test.ts apps/api/src/http-server.test.ts docs/TASK15-API-PRODUCTION-RUNS-2026-08-21.md`
- `git diff --check`
