# Luna — JOY Media 0–100 Platform Test and Report Plan

- Prepared: 2026-08-15
- Owner/executor: Luna
- Mode: evidence-first testing and reporting
- Repository: `C:\Users\HadiMoti\joy-media-audio-enhance`
- Local model root: `C:\Users\HadiMoti\JOY\models`
- Public editor: `https://joyst.ir/`
- Media API: `https://media.joyteam.ir/api`
- Admin/GBrain observation surface: `https://admin.joyteam.ir/brain`
- Baseline at plan creation: branch `codex/audio-enhance-workspace`, commit
  `d5ec5c9a0fab57b8a77b434ad4ea3312b6b7f192`
- Known local change at plan creation: `run-worker.bat` contains uncommitted model
  path configuration. Luna must record, preserve, and report it; do not silently
  discard, overwrite, or describe the starting tree as clean.
- Known tooling mismatch at plan creation: the repository pins pnpm `11.15.0`,
  while Corepack currently resolves pnpm `11.17.0`. Luna must align to the pinned
  version before running gates; do not bypass the version contract and call the
  result canonical.

## 1. Mission

Test JOY Media from zero to one hundred as one connected product, not as a
collection of isolated components. The run must cover repository quality,
local runtime, local AI models, paired Worker behavior, authenticated API,
project lifecycle, media ingest, every editor workspace, both timeline modes,
Inspector, audio, captions, text, effects, masking, upscaling, Joy Code, jobs,
playback, export, responsive behavior, accessibility, resilience, security,
and exact cleanup.

The output is an evidence-backed report, not a list of impressions. A feature
is not accepted because a button exists, a unit test is green, or a model file
is present. It is accepted only at the deepest layer the evidence proves.

The required final report is:

```text
docs/qa/LUNA-PLATFORM-0-TO-100-REPORT-<UTC-run-id>.md
```

The required evidence directory is:

```text
docs/qa/evidence/luna-platform-<UTC-run-id>/
```

## 2. Luna operating contract

1. Start with read-only discovery and record exact state before running or
   changing anything.
2. This assignment is test-and-report by default. Do not repair product code,
   alter model files, deploy a new release, or update GBrain unless the owner
   separately authorizes implementation.
3. Never use seeded UI labels, mocked providers, fixture-only receipts, or unit
   tests as proof that a real local model executed.
4. Never report a skipped, blocked, or unconfigured path as `PASS`.
5. Never expose login cookies, bearer tokens, Worker session tokens, signed
   media URLs, private media bytes, personal contact details, or secrets in
   logs/evidence.
6. Existing user projects and uploads are read-only. All mutations must belong
   to one exact disposable project created for this run.
7. Record every command, exit code, duration, test total, retry, warning, and
   failure. A retry-resolved result is not silently reported as first-pass.
8. If a failure is environmental, prove why. `BLOCKED-INTEGRATION` is a result,
   not permission to award points.
9. Stop immediately for a P0, ambiguous cleanup target, cross-project data
   exposure, credential exposure, or destructive action aimed at state not
   created by the run.
10. Finish only after reviewing all evidence, producing the report, and proving
    cleanup against the starting baseline.

## 3. Definition of 0–100

Each scorecard row is worth its assigned points.

- `PASS`: full points; observable result and retained evidence satisfy every
  acceptance condition.
- `PARTIAL`: half points; the path works only in part, uses an accepted fallback,
  or has a reproducible noncritical defect.
- `FAIL`: zero points; incorrect result, crash, data mismatch, broken workflow,
  or unmet acceptance condition.
- `BLOCKED-INTEGRATION`: zero points; dependency, runtime, license, hardware,
  wiring, or authorization prevents execution.
- `NOT RUN`: zero points and triggers the mandatory-coverage cap.
- `N/A`: allowed only when the feature is demonstrably not part of the current
  product contract. Intended but unfinished features are not N/A.

### 3.1 Weighted scorecard

| Area                                                                                 |  Points |
| ------------------------------------------------------------------------------------ | ------: |
| A. Repository, build, dependency, and artifact integrity                             |       7 |
| B. Identity, API, projects, persistence, and control plane                           |       8 |
| C. Media Library, import, preview, project isolation, and recovery                   |       8 |
| D. Workspace shell, information architecture, menus, and visual language             |       7 |
| E. Classic Timeline, Dual Lens/Flow, editing, tracks, and persistence                |      13 |
| F. Inspector, animation, transitions, effects, filters, color, and adjustment layers |      11 |
| G. Captions, CC timeline elements, text templates, and editable typography           |       6 |
| H. Audio Studio, mix/runtime routes, models, and audible output                      |      10 |
| I. Image/video masking, background removal, and mask export                          |       9 |
| J. AI image enhancement/upscaling                                                    |       5 |
| K. Joy Code, Jobs, Worker pairing, approvals, and provenance                         |       5 |
| L. Program Monitor, playback, export, Process Center, and recovery                   |       7 |
| M. Accessibility, responsive behavior, performance, security, and cleanup            |       4 |
| **Total**                                                                            | **100** |

### 3.2 Integrity caps

The arithmetic score may not hide critical gaps.

| Condition                                                   | Maximum final score | Release decision  |
| ----------------------------------------------------------- | ------------------: | ----------------- |
| Any P0                                                      |                  39 | NO-GO             |
| Any unresolved P1 or cleanup mismatch                       |                  69 | NO-GO             |
| Any mandatory platform journey not run                      |                  79 | NO-GO             |
| Any downloaded model lacks artifact and loader verification |                  89 | CONDITIONAL/NO-GO |
| No signed-in production smoke                               |                  90 | CONDITIONAL       |
| Worker/UI claims capability that cannot execute             |                  79 | NO-GO             |
| Evidence directory or final report incomplete               |             Invalid | NO-GO             |

`100/100` is permitted only when every mandatory row passes, no P0/P1 remains,
all model readiness layers are truthful, production smoke passes, and cleanup
returns the environment to baseline.

## 4. Severity and finding contract

Every finding receives a stable ID `LUNA-F###` and these fields:

| Field        | Required content                                                        |
| ------------ | ----------------------------------------------------------------------- |
| Area         | Scorecard area A–M                                                      |
| Surface      | Exact page, panel, tab, timeline, API, Worker, or model                 |
| Environment  | Local/live, browser/CLI, viewport, CPU/GPU, model/runtime               |
| Expected     | Observable expected behavior                                            |
| Actual       | Observable result without speculation                                   |
| Reproduction | Exact steps and repeat count                                            |
| Severity     | P0, P1, P2, or P3                                                       |
| Evidence     | Relative paths to screenshot, trace, log, JSON, media, or hash          |
| Root cause   | Confirmed seam or `unknown`                                             |
| Disposition  | open, expected, duplicate, integration-gap, follow-on, cannot-reproduce |
| Score impact | Rows/points affected and applicable cap                                 |

Severity rules:

- **P0:** security/privacy boundary breach, cross-project exposure, unrecoverable
  data loss, malicious file execution, corrupted output accepted as valid, or
  production-wide outage.
- **P1:** required journey cannot complete; save/reload loses authored state;
  Undo/Redo changes the wrong state; Worker advertises a false capability;
  model output is invalid; export is materially wrong; or cleanup is uncertain.
- **P2:** serious usability, accessibility, responsive, performance, or truth-in-
  UI problem with a workaround.
- **P3:** cosmetic or low-impact inconsistency with an obvious workaround.

## 5. Required run identity and evidence package

Generate a UTC run ID such as `20260815T153000Z`. Record:

- local branch, full commit, remote refs, dirty files, and `git diff --stat`;
- Windows version, CPU, RAM, GPU, VRAM, free disk, power mode, and display scale;
- Node, pnpm, Python environments, FFmpeg, FFprobe, Chrome, and Playwright
  versions;
- local model root, file sizes, SHA-256 hashes, and directory permissions;
- local API/editor/Worker endpoints and PIDs;
- public editor entry hash, API health, deployed release identifiers when
  discoverable without secrets;
- signed-in baseline counts for projects, assets, jobs, derivatives, exports,
  and paired Workers;
- test project ID and every asset/job/export ID created by the run.

Create these artifacts at minimum:

```text
run-manifest.json
environment.json
git-state.txt
model-inventory.json
model-loader-results.json
model-inference-results.json
automated-test-summary.json
browser-matrix.json
network-console-summary.json
accessibility-summary.json
performance-summary.json
export-ffprobe.json
export-audio-measurements.json
friction-ledger.md
cleanup-proof.json
screenshots/
```

Raw traces, videos, downloads, and model outputs may stay outside Git when too
large or private. The committed report must record their SHA-256, size, storage
location, retention policy, and redaction status.

## 6. Phase 0 — Freeze and baseline

### 6.1 Repository baseline

From `C:\Users\HadiMoti\joy-media-audio-enhance`:

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
git remote -v
git diff --check
git diff --stat
node --version
pnpm --version
ffmpeg -version
ffprobe -version
```

Acceptance:

- Luna records the existing `run-worker.bat` modification and any later changes
  separately.
- No existing user change is reverted, reformatted, staged, or committed.
- The candidate under test is one exact commit plus an explicit dirty-patch
  digest; it is never described only as “latest.”

### 6.2 Model baseline

Inventory `C:\Users\HadiMoti\JOY\models` recursively. Record relative path,
byte size, modification time, SHA-256, readable status, and duplicate content.
Do not add model binaries to Git.

Expected inventory:

| Capability                    | Expected local location                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| RNNoise                       | `audio\rnnoise\mp.rnnn`                                            |
| DeepFilterNet Windows runtime | `audio\deepfilternet\deep-filter-0.5.6-x86_64-pc-windows-msvc.exe` |
| HTDemucs                      | `audio\demucs\models--adefossez--HTDemucs`                         |
| Qwen3-TTS Base                | `audio\qwen3-tts`                                                  |
| Qwen3-TTS VoiceDesign         | `audio\qwen3-tts-voice-design`                                     |
| BiRefNet General/Portrait     | `masking\birefnet`                                                 |
| SAM 2.1 Hiera Large           | `masking\sam2.1-hiera-large`                                       |
| Grounding DINO Tiny           | `masking\grounding-dino-tiny`                                      |
| Real-ESRGAN x4+               | `upscaling\RealESRGAN_x4plus.pth`                                  |

Check the Demucs Hugging Face cache junction and prove it resolves to the JOY
model root. A junction existing is not model-load proof.

### 6.3 Production baseline

Using the existing signed-in Chrome session:

- open `https://joyst.ir/` and record shell/release evidence;
- request the public API health endpoint without printing credentials;
- open `https://admin.joyteam.ir/brain` and record whether GBrain status and
  quality counters load;
- record project/asset/job/export/Worker counts before any mutation;
- do not open or edit an existing user project.

## 7. Phase 10 — Static quality and automated gates

Run in this order and preserve full logs:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm audit:prod
pnpm test:e2e:audit
```

Then run focused tests for the newest/high-risk surfaces, even when the full
suite passed:

- `apps/worker/src/local-masking.test.ts`
- `apps/worker/src/local-upscaling.test.ts`
- `apps/worker/src/runtime.test.ts`
- `apps/worker/src/control-plane.integration.test.ts`
- `apps/editor-web/src/masking.test.ts`
- `apps/editor-web/src/MaskInspector.test.tsx`
- `apps/editor-web/src/upscaling.test.ts`
- `apps/editor-web/src/AudioPanel.test.tsx`
- `apps/editor-web/src/audio-studio-runtime.test.ts`
- `apps/editor-web/src/timeline-elements-showcase.test.ts`
- `apps/editor-web/src/timeline-context-menu.test.ts`
- `apps/editor-web/src/adjustment-layer.test.ts`
- `apps/editor-web/src/adjustment-render.test.ts`
- `apps/editor-web/src/FiltersPanel.test.tsx`
- `apps/editor-web/src/CaptionsPanel.test.tsx`
- `apps/editor-web/src/text-template-transaction.test.ts`
- `apps/editor-web/src/three-d-render-layer.test.ts`
- `apps/editor-web/src/export-mp4-contract.test.ts`
- `apps/editor-web/src/export-audio.test.ts`
- `tests/e2e/wp32-real-project-journey.spec.ts`
- `tests/e2e/timeline-editing-features.spec.ts`

Acceptance:

- zero unexpected test, type, lint, format, or build failures;
- all skips listed by exact test and reason;
- retries reported separately from first-pass success;
- production audit findings triaged by exploitability and reachability;
- bundle output and unexpectedly large chunks recorded.

Automated tests prove contracts; they do not replace the physical browser and
real-model phases below.

## 8. Phase 20 — Local model qualification

### 8.1 Readiness layers

Every model/runtime receives six independent statuses:

1. **Artifact:** required files exist, hash, size, and format are plausible.
2. **Loader:** the intended library opens the model with network disabled.
3. **Inference:** one deterministic fixture produces a valid derivative.
4. **Worker:** Worker advertises the exact capability only after its runner is
   ready and can claim/complete a job.
5. **UI:** the intended control queues the real local job and reports truthful
   progress/error/cancel states.
6. **Project/export:** output is attached to the intended project/timeline,
   survives reload, and appears correctly in export.

The final readiness for a model is the lowest proven layer. For example,
`Artifact PASS / Loader PASS / Worker BLOCKED` is an integration gap, not a
fully installed feature.

Set network-disabled/offline mode only after dependencies are installed. If a
loader attempts a model download during offline qualification, record failure:
the local package is incomplete or not connected to the expected cache.

### 8.2 Audio model matrix

#### RNNoise

- Confirm `run-worker.bat` resolves `JOY_MEDIA_RNNOISE_MODEL` to the local
  `.rnnn` file.
- Confirm FFmpeg exposes the `arnndn` filter.
- Process a deterministic noisy speech WAV.
- Verify output decodes, duration/sample rate/channel count are preserved,
  samples changed, no NaN/invalid samples exist, and clipping did not increase.
- Record loudness, peak, noise-floor proxy, runtime, CPU use, and output hash.
- Queue the same operation from Audio Enhance through the paired Worker and
  compare provenance with the CLI proof.

#### DeepFilterNet

- Treat the downloaded Windows item as a runtime binary, not automatically as a
  complete model package.
- Run its own `--help`/version path first and derive the invocation from that
  installed binary; do not guess unsupported flags.
- Process the same noisy WAV, validate the derivative, and compare objective
  measurements with RNNoise without claiming subjective superiority.
- Prove `JOY_MEDIA_ML_DENOISE_CMD` wiring before the UI can receive Worker PASS.
- If the binary contains/downloads additional model assets, inventory and hash
  them. Any network fetch during offline inference is a failure.

#### HTDemucs

- Use `C:\Users\HadiMoti\.joy-media\audio-venv\Scripts\python.exe`.
- Load `htdemucs` with network disabled and prove the cache junction resolves.
- Separate a deterministic mixed fixture into exactly `drums`, `bass`, `other`,
  and `vocals` at 44.1 kHz stereo.
- Verify all outputs decode, have compatible duration, contain nontrivial
  signal, and are not byte-identical.
- Record runtime, peak RAM/VRAM, output sizes, hashes, and reconstruction error.
- The current Audio catalog card is not Worker proof. Require an actual
  `audio.separate` runner/job/UI result; otherwise report `INTEGRATION-GAP`.

#### Qwen3-TTS Base

- Validate the local directory against its config and tokenizer references.
- Specifically verify all referenced speech-tokenizer assets are present; a
  large `model.safetensors` alone is not sufficient.
- Load with `local_files_only`/offline behavior using the intended Qwen runtime.
- Generate a short licensed English test phrase; record initialization and
  generation time, RAM/VRAM, output sample rate/duration/hash, clipping, and
  silence ratio.
- Test cancellation and a second warm inference.
- Require real Worker capability, consent/provenance, UI insertion, reload, and
  audible export before awarding end-to-end points.

#### Qwen3-TTS VoiceDesign

- Validate filename/index compatibility. The current downloaded weight is named
  `model_2.safetensors`; prove the loader expects and finds that exact file.
- Generate one neutral and one instruction-designed voice from the same text.
- Verify both outputs are valid and measurably distinct; retain only nonprivate,
  synthetic samples.
- Never use a real person's voice or claim voice cloning without explicit
  consent evidence.

### 8.3 Masking model matrix

#### BiRefNet General and Portrait

- Verify both ONNX files load locally and rembg resolves the intended files
  without downloading replacements.
- Test general subject, portrait/hair, transparent-edge, and difficult-background
  fixtures.
- Validate mask dimensions, grayscale/alpha semantics, nonempty foreground,
  edge continuity, output transparency, and source preservation.
- Test Subject and Person UI routes separately.

#### SAM 2.1 Hiera Large

- Prove both the local directory and intended runner load offline.
- For an image, test positive/negative points and a bounding box.
- For a short video, seed on a middle frame, propagate forward and backward,
  and measure frame count, duration, mask continuity, and subject loss.
- Validate VP9-alpha WebM output and preserved source audio where required.
- Confirm the Inspector remains available for both video and still-image clips.

#### Grounding DINO Tiny

- Load the local directory offline. Prefer `model.safetensors`; record why the
  duplicate `pytorch_model.bin` is or is not required.
- Test at least three prompts with known fixture ground truth, including one
  no-match prompt.
- Validate bounding boxes remain within image bounds and no-match behavior is a
  truthful error/empty result.
- Feed a detected box into SAM 2.1 and retain the combined Grounded-SAM proof.

### 8.4 Upscaling model matrix

#### Real-ESRGAN x4+

- Confirm `JOY_MEDIA_REAL_ESRGAN_MODEL` resolves to the checkpoint.
- Load through the included JOY runner, not a separate demo script.
- Test a small photographic image, a text/graphic image, and an RGBA image.
- Validate output dimensions, scale option, alpha handling, color channels,
  no overwrite of the source, nonzero output, and deterministic metadata.
- Compare Program Monitor before/after and verify the derived asset survives
  reload and export.
- Do not claim video upscaling unless a current video runner advertises and
  executes it.

## 9. Phase 30 — Worker, pairing, Jobs, and control plane

1. Start the Worker from the repository launcher and capture only redacted logs.
2. Verify Worker identity/state file permissions without printing its token.
3. Pair/approve only if needed; use the current user's Worker and never revoke an
   unrelated device.
4. Compare advertised capabilities with successful model-runner qualification.
5. A capability must disappear or report unavailable when its runner/model is
   absent; false “ready” is P1.
6. Test queue, claim, begin, progress, success, failure, cancellation, retry,
   reconnect, lease expiry, and duplicate-request idempotency.
7. Confirm local source paths and model paths never appear in API payloads,
   browser network responses, project JSON, or user-visible provenance.
8. Confirm Jobs tabs (Workers, Queue, Pair) use truthful state and English copy.
9. Confirm a completed derivative belongs to the exact source asset/project and
   cannot be attached cross-project.

Required failure drills:

- source asset missing locally;
- Worker disconnected before claim;
- Worker disconnected during inference;
- invalid model path;
- insufficient memory/device error;
- malformed output;
- user cancellation;
- retry after reconnect.

## 10. Phase 40 — Disposable project and media journey

Create exactly one project:

```text
LUNA Full Platform <UTC-run-id> <short-sha>
```

Immediately record its ID. Generate/use deterministic licensed fixtures:

- landscape video with audible stereo audio;
- portrait video;
- still photo;
- transparent PNG;
- animated GIF/WebP;
- speech WAV with controlled noise;
- music mix suitable for stem separation;
- valid SRT and WebVTT;
- malformed media and malformed captions for negative tests.

Journey:

1. Create, rename, save, close, reopen, refresh, trash, restore, and later
   permanently delete only the disposable project.
2. Import every fixture and verify type, dimensions, duration, codec, thumbnail,
   preview, and project ownership.
3. Verify local/original/cloud availability labels are truthful.
4. Reload and verify OPFS/cloud recovery without duplicated assets.
5. Test search, filter, sort, category, selection, bulk action, and failed import.
6. Prove assets from another project do not appear as project-owned media.
7. Place media by the actual visible controls and physical drag/drop.
8. Record all console errors, page errors, failed requests, and unexpected
   network calls from the beginning of the journey.

## 11. Phase 50 — Workspace shell and information architecture

Test the default workspace and each available preset at all required viewports:

- `1639×1066` desktop-primary;
- `1366×768` desktop-compact;
- `1024×768` desktop-minimum.

Acceptance matrix:

- every visible top-level feature has one logical home;
- Media, Edit, Enhance, and Deliver routes remain discoverable;
- tabs are sorted and grouped consistently;
- Animate/Motion responsibilities are coherent rather than duplicated;
- Transition, Effects, Filters, Color, and Adjust remain reachable;
- Captions and the separate Text Templates tab remain distinct;
- Inspector, Joy Code, Jobs, Program Monitor, Timeline, and Flow titles/icons
  match their content;
- minimal SVG icons are crisp, accessible, and follow `DESIGN.md`;
- no obsolete explainer line consumes panel space;
- no application-chrome Persian/Arabic text remains. Exclude user-authored media
  content and caption text from this scan;
- menus, drawers, popovers, and right-click actions match the JOY theme;
- keyboard focus, Escape, outside-click, and z-index behavior are correct;
- no page-level horizontal overflow or clipped critical control occurs.

## 12. Phase 60 — Classic Timeline and Dual Lens/Flow

Build one showcase composition containing every current timeline element type.
At minimum cover:

- main video and B-roll video;
- overlay/image;
- 3D scene generated/managed through Joy Code;
- editable text;
- CC captions;
- motion/animation;
- effects;
- filters;
- adjustment layer with a selected parent video/image;
- audio;
- sound effect;
- text-to-speech;
- transition junction.

Do not add Sticker as a required timeline type; the current owner direction is
to use the agreed six creative treatment families plus existing media, text,
caption, audio, transition, and 3D types.

### 12.1 Classic Timeline

- Verify track labels and clip artwork distinguish every type while preserving
  the darker background/lighter-element hierarchy.
- Verify the Flow/Dual Lens provenance line is absent from Classic Timeline.
- Horizontally scroll: track headers must stay at the physical left edge of the
  timeline content and disappear with the intended scroll behavior rather than
  floating over clips.
- Verify ruler, track header, and `0:00.00` areas have the current minimal
  background treatment.
- Verify scrollbars, zoom, Fit, follow-playhead, terminal time, and playhead hit
  testing.

### 12.2 Dual Lens/Flow

- Verify Time/Flow/Split modes, graph provenance, controller relationships,
  reveal/drill-in, and return to parent composition.
- Verify Dual Lens information appears only where it belongs and never leaks
  into Classic Timeline.
- Compare selection, playhead, source time, and Program Monitor between views.

### 12.3 Editing operations

- select one/many, range-select, move, trim, split, duplicate, reverse, freeze,
  speed/ramp, merge valid clips, reject invalid merge, ripple delete, Undo/Redo;
- drag between valid tracks and reject invalid kinds;
- lock, visibility, mute/solo/headphone controls and keyboard behavior;
- nested composition drill-in, offset preservation, and Back;
- right-click opens the themed timeline drawer over the timeline, never a raw
  browser menu or controls appended below the timeline;
- drawer actions, disabled states, shortcuts, focus containment, and dismissal;
- persistence after refresh/reopen and exact Undo/Redo boundaries;
- timeline/Inspector/Monitor agree on selection and current time.

## 13. Phase 70 — Inspector and creative treatment surfaces

### 13.1 Inspector core

- Visual, Mask, Enhance where eligible, Effects, Audio, and Speed tabs appear
  only for compatible selected elements.
- Image clips expose both Mask and Enhance; selecting one must not hide the
  other after refresh.
- Nothing-selected and source-missing states remain useful and truthful.
- Transform, crop, scale, rotation, opacity, blend, parenting, and expressions
  apply to the intended element and survive reload.
- Keyframe controls use an outlined diamond when no keyframe exists at the exact
  time and a filled diamond when one exists; test add/update/remove/navigation.

### 13.2 Animate/Motion

- Apply built-in presets, custom motion, spatial path, camera, and HTML scene.
- Verify preview is time-varying, editable, undoable, persistent, and exported.
- Verify motion controls and timeline Motion elements represent one coherent
  model rather than unrelated duplicates.

### 13.3 Transitions

- Apply, replace, favorite, edit duration, remove, undo, reload, and export.
- Test beginning/end junction constraints and adjacent clip changes.

### 13.4 Effects

- Apply multiple effects; toggle, edit, reorder, remove, undo, and persist.
- Verify visual preview and exported pixels change.
- Test Effect Studio recipe creation/application where currently supported.

### 13.5 Filters

- Verify the filter library includes and executes representative blur/noise
  families, including Gaussian and radial blur where advertised.
- Test strength, animation, reset, persistence, preview/export parity, and
  unsupported-device fallback.
- A thumbnail-only preview with no render effect is a failure.

### 13.6 Color

- Test manual grade, LUT, reset, scope/parade, persistence, and export parity.
- Verify the Color SVG and all nav icons match current JOY visual rules.

### 13.7 Adjustment layer

- Add a separate `Adjust` timeline layer.
- Select an explicit parent video or picture.
- Apply effects/color/filter/opacity/blend changes to the adjustment layer.
- Prove treatment scope, stacking/order, parent reassignment, missing-parent
  handling, Undo/Redo, reload, and export.
- Ensure the source clip is not destructively rewritten.

## 14. Phase 75 — Captions and Text Templates

### 14.1 Captions

- import SRT and WebVTT; create/edit/delete cues; seek by cue;
- verify timings, overlap validation, language metadata, RTL content support,
  style presets, opacity/scale, and caption-track timeline element;
- transcribe a licensed English fixture through the available real route;
- test progress, cancellation, retry, confidence, and source-language display;
- export SRT/WebVTT and compare parsed cues/timings;
- burn captions into video and verify visible frames plus reload/export parity;
- UI chrome remains English even when caption content is Persian/RTL.

### 14.2 Text Templates

- verify 10–20 distinct title/lower-third/highlight-line templates are visible;
- add representative templates to the timeline through real UI interaction;
- edit text, font, size, color, gradient, highlighted word, shadow, glow, blend,
  opacity, alignment, and timing;
- verify template insertion is atomic/undoable, state persists, and export matches
  Program Monitor;
- confirm Text Templates remain separate from caption-track authoring.

## 15. Phase 80 — Audio Studio and audible project proof

Test Enhance, Mix, and Runtime as one workflow.

### 15.1 Source/target state

- selected clip, selected track, and full timeline targeting;
- correct clip counts and source eligibility;
- Browser DSP, Local Worker, Cloud Brain, device, and runtime states are truthful;
- Local Worker disconnected/source-missing/model-missing messages lead to an
  actionable state and never claim readiness.

### 15.2 Enhance workflows

- Voice Polish, Podcast Quality, YouTube Master, Voice Design, Music Stems, and
  Audio Repair routes where advertised;
- each processing step identifies its execution target and readiness;
- actual processing changes audio bytes/samples, creates provenance, and remains
  undoable/recoverable;
- disabled or catalog-only routes are reported as integration gaps, not passed
  based on static cards.

### 15.3 Mix and automation

- keep each voice adjustment row on one compact line at supported widths;
- gain, pan, mute/solo, fades, compressor/EQ/limiter/normalize, master output;
- outlined/filled keyframe diamonds at exact playhead time;
- automation interpolation, next/previous keyframe, delete, Undo/Redo, reload;
- waveform/meters respond, do not clip incorrectly, and stay synchronized.

### 15.4 Audible acceptance

- create a mix containing source video audio, dedicated audio, sound effect,
  TTS, and at least one enhanced/denoised result;
- verify mute, gain, timing, fades, and sample continuity in preview;
- export and use FFprobe plus objective audio measurements;
- require AAC/audio stream, expected duration, non-silent RMS/loudness, bounded
  peak, and audible content at expected timeline intervals;
- compare warm/cold Worker runs and record runtime/resource use.

## 16. Phase 85 — Mask Inspector end-to-end

For both a still image and a short video:

1. Select the clip and open Mask.
2. Test Auto, BiRefNet, and SAM 2 + Grounding DINO routes that qualify locally.
3. Test Subject, Person, Prompt, positive/negative points, and Box.
4. Test Add/Subtract, Feather, Expand, Detail, Decontaminate, and Invert.
5. Create Mask and Remove BG.
6. Verify progress, cancellation, error recovery, provenance, derivative receipt,
   asset ownership, transparency, and timeline replacement/attachment behavior.
7. Reload/reopen and verify the result remains available.
8. Compare Program Monitor and exported composite/alpha behavior.
9. Confirm source remains unchanged and can be restored.
10. Confirm video tracking duration/frame count/audio retention.

SAM 3/3.1 is not required because the owner's Hugging Face access was rejected.
It must not reduce the score when it is absent, and JOY must not claim it is
installed. If the UI offers it, it must clearly identify gated/unavailable
status without attempting unauthorized access.

## 17. Phase 90 — Enhance/upscale end-to-end

1. Select a still-image clip and confirm Enhance and Mask coexist.
2. Run the qualified Real-ESRGAN path at all advertised scale choices.
3. Verify progress, cancel, retry, device/resource reporting, and source-missing
   behavior.
4. Compare dimensions, file format, alpha, color, detail, artifacting, and output
   size with the source.
5. Ensure the derivative belongs to the exact project/source and provenance
   records model ID/version/checkpoint hash without exposing local paths.
6. Insert/apply the derivative, reload, Undo/Redo, and export.
7. Verify no silent Cloud fallback or paid request occurs.

## 18. Phase 92 — Joy Code and agent-controlled editing

- Composer welcome/instructions and all application chrome are English.
- Submit safe commands for timeline insertion, trim, split, transform, caption,
  text, motion, effect, adjustment layer, mask request, upscale request, and 3D
  element creation where tools exist.
- Verify plan preview, approval mode, explicit mutation boundary, command-bus
  result, Undo/Redo, durable revision, history, idempotency, and reload.
- Reject invalid, duplicate, cross-project, unsupported, or unapproved actions
  with actionable errors.
- Ensure Joy Code cannot bypass Worker locality, provider consent, project
  ownership, or model readiness.
- Compare agent-created timeline elements with equivalent human-created elements;
  they must use the same schema, Inspector, renderer, and export path.

## 19. Phase 95 — Program Monitor, playback, export, and recovery

### 19.1 Monitor/playback

- play, pause, seek, scrub, step, loop/end-of-file, keyboard Space, fit/fullscreen;
- aspect selector has adequate width and no redundant left-side dimensions/time
  copy remains where the current design removed it;
- verify all supported aspect presets and atomic dimension changes;
- preview reflects timeline order, transforms, animation, transition, effects,
  filter, color, adjustment, captions, masking, 3D, and audio at sampled times;
- no stale frame after project switch, source replacement, or reload.

### 19.2 Export

- run preflight and export H.264/AAC from the integrated showcase project;
- record settings, expected frame count/duration/aspect, and operation identity;
- verify downloaded bytes with SHA-256 and FFprobe;
- sample frames before/during/after transitions and treatment layers;
- validate caption visibility/timing and audio measurements;
- refresh and re-download the exact completed export byte-for-byte;
- test cancellation, interrupted recovery, retry idempotency, and cleanup;
- Process Center status must agree with API and retained output.

## 20. Phase 97 — Nonfunctional gates

### 20.1 Browser reliability

At each viewport, record:

- page errors;
- console errors and warnings;
- failed/cancelled same-origin requests;
- unhandled rejections;
- duplicate jobs/operations;
- body and panel overflow;
- focus loss/traps;
- stale loading states.

### 20.2 Accessibility

- axe scan at representative project, timeline, Inspector Mask, Audio, Caption,
  Jobs, export, and drawer states;
- full keyboard route through primary actions;
- visible focus, accessible names, selected/expanded/disabled states;
- dialogs/drawers trap and restore focus;
- contrast for timeline element families and selected states;
- reduced-motion and coarse-pointer checks.

### 20.3 Performance and stability

Measure cold and warm:

- shell/project load;
- asset preview readiness;
- timeline interaction latency on the showcase project;
- play/scrub responsiveness and dropped frames;
- each local model load and inference;
- export duration and peak resource use.

Run a 15-minute stability loop: playback, scrub, switch tabs, run one local
derivative, Undo/Redo, save/reload, and repeat. Record memory before/after,
detached Workers/processes, crashes, and queue leaks. Do not invent universal
performance budgets; compare against the same machine/run baseline and flag
large regressions or user-visible stalls.

### 20.4 Security/privacy

- signed-out editor/API behavior and protected endpoint rejection;
- project and asset ownership isolation;
- Worker session revocation and pairing boundaries;
- path/secret/token redaction;
- malicious filename and malformed media/caption handling;
- no shell construction from prompts, filenames, or model parameters;
- model files remain outside Git and are never uploaded to the API;
- no unexpected paid/cloud operation.

## 21. Phase 99 — Cleanup and reconciliation

Cleanup is mandatory acceptance work.

1. Cancel or wait for every run-created job to become terminal.
2. Remove only derivatives, exports, imported fixture objects, and browser
   downloads created by the recorded run IDs.
3. Permanently delete only the disposable project by its exact ID.
4. Do not revoke the owner's persistent Worker unless the run created a separate
   disposable Worker identity.
5. Do not delete model files, virtual environments, caches, or the Demucs
   junction.
6. Compare final project/asset/job/export/derivative/Worker counts with baseline.
7. Verify no test process, dev server, browser download, temporary media, or
   leased operation remains unintentionally.
8. Record any intentional retained evidence with hashes and owner-approved
   retention.

Any uncertain target or count mismatch is P1 and stops a passing closeout.

## 22. Phase 100 — Required final report

Create `docs/qa/LUNA-PLATFORM-0-TO-100-REPORT-<UTC-run-id>.md` with this exact
structure:

### 22.1 Executive result

```text
Final score: NN/100
Integrity cap: none | <reason and cap>
Decision: GO | CONDITIONAL | NO-GO
Candidate: <commit + dirty patch hash>
Local run: PASS/PARTIAL/FAIL
Production smoke: PASS/PARTIAL/FAIL/NOT RUN
Cleanup: PASS/FAIL
P0/P1/P2/P3: N/N/N/N
```

State the three most important truths in plain language. Do not lead with test
counts if a real journey or model is blocked.

### 22.2 Scorecard

| Area      |  Weight | Earned | Status | Key evidence | Open findings |
| --------- | ------: | -----: | ------ | ------------ | ------------- |
| A–M       |         |        |        |              |               |
| **Total** | **100** | **NN** |        |              |               |

Explain every partial/zero and every applied integrity cap.

### 22.3 Environment and candidate

Include repository identity, dirty patch, runtime versions, machine/GPU,
model-root digest, public release evidence, and test project ID.

### 22.4 Automated gates

List each command, start/end UTC, exit code, pass/fail/skip/retry totals, log
path, and failure disposition.

### 22.5 Model qualification table

| Model/runtime         | Artifact | Loader | Inference | Worker | UI  | Project/export | Runtime/resources | Finding |
| --------------------- | -------- | ------ | --------- | ------ | --- | -------------- | ----------------- | ------- |
| RNNoise               |          |        |           |        |     |                |                   |         |
| DeepFilterNet         |          |        |           |        |     |                |                   |         |
| HTDemucs              |          |        |           |        |     |                |                   |         |
| Qwen3-TTS Base        |          |        |           |        |     |                |                   |         |
| Qwen3-TTS VoiceDesign |          |        |           |        |     |                |                   |         |
| BiRefNet General      |          |        |           |        |     |                |                   |         |
| BiRefNet Portrait     |          |        |           |        |     |                |                   |         |
| SAM 2.1 Hiera Large   |          |        |           |        |     |                |                   |         |
| Grounding DINO Tiny   |          |        |           |        |     |                |                   |         |
| Real-ESRGAN x4+       |          |        |           |        |     |                |                   |         |

Explicitly identify catalog-only cards and missing Worker adapters.

### 22.6 Platform journey matrix

Report every phase/surface, viewport, expected result, actual result, evidence,
and finding IDs. Include Classic Timeline and Dual Lens separately.

### 22.7 Output verification

Include export hash/size, FFprobe streams, duration/frame/aspect, sampled-frame
evidence, caption proof, audio measurements, and preview/export discrepancies.

### 22.8 Accessibility, performance, security, and resilience

Include axe totals, keyboard findings, overflow matrix, timings/resources,
stability-loop result, auth/privacy checks, and failure drills.

### 22.9 Friction ledger

Include every `LUNA-F###`, severity, reproduction, evidence, disposition,
score impact, and recommended owner/work package. Do not hide expected gaps in
prose.

### 22.10 Cleanup proof

Show baseline/final counts, exact disposable project deletion, terminal job
states, retained evidence, and any discrepancy.

### 22.11 Recommendation

Provide:

- what is genuinely production-ready;
- what is locally installed but not integrated;
- what is UI/catalog only;
- P0/P1 fixes required before release;
- prioritized P2/P3 follow-ons;
- the smallest next implementation package that moves the score materially.

## 23. Final acceptance checklist

- [ ] Exact candidate and dirty patch recorded.
- [ ] Starting user state protected and baselined.
- [ ] Full static/unit/build/audit gates run.
- [ ] Three-viewport browser audit run.
- [ ] One real disposable project completed end-to-end.
- [ ] Classic Timeline and Dual Lens tested separately.
- [ ] Every current creative/editor surface tested.
- [ ] Every downloaded model artifact and loader tested offline.
- [ ] Every advertised Worker capability tested physically.
- [ ] Catalog-only versus integrated models stated truthfully.
- [ ] Masking tested for image and video.
- [ ] Real-ESRGAN tested through JOY's included runner.
- [ ] Audio output proven audible and measured.
- [ ] Export verified by FFprobe, hashes, frames, captions, and audio.
- [ ] Joy Code and Jobs tested without bypassing approval/locality.
- [ ] English-only application chrome verified.
- [ ] Accessibility, responsive, security, performance, and resilience checked.
- [ ] Console/page/network errors reconciled.
- [ ] Cleanup matches baseline exactly.
- [ ] Evidence package complete and redacted.
- [ ] Weighted score and integrity caps calculated correctly.
- [ ] Final report contains a clear GO/CONDITIONAL/NO-GO decision.

Luna may report `100/100` only when every box above is supported by retained
evidence and the final report contains no unresolved contradiction.
