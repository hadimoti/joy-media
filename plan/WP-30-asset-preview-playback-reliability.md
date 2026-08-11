# WP-30 — Cross-Browser Asset Preview and Animated-Media Reliability

**Status:** In progress — local decoder/cache, timeline/export, and CI gates green; live recovery/deployment/closeout remain open
**Priority:** P1  
**Baseline:** `280a84575d79a2a6848cd4a25804f705afcc4c0a`  
**Repository:** `/opt/joy-media/repo`  
**Production root:** `/opt/joy-media`  
**Depends on:** WP-29 finished and deployed  
**Primary result:** An uploaded image or animation is visible and usable in every authenticated JOY Media browser, and animated GIF/WebP media plays consistently in the Asset Library, Program Monitor, timeline, and export.

## Summary

WP-30 closes the asset-preview gap observed when a GIF uploaded in the GPT in-app browser appeared there but not in Chrome. It also fixes the deeper animated-media limitation: GIF and WebP originals can currently reach a native `<img>` preview, but the timeline, sticker cache, and export paths decode only one frame.

This work package makes private cloud storage the durable owner-visible source, treats OPFS as a verified browser cache, records animation timing metadata, and introduces one deterministic animated-image frame source shared by preview, timeline playback, Program Monitor, and export.

WP-30 is intentionally narrower than another broad application audit. It must finish one end-to-end path:

> Import in browser A → discover and preview in browser B → place on timeline → play, pause, seek, loop, speed/reverse/freeze → export the same animation → refresh and recover.

## Confirmed Baseline Gaps

The implementation starts from these repository facts:

- `media-import.ts` accepts GIF and WebP but `describeImage()` uses `createImageBitmap()` and records only dimensions.
- `AssetLibraryPanel.tsx` renders images with a native `<img>`, so a valid local/cloud object URL may animate in one browser.
- `timeline-media-import.ts` treats every image as a five-second still when no duration is available.
- `App.tsx` export uses a single decoded still frame for every `image` asset.
- `sticker-image-cache.ts` converts an image to one RGBA bitmap and therefore freezes animated sources.
- `AssetDescriptorV1` and `BrowserMediaDescriptor` have no animation cycle, frame-count, or loop metadata.
- Owner assets are fetched through `GET /v1/library/my-assets`, and previews already prefer derivative → OPFS original → authorized cloud original. The missing behavior must therefore be classified as catalog, authorization/fetch, or decode failure instead of being reported as one generic blank thumbnail.
- The committed browser fixture pack contains no static WebP, animated GIF, or animated WebP proof asset.

## Product Decisions

These decisions are part of WP-30 and must not be re-designed during implementation without updating this plan.

1. **Private cloud is durable; OPFS is a cache.** A successfully cloud-backed owner asset must be discoverable from a fresh authenticated browser profile. Local-only assets are explicitly labeled and never presented as cross-browser safe.
2. **Animation metadata is intrinsic media metadata.** Store one animation cycle duration, frame count, and loop count. Do not store full decoded frames inside the project JSON.
3. **Timeline duration is authored separately from animation cycle duration.** A newly placed animated image defaults to one full animation cycle. Extending the clip repeats the cycle; trimming selects a smaller authored window.
4. **Loop count describes the source, not the timeline.** `0` means the source declares infinite looping. Timeline playback still ends at the clip’s authored duration.
5. **One frame-selection function is authoritative.** Program Monitor and export must select the same frame for the same asset time, playback rate, reverse state, and freeze state.
6. **Static images keep existing behavior.** PNG, JPEG, and non-animated WebP default to a five-second still and must not pay the animated-decoder cost.
7. **Animation decoding is bounded.** Validate dimensions, frame count, total decoded bytes, cycle duration, and individual frame delays before catalog mutation. Reject unsafe inputs with actionable feedback.
8. **Native `<img>` is an optimization, not proof of parity.** Asset cards may use native animation, but timeline/export acceptance is based on the deterministic decoder.
9. **Reduced motion is respected in browsing UI.** With `prefers-reduced-motion`, cards show a poster unless the user starts preview. Timeline and authored export remain unchanged.
10. **No account-wide asset is deleted during testing.** Live acceptance uses one run-unique disposable project and run-unique fixture copies.

## Scope

### In scope

- Static PNG/JPEG/WebP and animated GIF/WebP import classification.
- Cross-browser owner catalog synchronization and authorized original rehydration.
- Asset-card and modal-preview status, animation, retry, and error states.
- Animated-image metadata, timing, frame selection, cache, and cancellation.
- Timeline placement, scrub, playback, pause, loop, trim, speed, reverse, and freeze.
- Program Monitor and export visual parity.
- Alpha compositing into the authored composition.
- Three desktop viewport browser coverage and two isolated authenticated browser profiles.
- Offline/cache behavior, owner isolation, reload recovery, cleanup, deployment, QA, and GBrain reconciliation.

### Out of scope

- SVG animation, APNG, animated AVIF, Lottie, and HTML scenes.
- Editing individual GIF/WebP frames or source loop metadata.
- Preserving alpha in the final H.264 export container; alpha is composited over the project background.
- New paid Cloud or licensed Worker operations.
- Reverse-audio preview parity, which remains the disclosed WP-29 limitation for audible video clips.
- A redesign of the complete Asset Library.

## Data and Interface Changes

### Media descriptor

Extend the shared browser/server/project descriptor with optional animation metadata:

```ts
interface AnimationDescriptorV1 {
  readonly frameCount: number;
  readonly cycleDurationUs: number;
  /** 0 means infinite; a positive number is the source-declared cycle count. */
  readonly loopCount: number;
  readonly hasAlpha: boolean;
}

interface AssetDescriptorV1 {
  readonly mimeType: string;
  readonly durationUs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly animation?: AnimationDescriptorV1;
}
```

Rules:

- `durationUs` remains the intrinsic playable duration for timed audio/video.
- `animation.cycleDurationUs` is the duration of one animation cycle.
- Absence of `animation` means static image behavior.
- Migration is additive and old assets remain valid.
- Server validation rejects impossible or unbounded metadata.
- The server does not trust browser-provided metadata without validating the original bytes or a verified derivative receipt.

### Normalized animation manifest

Do not place per-frame pixel data in catalog or project JSON. Store a versioned, content-addressed manifest in the browser cache and, when generated server-side, as an authorized derivative. It contains:

- source asset ID and SHA-256;
- decoder/profile version;
- canvas dimensions and alpha flag;
- frame start/end times;
- disposal/blend semantics normalized to composited frames;
- verified byte counts and manifest SHA-256.

The manifest profile must change whenever timing, disposal, or decoder semantics change.

### Catalog synchronization

On Asset Library open and explicit refresh:

1. Fetch owner assets and shared assets.
2. Merge by owner/project/asset ID, never by display name.
3. Preserve server descriptor, SHA-256, byte size, cloud-backed state, and updated revision.
4. Reconcile the local catalog without deleting valid local-only entries.
5. Mark local-only entries as **This browser only**.
6. Mark uploaded-but-unconfirmed entries as **Backup incomplete**.
7. Make a cloud-backed asset immediately eligible for OPFS rehydration in a fresh profile.
8. Use `BroadcastChannel` or the existing local change signal for same-profile tabs; use server refresh/revision for cross-browser discovery.

## Decoder and Rendering Architecture

Introduce a small shared animation subsystem rather than adding special cases throughout `App.tsx`.

### Required interfaces

```ts
interface AnimatedImageSource {
  readonly descriptor: AnimationDescriptorV1;
  frameAt(timeUs: number, signal?: AbortSignal): Promise<AnimatedImageFrame>;
  poster(signal?: AbortSignal): Promise<AnimatedImageFrame>;
  dispose(): void;
}

interface AnimatedImageFrame {
  readonly startUs: number;
  readonly endUs: number;
  readonly image: ImageBitmap;
}
```

### Decode strategy

1. Sniff the file signature; never rely only on extension or declared MIME.
2. Use a worker-owned deterministic decoder so parsing and frame compositing do not block the UI thread.
3. Reuse a reviewed GIF parser already present through the renderer dependency only if its license, bundling, disposal behavior, and security limits are verified; otherwise add an explicit direct dependency.
4. Use `ImageDecoder` only behind a capability adapter and parity tests. It cannot be the sole implementation.
5. Add equivalent animated-WebP decoding. If the reviewed browser decoder cannot provide deterministic animated WebP frames, generate a verified normalized derivative through the local API/Worker path and keep the original available for card preview. Do not silently freeze the first frame.
6. Composite disposal/blend operations into deterministic RGBA frames.
7. Cache decoded frames with an LRU byte budget and per-asset limit.
8. Cancel pending work when a card leaves the viewport, the selected asset changes, playback seeks again, or export is cancelled.
9. Close `ImageBitmap` objects and revoke object URLs during eviction/disposal.

### Authoritative time mapping

For an animated image clip:

- Map project playhead to clip-local authored time.
- Apply trim/source offset and positive playback rate.
- Apply reverse using the same endpoint convention as video clips.
- Freeze resolves one exact frame and holds it.
- Otherwise select `cycleTimeUs = sourceTimeUs mod cycleDurationUs`.
- Resolve zero/very-small source delays to the documented safe minimum during parsing, not ad hoc during playback.
- At a frame boundary, use half-open intervals `[startUs, endUs)` so Monitor and export cannot disagree by one frame.

## UI Requirements

### Asset cards and preview

- Show **Animated** on confirmed animated GIF/WebP assets and **Static** only in details, not as noisy card chrome.
- Show the source state: **Cloud**, **Local cache**, **This browser only**, or **Backup incomplete**.
- Preserve card dimensions while loading; no grid reflow or clipped controls.
- Pause native animated previews when offscreen.
- With reduced motion, show the poster and an explicit Play preview control.
- Use distinct actionable errors:
  - sign-in/authorization expired;
  - cloud original missing;
  - local cache corrupt and cloud recovery failed;
  - unsupported/corrupt animation;
  - decoder resource limit exceeded.
- Provide Retry preview and Refresh library actions where recovery is possible.
- Never leave only a checkerboard or spinner after a terminal error.

### Timeline and Program Monitor

- Animated assets are visibly distinguished from still images.
- Placement uses the natural cycle duration and real dimensions.
- Scrubbing selects the correct deterministic frame.
- Space pauses on the exact frame and resumes from it.
- Composition end continues to use the verified WP-29 loop behavior.
- Speed presets, manual rate, reverse, and freeze operate consistently.
- Fit-to-width and effective-duration logic include the authored animation clip duration.
- Program Monitor preserves alpha compositing, aspect-ratio selection, and nested-compound behavior.

### Export

- Sample the deterministic animated frame at each export timestamp.
- Do not call the existing one-frame still decoder for an animated descriptor.
- Composite alpha into the authored scene before H.264 encoding.
- Preserve the selected aspect-ratio dimensions.
- Cancellation releases decoder workers, frames, object URLs, and partial export state.
- Refresh/retry/re-download behavior remains governed by the WP-29 export ledger.

## Security and Resource Limits

Define and test explicit defaults, configurable only through reviewed constants:

- maximum original bytes;
- maximum width, height, and total pixels;
- maximum frame count;
- maximum cycle duration;
- minimum normalized frame delay;
- maximum decoded bytes per asset;
- global animation-frame cache budget;
- maximum concurrent decoders.

Reject malformed/truncated files and decompression bombs before registering an asset. Authorization remains owner/project scoped. A second test account must receive no catalog entry and no bytes for another owner’s private asset.

## Implementation Loop

For each step below:

1. Record SHA, timestamp, and clean-tree state.
2. Implement only that step.
3. Run its focused tests and affected typecheck/build.
4. Review error, cancellation, persistence, and cleanup paths.
5. Append the verdict to `docs/qa/WP-30-review-log-<run-id>.md`.
6. Commit and push only after the step gate passes.
7. If a regression appears, reproduce once, repair it with a focused test, and repeat the current gate before continuing.

## STEP 0 — Reproduce and Classify the Existing Failure

Using the same signed-in account but two isolated browser profiles:

- Record Chrome/in-app browser versions, viewport, asset ID, MIME, SHA, cloud-backed flag, and project context without exposing personal paths.
- Import one run-unique animated GIF in profile A.
- Refresh the library in profile B.
- Determine separately whether profile B fails at:
  1. owner catalog discovery;
  2. project/local catalog merge;
  3. authorized original fetch;
  4. OPFS recovery;
  5. native image decode/render.
- Capture sanitized console, page errors, same-origin request failures/statuses, and card state.
- Repeat once from a fresh profile.

### Gate

The defect has a reproducible category and evidence. No product change is made before this classification.

## STEP 1 — Deterministic Fixture and Metadata Foundation

Add generated, redistributable fixtures with manifest SHA-256, byte count, dimensions, frame count, cycle duration, alpha, loop count, generator version, and license/provenance:

- static WebP;
- animated GIF with at least four visually distinct frames;
- transparent animated GIF with disposal changes;
- finite-loop animated GIF;
- infinite-loop animated GIF;
- animated WebP with distinct frames and alpha;
- truncated/corrupt GIF and WebP;
- oversized/resource-limit headers that are safe to keep in Git.

Implement signature sniffing, metadata extraction, schema migration, server validation, and round-trip persistence.

### Gate

- Static and animated formats classify correctly.
- Corrupt/unsafe inputs create no catalog or cloud record.
- Metadata survives API, project persistence, refresh, and duplication.
- Old projects/assets migrate without mutation or data loss.

## STEP 2 — Cross-Browser Catalog and Original Recovery

- Make the owner catalog/revision authoritative for cloud-backed assets.
- Reconcile it into each browser’s Asset Library state.
- Distinguish cloud-backed, cache-only, and incomplete-backup states.
- Rehydrate a verified OPFS original from authorized private cloud bytes when the local cache is absent or corrupt.
- Validate SHA-256 and byte length before publishing the recovered cache entry.
- Deduplicate concurrent refresh/resolve requests.
- Add retry and explicit auth/missing/corrupt errors.

### Gate

An asset imported and cloud-confirmed in profile A appears and previews in a clean profile B after refresh, with zero dependence on profile A’s OPFS/localStorage.

### Step-2 execution result

PASS on the isolated authenticated stack. The three-viewport suite now also
places the imported animated GIF through the public Asset Library **Add to
timeline** action and verifies its one-second authored cycle in the timeline,
so the animation descriptor is retained when the asset moves from catalog into
project JSON. The stronger OPFS-delete/corruption recovery and signed-in live
deployment gates remain part of Steps 7–9.

## STEP 3 — Animated Decoder and Cache

- Implement the worker-owned decoder abstraction and normalized manifest.
- Normalize GIF/WebP timing, loop, alpha, and disposal semantics.
- Implement deterministic `frameAt()` and poster selection.
- Add bounded LRU caching, request deduplication, cancellation, and disposal.
- Instrument decode duration, cache hit/miss, evictions, and rejected resource-limit inputs without logging user filenames or bytes.

### Gate

Known timestamps produce expected frame hashes for every fixture, including boundary, loop, alpha, cancellation, and eviction cases.

## STEP 4 — Asset Library Preview UX

- Wire catalog state, preview source, animated badge, native optimization, deterministic fallback, reduced-motion behavior, and actionable errors.
- Keep only visible/selected cards active.
- Add keyboard-accessible Play/Pause preview and Retry actions.
- Preserve card selection and layout during refresh/recovery.

### Gate

Static and animated cards/modal previews work at all three viewports with no layout shift, blank terminal state, focus loss, or leaked object URL/decoder.

## STEP 5 — Timeline and Program Monitor Parity

- Place animated assets with natural cycle duration.
- Use the shared time mapper for scrub, play, pause, seek, rate, reverse, and freeze.
- Render frames through Program Monitor without the still-image cache path.
- Preserve transform/effects, alpha, aspect ratio, audio state, nested-compound projection, Undo/Redo, and refresh persistence.
- Keep playback-loop, Space-key race protection, fit-to-width, effective duration, page following, and sticky headers green.

### Gate

For selected checkpoints, the Program Monitor frame hash equals the decoder’s expected frame hash. Playback reaches the clip end, loops only according to the timeline/composition rules, pauses exactly, and resumes without a stale-load restart.

## STEP 6 — Export Parity

- Replace the animated-image one-frame export path with the shared frame selector.
- Verify compositing and selected dimensions.
- Prove cancellation/retry/re-download do not leak or duplicate decoder/export state.
- Keep static-image export unchanged.

### Gate

Exported MP4 is H.264/AAC, has expected dimensions and duration within one frame, and extracted video-frame hashes at selected timestamps prove that the animation is not frozen and matches Program Monitor output.

## STEP 7 — Browser, Accessibility, and Performance Matrix

Add a dedicated Playwright suite, for example:

```text
tests/e2e/wp30-cross-browser-assets.spec.ts
tests/e2e/wp30-animated-timeline-export.spec.ts
tests/e2e/wp30-asset-preview-a11y.spec.ts
```

Run at:

- `1639 × 1066`;
- `1366 × 768`;
- `1024 × 768`.

Use two isolated authenticated contexts to model the in-app browser and Chrome. Include:

- import in A, discover/preview in B;
- fresh-profile cloud rehydration;
- same-profile tab refresh notification;
- static WebP and animated GIF/WebP;
- card and modal frame changes;
- real timeline drag/drop and Add action;
- scrub, Space pause/resume, loop, rate, reverse, freeze;
- aspect ratio, compound timeline, and fit/follow regressions;
- export/download/frame-hash proof;
- reload and no duplicate catalog/timeline entry;
- cached offline preview and uncached offline error;
- corrupt cache self-heal;
- second-account owner isolation;
- reduced-motion and keyboard/focus behavior;
- no ErrorBoundary, page overflow, page error, unexpected console error, or failed same-origin request.

Performance evidence must record:

- first poster and first animated frame latency;
- main-thread long tasks;
- decoder worker CPU time;
- peak/cache decoded bytes;
- object URL and bitmap counts before/after cleanup;
- dropped/presentation frame rate during one controlled playback run.

### Gate

All functional and UI/accessibility cases pass at all viewports. Resource use stays within documented budgets and returns to baseline after closing previews/project.

## STEP 8 — Signed-In Live Acceptance and Cleanup

After candidate CI is green, deploy immutable API/editor releases from the same SHA using the established `/opt/joy-media` backup, health-check, byte-verification, and automatic rollback procedure.

Create exactly one disposable project:

```text
WP-30 animated asset <UTC-run-id>
```

Live flow:

1. Import run-unique animated GIF and WebP fixture copies in browser A.
2. Confirm cloud backup completes.
3. Open browser B with an empty local cache and refresh.
4. Confirm both assets appear and animate.
5. Place, scrub, play, pause, resume, speed, reverse, freeze, and loop.
6. Export and verify frame changes, dimensions, codec, and duration.
7. Refresh and confirm catalog, timeline, and re-download persistence.
8. Remove only run-created assets/project/exports/downloads.
9. Compare project, asset, derivative, private-object, job, and export counts with baseline.

Do not touch the user’s surviving project or manually uploaded file.

### Gate

Cross-browser live parity passes, public bytes match the immutable release, and all disposable state is removed without a count discrepancy.

## STEP 9 — QA, State, and GBrain Closeout

Create:

```text
docs/qa/WP-30-asset-preview-playback-<run-id>.md
docs/qa/WP-30-review-log-<run-id>.md
```

Update:

- `STATE.md`;
- this plan’s checklist/status;
- linked asset/browser audit documents;
- `joy-media-state` GBrain page;
- a dedicated WP-30 GBrain page only if one already exists or is explicitly approved.

Record:

- final product SHA and documentation SHA;
- GitHub workflow URLs and totals;
- immutable release names and rollback pointers;
- database backup hash when a server schema migration is deployed;
- two-profile/three-viewport results;
- fixture hashes and frame-hash comparisons;
- public asset hashes;
- performance/resource results;
- cleanup comparison;
- remaining documented limitations.

Use GBrain whole-page hash guards: fetch, re-fetch, compare `content_hash`, update only the terminal WP-30 section, write, re-fetch, verify, and run doctor. Never print its token.

## Test Commands

The final candidate gate must include:

```bash
pnpm install --frozen-lockfile
pnpm verify:ci
pnpm run test:e2e:audit
pnpm exec playwright test \
  tests/e2e/wp30-cross-browser-assets.spec.ts \
  tests/e2e/wp30-animated-timeline-export.spec.ts \
  tests/e2e/wp30-asset-preview-a11y.spec.ts \
  --project=desktop-primary \
  --project=desktop-compact \
  --project=desktop-minimum \
  --workers=1
```

Also run focused package tests for schema, media import/sniffing, control-plane catalog/API, project media resolver, animation decoder/cache, timeline mapping, renderer, and export.

## Likely Implementation Surfaces

This is a routing guide, not permission for broad rewrites:

- `apps/editor-web/src/media-import.ts`
- `apps/editor-web/src/AssetLibraryPanel.tsx`
- `apps/editor-web/src/asset-library-state.ts`
- `apps/editor-web/src/asset-card-preview.ts`
- `apps/editor-web/src/project-media-resolver.ts`
- `apps/editor-web/src/timeline-media-import.ts`
- `apps/editor-web/src/sticker-image-cache.ts`
- `apps/editor-web/src/App.tsx`
- `apps/editor-web/src/control-plane-client.ts`
- `apps/api/src/http-server.ts`
- `apps/api/src/control-plane.ts`
- `apps/api/src/postgres-control-plane.ts`
- `packages/project-schema/src/v1.ts`
- `packages/renderer-pixi/src/`
- `packages/test-fixtures/media/`
- `tooling/generate-media-fixtures.mjs`
- `tests/e2e/`

## Rollback

- Use additive database/schema changes only.
- Take and verify a database backup before any production migration.
- Build API and editor from one approved SHA into immutable release directories.
- Switch only `/opt/joy-media/releases/current-api` and `/opt/joy-media/web`.
- If health, public-byte, signed-in preview, or owner-isolation checks fail, restore both previous pointers, restart the API, verify health/public bytes, record the failure, and stop.
- Do not edit immutable release artifacts or the live target directly.

## Final Acceptance

WP-30 is finished only when all of the following are true:

- A cloud-backed GIF/WebP imported in one authenticated browser appears in a fresh second browser after refresh.
- OPFS deletion/corruption in the second browser rehydrates verified authorized bytes from private cloud.
- Static WebP remains static and animated GIF/WebP visibly change frames in cards and preview.
- Timeline/Program Monitor frame selection matches deterministic fixture hashes while scrubbing and playing.
- Space pause/resume, composition loop, rate, reverse, and freeze behave correctly.
- Exported H.264/AAC output changes frames at the expected timestamps and matches Program Monitor compositing.
- Static images and existing video/audio workflows do not regress.
- Owner isolation prevents another account from discovering or fetching private assets.
- All three viewports pass with no overflow, inaccessible control, ErrorBoundary, page error, unexpected console error, or failed same-origin request.
- Decoder/cache resource limits are enforced and cleanup returns resource counts to baseline.
- CI, immutable deployment, public-byte verification, live acceptance, and cleanup all pass.
- QA and GBrain identify the final SHA and consistently say `WP-30 FINISHED`.
- No P0/P1, `NOT-RUN`, unapproved blocker, stale release pointer, or cleanup discrepancy remains.

## Execution Checklist

- [x] STEP 0 — Existing failure classified in two browser profiles.
- [x] STEP 1 — Fixtures, sniffing, metadata, migration, and validation green.
- [x] STEP 2 — Cross-browser catalog and cloud recovery green.
- [ ] STEP 3 — Deterministic decoder/cache green.
- [ ] STEP 4 — Asset Library preview UX green.
- [ ] STEP 5 — Timeline and Program Monitor parity green.
- [x] STEP 6 — Local animated timeline/export parity and frame-hash proof green; live deployment proof remains open.
- [ ] STEP 7 — Two-profile, three-viewport browser/performance matrix green.
- [ ] STEP 8 — Immutable deployment, signed-in live acceptance, and cleanup green.
- [ ] STEP 9 — QA, state, GBrain, and documentation CI green.
- [ ] WP-30 marked `FINISHED` only after every item above passes.
