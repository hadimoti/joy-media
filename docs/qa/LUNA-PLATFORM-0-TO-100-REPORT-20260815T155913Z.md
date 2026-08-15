# Luna Platform 0-to-100 Test and Report

Run date: 2026-08-15 15:59:13 UTC
Plan: `plan/LUNA-PLATFORM-0-TO-100-TEST-AND-REPORT.md`
Repository: `codex/audio-enhance-workspace`
Candidate commit: `d5ec5c9a0fab57b8a77b434ad4ea3312b6b7f192`
Decision: **NO-GO for an unqualified production release**
Raw score: **72.5 / 100**
Integrity-capped score: **69 / 100**

## Executive result

The platform is in a strong testable state: the repository installs, typechecks,
lint-checks, builds, passes the complete unit suite, passes the production
dependency audit, serves the public editor and Media API, and completes the
disposable real-project journey on retry at all three desktop sizes. The live
Inspector exposes the intended Enhance and Mask surfaces, the Mask UI is
present and honest when the selected clip has no source, and the deployed page
had no application console errors during smoke testing.

It is not a 100% release candidate yet. The downloaded model directory contains
real artifacts, but several advertised local runtimes are not executable in the
current Windows setup. In addition, Persian transcription deterministically
returns English text, the aspect-ratio browser assertion still targets a UI line
that was intentionally removed, and Worker insertion has an intermittent
asset-fixture race. The most important release blockers are the model/runtime
seams, not the core editor shell.

## 1. Candidate and environment

| Item                     | Result                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Branch / commit          | `codex/audio-enhance-workspace` / `d5ec5c9a0fab57b8a77b434ad4ea3312b6b7f192`                                            |
| Working tree at start    | `M run-worker.bat`; new plan file untracked; preserved unchanged                                                        |
| Node                     | `v22.22.3`                                                                                                              |
| Required package manager | `corepack pnpm@11.15.0`                                                                                                 |
| Global pnpm              | `11.17.0` (not used for gates)                                                                                          |
| Python                   | `3.11.15` in audio and masking environments                                                                             |
| FFmpeg / FFprobe         | available from WinGet links                                                                                             |
| Model root               | `C:\Users\HadiMoti\JOY\models`                                                                                          |
| Model root inventory     | 55 files / 13,370,020,669 bytes / 12.45 GiB                                                                             |
| GPU                      | no GPU-dependent path was assumed; CPU paths were used                                                                  |
| Live editor              | `https://joyst.ir/` returned HTTP 200                                                                                   |
| Live Media API           | `https://media.joyteam.ir/api/health` returned HTTP 200 and `{"ok":true,"service":"joy-media-api","controlPlane":true}` |
| Admin page               | `https://admin.joyteam.ir/brain` returned HTTP 200                                                                      |

The pre-existing `run-worker.bat` model-path change was not modified or
discarded. It points Worker model variables at the JOY model root, but the
runtime qualification below shows that path wiring alone is not sufficient for
all providers.

## 2. Weighted scorecard

| Area                                                                       |  Weight |   Earned | Status      | Evidence / reason                                                                                                                                              |
| -------------------------------------------------------------------------- | ------: | -------: | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Repository, build, dependency, artifact integrity                       |       7 |      3.5 | PARTIAL     | Install, typecheck, lint, tests, build and audit pass; format check reports 87 existing files.                                                                 |
| B. Identity, API, projects, persistence, control plane                     |       8 |        8 | PASS        | Public app/API health and real-project journey pass on focused retry.                                                                                          |
| C. Media Library, import, preview, isolation, recovery                     |       8 |        8 | PASS        | Full e2e coverage plus WP-32 passes all three viewport projects on retry.                                                                                      |
| D. Workspace shell, IA, menus, visual language                             |       7 |        7 | PASS        | Live page smoke exposes the current tab grouping and no app console errors.                                                                                    |
| E. Classic Timeline, Dual Lens/Flow, editing, tracks, persistence          |      13 |      6.5 | PARTIAL     | Merge/speed paths pass; aspect-ratio assertion cannot find the intentionally removed monitor meta line.                                                        |
| F. Inspector, animation, transitions, effects, filters, color, adjustments |      11 |       11 | PASS        | Full editor audit plus live Inspector; Enhance, Mask, Effects, Audio, Speed and Adjust surfaces are present.                                                   |
| G. Captions, CC elements, text templates, editable typography              |       6 |        3 | PARTIAL     | Caption import/export/RTL-template paths pass; Persian transcription content is wrong in all viewports.                                                        |
| H. Audio Studio, mix/runtime routes, models, audible output                |      10 |        5 | PARTIAL     | Browser DSP and Demucs pass; RNNoise Windows path, DeepFilter model, and Qwen runtime remain incomplete.                                                       |
| I. Masking, background removal, mask export                                |       9 |      4.5 | PARTIAL     | BiRefNet General and Portrait run; SAM2/Grounding runtime packages are absent.                                                                                 |
| J. AI image enhancement/upscaling                                          |       5 |      2.5 | PARTIAL     | Real-ESRGAN works only with a test compatibility shim; the shipped runner fails without it.                                                                    |
| K. Joy Code, Jobs, Worker, pairing, approvals, provenance                  |       5 |      2.5 | PARTIAL     | Protocol-fixture Worker insertion passes on retries in two viewports but has an intermittent asset race; physical local Worker was disconnected in live smoke. |
| L. Monitor, playback, export, Process Center, recovery                     |       7 |        7 | PASS        | WP-32 export journey passes all three viewports on focused retry; public API and editor are healthy.                                                           |
| M. Accessibility, responsive behavior, performance, security, cleanup      |       4 |        4 | PASS        | Three viewport audit completed; no application console errors; no cross-project mutation observed.                                                             |
| **Raw total**                                                              | **100** | **72.5** | **PARTIAL** | Model and caption gaps prevent a release claim.                                                                                                                |

### Integrity caps applied

- **Maximum 69:** unresolved P1 integration/correctness findings remain.
- The installed model set also contains providers without a verified loader or
  Worker path, so the model-readiness cap would independently prevent a 100
  score.
- No P0 security, privacy, or cross-project exposure was found.

## 3. Automated gates

All repository gates used the pinned package-manager version through Corepack.

| Command                                                   | Result         | Details                                                                                                                         |
| --------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm@11.15.0 install --frozen-lockfile`         | PASS           | Already up to date.                                                                                                             |
| `corepack pnpm@11.15.0 typecheck`                         | PASS           | Exit code 0.                                                                                                                    |
| `corepack pnpm@11.15.0 lint`                              | PASS           | Exit code 0.                                                                                                                    |
| `corepack pnpm@11.15.0 test`                              | PASS           | 321 files passed, 1 skipped; 2,206 tests passed, 2 skipped.                                                                     |
| `corepack pnpm@11.15.0 format:check`                      | FAIL / P2      | 87 existing files reported; no formatting changes were made during this test run.                                               |
| `corepack pnpm@11.15.0 build`                             | PASS           | All workspaces built; Vite build completed in 5.97s.                                                                            |
| `corepack pnpm@11.15.0 audit:prod`                        | PASS           | No known vulnerabilities found.                                                                                                 |
| `corepack pnpm@11.15.0 test:e2e:audit`                    | FAIL / triaged | 153 tests: 141 passed, 3 skipped, 9 failed.                                                                                     |
| Focused retry of four failing specs across three projects | FAIL / triaged | 36 tests: 29 passed, 7 failed; stable aspect-ratio and Persian failures; Worker failure moved viewport; WP-32 passed all three. |

The three skipped e2e cases are the intentional Local Worker audio cases; they
require an external paired Worker and were not silently counted as passes.

## 4. Model qualification

Status meanings: artifact means the local files exist; loader means the native
runtime can open them; inference means a real sample produced valid output;
Worker/UI means the product path can invoke it, not merely list a card.

| Model / runtime       | Artifact                                                                                               | Loader                                      | Inference                                              | Worker / UI                         | Finding                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| RNNoise `mp.rnnn`     | PASS; SHA-256 `4E84A448A4BAF937992AAF4D10C8258007EC5D24219B6647DFD5FB4B563AD231`                       | PASS with escaped Windows filter path       | PASS; 3.000s, 48 kHz mono WAV                          | FAIL with current raw Windows path  | `apps/worker/src/local-gpu.ts:291` builds `arnndn=m=<path>` without Windows filter escaping.                                    |
| DeepFilterNet 0.5.6   | PASS; Windows binary SHA-256 `75E11FA16445F560CB6B021521DDB89E89270D13B83089705D98776F58FD7915`        | PASS; `deep_filter 0.5.6 --version`         | BLOCKED                                                | BLOCKED                             | The binary is present but no required DeepFilter model archive (`.tar.gz`) is present.                                          |
| HTDemucs              | PASS; snapshot weight SHA-256 `D9FA14133CFCC034A6758923BB3A8CA9F8DFD0B582134643BBF83F72C17576DD`       | PASS offline with `HF_HUB_OFFLINE=1`        | PASS; CPU CLI produced bass, drums, other, vocals WAVs | Partial                             | Demucs v4.1.0 and torch CPU are installed in the isolated audio environment; no end-to-end Worker insertion was claimed.        |
| Qwen3-TTS Base        | PASS; weight SHA-256 `38FC7FC51C5E776E840414B6FD443962E9411B9654888FD7913E4DA643CB857C`                | BLOCKED                                     | BLOCKED                                                | Catalog/UI route only               | `qwen_tts`, `transformers`, and `soundfile` are absent from the audio environment.                                              |
| Qwen3-TTS VoiceDesign | PASS; `model_2.safetensors` SHA-256 `391E8DB219F292C515297CDCEEB43E4EAE67CDDE35FA57E79A6A8A532FCA0522` | BLOCKED                                     | BLOCKED                                                | Catalog/UI route only               | Same missing runtime; filename/model compatibility was not asserted without the native loader.                                  |
| BiRefNet General      | PASS; SHA-256 `58F621F00F5D756097615970A88A791584600DCF7C45B18A0A6267535A1EBD3C`                       | PASS with rembg/ONNX Runtime                | PASS; RGBA 320×180 output                              | Partial                             | Real model was loaded via a test cache alias; live Mask UI exposes the route but no source clip was available for a live job.   |
| BiRefNet Portrait     | PASS; SHA-256 `1BA1C8FF5A7BBFADC8D8D13FB11D7BE793F91F23D9D466549E37A854F6668F99`                       | PASS with rembg/ONNX Runtime                | PASS; RGBA 320×180 output                              | Partial                             | Same source-clip qualification boundary as General.                                                                             |
| SAM 2.1 Hiera Large   | PASS; `.pt` SHA-256 `2647878D5DFA5098F2F8649825738A9345572BAE2D4350A2468587ECE47DD318`                 | BLOCKED                                     | BLOCKED                                                | UI option exists; Worker blocked    | The masking environment has no `sam2`, `torch`, or `transformers` package. The model files alone are not a usable SAM provider. |
| Grounding DINO Tiny   | PASS; safetensors SHA-256 `1A2412EF99BD74BCD3C2A246FA1E48581F8889A1300C9051974741314FC042F3`           | BLOCKED                                     | BLOCKED                                                | UI option exists; Worker blocked    | The same missing transformer runtime prevents the prompt/grounding route.                                                       |
| Real-ESRGAN x4+       | PASS; SHA-256 `4FA0D38905F75AC06EB49A7951B426670021BE3018265FD191D2125DF9D682F1`                       | FAIL in shipped runner; PASS with test shim | PASS with test shim; 320×180 → 640×360 PNG             | FAIL until dependency seam is fixed | `basicsr==1.4.2` imports removed `torchvision.transforms.functional_tensor` under pinned torchvision 0.23.0.                    |

## 5. Platform journey matrix

| Surface / phase                         | Local result                  | Live result                         | Evidence / disposition                                                                                                                   |
| --------------------------------------- | ----------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| App boot, identity, health              | PASS                          | PASS                                | `joyst.ir` 200; Media API health 200; admin page 200.                                                                                    |
| Media Library and asset browsing        | PASS                          | PASS                                | Full e2e audit and live initial Media workspace.                                                                                         |
| Classic Timeline                        | PASS with one stale assertion | PASS                                | Live body shows tracks, `ADJ1 Adjust`, and current compact timeline. Remove/update the old `monitor-meta` selector in the test contract. |
| Dual Lens / Flow                        | PASS in audit coverage        | Not separately opened in live smoke | No live mutation was made; keep this as a follow-up manual smoke when the paired Worker is available.                                    |
| Inspector / Enhance / Mask              | PASS                          | PASS                                | Live selected clip showed Visual, Enhance, Mask, Effects, Audio, Speed and Adjust.                                                       |
| Effects / Filters / Color / Adjust      | PASS in audit                 | PASS surface presence               | No application console errors; current Mask selection correctly showed `Worker ready · source missing`.                                  |
| Captions / CC timeline / text templates | PARTIAL                       | Not opened in live smoke            | Import/export/RTL templates pass; Persian transcription is wrong across primary, compact, and minimum.                                   |
| Audio Studio                            | PARTIAL                       | PASS for Browser DSP UI             | Browser DSP plan shows 3/3 ready; actual local model/provider readiness is partial as documented above.                                  |
| Mask export / background removal        | PARTIAL                       | PASS UI only                        | BiRefNet inference passes offline; SAM2 route is blocked by missing packages.                                                            |
| Joy Code / Jobs / pairing               | PARTIAL                       | Worker disconnected                 | Protocol fixture insertion is exercised; physical paired Worker run remains unavailable.                                                 |
| Program Monitor / playback / export     | PASS                          | PASS                                | WP-32 focused retry passes all three viewports.                                                                                          |

## 6. Findings ledger

### LUNA-F001 — Persian transcription returns English content

- Area: G / captions
- Severity: **P1**, open
- Reproduction: run `[R5 CASE-59] transcribes Persian with RTL punctuation,
confidence, and caption seek` under desktop-primary, desktop-compact, and
  desktop-minimum.
- Expected: `سلام به استودیوی جوی خوش آمدید.` in the `fa-IR` caption source.
- Actual: `Welcome to JOY Media Studio today.` in all three viewports.
- Evidence: `test-results/wp29-r5-batch-c-WP-29-R5-b-bf261-confidence-and-caption-seek-desktop-primary/`, with equivalent compact and minimum folders.
- Disposition: fix fixture/locale result wiring or transcription response
  selection before release; do not mask this with a language-direction-only
  assertion.

### LUNA-F002 — RNNoise model path is not escaped for Windows FFmpeg filters

- Area: H / audio Worker
- Severity: **P1**, open
- Reproduction: run FFmpeg with the configured path from `run-worker.bat`:
  `arnndn=m=C:\Users\HadiMoti\JOY\models\audio\rnnoise\mp.rnnn`.
- Expected: configured Worker route produces a denoised WAV.
- Actual: FFmpeg rejects the filter expression because the Windows drive/path
  is parsed as filter syntax. The same model succeeds when the drive colon is
  escaped and the value is quoted; output was a valid 3.000s 48 kHz mono WAV.
- Root seam: `apps/worker/src/local-gpu.ts:291` passes the raw path.
- Disposition: add platform-safe FFmpeg filter escaping and a Windows Worker
  regression test.

### LUNA-F003 — Real-ESRGAN runner is incompatible with the pinned torchvision

- Area: J / upscaling
- Severity: **P1**, open
- Reproduction: launch `apps/worker/upscaling/joy_realesrgan_runner.py` in the
  isolated environment created from `requirements-image.txt`.
- Expected: the local Real-ESRGAN checkpoint produces an upscaled image.
- Actual: the runner exits before model load with
  `ModuleNotFoundError: torchvision.transforms.functional_tensor` from
  `basicsr==1.4.2` under `torchvision==0.23.0`. A test-only import alias made
  the same checkpoint produce a valid 640×360 PNG, proving the model artifact
  is usable once the dependency seam is corrected.
- Disposition: pin a compatible torchvision/torch stack or add a maintained
  compatibility layer in the runtime; do not ship the test shim implicitly.

### LUNA-F004 — SAM2/Grounding DINO artifacts have no installed native runtime

- Area: I / masking
- Severity: **P1**, integration-gap
- Reproduction: probe the masking environment and invoke the provider imports.
- Expected: the visible SAM2 + Grounding DINO choice can load local models.
- Actual: `sam2`, `torch`, and `transformers` are absent; the UI option is
  present but the Worker cannot execute this provider.
- Disposition: install and qualify the official runtime in an isolated Worker
  environment, including offline local-path loading, before presenting it as
  available.

### LUNA-F005 — Qwen3-TTS artifacts are catalog-only in the current environment

- Area: H / TTS and Voice Design
- Severity: **P1**, integration-gap
- Reproduction: probe the audio environment for `qwen_tts`, `transformers`, and
  `soundfile`, then attempt a local load from both Qwen directories.
- Expected: Base and VoiceDesign models can be loaded locally for an audio job.
- Actual: all three runtime packages are absent; no loader or inference proof
  exists.
- Disposition: add the approved Qwen runtime, verify both model directory
  layouts (including `model_2.safetensors`), then run a real speech output test.

### LUNA-F006 — DeepFilterNet binary is present without its model archive

- Area: H / denoise
- Severity: **P1**, integration-gap
- Reproduction: `deep-filter-0.5.6-x86_64-pc-windows-msvc.exe --version` passes,
  but no `.tar.gz` model exists under the provisioned DeepFilterNet directory.
- Expected: the Worker can launch a complete DeepFilterNet denoise request.
- Actual: only the executable and platform libraries are installed.
- Disposition: provision the matching model archive and qualify a decoded output.

### LUNA-F007 — Aspect-ratio e2e assertion targets removed monitor metadata

- Area: E / monitor and timeline
- Severity: **P2**, test-contract mismatch
- Reproduction: the aspect-ratio test selects `1:1` and then looks for
  `article.monitor-panel span.monitor-meta[dir="ltr"]`.
- Expected by test: `1080 × 1080` in that span.
- Actual: the locator does not exist after the user-requested removal of the
  redundant monitor metadata line; the aspect-ratio control now owns the
  dimension presentation. The rest of the test does not prove or disprove the
  underlying persisted canvas because it stops at the stale locator.
- Disposition: update the assertion to the current aspect-ratio drawer/control,
  then rerun persistence and Undo.

### LUNA-F008 — Worker insertion has an intermittent asset-fixture race

- Area: K / Worker Jobs
- Severity: **P2**, flaky test infrastructure
- Reproduction: the full audit failed the Worker insertion case with
  `ASSET_NOT_FOUND` in one viewport; the focused retry failed in a different
  viewport, while the remaining viewport passed.
- Disposition: make the disposable asset setup await server persistence and
  avoid cross-worker fixture IDs; keep the test red until retries are stable.

### LUNA-F009 — WP-32 initially saw transient derivative/content 409s

- Area: L / project/export
- Severity: **P2**, flaky test infrastructure
- Reproduction: initial full audit saw same-origin HTTP 409s for derivative/cloud
  content in two viewport workers. The focused retry passed all three viewport
  projects.
- Disposition: retain retry evidence, inspect fixture readiness/cleanup ordering,
  and require a repeat stability run before calling it resolved.

### LUNA-F010 — Repository format gate reports existing drift

- Area: A / repository hygiene
- Severity: **P2**, follow-on
- Reproduction: `corepack pnpm@11.15.0 format:check`.
- Actual: 87 files reported; no formatting rewrite was attempted in a test-only
  run.
- Disposition: schedule a dedicated formatting cleanup with reviewable scope.

## 7. Evidence inventory

- Full e2e screenshots, videos, traces, and error contexts: `test-results/`.
- Focused retry evidence: the latest folders beginning with
  `timeline-editing-features--`, `wp29-r2-worker-insertion-`,
  `wp29-r5-batch-c-`, and `wp32-real-project-journey-`.
- Offline Demucs output: `test-results/luna-demucs/htdemucs/audio/` with four
  decoded WAV stems.
- BiRefNet outputs: `test-results/luna-birefnet.png` and
  `test-results/luna-birefnet-portrait.png`.
- Real-ESRGAN qualified output with test shim:
  `test-results/luna-realesrgan-shim.png`.
- RNNoise output from escaped FFmpeg command:
  `test-results/luna-rnnoise.wav`.
- Test request and compatibility shim used only for qualification:
  `test-results/luna-realesrgan-request.json` and
  `test-results/sitecustomize.py`. They are not production runtime changes.

## 8. Cleanup and safety

- No existing user project was mutated by this run.
- Live Chrome smoke only opened the existing JOY Media workspace, selected an
  existing visible timeline clip, and inspected the Inspector/Mask UI.
- The local disposable-project journey created and cleaned its own test state;
  WP-32 passed on focused retry in all three viewports.
- No model files were deleted or overwritten. The Demucs cache is accessed
  through the existing junction, and BiRefNet qualification used hard-link
  aliases in the ignored test-results area.
- Source changes were not made as part of this test/report execution. The
  pre-existing `run-worker.bat` working-tree change was preserved.

## 9. Release recommendation

### Ready now

- Repository install, typecheck, lint, unit tests, build, production audit.
- Core editor shell, Media Library, timeline editing paths, Inspector shell,
  caption import/export/template paths, and disposable project export journey.
- Local HTDemucs inference and BiRefNet General/Portrait inference as isolated
  model qualifications.
- Production web/API availability and signed-in live UI smoke.

### Must be fixed before claiming 100%

1. Correct Persian transcription result wiring and add a regression fixture.
2. Fix Windows RNNoise FFmpeg filter-path escaping.
3. Make the Real-ESRGAN dependency stack compatible without a test-only shim.
4. Install and offline-qualify SAM2 + Grounding DINO runtime packages.
5. Install and qualify Qwen3-TTS Base and VoiceDesign runtime paths.
6. Provision the DeepFilterNet model archive and execute a real denoise run.
7. Update the stale aspect-ratio e2e selector to the current UI contract.
8. Stabilize Worker asset setup and repeat the full three-viewport audit.

The smallest next implementation package that moves the score materially is the
runtime-readiness package: RNNoise path escaping, Real-ESRGAN compatibility,
SAM2/Grounding package installation, Qwen runtime installation, and one shared
model-health contract that prevents catalog-only providers from being shown as
ready. After that, rerun the caption and Worker fixes before deployment.
