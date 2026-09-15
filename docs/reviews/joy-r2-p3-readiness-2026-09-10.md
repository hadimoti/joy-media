# JOY R2 P3 shipping export readiness — 2026-09-10

This bounded slice adds a real browser acceptance matrix for the five shipping Look packs in both intended export orientations. It drives the shipped `Export MP4` UI, reopens the project before export, captures the browser download, and probes the resulting MP4 bytes with `ffprobe` for container, dimensions, duration, frame count, and monotonic video PTS. Music Pulse also requires an AAC 48 kHz stream when that real audio path is available.

## Matrix

| Pack              | Portrait (`reels-1080`)                  | Landscape (`youtube-1080`)               |
| ----------------- | ---------------------------------------- | ---------------------------------------- |
| Editorial Clean   | NOT RUN — pending focused Playwright run | NOT RUN — pending focused Playwright run |
| Product Precision | NOT RUN — stopped after first case       | NOT RUN — stopped after first case       |
| Kinetic Type      | NOT RUN — pending focused Playwright run | NOT RUN — pending focused Playwright run |
| Quiet Documentary | NOT RUN — stopped after first case       | NOT RUN — stopped after first case       |
| Music Pulse       | NOT RUN — pending focused Playwright run | NOT RUN — pending focused Playwright run |

## Checks

- Focused command: `pnpm exec playwright test tests/e2e/r2-p3-shipping-export-acceptance.spec.ts --project=desktop-primary --workers=1`.
- Scoped lint: `pnpm exec eslint tests/e2e/r2-p3-shipping-export-acceptance.spec.ts`.
- Scoped format: `pnpm exec prettier --check tests/e2e/r2-p3-shipping-export-acceptance.spec.ts docs/reviews/joy-r2-p3-readiness-2026-09-10.md`.
- Each case must produce nonempty downloaded bytes, an MP4 container, the requested dimensions, positive duration, positive frame count, monotonic video PTS, and (for Music Pulse) AAC at 48 kHz. Evidence is attached by the test for each case.

## Local verification

Without JOY_P3_REAL_EXPORTS=1, the test records an explicit NOT RUN annotation so ordinary local checks do not wait four minutes per missing real export. With the opt-in set, the self-hosted runner must execute the real browser matrix. The post-hardening opt-in run also timed out waiting for the first download after 240 seconds on the local runner, even after importing and adding the local video fixture. The remaining nine cases were not run. This must be rerun on the self-hosted path with its real Worker/export services.

## Current decision

**P3 remains OPEN.** This file is a test-only readiness slice; it does not claim that the matrix passed. A later bounded run must execute the focused browser suite on a self-hosted environment and replace the NOT RUN entries with observed PASS/FAIL results. Audio/video drift, the 241-frame tooling discrepancy, cancellation/cleanup, and a reproducible gallery remain follow-up evidence until directly observed on real exported bytes.

## Regenerated v2 CI wiring

The regenerated `.github/workflows/release-candidate-v2.yml` real-service acceptance lane sets `JOY_P3_REAL_EXPORTS=1` for its full desktop matrix. The fixture-only desktop lane remains unconfigured and therefore records an explicit NOT RUN. The P3 test writes `test-output/browser/p3-export-matrix.json`; the real-service retention allowlist and successful-harness evidence contract require that file, so a green real-service pass cannot silently omit the P3 matrix. Smoke-only harness runs are exempt from this P3 evidence requirement. No legacy workflow is used.

Static validation after the wiring change: TypeScript, scoped ESLint, scoped Prettier, Node syntax check, self-hosted harness tests (20 pass / 11 platform skips), and the opt-out Playwright guard all passed. The first v2 run containing this wiring was `34522619556` on candidate `0916e02fe4b3b5d69deda36e3e6d593244ee298e`: pass 1 failed after a 240-second first-case download timeout, then nine cases hit the persisted active-project selector state; pass 2 hung for several hours and was cancelled. Its retained evidence and artifact-quota outcome are recorded in the Desktop receipt.

The matrix now navigates to the app origin before clearing `joy-media.active-project.v1` to a null selection before every case, preserving the persisted reference project while forcing each cold `/` navigation through the real Projects selector. Its download wait is aligned to the real-service harness's 35-minute Worker verification bound. These changes are statically verified but were not present in run `34522619556`; a fresh v2-only self-hosted run is required. P3 remains OPEN until that run yields a terminal ten-case PASS/FAIL/NOT RUN matrix and the plan's independent media/gallery evidence.
