# WP-29 — First Project Golden Path and Real-Media Reliability

**Status:** In progress — reliability hardening and browser safety smoke implemented; signed-in 100-case closure pending
**Priority:** P1 product reliability  
**Depends on:** WP-27 audit remediation and WP-28 project lifecycle, both live  
**Primary result:** A fresh signed-in user can create a project, import their own
media, make a basic edit, add captions, apply worker-independent audio cleanup,
export a verified MP4, refresh, and re-download it in under five minutes.

## Summary

JOY Media has broad editing capability, but the first-project path is not yet a
verified vertical slice. The 2026-08-09 Chrome audit recorded 57 functional
passes, six P1 failures that were subsequently fixed, and 37 scenarios that
could not be exercised. Repository review found a more fundamental gap behind
several of those unknowns: imported originals are persisted to OPFS and private
cloud storage, but Timeline playback and Export still convert every asset ID to
`/media/reference/<assetId>.mp4`. Arbitrary imported assets therefore do not
share the proven playback/export path used by the three bundled reference clips.

WP-29 closes that seam first. It then makes import and placement one action,
provides a compact first-project guide, connects captions and audio to the user's
actual bytes, hardens Worker execution, makes export project-scoped and
recoverable, adds a real Chrome E2E harness, and reruns the 37 unexecuted audit
cases.

This milestone does not add another large editor panel. It connects and proves
the capabilities already visible in the product.

## Current implementation evidence (2026-08-09)

The first vertical slice is implemented in the working tree:

- Project-scoped media resolution prefers verified OPFS originals, falls back to
  the owner-authorized private-original endpoint, and only permits the three
  seeded reference IDs to use `/media/reference/*.mp4`.
- Import metadata (kind, MIME, duration, dimensions, byte count, and SHA-256)
  is persisted in the creative document. Timeline file drops consume files
  directly, library cards have an explicit Add to timeline action, and placement
  preserves descriptor duration while creating the render binding.
- Program Monitor, transcription, and export use the same resolver. Export uses
  content bounds, includes all timeline video clips and transition partners,
  slices audio to source in/out, applies the authored offline mix once, and
  keeps completed output in a bounded OPFS cache for reload re-download. Image
  assets are decoded to hold frames, and the recorder now has codec/storage
  preflight, AbortSignal cancellation, and same-ID retryable history entries.
- Audio runtime status is read from the control plane rather than hard-coded;
  Browser DSP is exposed only when clips exist and an execution callback is
  available. The RNNoise integration test is explicitly skipped unless a
  provisioned model exists, so normal CI is hermetic.

The first reliability hardening slice is now implemented in the working tree.
The remaining closeout work is live evidence rather than an unverified claim:
the authenticated 37-case rerun, real Worker pairing/result insertion, and
browser-level post-encode ffprobe evidence still require a disposable signed-in
run. The implementation deliberately keeps those rows open until they are
observed and recorded.

## 2026-08-10 implementation evidence

- Added project-scoped logical operation records with fingerprint conflict
  detection, attempt/retry tracking, terminal status, and purge cleanup. Export
  records now reuse the same logical ID on explicit retry.
- Recovery warnings are retained by `EditorSession` and surfaced as an
  actionable toast instead of being discarded during snapshot recovery.
- Added generated, checksum-pinned PNG/JPEG, H.264/AAC MP4, WAV, MP3, SRT,
  WebVTT, invalid, and corrupt fixtures with MIME/duration/dimensions/audio
  metadata in `packages/test-fixtures/media/`.
- Added Playwright projects for 1639×1066, 1366×768, and 1024×768 with
  console/pageerror/request-failure, overflow, and Axe assertions. The login
  safety smoke passes at all three viewports; it does not impersonate a
  production identity.
- Worker ML capability advertisement is now fail-closed on an actually
  runnable custom command or reviewed RNNoise model. Long-running ML commands
  are cancellable and the daemon sends independent keepalives and terminal
  failure reports. Pairing now polls until approval/expiry.
- Verification on this candidate: `pnpm typecheck`, `pnpm lint`, `pnpm build`,
  `pnpm audit:prod`, full Vitest (`232 files; 1,722 passed; 2 skipped`), and
  `pnpm test:e2e` (`3 passed`). The repository-wide Prettier check still reports
  81 pre-existing files outside this slice; changed files are formatted.
- Signed-in live smoke after deployment verified the project action menu
  (Rename, Duplicate, Move to Trash, Escape dismissal) and Audio Studio at
  1639×1066, 1366×768, and 1024×768. Project selector widths had no overflow;
  Audio runtime cards measured equal `40.9018px` heights at primary/minimum
  widths; the live browser emitted no warning/error logs. No destructive action
  was submitted.

## Success metric

Starting from the Projects page in a fresh authenticated browser profile, a user
must be able to complete this journey without entering an opaque asset ID,
installing an ML model, pairing a Worker, or opening Diagnostics:

1. Create a project.
2. Import a short MP4 from the empty Timeline or Assets.
3. See the real media on the Timeline and play it in Program Monitor.
4. Trim or move the clip and confirm undo/redo.
5. Add/import captions and see them in preview.
6. Apply the browser-only Quick Voice Polish preset.
7. Export the content range to MP4.
8. Refresh the workspace and re-download the completed export.

The reference fixture journey must finish in less than five minutes at
`1639×1066`, with the same functional path remaining available at `1366×768`
and `1024×768`.

## Current evidence and risks

| Area                 | Current evidence                                                     | Risk                                                                                                            |
| -------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| WP-27 audit          | 57 PASS, six fixed P1 defects, 37 NOT-RUN                            | Large parts of the product remain manually unverified                                                           |
| Browser automation   | 231 Vitest files run in Node; no application Playwright suite        | Upload, OPFS, download, focus, layout, fullscreen, and media behavior are outside CI                            |
| Imported media       | Resolver now prefers verified OPFS bytes and owner-authorized private originals | Image holds, Worker result delivery, and browser-level reload evidence remain open                              |
| Timeline empty state | Valid files and JOY asset payloads are consumed directly               | Batch progress/cancel, touch browser evidence, and Getting Started guidance remain open                        |
| Library placement    | Cards expose Add to timeline and carry safe descriptor metadata         | Bulk placement, selection/focus handoff, and browser coverage remain open                                      |
| Captions             | Selected media is resolved and sent to transcription                    | Full SRT/VTT/EN/FA browser rerun and progress/cancel UI remain open                                             |
| Audio Studio         | Worker/provider state is queried and Browser DSP has an honest enabled route | Canonical audio migration, audible golden-path proof, and real Worker execution remain open                |
| Worker audio         | `audio.ml-denoise` exists                                            | Missing local source may cause a synthetic noise fixture to be processed; long blocking jobs can outlive leases |
| Export duration      | Content bounds drive the default range                               | Explicit preflight/range choice and verified duration gates remain open                                        |
| Export mix           | One authored offline mix is started; raw sources are not recorded     | Image/audio-only frame coverage and audible browser evidence remain open                                      |
| Export recovery      | Completed blobs are staged in a bounded OPFS cache; running entries become retryable and the UI offers cancel/retry | Post-encode verification and project-scoped operation fingerprints remain open |
| Playback diagnostics | Decode/drop/drift counters exist                                     | Metrics accumulate, ignore presented-frame metadata, and report proxy mode without selecting a proxy            |
| Full suite           | RNNoise is now an explicit provisioned-model integration test           | Playwright/axe coverage and the remaining browser audit are not yet wired                                      |

## Product and architecture decisions

### D-WP29-1 — The basic path is Worker-independent

The required golden path uses browser decoding, browser DSP, and browser export.
Worker-enhanced ML denoise is an optional second route. A disconnected Worker or
missing model must never block import, captions, basic mixing, or export.

### D-WP29-2 — User media is never replaced with fixture media

Bundled media and transcription fixtures are allowed only in an explicitly
labeled Demo/Reference project or test harness. If selected bytes are missing,
unauthorized, corrupt, or unavailable on a Worker, the operation fails with an
actionable error. It must not process `asset-intro`, generated noise, or another
fixture as a silent fallback.

### D-WP29-3 — One source resolver serves preview, transcription, audio, and export

Add a typed project-media resolver with this priority:

1. Integrity-verified OPFS original.
2. Verified local derivative when the requested operation permits it.
3. Owner-authorized private/cloud original fetched through the JOY Media API.
4. A committed reference URL only when the asset ID is one of the explicit
   reference-project fixture IDs.

The resolver owns object-URL creation and revocation. No provider URL, private
object reference, local filesystem path, or bearer value enters project JSON or
UI logs.

### D-WP29-4 — Media metadata is durable project data

On successful import, persist the safe asset kind, MIME type, byte length,
SHA-256, duration, width, and height with the creative document. Timeline
placement uses that descriptor rather than a five-second fallback. Storage
locations remain outside the creative document.

### D-WP29-5 — Imported visual media receives a render controller

Placing video or image media creates an undoable clip-to-render-controller
binding in the same project transaction. Inspector, Effects, Motion, and Color
target that controller, and preview/export read its transform/effects. Clip
deletion removes an unshared controller; duplication creates an independent
controller. Do not model a video as a fake still image.

### D-WP29-6 — Guidance is derived, compact, and dismissible

The editor exposes a small Getting Started row, not a blocking tour or new
panel. Completion comes from real project/export state. Only dismissal, explicit
skip choices, and the Review acknowledgement are stored per project. The row
collapses to the current next action at compact widths and disappears after the
first successful export.

### D-WP29-7 — Browser exports recover by retry, not by pretending to resume

A browser `MediaRecorder` encode cannot continue after a reload. A running
record discovered after reload becomes `interrupted-retryable`; the UI offers
Retry with the same logical operation fingerprint. It never auto-creates a
second export. Completed outputs are cached in OPFS for durable re-download.

### D-WP29-8 — Test authentication is isolated from production authentication

The browser E2E stack may run a test-only local API and inject test storage state
from the test process. It must not add a production test-token route, Media auth
bypass, hard-coded account, or committed cookie.

### D-WP29-9 — Audit closure is broader than the product scope

All 37 prior NOT-RUN cases are attempted in the final rerun. Advanced Effects,
Motion, Camera, and Template cases use the existing seeded project where
appropriate; WP-29 does not add new advanced capabilities solely to make an
audit row pass. New P0/P1 defects and P2 defects affecting the golden path block
closeout. Other reproducible findings receive defect IDs and a follow-up plan.

## Planned deliverables

- `ProjectMediaResolver` shared by playback, transitions, transcription, audio,
  thumbnails where appropriate, and export.
- Durable safe media descriptors and clip render-controller bindings.
- One-action file import/drop/library placement with progress and rollback.
- Compact Getting Started row and accessible Projects empty-state CTA.
- Real-source caption import/transcription with no silent fixture fallback.
- Worker-independent Quick Voice Polish using one preview/export audio graph.
- Live Worker/provider status, plus a fail-closed optional ML-denoise path.
- Project-scoped operation/export records and a bounded OPFS export cache.
- Export preflight, content-range rendering, cancel, retry, and post-encode
  verification.
- Hermetic fixture pack, Playwright/axe browser suite, and split CI jobs.
- Updated WP-27 rerun report, `STATE.md`, and GBrain closeout page.

## Execution plan

### WP-29.0 — Preflight, baseline, and safety envelope

- [ ] Confirm the canonical checkout is clean and record `HEAD`, `origin/main`,
      `vps-local/main`, deployed API/editor releases, and rollback releases.
- [ ] Create a History restore point for the existing live project and use a
      new disposable project named `WP-29 golden path <run-id>` for mutations.
- [ ] Record Chrome version, OS/GPU/media capabilities, all three viewports,
      public/API health, and initial console/network errors.
- [ ] Run typecheck, lint, editor/API/Worker builds, unit tests, production
      audit, and focused export/worker tests. Record the RNNoise failure as the
      expected baseline until WP-29.1 fixes test hermeticity.
- [ ] Reproduce these four seams once before implementation:
  - import a non-reference MP4 and observe its playback/export source request;
  - export a short clip from a 60-second blank composition;
  - inspect Audio Worker/Cloud readiness against actual Jobs state;
  - verify whether authored mute/gain/pan changes reach the exported audio.
- [ ] Capture a baseline screenshot, network trace, and result report under
      `docs/qa/evidence/<run-id>/` without secrets or personal paths.

**Gate:** No production mutation occurs until the disposable project, current
release pointers, health, and rollback targets are recorded.

### WP-29.1 — Hermetic fixtures, browser harness, and green default CI

#### Fixture pack

- [ ] Add redistributable, generated fixtures under
      `packages/test-fixtures/media/`:
  - PNG and JPEG;
  - three-second `320×180` H.264/AAC MP4;
  - three-second mono 48 kHz WAV and MP3;
  - English multiline SRT and Persian RTL WebVTT;
  - Markdown/image Joy Code attachments;
  - unsupported text, empty file, and corrupt MP4.
- [ ] Add a generation script, provenance/licence README, and manifest with
      SHA-256, byte length, MIME, duration, dimensions, channels, and sample
      rate. Fixture regeneration must reproduce the manifest.

#### Browser harness

- [ ] Add `@playwright/test` and `@axe-core/playwright` with root scripts:
  - `pnpm test:e2e` — required golden path;
  - `pnpm test:e2e:headed` — local diagnosis;
  - `pnpm test:e2e:audit` — expanded 100-case rerun groups.
- [ ] Add a test-only local stack using the existing control-plane HTTP server,
      in-memory control plane/private-object store, deterministic provider
      responses, and a fixed test identity that exists only in the test
      process.
- [ ] Add Playwright projects for `1639×1066`, `1366×768`, and `1024×768`.
      Capture trace, video, screenshot, console, network, and downloads on
      failure.
- [ ] Prefer role/name locators. Add stable `data-asset-id`, `data-track-id`,
      and `data-clip-id` hooks only where drag geometry cannot be addressed
      accessibly.
- [ ] Fail browser tests on unexpected `pageerror`, console error, failed
      same-origin request, page-level horizontal overflow, focus escape from a
      modal, or an inaccessible dialog.

#### RNNoise test repair

- [ ] Make ML-runner unit coverage hermetic by injecting filesystem/process
      execution and asserting FFmpeg arguments, output verification, cancel,
      and error paths without a real model.
- [ ] Keep the real `arnndn` run behind an explicit
      `JOY_MEDIA_RNNOISE_MODEL` integration gate on a runner with a pinned,
      checksum- and licence-reviewed model. Default `pnpm test` must report a
      deliberate skip or pass, never an environment failure.
- [ ] Split CI into required unit/build/audit and Chrome E2E jobs; retain an
      optional provisioned RNNoise integration job. Upload failure artifacts.

**Gate:** `pnpm verify:ci` exits zero on a normal developer/CI machine and one
Playwright smoke can create and remove a local test project without any
production auth bypass.

### WP-29.2 — Real project-media source and render-controller vertical slice

- [ ] Add a typed resolver result union for video, audio, and image sources,
      including descriptor, integrity identity, source tier, URL/bitmap/bytes,
      and cleanup ownership.
- [ ] Reuse the verified fallback rules already proven by the Assets preview
      code, but centralize them so Program Monitor and Export do not implement
      a separate resolution policy.
- [ ] Restrict `/media/reference/*.mp4` resolution to the explicit reference
      asset map. A random imported ID must never generate a reference URL.
- [ ] Cache resolutions per project/asset/integrity identity, deduplicate
      concurrent loads, revoke object URLs on replacement/project close, and
      retry authorized cloud fallback after a recoverable OPFS miss.
- [ ] Persist safe media descriptors during import and migrate old project
      records by looking up catalog metadata without inventing duration or
      dimensions.
- [ ] Replace URL-based active-clip lookup with explicit clip identity from the
      playhead/selection. Two timeline clips that share one asset must remain
      independent.
- [ ] Update Program Monitor playback for:
  - video decode and source-time mapping;
  - image hold frames;
  - audio-only playback with the composition background/visual layer;
  - gaps and missing/unauthorized media with actionable UI.
- [ ] On media placement, create the clip and its render controller in one
      project operation. Apply controller transform/effects in the video/image
      render node used by both preview and export.
- [ ] Add tests for OPFS hit, authorized cloud fallback, reference-fixture
      fallback, integrity mismatch, revoked authorization, missing bytes,
      duplicate-asset clips, object-URL cleanup, and reload rehydration.

**Gate:** A newly imported fixture MP4—not a seeded reference ID—plays before
and after refresh, produces no `/media/reference/media-*.mp4` request, retains
its exact descriptor, and can be selected in Inspector/Effects through its
render controller.

### WP-29.3 — One-action project start, import, and Timeline placement

- [ ] Add a visible Create Project CTA to the Projects empty state while
      retaining the compact plus action when projects already exist.
- [ ] Keep project creation focused: name plus a visible default format summary.
      Do not add a multi-page wizard. Existing projects and catalog migration
      remain unchanged.
- [ ] Upgrade the empty Timeline strip to expose two labeled actions:
      `Import media` and `Browse library`.
- [ ] Consume `DataTransfer.files` directly. Consume and validate JOY asset drag
      payloads directly. Do not reopen a picker after a valid drop.
- [ ] Support click, keyboard Enter/Space, pointer, drag/drop, and touch-width
      `Add to timeline` actions.
- [ ] Remove mandatory opaque Asset ID entry from the ordinary Assets import
      form. Generate the ID internally; expose a custom ID only under an
      Advanced disclosure.
- [ ] Include kind and safe descriptor in the library placement payload. Use
      the real duration for video/audio and the documented default still
      duration for images.
- [ ] Provide explicit Add to Timeline actions on asset cards and bulk
      selection. Drop/add targets the compatible unlocked track or creates one
      atomically.
- [ ] After placement, select the new clip, seek to its start, fit the content
      if the timeline was empty, and focus the next useful control.
- [ ] Show per-file/batch progress with success/failure counts, cancel where
      supported, and retry. Invalid/empty/corrupt media is rejected before
      catalog/timeline mutation. Partial batches retain only verified successes.
- [ ] Add the Getting Started row:
  - Media — complete when a resolvable clip exists;
  - Review — acknowledged after playback or explicitly skipped;
  - Captions — optional, complete when caption content exists or skipped;
  - Audio — optional, complete when authored audio differs from default or
    skipped;
  - Export — complete after a project-scoped successful export.
- [ ] Each guide action activates the relevant Dockview panel and returns focus
      predictably. Dismiss/skip state participates in project purge; completion
      is derived rather than duplicated.

**Gate:** Mouse, keyboard, and touch-width browser tests create a project,
import/drop a real MP4, place it once with correct duration, and leave one
selected playable clip with no duplicate asset or controller.

### WP-29.4 — Captions from the selected user's media

- [ ] Preserve the repaired Add Caption Track CTA and add direct empty-state
      choices for Manual caption, Import SRT/VTT, English transcription, and
      Persian transcription.
- [ ] Resolve the selected/active clip through `ProjectMediaResolver` and send
      its real authorized bytes and safe filename to the transcription path.
- [ ] Remove the silent `asset-intro`/fixture substitution. Keep fixtures only
      behind an explicit `Use demo transcript` action labelled as demo data.
- [ ] Prevent double submission; expose progress, cancel, retry, source clip,
      detected/requested language, and actionable provider errors.
- [ ] Preserve original word/timing data while editing display text. Verify RTL
      direction, punctuation, search, seek, confidence, and reload behavior.
- [ ] Import and export valid multiline SRT and Persian WebVTT, then parse the
      downloaded files independently to prove timing/encoding.
- [ ] Make caption burn-in consume the same caption state in Program Monitor
      and Export.

**Gate:** Manual, SRT, WebVTT, English, and Persian paths operate on the
disposable project's actual media, survive refresh, and never claim a fixture
transcript is the user's audio.

### WP-29.5 — Honest browser audio path and optional Worker enhancement

#### Browser-only Quick Voice Polish

- [ ] Make `JoyProjectV1.audio` the canonical audio state. Migrate the legacy
      project-local key once and stop dual non-atomic writes.
- [ ] Build one audio-render graph consumed by preview and export. It must honor
      master/clip mute, solo, gain, pan, fades, and supported effects.
- [ ] Add Quick Voice Polish using only real browser/audio-core primitives
      already available: gate/denoise where honest, EQ, compression, limiter,
      and normalization. Do not label a noise gate as ML denoise.
- [ ] Apply the preset non-destructively, preview A/B, undo/redo it, and persist
      parameters across refresh.
- [ ] Route Audio panel status from real capability/provider data. Device and
      cache controls affect a real target or are removed/disabled with honest
      explanation.

#### Shared Worker state and execution safety

- [ ] Factor one Worker runtime-status service/provider shared by Audio and
      Jobs. Display `connected`, `disconnected`, `revoked`, and capabilities
      from live data. Rename the count from `active` to `paired` where it means
      non-revoked rather than online.
- [ ] Make Worker claim continue after browser approval without requiring a
      manual process restart. Send hello/keepalive every 10–15 seconds (or
      refresh presence on authenticated lease polls) so an idle Worker remains
      connected past the 35-second UI threshold.
- [ ] Advertise `audio.ml-denoise` only when its custom command or reviewed
      RNNoise model is actually runnable.
- [ ] Require the requested asset ID in the Worker's local asset registry, or
      use a separately approved private-byte transfer. Non-fixture jobs must
      fail closed when source bytes are unavailable; never generate noise.
- [ ] Replace blocking long-running subprocess execution with cancellable async
      execution. Renew the lease independently at most every 10 seconds,
      deliver cancellation, terminally fail sanitized runtime errors, reject
      stale completion, and enforce bounded attempts/backoff.
- [ ] Use a stable operation/job ID. Disable double submission and reattach to
      an existing matching job rather than queueing another.
- [ ] Extend the verified result-upload path to audio derivatives. Register the
      durable result, cache it in OPFS, and insert/replace it only after the
      user approves the result. Cancel/failure leaves no partial creative
      mutation.

**Gate A:** The full required golden path, including audible Quick Voice
Polish, passes with no Worker.  
**Gate B:** A disposable Worker pairs without restart, stays connected while
idle for 60 seconds, processes the selected asset exactly once, returns
verified playable bytes, supports cancel/retry, and cannot lease after revoke.

### WP-29.6 — Project operations, export correctness, and recovery

#### Operation state

- [ ] Add a small project operation ledger for import, audio, Worker job, and
      export. Each record includes logical ID, project ID, type, fingerprint,
      project revision, status, attempt, timestamps, and result/error reference.
- [ ] Reusing an operation ID with a matching fingerprint resumes/reattaches;
      a mismatched fingerprint returns a conflict. One user action creates one
      logical asset/job/export.
- [ ] Surface `Saving`, `Saved locally`, `Recovered with warnings`, quota
      failure, interrupted, canceling, and retryable states. Do not discard
      persistence recovery warnings.
- [ ] Use the existing project lock boundary to reject or clearly resolve a
      second-tab write. Persisted cross-reload undo ordering is out of scope;
      recovered project state and new-session undo must remain correct.

#### Export

- [ ] Add Export preflight showing preset, dimensions, content range/duration,
      frame count, caption burn-in, audio route, estimated work, filename, and
      unresolved sources.
- [ ] Default to Content range: first included content start through the last
      enabled clip/caption/object end. Retain explicit Full Composition only as
      a user choice. A three-second fixture must not silently export 60 seconds.
- [ ] Enumerate every relevant enabled clip, image, audio lane, transition
      partner, caption, and visual object rather than discovering media only at
      selected boundaries.
- [ ] Use `ProjectMediaResolver` for every source. Gaps render the composition
      background and silence; images render as holds; audio-only content mixes
      without being treated as video.
- [ ] Start exactly one authored mixed-audio source. Do not start parallel raw
      sources that bypass mute/gain/pan/fades/effects. Handle 44.1/48 kHz input
      deterministically.
- [ ] Add `AbortSignal` cancellation through preloading, scene capture, frame
      paint, audio, and `downloadBrowserMp4`; always stop media sources, clear
      timers, close contexts, destroy renderers, and revoke temporary URLs.
- [ ] Make export history v2 project-scoped and migrate v1 entries safely. Store
      revision, preset, range, manifest, SHA-256, bytes, status, and result ref.
- [ ] Store completed output in a bounded OPFS cache (default: newest three per
      project within a 512 MiB cap). Evict oldest completed entries only after a
      new result is verified; never evict a running item.
- [ ] On reload, classify an in-browser running encode as
      `interrupted-retryable`; offer one explicit Retry using the same logical
      operation. Completed results remain re-downloadable after refresh.
- [ ] Independently verify the result before success: nonzero bytes, decodable
      H.264/AAC, chosen dimensions, duration within one frame of range, and
      authored audio present unless intentionally muted.

**Gate:** The downloaded fixture export passes `ffprobe`, duration is within
one frame of the content range, mute/gain/pan are audible/measurable, cancel
cleans up, reload never leaves `Exporting` stuck, one retry creates one result,
and completed output re-downloads after refresh.

### WP-29.7 — Playback measurement and controlled performance repair

- [ ] Reset diagnostics per playback session, seek, and clip switch. Separate
      decode misses, presented-frame drops, A/V drift, intentional seek, and
      background-tab throttling.
- [ ] Consume `requestVideoFrameCallback` metadata (`mediaTime`,
      `presentedFrames`, `expectedDisplayTime`) and associate it with the active
      clip ID rather than matching by URL.
- [ ] Do not report proxy quality unless a verified proxy is actually selected.
      If a proxy is selected, expose source/quality state and preserve playhead.
- [ ] Run three controlled ten-second passes on the named reference Chrome/GPU,
      excluding the first second of warmup.
- [ ] Cover duplicate-asset clips, a gap, 0.5×/2× rate, freeze, repeated seek,
      transition, and background-tab recovery.

**Reference-host gate:** presented-frame drop rate `≤2%`, p95 A/V drift
`≤50 ms`, max drift `≤100 ms`, and no stall over `500 ms`. Virtualized CI uses
a non-catastrophic smoke threshold and never replaces the named-host evidence.

### WP-29.8 — Browser audit closure, production deployment, and cleanup

#### Automated browser suites

- [ ] `golden-path.spec.ts`: create → import → place → play/edit → caption →
      browser audio polish → export → download → refresh → re-download.
- [ ] `audit-assets-timeline.spec.ts`: uploads, invalid/cancel, DnD, move, trim,
      rate/freeze, fullscreen.
- [ ] `audit-captions.spec.ts`: manual/revert/templates/SRT/VTT/EN/FA.
- [ ] `audit-worker-workflows.spec.ts`: pair, readiness, local/browser routing,
      cancel/retry/revoke, reload.
- [ ] `audit-effects-motion.spec.ts`: seeded selected object, Effects, Color,
      Inspector, Motion, Camera, Templates, undo/reload.
- [ ] `audit-recovery.spec.ts`: import interruption, project reopen, export
      interruption/retry, no duplicate logical records.
- [ ] Run axe scans on Projects, workspace, import, Captions, Audio, Worker pair,
      and Export preflight. Verify keyboard focus and Escape behavior.

#### Rerun the 37 previous NOT-RUN scenarios

| Group                                           | Case IDs             | Execution route                                                                 |
| ----------------------------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| Upload and file bridge                          | 15–18, 25, 93        | Playwright file inputs, real DnD payloads, fixture pack                         |
| Pointer/user gesture                            | 10, 32, 33, 37, 46   | Chrome pointer, context menu, dialog, fullscreen handling                       |
| Captions                                        | 53–59                | Repaired CTA plus manual/import/export/EN/FA fixtures                           |
| Worker and audio routing                        | 63, 66, 67, 89       | Disposable offer/Worker and browser-only DSP route                              |
| Effects/Color/Inspector/Motion/Camera/Templates | 71, 72, 74–77, 79–85 | Seeded selected clip/controller, undo and reload                                |
| Destructive cloud/AI                            | 24                   | In-memory stack first; disposable live project only with recorded authorization |
| Reload during operation                         | 100                  | Inject reload at progress, verify interrupted/retry semantics                   |

- [ ] Create a new results file
      `docs/qa/gpt-chrome-usage-audit-<run-id>.md`; do not rewrite the historical
      pre-fix verdicts in the 20260809 report.
- [ ] Give every case a functional and UI/A11y verdict. Tooling is no longer a
      valid reason for NOT-RUN. A genuinely unavailable paid/external provider
      is `BLOCKED-CONSENT` or an explicit integration blocker, not PASS.
- [ ] Reproduce each new failure once. P0/P1 and golden-path P2 defects block
      closeout; consolidate duplicates under new `JOY-QA-*` IDs.

#### Deploy and close

- [ ] Run `pnpm verify:ci`, required Playwright projects, API/Worker integration,
      export verification, and production audit on the exact candidate commit.
- [ ] Commit one reviewable slice per work package, push GitHub `origin/main`
      and VPS `vps-local/main`, and deploy immutable API/editor/Worker artifacts
      only from clean pushed commits.
- [ ] Run write-free deployment preflight, retain prior releases, switch only
      affected symlinks/services, then verify origin/public health and asset
      hashes.
- [ ] Run the signed-in live golden path in the disposable project at all three
      viewports. Capture screenshots, console/network logs, export metadata,
      and elapsed time without secrets.
- [ ] Cancel temporary jobs, revoke the disposable Worker, permanently remove
      the disposable project/assets after exact target review, and confirm no
      audit object remains.
- [ ] Update `STATE.md`, this plan's status/evidence, the WP-27 remediation
      section, and GBrain's JOY Media pointer/dedicated WP-29 page. Export and
      push GBrain only after verifying the live release.

## Test matrix

| Layer                   | Required coverage                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema/persistence      | Safe media descriptors, audio migration, operation/export v1→v2 migration, recovery warnings, quota/corrupt-write fault injection                     |
| Media resolver          | OPFS, cloud fallback, reference allowlist, integrity mismatch, authorization loss, concurrent resolution, URL cleanup                                 |
| Import/Timeline         | File validation, batch partial success, exact duration, track choice, controller binding, selection/focus, undo/redo/reload                           |
| Captions                | Manual edit/revert, SRT/VTT round trip, EN/FA source bytes, RTL, cancel/retry, no fixture substitution                                                |
| Audio                   | Unified graph parity, mute/solo/gain/pan/fades/effects, A/B, undo, 44.1/48 kHz, browser-only preset                                                   |
| Worker/API              | Pair/claim, keepalive, capability health, asset locality, heartbeat, stale lease, cancel, terminal fail, bounded retry, verified result upload/revoke |
| Export                  | Preflight, content range/gaps, video/image/audio, transitions, captions, mix, cancel cleanup, OPFS cache, reload/retry/re-download, ffprobe           |
| Component/accessibility | Projects/empty Timeline/guide/import/Captions/Audio/Export dialogs, keyboard/focus/Escape, compact layouts                                            |
| Browser E2E             | Complete golden path and 37-case closure at all three viewports; console/network/overflow assertions                                                  |
| Production              | Signed-in identity, real private media path, optional healthy Worker, public health, immutable release and rollback evidence                          |

## Acceptance criteria

WP-29 is complete only when all of the following are true:

- A fresh signed-in user completes the required golden path in under five
  minutes without pairing a Worker or downloading a model.
- A real imported random asset ID previews and exports from verified OPFS/cloud
  bytes; no random ID is requested from `/media/reference/`.
- MP4, PNG/JPEG, WAV/MP3, SRT, WebVTT, invalid, empty, and corrupt fixtures have
  recorded outcomes with no partial invalid catalog mutation.
- Import and Add to Timeline work with mouse, keyboard, drag/drop, and
  touch-width controls; real duration and kind survive refresh.
- Imported visual media is selectable and editable through an independent
  render controller; preview and export use the same authored transform/effect
  state.
- Captions use the selected project's actual media. Demo fixtures are explicit
  and never silently substituted.
- Quick Voice Polish works with no Worker, is audible in preview/export,
  persists, and is undoable.
- Worker status is live and honest. The optional Worker path processes only the
  selected asset, stays connected idle, renews leases, cancels, fails
  terminally, retries without duplication, returns verified playable bytes,
  and stops leasing after revoke.
- One logical action creates one import/audio/job/export result; refresh at
  every completed stage produces no duplicate or stuck state.
- Export defaults to content range, uses the authored audio mix, supports
  cancel/retry, passes independent H.264/AAC metadata checks, and remains
  re-downloadable after refresh.
- Reference-host playback meets the documented drop/drift/stall thresholds or
  WP-29 remains open with a reproduced performance defect.
- `pnpm verify:ci` and required Playwright jobs are green. RNNoise's real-model
  test is an explicit provisioned integration, not a default environment
  failure.
- All 37 former NOT-RUN case IDs have new functional and UI/A11y outcomes. Any
  external blocker is explicitly classified and evidenced.
- No password, token, private path, provider object reference, personal media
  identifier, or test authentication state enters commits/reports.
- The live project is restored, disposable project/assets/jobs/Worker are
  removed or revoked, rollback releases remain available, and GitHub/VPS/GBrain
  records match the deployed commit.

## Explicit non-goals

- Marketplace/collaboration transport.
- New advanced Effects, Motion, Camera, or Template capability unrelated to a
  discovered golden-path defect.
- Automatic installation or redistribution of unreviewed ML models.
- A server render farm or resumable server-side export architecture.
- Persisting the entire cross-domain undo stack across browser restarts.
- Mobile-phone layout below the current `1024×768` minimum-width contract.
- Any production authentication bypass or committed live-browser session.

## Stop conditions

Pause implementation and report before proceeding if:

- imported bytes cannot be tied unambiguously to the signed-in owner/project;
- OPFS/cloud integrity metadata disagree;
- the proposed media descriptor requires exposing a storage location;
- Worker source locality cannot be proven and no explicit transfer was
  approved;
- a migration would discard or silently rewrite an existing project;
- export verification finds data corruption or unexpected private-media
  disclosure;
- production health or rollback evidence is unavailable;
- the worktree contains unrelated changes that overlap required files.

## Suggested next-session prompt

```text
Execute plan/WP-29-first-project-golden-path-reliability.md in order. Start with
WP-29.0 and WP-29.1, then close the real ProjectMediaResolver vertical slice
before onboarding polish. Never substitute fixture bytes for user media. Keep
the required path Worker-independent, commit each gate separately, and do not
deploy until verify:ci plus the required Playwright golden path are green.
```
