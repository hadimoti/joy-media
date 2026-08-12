# WP-30 Final CI Animated-Export Repair and Closeout

**Status:** FINISHED — final live Chrome and GBrain evidence recorded; documentation-only CI pending
**Date:** 2026-08-11  
**Current deployed product SHA:** `1b7e8abf27e41d132cda0714c890206400596c41`
**Current documentation SHA:** pending documentation-only closeout commit
**Failed GitHub run:** [31519828019](https://github.com/hadimoti/joy-media/actions/runs/31519828019)  
**Repository:** `/opt/joy-media/repo` on the VPS and `C:/Users/HadiMoti/joy-vps/joy-media-fix` locally

## Objective

Fix the remaining WP-30 animated-export defect, prove it in bundled Chromium and
signed-in Google Chrome, deploy an immutable repair release, remove all disposable
state, and reconcile the repository and GBrain to the final repair SHA.

This is a narrow repair. The cross-browser catalog, preview, rehydration, and WebP
decoder cases are already green. Do not reopen or redesign those working paths
unless the focused repair demonstrates a shared regression.

## Current Evidence and Scope

GitHub run `31519828019` produced:

- `check`: `PASS`;
- `browser-e2e`: `FAIL`;
- `141 passed`, `3 failed`, `3 skipped`;
- the six WP-30 cross-browser asset instances passed: two cases at each of the
  three configured viewports;
- the only failures were the same animated GIF export case at:
  - `1639x1066`;
  - `1366x768`;
  - `1024x768`;
- both the initial run and retry produced identical sampled frame hashes:
  `e07a49a8d6e0ccc17c17c376b10c8434`.

Manual coverage already retained:

- GPT in-app browser: signed-in GIF import, animation metadata, timeline placement,
  export completion, Recent processes entry, and cleanup;
- Google Chrome: signed-in User-assets discovery and verified local-copy GIF preview;
- missing manual proof: a downloaded Chrome export with two distinct decoded video
  frames.

## Working Root-Cause Hypothesis

The export preloader in `apps/editor-web/src/App.tsx` correctly prepares image media
as either `stillFrame` or `animatedFrameSource`. Its `captureExportClip()` function
also knows how to render both forms.

However, the frame-paint path currently chooses the active clip only when the
prepared record has `video !== undefined`. Animated images intentionally have no
HTML video element, so they can be rejected before `captureExportClip()` is called.
The renderer then records an unchanged canvas, which is consistent with identical
frame hashes at every viewport.

Treat this as a hypothesis until Step 1 reproduces and instruments the exact branch.
Do not weaken the browser assertion merely to make CI green.

## Operating Loop

For every step:

1. Record SHA, timestamp, command, browser/project context, and starting state.
2. Perform only that step.
3. Review functional, visual, console, network, persistence, and cleanup evidence.
4. Continue only when the step is `PASS`.
5. Reproduce every apparent product failure once before changing code.
6. After a repair, add a regression that fails without the repair.
7. If the repair SHA changes, replace it in all later evidence and restart the
   candidate gates from Step 4.

## STEP 0 — Freeze State and Preserve Failure Evidence

### Actions

- Confirm the local worktree is clean and `HEAD == origin/main == 0aa5e314...`.
- Record the deployed immutable API/editor release names and rollback pointers.
- Download the failed workflow artifacts for run `31519828019` into a private
  temporary evidence directory.
- Preserve the primary, compact, and minimum viewport traces, screenshots,
  videos, and `animated-export.json` attachments.
- Record that production remains on product SHA `43c5521`; do not redeploy or
  mutate live state during diagnosis.

### Gate

- Failure evidence exists for all three viewports and contains no secrets.
- Worktree and production pointers remain unchanged.

## STEP 1 — Reproduce and Prove the Branch Failure

### Actions

Run the exact failing spec using the CI browser and one worker:

```bash
pnpm exec playwright test tests/e2e/wp30-animated-timeline-export.spec.ts \
  --project=desktop-primary \
  --project=desktop-compact \
  --project=desktop-minimum \
  --workers=1
```

Add temporary test-only evidence or a durable diagnostic attachment that records,
for two or more export frames:

- composition time;
- active clip ID and asset kind;
- whether the prepared media has `video`, `stillFrame`, or
  `animatedFrameSource`;
- selected animation-frame `startUs`;
- whether a `VideoFrameNode` was created;
- renderer readback/frame hash.

Confirm whether the active animated clip is excluded solely because
`media.video` is absent. Remove temporary logging after the cause is proven; keep
only useful sanitized assertions/attachments.

### Gate

- The failure reproduces at least twice or the retained CI trace proves the same
  deterministic branch.
- Root cause is classified as product code, test sampling, or both.
- No production or user project is touched.

## STEP 2 — Implement the Minimal Product Repair

### Required behavior

Introduce one named renderability predicate/helper for prepared export media. It
must return true when any supported visual source is ready:

- detached HTML video plus decoder;
- decoded static-image frame;
- decoded animated-image frame source.

It must return false for audio-only or incomplete/unresolved media.

Use the helper consistently for:

- active-clip selection;
- transition-partner selection;
- any other export branch that currently checks only `media.video` before calling
  `captureExportClip()`.

Preserve:

- owner-authorized OPFS/cloud media resolution;
- animation source-time mapping, loop behavior, rate, reverse, freeze, and
  transition timing;
- `VideoFrameNode` construction and visual-object bindings;
- abort and cleanup semantics for decoded frames and object URLs;
- static image, video, audio, captions, effects, and HTML-scene export behavior.

Do not solve the failure by substituting a video element for image decoding or by
falling back to a bundled reference asset.

### Gate

- The animated image reaches `captureExportClip()` at each sampled export time.
- Two source times in different GIF frame windows select distinct decoded frames.
- No new resource leak or unsupported media fallback is introduced.

## STEP 3 — Add Focused Regression Coverage

### Unit and contract tests

Add tests that prove:

- prepared video media is renderable;
- a static image with only `stillFrame` is renderable;
- an animated image with only `animatedFrameSource` is renderable;
- audio-only and incomplete records are not renderable;
- active and transition animated-image clips are not filtered out;
- frame selection at `0us`, `300000us`, and after a one-second loop uses the
  expected GIF frame windows;
- cleanup disposes the animated frame source exactly once on success, abort, and
  failure.

### Browser-test hardening

Keep the assertion that exported frames differ, but remove seek ambiguity from the
proof. Extract deterministic frame indexes from one decode pass, for example output
frames `0` and `9` at 30 fps, using an FFmpeg `select` filter and `framemd5` or
equivalent decoded-pixel hashing.

Also assert:

- H.264 video and AAC audio;
- nonzero bytes;
- expected dimensions and duration;
- two distinct decoded frames;
- retained Recent-process download works after refresh;
- no console error, page error, or unexpected failed same-origin request.

The assertion must continue to fail for a static/unchanged exported canvas.

### Gate

- Focused unit/contract tests fail on the old implementation and pass on the
  repaired implementation.
- The browser proof distinguishes actual encoded output frames, not source fixture
  bytes or Program Monitor DOM state.

## STEP 4 — Run the Focused Browser Matrix

Run:

```bash
pnpm exec playwright test tests/e2e/wp30-animated-timeline-export.spec.ts \
  --project=desktop-primary \
  --project=desktop-compact \
  --project=desktop-minimum \
  --workers=1

pnpm exec playwright test tests/e2e/wp30-cross-browser-assets.spec.ts \
  --project=desktop-primary \
  --project=desktop-compact \
  --project=desktop-minimum \
  --workers=1
```

Repeat the animated-export matrix once from a clean browser/storage state to prove
it is deterministic rather than flaky.

### Gate

- Animated export: `3/3 PASS` twice.
- Cross-browser asset suite: `6/6 PASS`.
- No retries are required for acceptance.
- All downloads contain distinct decoded frames and valid H.264/AAC streams.

## STEP 5 — Run the Full Candidate Gate

Run from a clean checkout of the proposed repair SHA:

```bash
pnpm install --frozen-lockfile
pnpm verify:ci
pnpm run test:e2e:audit
```

Record test totals, skipped integration cases, build/audit output, bundle sizes,
browser evidence, and cleanup.

### Gate

- Every command exits zero.
- The full browser result has no unexpected failure or retry-dependent pass.
- No ignored or untracked product/test file remains.
- Privacy scan and `git diff --check` pass.

## STEP 6 — Commit, Push, and Require Green GitHub CI

### Actions

- Commit the minimal product repair and its tests as one additive commit.
- Push to `origin/main` without rewriting history.
- Wait for both GitHub jobs:
  - `check`;
  - `browser-e2e`.
- Download and inspect the successful animated-export evidence from all three
  viewport projects.

### Gate

- `origin/main`, local `HEAD`, and workflow `headSha` match the repair SHA.
- Overall workflow conclusion is `success`.
- The run records `3/3` animated exports and `6/6` cross-browser asset instances.

## STEP 7 — Immutable Repair Deployment

### Preflight

- Fast-forward `/opt/joy-media/repo` to the exact green repair SHA.
- Record current API/editor rollback pointers.
- Create and verify a fresh PostgreSQL backup without printing credentials.
- Run database connectivity, schema-only dump, disk/inode, service, socket,
  `nginx -t`, direct health, and public health checks.

### Deployment

- Build API and editor from the same repair SHA.
- Create new immutable release directories containing the UTC timestamp and short
  SHA.
- Validate staged API health and editor asset hashes.
- Switch only:
  - `/opt/joy-media/releases/current-api`;
  - `/opt/joy-media/web`.
- Restart only `joy-media@api.service` unless nginx configuration changed.
- Verify service state, port `8790`, direct/public health, public root, and public
  byte hashes.

### Automatic rollback

If a post-switch check fails, restore both recorded pointers, restart the API,
recheck health, record the failure, and stop before live browser testing.

### Gate

- Both live immutable releases were built from the green repair SHA.
- Health and public-byte parity are green.
- Previous releases and the new database backup remain available.

## STEP 8 — Signed-In Google Chrome Acceptance

Use the existing authenticated Chrome session and create exactly one disposable
project:

```text
WP-30 animated export repair <UTC-run-id>
```

Do not open or modify the surviving user project or manually uploaded asset.

### Actions

1. Import the committed `animated.gif` fixture under a run-unique filename.
2. Verify animation metadata and distinct preview frames.
3. Add it to the timeline through the public UI.
4. Scrub and play through at least two animation frames.
5. Export H.264/AAC MP4.
6. Capture the Chrome download.
7. Run FFprobe and deterministic decoded-frame hashing on the downloaded file.
8. Verify dimensions, duration, audio stream, and distinct output frames.
9. Refresh and re-download the retained export.
10. Confirm zero fatal console errors, page errors, and unexpected failed
    same-origin requests.

Repeat only the export/download proof at one compact viewport if the primary
Chrome run passes; the full three-viewport proof remains the deterministic CI
matrix.

### Gate

- Real signed-in Chrome produces a valid MP4 with distinct decoded animation
  frames.
- Refresh/re-download works.
- The surviving user project and upload remain byte/state unchanged.

## STEP 9 — Cleanup

- Stop or complete every disposable export.
- Permanently delete only `WP-30 animated export repair <UTC-run-id>`.
- Remove only the fixture asset and browser downloads created by this run after
  their hashes are recorded.
- Verify Trash is empty of run-created state.
- Compare project, asset, export, job, derivative, private-object, and browser-local
  counts with the baseline.
- Confirm no running or leased disposable operation remains.

### Gate

- No WP-30 repair test residue remains.
- User-owned project and manually uploaded asset are unchanged.

## STEP 10 — QA and GBrain Reconciliation

Update:

- `docs/qa/WP-30-review-log-20260811.md`;
- `plan/WP-30-asset-preview-playback-reliability.md`;
- this plan;
- any state/browser-audit document that still calls WP-30 green at SHA `43c5521`;
- GBrain pages:
  - `joy-media-state`;
  - `joy-media-wp29-first-project-golden-path`.

GBrain writes must use the supported page interface:

- CLI equivalent: `gbrain put <slug> --content ...`;
- while `gbrain serve` owns the PGLite lock, use authenticated MCP `put_page`.

For each page:

1. Fetch the complete page twice.
2. Require identical pre-write `content_hash` values.
3. Replace only the terminal WP-30 section.
4. Record the failed run, repair SHA, successful CI URL, immutable releases,
   Chrome proof, and cleanup result.
5. Write the complete page.
6. Re-fetch and verify content, new hash, and timestamp.
7. Run GBrain doctor without printing its bearer token.

Do not leave the current GBrain statement saying only that CI was still running.

### Gate

- Repository and GBrain identify the same final repair SHA and evidence.
- Both pages are hash-verified.
- No unrelated GBrain content changed.

## STEP 11 — Documentation-Only Final Commit

- Add final CI, deployment, Chrome, cleanup, and GBrain hashes to the QA documents.
- Run Markdown formatting, privacy scan, and `git diff --check`.
- Commit and push only documentation/state changes.
- Require its GitHub `check` and `browser-e2e` jobs to pass.
- Fast-forward `/opt/joy-media/repo` to the documentation SHA without redeploying
  product artifacts.

Record separately:

- `deployedProductSha = <repair SHA>`;
- `closeoutDocsSha = <documentation SHA>`.

## Final Acceptance

WP-30 is finished only when:

- the identical-frame defect is explained and regression-tested;
- focused animated export is `3/3 PASS` twice;
- cross-browser asset coverage remains `6/6 PASS`;
- full local candidate gates and GitHub CI pass;
- signed-in Chrome produces an H.264/AAC export with distinct decoded frames;
- immutable repair deployment and public-byte verification pass;
- refresh/re-download and cleanup pass;
- the user’s surviving project/upload are unchanged;
- repository QA and both GBrain pages identify the final repair SHA;
- no P0/P1, unexpected `NOT-RUN`, stale production pointer, or cleanup discrepancy
  remains.

## Execution Checklist

- [x] STEP 0 — Freeze state and preserve three-viewport failure evidence.
- [x] STEP 1 — Reproduce and prove the export branch failure.
- [x] STEP 2 — Implement the minimal renderability repair.
- [x] STEP 3 — Add unit, contract, and deterministic encoded-frame proof.
- [x] STEP 4 — Focused `3/3` export twice and `6/6` cross-browser matrix green.
- [x] STEP 5 — Full local candidate gate green.
- [x] STEP 6 — Repair commit pushed and GitHub CI green.
- [x] STEP 7 — Immutable repair deployment green.
- [x] STEP 8 — Signed-in Chrome export/FFprobe/frame-hash proof green.
- [x] STEP 9 — Disposable-state cleanup green.
- [x] STEP 10 — QA and GBrain reconciled to the repair SHA.
- [ ] STEP 11 — Documentation-only CI green.
- [ ] WP-30 marked `FINISHED` after the documentation-only workflow passes.

## Final live evidence

The signed-in Chrome run `20260812063009` completed against product SHA
`1b7e8abf27e41d132cda0714c890206400596c41`. It imported the committed animated
GIF fixture, previewed it, placed it on the timeline, exported one H.264/AAC
MP4, refreshed and re-downloaded the identical bytes, and left no console
errors or same-origin request failures. FFprobe reported 1080x1920, 30 fps,
and 1.000000 seconds; decoded frame hashes differed. The disposable project
and temporary files were removed without touching the surviving project/upload.
See `docs/qa/WP-30-final-live-closeout-20260812061237.md` for the complete
sanitized evidence and GBrain hashes.
