# WP-30 Review Log — 2026-08-11

**Status:** In progress  
**Baseline:** `280a84575d79a2a6848cd4a25804f705afcc4c0a`  
**Live product observed:** WP-29 final release from the signed-in JOY Media session  
**Scope:** Step 0 reproduction and Step 1 animated-image metadata/decoder slice

## STEP 0 — Cross-browser reproduction

### Environment

- In-app browser: authenticated `https://joyst.ir/` session.
- Chrome: authenticated `https://joyst.ir/` session through the browser extension.
- No passwords, tokens, local filesystem paths, or personal asset bytes were recorded.
- The surviving project was opened read-only. No project mutation, upload, deletion, export, or worker/cloud job was started.

### Observed state

The in-app browser showed the owner asset view with three images and one video. The image list included:

- `3648c8ffd2.gif` — `image/gif`, cloud original;
- `multimedia-gif.webp` — `image/webp`, cloud original;
- the existing PNG upload.

Chrome initially opened a different project list, but after opening a disposable audit project and switching from the cloud bucket to **User assets**, it showed the same three images and one video. Both animated image cards had complete decoded images in Chrome:

- GIF: decoded dimensions `618 × 647`;
- WebP: decoded dimensions `128 × 122`.

Chrome reported no warning/error console entries during the comparison. The original “visible in the GPT browser but absent in Chrome” symptom did not reproduce on the current deployed candidate.

### Classification

`STEP-0: PASS — symptom not reproducible on current release.`

The evidence points to a prior browser-profile/catalog-view or cache state difference, not a current owner-catalog authorization failure. Both browsers now receive the owner catalog, and the cards resolve through local/cloud sources. The deeper parity defect remains confirmed by source inspection: timeline, sticker cache, and export previously reduced images to one decoded frame.

## STEP 1 — Fixture, metadata, and deterministic GIF slice

Implemented in the working tree:

- byte-level GIF and animated-WebP metadata inspection;
- additive animation descriptor fields in browser, API, and project-schema records;
- intrinsic animation cycle duration for newly imported animated images;
- API validation for frame count, cycle duration, loop count, and alpha metadata;
- direct `gifuct-js` dependency for deterministic GIF frame compositing;
- composited GIF frame source with timing, looping, disposal, alpha, and bounded ownership;
- Monitor/sticker bitmap time selection for decoded GIF sources;
- export frame selection for animated image descriptors and legacy GIF bytes without metadata;
- visible `Animated` card metadata.
- generated static WebP, animated GIF, animated WebP, and corrupt GIF/WebP
  fixtures with SHA-256 manifest entries and provenance in the fixture README.

### Verification

- Animated metadata tests: `4/4 PASS`.
- Animated decoder tests: `2/2 PASS`.
- Media import, resolver, and metadata regression tests: `14/14 PASS`.
- API HTTP regression tests: `18/18 PASS`.
- Fixture manifest plus committed-fixture parser tests: `8/8 PASS`.
- Editor/API/project-schema TypeScript build: `PASS`.
- Repository check: typecheck, ESLint, Prettier, and `1,921 PASS / 2 licensed skips`.
- Workspace production build: `1,303 modules transformed`, `PASS`.
- `git diff --check`: `PASS`.

### Step-1 verdict

`PASS — fixture, signature, metadata, schema, server validation, and bounded
GIF decode foundations are green.`

### Remaining Step-3/Step-4 work

- Add resource-limit fixtures and enforce decoded-byte/frame-budget rejection before catalog mutation.
- Complete deterministic animated-WebP proof. The current frame source uses a Chromium
  `ImageDecoder` capability adapter and fails closed when unavailable; it is not yet
  accepted as cross-browser parity evidence.
- Run the three-viewport Playwright matrix, signed-in disposable-project acceptance,
  export frame-hash proof, deployment, cleanup, and GBrain closeout.
- Add cache-budget/cancellation tests and full browser Monitor/export frame-hash evidence.
- Run the three-viewport Playwright matrix and signed-in disposable-project acceptance.

## Safety and cleanup

- The surviving project and manually uploaded file were not changed.
- No temporary project or asset was created by this review.
- No production files, release pointers, database rows, or GBrain pages were changed.
- Working-tree changes remain uncommitted pending the next WP-30 implementation slice.

## Verdict

WP-30 remains **IN PROGRESS**. Step 0 is closed as a non-reproduced current-release symptom; the metadata/GIF implementation slice is green; animated WebP parity, fixture/browser proof, deployment, cleanup, and closeout documentation remain open.
