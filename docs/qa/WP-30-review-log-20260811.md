# WP-30 Review Log — 2026-08-11

**Status:** Closeout evidence recorded; GBrain synchronization remains pending
**Candidate/deployed product:** `43c5521`
**API release:** `wp30-api-20260811T171706Z-43c5521`
**Editor release:** `editor-web-20260811T171706Z-43c5521-wp30`
**Scope:** WP-30 animated-media implementation, candidate gates, deployment, and signed-in smoke

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

## STEP 2 — Cross-profile catalog and original recovery smoke

Added `tests/e2e/wp30-cross-browser-assets.spec.ts`. With the isolated test API
and a fresh second browser context, the three configured desktop viewports each
passed (`3/3`, `10.4s`):

- GIF and animated WebP imported through the real media file input;
- Asset cards retained the `Animated` descriptor state and decoded previews;
- the verified preview modal opened and closed for both formats at each viewport;
- the second context discovered both owner assets from `/v1/library/my-assets`;
- animation metadata survived cloud upload/catalog refresh;
- authorized original bytes were fetched from the second context and matched
  the fixture SHA-256 and byte lengths;
- the disposable project was purged by the test cleanup path.

This is local authenticated-stack evidence, not signed-in production evidence.
The card uses the existing poster/thumbnail optimization; animated frame parity
is intentionally validated by the deterministic decoder and remains open for
Monitor/export browser proof.

### Chromium decoder proof

The same suite also exercised the browser `ImageDecoder` capability adapter at
all three viewports (`3/3 PASS`). Chromium reported four WebP frames and four
distinct RGBA frame hashes. The production adapter now awaits
`decoder.tracks.ready` before reading the selected track; this prevents a cold
decoder race where `selectedTrack` was temporarily undefined.
The decoder also revalidates frame-count, cycle-duration, and decoded-memory
budgets immediately before parsing/allocating frames; the over-budget contract
test passes (`4/4` decoder tests).

### Timeline placement regression

The Assets-panel path previously accepted an animated descriptor from the
catalog but reconstructed the project asset descriptor without its
`animation` field. That caused a placed GIF/WebP to lose its intrinsic cycle
and fall back to the five-second still-image duration. The project-import
bridge now preserves the descriptor end to end. The browser suite places the
run-unique animated GIF through the public **Add to timeline** button and
asserts the resulting clip advertises the fixture’s `1.0s` cycle at all three
viewports. The full matrix completed `6/6 PASS` in `14.2s` with no retained
page-error or same-origin-request failure. Disposable projects and their
fixture assets were purged by the test cleanup path.

### Step-3 cache ownership slice

`StickerImageCache` now uses a per-object generation token. Clearing or
replacing an object invalidates in-flight blob/decoder work, stale completions
cannot publish into the cache, and replaced animated sources are disposed
before their entry is swapped. Focused ownership/cancellation coverage is
`2/2 PASS`; the editor TypeScript build and `git diff --check` are also green.
The complete normalized-manifest, eviction-budget, and Monitor/export frame
hash gate remains open under Steps 3–6.

The cache now also enforces a `256 MiB` decoded-frame budget with
least-recently-used eviction. Focused ownership/budget coverage is `3/3 PASS`
after the addition; the complete browser resource-counter and frame-hash gate
is still open.

### Timeline/export browser proof

Added `tests/e2e/wp30-animated-timeline-export.spec.ts`. The three-viewport
run combined with the cross-profile suite completed `9/9 PASS` in `23.8s`:

- a run-unique animated GIF was imported through the public UI and placed on
  the timeline;
- the resulting clip retained its `1.0s` authored cycle;
- Export MP4 produced a non-empty browser download;
- `ffprobe` verified H.264 video, AAC audio, and a positive duration;
- `ffmpeg` frame-MD5 samples at `0s` and `0.3s` were distinct, proving the
  exported animation was not frozen;
- the test cleanup purged the disposable project and fixture asset.

This is isolated local authenticated-stack evidence. Signed-in production
deployment and cleanup are now covered below; OPFS corruption injection remains
covered by the focused cache/recovery contracts rather than a destructive live
mutation.

### Candidate gate

`pnpm verify:ci` passed on the candidate after the export regression was added:

- `267` test files passed, `1` licensed test file skipped;
- `1,926` tests passed, `2` licensed skips;
- all workspace TypeScript builds passed;
- editor production build transformed `1,303` modules;
- production dependency audit reported no known vulnerabilities.

The combined WP-30 browser suite is `9/9 PASS` across the three configured
desktop viewports. The candidate was then deployed immutably and verified by
the signed-in smoke below.

### Deployment and signed-in production smoke

- VPS repository was fast-forwarded to `43c5521`; the worktree and all three refs
  (`HEAD`, `origin/main`, and `vps-local/main`) were clean and equal before the
  switch.
- PostgreSQL backup: `/opt/joy-media/data/backups/joymedia-pre-wp30-20260811T171614Z.sql.gz`.
  SHA-256: `b0778b6befdfb2a217f39261a6efa991247d779ba14309c1ab4cc5e3ba3a6d26`.
  The backup was readable and the schema-only dump check passed.
- Staged API health passed on the isolated port, then the managed API/editor
  pointers were switched atomically. `joy-media@api.service`, nginx syntax,
  direct health, and public health all passed.
- Public `index.html` SHA-256 matched the immutable editor release:
  `45fc985794d117f1dfbde8ccb67e55afd872bbaf6207a2bd1aa451c50f198f50`.
  Public entry `/assets/index-jToF84lE.js` matched release SHA-256
  `68e001b2fabb424ebf9bdbd612b38b4e04de328561516b4d1d3a36895d7d8fe6`.
- In the signed-in in-app browser, the existing owner project was inspected
  read-only with zero warning/error logs. Aspect-ratio options exposed Fit,
  16:9, 4:3, 3:2, 21:9, 1:1, 9:16, 4:5, 3:4, and 2:3; Speed was present;
  the timeline context menu exposed Reverse and Set playback rate.
- Disposable project `WP-30 live 20260811-1722` was created only after the
  release reload. `animated.gif` imported with visible `Animated` metadata,
  placed at the authored `1.0s` cycle, exported successfully, and appeared in
  Recent processes with a retained MP4 download link. The project was moved to
  Trash and permanently deleted; Trash was verified empty. No surviving project
  or manually uploaded asset was changed. Final live console/error log count:
  `0`.
- A fresh Chrome-only pass was then run through the existing signed-in Chrome
  session. Chrome switched to **User assets**, listed the owner GIF
  `3648c8ffd2.gif`, opened its verified local-copy preview, and closed the
  preview cleanly. No Chrome warning/error logs were captured. The surviving
  project was not opened or mutated in this pass.
- The in-app browser download-event hook did not observe the later blob-link
  click within 15 seconds, although the retained link had the correct MP4
  filename and `download` attribute. Local Playwright/ffprobe evidence remains
  the authoritative byte-level download proof; this is recorded as a browser
  harness limitation, not a product failure.

### Closeout limitations

- GBrain MCP write tools were not available in this execution context, so the
  two authoritative GBrain pages were not modified. The documentation commit
  records this explicitly; WP-30 must not be described as fully synchronized
  until those pages are updated and hash-verified.

## Safety and cleanup

- The surviving project and manually uploaded file were not changed.
- Two disposable smoke projects were created during the live verification; both
  were permanently deleted, and Trash was empty at the end.
- Product deployment changed only the managed immutable release pointers; the
  previous API/editor releases and the database backup remain available for
  rollback.
- No GBrain page was changed because the required MCP write capability was not
  present.

## Verdict

WP-30 product implementation, candidate CI, immutable deployment, signed-in
animated import/timeline/export smoke, and disposable-state cleanup are green.
The package remains **OPEN FOR GBrain SYNCHRONIZATION** until the two GBrain
pages are updated and hash-verified. The deployed product SHA is `43c5521`.
