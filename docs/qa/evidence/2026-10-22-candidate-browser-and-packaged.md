# Candidate evidence: browser suites and packaged desktop (2026-10-22)

Not a release receipt. No CI was dispatched and nothing was pushed. The release gate still needs a
candidate-bound receipt from the owner-authorized workflow.

## Code under test

- Product code: `7b1ba791` (bridge, silent-video export, staged-export library filter).
- Later test-only commit: `3007963c` (stock-video fixture declaration and failure message).

## Packaged desktop (hidden desktop, `playwright.desktop.config.ts`, retries 0)

Built from `7b1ba791`: editor-web and desktop packages rebuilt, then `package-release.mjs --unpacked`.

- `editor-acceptance`, `export-semantics`, `fresh-profile`, `joy-code-panel`, `local-worker-route`,
  `menu-actions`, `menu-panels`, `missing-media`, `project-package-integrity`: **30 passed**.
- `missing-media` includes the four silent-video export cases and the thumbnail bridge (11/11).

## Browser suites (`playwright.config.ts`, seven viewport projects, retries 0)

Run on `7b1ba791`: **851 passed, 3 failed, 7 skipped** (861 cases).

- Skipped (7, one per viewport): `R5 CASE-66`, declared integration-blocked. It needs an independent
  Worker with `audio.ml-denoise` and its model runtime.
- Failed, `stock-video-ui.spec.ts` (2 cases, desktop-1581 and desktop-1920): the stock fixture's
  cloud-original 409 was not declared. Fixed in `3007963c`. Repeat runs on three viewports after the
  fix: 9/9 passed.
- Failed, `agent-director-runtime.spec.ts` "cancellation rejects a delayed provider reply" (1 case,
  desktop-1920): an exact expected-miss count of 2 for the original-asset read and the cloud-content
  read observed 1. Open, not changed. Earlier, the same test failed once in the all-projects run
  (desktop-1581) and passed 5/5 in isolation. The cancellation assertions themselves passed each
  time. The count is a layout and timing dependency on optional reads. Making it a range would
  weaken the test, so it is left for an owner decision.

New browser coverage: `tests/e2e/silent-video-export.spec.ts` (silent, sound, mixed), 21/21 across the
seven viewports in the all-projects run.

## Unit suites (run on `7b1ba791`)

- Desktop vitest: 21 files, 174 tests passed.
- Editor-web vitest: 306 files, 1,898 tests passed.
- ESLint and `tsc --noEmit` clean on touched files.

## Open items

1. Live Director cancellation count (above). Owner decision needed.
2. Real-service account acceptance has not run. It needs isolated PostgreSQL and S3-compatible storage,
   a test mailbox for one-time codes, and sandbox billing. No production accounts or credentials.
3. Fullscreen: native host toggle is covered packaged (`menu-actions`). The renderer Fullscreen API does
   not settle on the hidden desktop. A visible check needs owner approval.
4. Worker source limit (512 MiB, whole-file buffering on both sides). Streaming proposal pending.
5. Candidate-bound release receipt: requires CI dispatch, which needs owner approval.
