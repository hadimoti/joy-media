# WP-29 Final Luna Closeout

**Status:** Ready for execution; evidence-driven closeout loop
**Repository:** `/opt/joy-media/repo`
**Production root:** `/opt/joy-media`
**Candidate:** `8756325dc1c336385008332f5200c706c0c09954`

This is the execution checklist for GPT Luna. R0–R5 have retained accepted
evidence. R6 and the current-session feature verification must be completed in
order. Do not mark WP-29 finished when a step is running, skipped, or blocked.

## Operating loop

For every step, record SHA, UTC timestamp, environment, viewport, project
context, logs, screenshots/traces, console/page/network failures, and cleanup.
Review the evidence before continuing. A product failure is reproduced once,
fixed only in `/opt/joy-media/repo`, covered by a regression test, committed and
pushed, and restarts the loop at Step 1 with the new SHA. An environmental
blocker is recorded as `BLOCKED-INTEGRATION` and stops closeout. Never rewrite
history, edit a release directory directly, expose secrets, or mutate the
surviving user project/upload.

## Steps

### 1. Candidate and CI freeze

- Confirm clean worktree, `HEAD`, `origin/main`, and workflow head match.
- Require the complete GitHub workflow to conclude `success`.
- Record check/browser-e2e job URLs, totals, and the retained evidence artifact.

### 2. Local candidate gates

- Run `pnpm install --frozen-lockfile`, `pnpm verify:ci`, and the full
  `pnpm run test:e2e:audit` matrix.
- Run `tests/e2e/timeline-editing-features.spec.ts` at 1639×1066, 1366×768,
  and 1024×768; require 9/9.
- Record bundle sizes, media/codec proof, and all browser error channels.

### 3. VPS backup and preflight

- Fast-forward `/opt/joy-media/repo` to the candidate and verify a clean tree.
- Record old API/editor symlinks, service/PID/restart/socket, disk/inodes,
  database connectivity, schema-only dump, and `nginx -t`.
- Create a fresh PostgreSQL backup, record SHA-256, and verify gzip/PostgreSQL
  readability without printing credentials.

### 4. Immutable deployment

- Build API/editor from the same SHA in timestamped release directories.
- Validate staged entrypoints/assets, switch only `current-api` and `web`, and
  restart `joy-media@api.service`.
- Verify direct/public health, public root, service state, socket, and exact
  public `index.html`/entry-JavaScript hashes. Roll back both pointers and stop
  if any post-switch check fails.

### 5. Signed-in live baseline

- Use the existing authenticated JOY session and record release, Chrome,
  viewport, project/worker/job/asset/export counts, and initial errors.
- Create exactly one disposable project named `WP-29 final live <UTC-run-id>`;
  checkpoint before mutation. Never open or alter the surviving project/upload.

### 6. Current-session feature matrix

Run local/browser evidence at all three required viewports and a signed-in live
smoke. Verify:

- Aspect footer offers Fit, 16:9, 4:3, 3:2, 21:9, 1:1, 9:16, 4:5, 3:4,
  and 2:3; dimensions change atomically; Undo/Redo and refresh agree.
- Timeline context actions expose Freeze/Reverse/Merge, respect locked tracks,
  merge only valid contiguous clips, support physical two-click drill-in and
  Back, preserve parent offsets, and reject invalid/duplicate compounds.
- Speed exposes validated manual rates, presets, Reverse, Ease In/Out/In-Out,
  presentation/audio binding continuity, Undo/Redo, reload persistence, and the
  documented silent reverse-preview limitation.
- Fit handles short/long content and effective duration; zoom/follow keeps
  headers and terminal playhead visible; EOF loops; Space pauses/resumes the
  actual media without repeat-key or async-restart races.

### 7. Golden-path regression

In the disposable project, import fixture media, prove OPFS/cloud preview after
refresh, use public placement and real drag/drop, captions, Browser DSP, and
H.264/AAC export. Verify download bytes, dimensions, codecs, duration,
audibility/gain/mute, re-download after refresh, interrupted retry idempotency,
and cancellation cleanup. Retain accepted licensed Worker/Cloud evidence; do
not create unnecessary paid work.

### 8. Cleanup

Stop/cancel disposable work, revoke only a disposable Worker, remove only
fixture objects, permanently delete the exact disposable project, clear browser
downloads/evidence after hashing, and compare projects/workers/jobs/exports/
derivatives/private objects with baseline. Preserve rollback releases/backup and
the user’s surviving state.

### 9. QA reconciliation

Create `docs/qa/WP-29-session-features-<run-id>.md`. Reconcile STATE, the WP-29
closeout/golden/orchestration plans, R6, review log, GBrain handoff, and linked
WP-27 reports. Include candidate/release SHAs, backup hash, CI URLs/totals,
feature matrix, live results, FFprobe/audio measurements, public hashes,
cleanup comparison, intentional reverse limitation, and irreversible actions.

### 10. GBrain closeout

For `joy-media-state` and `joy-media-wp29-first-project-golden-path`, fetch the
complete page twice, compare `content_hash`, edit only the terminal WP-29
section, write the full page, re-fetch/hash-verify, and run the GBrain doctor.
Never print bearer tokens or alter an unrelated companion checkout.

### 11. Documentation commit

After GBrain verification, add final hashes to QA docs, run Markdown/Prettier,
privacy, and `git diff --check`, commit only QA/plan/state closeout changes,
push, and wait for documentation CI. Record `deployedProductSha` separately
from `closeoutDocsSha`; do not redeploy product artifacts for the docs commit.

## Final acceptance

WP-29 is `FINISHED` only when candidate CI/local gates, immutable deployment,
three-viewport session features, signed-in golden path, retained R2–R5 proof,
cleanup, QA consistency, both GBrain hashes, and documentation CI are green,
with no unresolved P0/P1, NOT-RUN, unapproved blocker, stale pointer, or cleanup
discrepancy.
