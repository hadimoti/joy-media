# v1.0.3 Persian caption validation (2026-10-25)

**Status: partial.** Right-to-left caption lines lay out correctly in the packaged CLI (Persian is the verified sample). Captions wrap automatically and honour typed line breaks. The Noto caption faces draw at the Arial-equivalent size (owner option B, commit `a8bc28be`). P0-4 Step 10 now checks production timing and encoded-output fidelity, and its assertions pass. Not complete: the real installer lifecycle is BLOCKED on this PC, no committed reference test exists for the caption pixel probe, and the desktop canonical-face case and the lifecycle caption font check (which still requires Arial) are not started. The P0 lane had a Vitest worker RPC timeout that made a passing run exit 1. It is fixed: the full P0 lane now exits 0 (see Verification).

## Results by requested item

| Item                       | Result  | Evidence                                                                                                                                                                                                           |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Font metrics and integrity | PASS    | Four TrueType faces match the libass manifest by length and SHA-256. OS/2 `usWinAscent` 905 and `usWinDescent` 212 on all four. `libass-fonts.test.ts` and `copy-cli-fonts.test.mjs`: 10 of 10 pass.               |
| Packaged asset integrity   | PASS    | `verify-release`: 13 of 13 on a fresh extraction of the ZIP. `verify-package` on the installed copy: 21 of 21. The installed fonts are byte-identical to the repository assets.                                    |
| Persian caption rendering  | PASS    | Isolated installed-file copy, not the installer. MP4 `13332bc2…`, `Captions: ass.`, no warnings.                                                                                                                   |
| English caption regression | PASS    | Isolated installed-file copy. MP4 `e7ed77bb…`, same message and no warnings.                                                                                                                                       |
| Correct caption timing     | PASS    | Production pre-encoding composite: no caption before frame 45, caption ink on every frame 45 to 74, no caption from frame 75, and no difference outside the caption band. P0 Step 10 and the dedicated test agree. |
| Encoded-output quality     | PASS    | Every decoded frame reaches at least 40 dB luma PSNR against its own composite. The P0 minimum is 44.222 dB (frame 51). Active frames show the caption, and caption-free frames carry no residual.                 |
| Real installer lifecycle   | BLOCKED | Hyper-V is enabled, but this session is not elevated, and no Windows 11 install media or 1.0.1 package is on this PC. See "Installer lifecycle".                                                                   |

## Commits and provenance

- Release source: `a8bc28beb21f92715cbd6de9b7e8ac6a663106d8` (manifest `targetCommit`, built `2026-10-25T14:46:49Z`).
- Later commits on `v1.0.3/no-owner-tracks`: `7031080c` (earlier evidence note), `836569e1` (P0-4 Step 10 replacement, code and tests), `55b9d0e2` (scoped documentation scrub), `11cc4f33` (P0 process calls made asynchronous, see Verification), and the commit that adds this note.
- Host-safety and font commits, 2026-10-25: `85243821` (installer and lifecycle gate, refusing unless the host is a positively identified disposable environment) and `1f82cbc7` (WOFF2-to-TTF converter; rebuilds the four libass faces byte for byte).
- Production source is unchanged since `a8bc28be`. `git diff a8bc28be HEAD -- apps/cli/src/services apps/cli/src/commands/render-media.ts apps/cli/src/commands/render-cmd.ts` is empty.
- The CLI bundle rebuilt from HEAD (`node scripts/bundle.mjs` in `apps/cli`) has SHA-256 `1c5a241fd0f6542f1815598e0f272c491e498708b8de807b08e064749ffa150b`, the same as the release bundle. It was rebuilt after each reverse mutation and matched again after each restore.
- Release digests (`apps/desktop/dist/releases/SHA256SUMS.txt`, recomputed today):
  - ZIP `joy-media-windows-x64-v1.0.2.zip`: `c052cac474f9b0dc7a20128ac60447f6ab5c5c1d7db707553cc22affb85a9040`
  - setup `joy-media-setup.exe`: `d61e0e1fecf5a0acb2e0c5f127fb7d1ce320aabb21281a0ea43d72c9e0e5c6bf`
  - `joy-media.exe`: `e048632e03fabc96de5e10afbebc0aa31f4e1674155ea3d270597fe7523f9d80`
  - bundle `joy-media-bundle.mjs`: `1c5a241fd0f6542f1815598e0f272c491e498708b8de807b08e064749ffa150b`
- The setup contains the ZIP once, byte for byte (`verify-release`).

## Version state

The source version is 1.0.3 from commit `a328b956`: `apps/desktop/package.json`, `apps/cli/package.json`, `apps/desktop/installer/Setup.cs` (`ProductVersion`), the CLI constant and banner, and the lifecycle smoke labels. The 1.0.2 development artifacts recorded above (built from `a8bc28be`) remain as evidence only. The 1.0.3 development candidate is described in the section below. Nothing was released, tagged or overwritten, and the published v1.0.2 assets were not touched.

Coordinated update plan, to run before the future candidate freeze:

1. Set the version in `apps/desktop/package.json` and `apps/cli/package.json`, and `ProductVersion` in `apps/desktop/installer/Setup.cs`.
2. Pass the same version to `build-installer.ps1` and `package-installer.mjs`, so the artifact names and the release manifest follow it.
3. Update the lifecycle's previous-version pins (`tests/desktop/windows-lifecycle.ps1` and the release-candidate workflows) and the readiness evidence generator (`tooling/release/src/create-readiness-evidence.mjs`).
4. Rebuild, then re-run the release checks (`verify-release`, `verify-package`) on the new source commit.

## Font manifest

The libass folder holds four TrueType faces under OFL-1.1. Each was recomputed today and matches the manifest:

| File                                     | Bytes   | SHA-256                                                            |
| ---------------------------------------- | ------- | ------------------------------------------------------------------ |
| `noto-sans-arabic-arabic-400-normal.ttf` | 151,388 | `b14cc971b62d127a0659904262f5a4f604aa7fe7bff3e86976598eb3739e27e5` |
| `noto-sans-arabic-arabic-700-normal.ttf` | 151,512 | `40bc2694cfea3c5b4f00d8b38837723b4573d70c0b8271e22dbf395897cdf715` |
| `noto-sans-arabic-latin-400-normal.ttf`  | 21,452  | `26568b66dd3e100ae68400967587ab58d7b6db3f74ee3a11c7670c4f57da60ae` |
| `noto-sans-arabic-latin-700-normal.ttf`  | 21,436  | `890a4ebc26118188be87f022db33adb79636353c02996eca7f8100c992ac5508` |

Commit `a8bc28be` sets `usWinAscent` to 905 and `usWinDescent` to 212 on all four faces (they were 1431 and 738). The byte lengths are unchanged, the table and file checksums were recomputed, and the `hhea` and typo metrics are unchanged.

libass draws a face at the requested size multiplied by unitsPerEm and divided by (usWinAscent + usWinDescent). Measured at 640 × 360, with a requested size of 20 px, drawing `HELLO WORLD`:

| Face and metrics                               | usWinAscent + usWinDescent | Drawn width × height | Drawn em       |
| ---------------------------------------------- | -------------------------- | -------------------- | -------------- |
| Windows Arial fallback (used for Latin before) | 1117 per 1000 em           | 125 × 13             | 17.9 px (0.89) |
| Noto, shipped metrics                          | 2169 per 1000 em           | 63 × 7               | 9.2 px (0.46)  |
| Noto, Arial-equivalent metrics (chosen)        | 1117 per 1000 em           | 123 × 13             | 17.9 px (0.89) |
| Noto, nominal metrics                          | 1000 per 1000 em           | 137 × 15             | 20 px (1.00)   |

The owner reviewed the before and after frames and chose option B. English keeps the size it had on the Arial fallback. The Persian frames approved before this decision were drawn at 0.46 of the planned size, and the Arial-equivalent metrics draw them about 1.9 times larger.

## Right-to-left lines (earlier round, unchanged)

- `compileCaptionAss` passed caption lines to libass without bidi embedding. libass lays out a paragraph left to right unless it is embedded, so Persian sentences came out with their word order and punctuation reversed.
- The cue `direction` reached the compiler but was never read.
- Fix: each right-to-left line is wrapped in U+202B and U+202C. Direction comes from the cue for `ltr` and `rtl`. For `auto` it comes from the first letter of each line. Digits are neutral. Left-to-right lines are unchanged.

## Installed-copy renders (isolated file set)

Each sample was built with the packaged CLI from an isolated copy of the release files, not from the owner's installation: project create (640 × 360), caption track, a 6 s blue picture clip, three caption cues, export, plan prepare, plan apply and render to MP4. The isolated copy's `joy-media.exe` and CLI bundle match the manifest.

| Sample  | MP4 SHA-256                                                        | Bytes  |
| ------- | ------------------------------------------------------------------ | ------ |
| Persian | `13332bc2a9cc14d03932c1145dec0a769b1059ddfde1bd9fd7d79ff1b99f0ec4` | 27,632 |
| English | `e7ed77bb41f5198a34150f1d997cfd8d98f2e19d60b5e262c2f55b0fd074ac73` | 28,569 |

- Cues. Persian: `سلام، دنیا!` at 0.2 s; `سلام Hello 123 ۴۵۶ ؟` at 2.0 s; a long Persian sentence at 3.9 s. English: `HELLO WORLD` at 0.2 s; `Second caption` and `123` on two lines from a typed break at 2.0 s; a long English sentence at 3.9 s.
- Plan prepare reports no changed entities and no warnings. The planner wrapped the long cues.
- Render reports `Captions: ass.` with no warnings. ffprobe: H.264, 640 × 360, yuv420p, 30 fps, 180 frames, 6.000 s, with an AAC audio stream. The render events show `totalFrames` 336, the sum of clip frames: 180 picture frames, then 48, 48 and 60 caption frames.
- A second render from an earlier extraction of the same build gave the same MP4 bytes and the same CLI bundle digest.

Negative cases on the installed copy (final build):

| Case                                            | Plan prepare                                           | Render                                  |
| ----------------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Libass folder removed                           | `SETUP_REQUIRED`, `canonical-caption-face-unavailable` | `RENDER_PREPARATION_REQUIRED`, no media |
| One-bit tamper, same length, before preparation | `SETUP_REQUIRED` (pinned length and digest)            | `RENDER_PREPARATION_REQUIRED`, no media |
| One-bit tamper, same length, after a good plan  | Prepare and apply succeed                              | `RENDER_ENVIRONMENT_DRIFT`, no media    |

## P0-4 Step 10

### Original failing measurement

Step 10 of `apps/cli/src/commands/p0-design.e2e.test.ts` failed with `expected 5639 to be less than or equal to 128`. It compared frame 75 of two independently encoded MP4s, one with the caption and one without, over the band x 120 to 1159, y 560 to 659. A pixel counted when its largest RGB channel difference was above 12. The value reproduced exactly in the lab and in the test.

### Verified H.264 root cause

- The lab's encoder reproduction decodes to the same pictures as the CLI's MP4s: the decoded 150-frame files have identical SHA-256 digests for both clips. The H.264 byte streams differ, and that difference was not traced.
- The caption clip has one keyframe (frame 0), 61 P-frames and 88 B-frames.
- Before the caption appears, the decoded clips already differ: 947 luma pixels in the band at frame 44 with the CLI settings.
- A change far from the caption (a 160 × 90 luma block at frame 10) gives 5,222 RGB pixels at frame 75 with the same settings. The 128-pixel bound cannot separate caption timing from encoder history.
- MB-tree off: 3,891 RGB pixels at frame 75, still above 128. A keyframe at frame 75: 0 at frame 75, and the caption is still present at frame 74 (18,290 RGB pixels).

The data fit MB-tree (lookahead-based quantizer decisions) with B-frame and temporal prediction carrying differences forward. The x264 decisions themselves were not traced.

### Replacement methodology

Two responsibilities, kept apart. Both are implemented in `apps/cli/src/commands/caption-frame-evidence.ts` and used by the P0 Step 10 and by `apps/cli/src/commands/caption-frame-evidence.e2e.test.ts`.

- **Timing (pre-encoding).** The composite is captured through the CLI's own render (`runHeadlessRender`). The FFmpeg argument list is the production one, taken from the render itself. Only the output sink changes, to raw yuv420p frames, and the audio chain is discarded. The caption band is cropped to rgb24 for the pixel count. The caller passes the same environment as the CLI calls that prepared the project: the isolated profile and the same Chromium. Checks: frames 0 to 44 and 75 to 149 are identical to the no-caption composite, frames 45 to 74 show caption ink in the band, and no sample outside the band differs on any frame. The threshold of 12 and the band geometry are unchanged.
- **Encoded output.** The MP4 from the CLI is decoded and compared with its own composite. Checks: decodable; 150 frames; 1280 × 720; yuv420p; presentation times n/30. Luma PSNR of at least 40 dB on every frame (the approved floor). On active frames the band must differ from the no-caption composite by at least 5,000 luma pixels (half of the lowest measured count). On caption-free frames the band must not differ from its own input by more than 24 in more than 200 pixels (about four times the measured maximum of 49). FFmpeg and libx264 build identities are recorded.

### Exact pre-encoding timing results

| Run                | Frames 45 to 74: band RGB pixels | Frames 0 to 44 and 75 to 149 | Outside-band differing samples |
| ------------------ | -------------------------------- | ---------------------------- | ------------------------------ |
| P0 Step 10 (final) | 12,196 to 12,224 per frame       | 0                            | 0 on every frame               |
| Dedicated test     | 12,183 to 12,222 per frame       | 0                            | 0 on every frame               |

Filter graph (production `-filter_complex`, dedicated test): `sha256:70bc09bf0024b06c951dad510669250175445b1b7cebd19ced8b16946215924e`.

### Per-frame fidelity results

| Run                | Minimum luma PSNR    | Average luma PSNR | Lowest active-frame count | Largest caption-free residual |
| ------------------ | -------------------- | ----------------- | ------------------------- | ----------------------------- |
| P0 Step 10 (final) | 44.222 dB (frame 51) | 45.495 dB         | 10,826 pixels             | 49 pixels                     |
| Dedicated test     | 44.322 dB (frame 71) | 45.887 dB         | 10,830 pixels             | 39 pixels                     |

Encoder identities on both runs: `ffmpeg version n8.1.3-20260922` and `x264 - core 165`. Every per-frame PSNR value is in `docs/qa/evidence/2026-10-25-v103-caption-measurements.json`.

### Reverse mutations (production code restored after each run)

Each row is one temporary edit to production code, followed by the dedicated test, then a restore from a saved copy and a rebuild that matched the release bundle digest.

| Mutation                                                                   | Timing test                                             | Encoded-output test                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| Caption ends one frame late (end time + 33 ms, which compiles to frame 76) | FAIL: 17,747 samples outside the cue differ on frame 75 | PASS, as designed: the encoded output matches its own composite |
| Caption begins one frame late (start time + 33 ms, frame 46)               | FAIL: no caption ink on frame 45                        | FAIL: 402 band pixels on frame 45, below 5,000                  |
| Caption rendering disabled (ASS filter skipped)                            | FAIL: 30 active frames without ink                      | FAIL: 30 active frames below 5,000 pixels                       |
| Encoded output degraded (libx264 CRF 20 to 40)                             | PASS, as designed: the composite is unaffected          | FAIL: 270 frame violations; minimum 32.02 dB at frame 51        |

The one-frame shift is 33 ms rather than 33.334 ms, because the compiler refuses a boundary that cannot be represented at centisecond precision without changing a visible frame. The shorter shift is still exactly one frame at 30 fps.

Test-level controls, run in the same file on every run:

- An intentional visual defect (a 200 × 80 light block drawn into composite frames 100 to 109, then encoded): the checker reports 10 frames below 40 dB, the worst at 21.82 dB. The test expects this and passes.
- Corrupted bytes (8 KiB zeroed in the middle of the faststart MP4): the checker reports 81 violations. The test expects this and passes.

### Verification and regression results

| Check                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 design test (`vitest.p0.config.ts`, `p0-design.e2e.test.ts`) | The test passes, and all of its steps pass. Before the fix, Vitest reported `[vitest-worker]: Timeout calling "onTaskUpdate"` after the pass and exited 1. Cause: the test ran its renders and FFmpeg calls with `spawnSync`, which blocks the worker. One unchanged run recorded worker stalls of 132.6 s and 12.6 s, and vitest's worker RPC fails after 60 s. Fix (`11cc4f33`): those calls run through an asynchronous `runProcess` wrapper, and each helper awaits it. Result: vitest exits 0, with 1 of 1 passed. Assertions, thresholds, timeouts and the lane configuration are unchanged. |
| Full P0 lane (`vitest.p0.config.ts`, 10 files)                  | 10 of 10 files and 175 of 175 tests pass; vitest exits 0 with no worker timeout. Measured with a temporary preload that records event-loop gaps (not committed): the longest remaining synchronous gap is 8.7 s, under the 60 s RPC limit.                                                                                                                                                                                                                                                                                                                                                         |
| Dedicated caption test (`caption-frame-evidence.e2e.test.ts`)   | 4 of 4 pass in 15 s, exit 0; longest synchronous gap 9.1 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Full CLI suite (`apps/cli/src`)                                 | 54 files passed, 2 skipped; 808 tests passed, 25 skipped; exit 0 (run before the P0 change; that file is excluded from this suite)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Caption-related CLI files inside that run                       | `timeline-captions` 12 of 12, `render-parity` 19 of 19, `render-recovery` 8 of 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Release-harness tests (`tooling/release`)                       | 16 files, 318 tests passed, 4 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Desktop packaging scripts (`apps/desktop/scripts`)              | 2 files, 11 tests passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Desktop node tests (`tests/desktop/*.test.mjs`)                 | 30 tests passed (checksum 6, CLI environment 2, user data 1, accounting 21)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Font and runtime package (`packages/html-scene-runtime`)        | 13 files passed, 1 skipped; 71 tests passed, 1 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| TypeScript, CLI (`tsc -p apps/cli/tsconfig.json --noEmit`)      | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ESLint and Prettier on changed files                            | pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Correction to the earlier note

The earlier version of this note said the test stopped at Step 10, so later steps did not run. That was wrong. `runStep` continues after a failure, and the only recorded failure was Step 10.

## Track status (master plan, this round)

| Track | Item                      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | L4 frame-count contract   | VERIFIED on this branch. The API requires `x-joy-frame-count` and `x-joy-frame-rate`. Missing, malformed, zero, fractional or oversized values return `REQUEST_INVALID` naming the header (9 of 9 API cases pass). The library requires the frame count, and `remuxBrowserMp4` refuses a missing count (export-core: 20 of 20 pass).                                                                                                    |
| A     | L9 test strengthening     | PARTIAL. The 48 kHz duration test asserts audio and video duration within one AAC frame (1024/48000 s). Reverse mutation: removing the `apad` filter fails that test (audio 0.187 s short against a 0.0213 s tolerance), and the file was restored by hash. NOT STARTED: the control-port helper and the transitive import check.                                                                                                       |
| B     | L3 Persian captions       | PARTIAL. Done: font metrics, the companion faces, the reproducible WOFF2-to-TTF tool with a same-bytes test (`1f82cbc7`), the pixel probe (`caption-face-pixels.ts`, which decides from drawn pixels, not logs), the caption timing and encoded-output tests, the isolated installed-copy renders, and the negative refusals. NOT STARTED: a committed reference for the pixel probe (no test imports it directly), the desktop canonical-face export case, and the lifecycle caption font check (`windows-lifecycle.ps1` still requires `arial.ttf`, and it waits for the desktop case).                                        |
| C     | L5a held-file publication | VERIFIED on this Windows host. The case `keeps the last good output and stages nothing when another program holds the media open` passes. The lifecycle runs the file and counts a skipped case as a failure. The lifecycle receipt is pending.                                                                                                                                                                                         |
| I     | F3 privacy scrub          | PARTIAL. Scrubbed in this round: owner-profile paths, private addresses, a host folder and a container home directory in 10 documents (commit `55b9d0e2`). Still present in the current tree: about 50 files with owner-profile paths or UNC examples in plans, reviews and operational scripts, and one owner-profile guard in `.github/workflows/release-candidate-v2.yml`. Changing the guard is a CI policy decision for the owner. |
| I     | F4 readiness matrix       | PARTIAL. The held-file statements in `docs/qa/READINESS-MATRIX.md` are updated. The other inconsistencies listed in the master plan were already resolved on 2026-10-25 in the matrix.                                                                                                                                                                                                                                                  |

## Installer lifecycle (BLOCKED)

- Not run here: the real installer and `uninstall.cmd`. The isolated copy above is packaging and runtime evidence only.
- Why: the installer and uninstaller use fixed names. They write a fixed install folder, a Desktop shortcut and a Start Menu shortcut, a per-user uninstall entry, and the user PATH. Running them on this PC would overwrite or remove the owner's existing installation.
- Environment approved by the owner: a clean, disposable Windows 11 x64 Hyper-V VM, used only for installer acceptance. Conditions: the owner's installation, PATH, registry, shortcuts and installed applications are not touched; no Windows feature, firmware setting or host reboot without separate approval; a checkpoint before installation; install, launch, upgrade, uninstall and cleanup run inside the VM; installer hashes are verified; the VM is restored to its checkpoint afterwards. GPU and WebGL acceptance stay separate, because a VM does not establish hardware-accelerated rendering compatibility.
- Checked 2026-10-25, still BLOCKED: (1) Hyper-V is enabled and its services run. This session is not elevated, `Get-VM` is denied, and the account is not a member of Hyper-V Administrators, so VM creation and checkpoints need an elevated session or that membership. (2) No Windows 11 x64 install media was found on the drives or profile folders searched to depth 2. (3) The harness `tests/desktop/windows-lifecycle.ps1` needs the 1.0.1 setup, ZIP and checksums, pinned by SHA-256. None are on this PC, so its upgrade, repair and rollback steps cannot run. (4) The release directory holds version 1.0.2 at `a8bc28be`. Its four digests match `SHA256SUMS.txt` (see Commits and provenance), but a v1.0.3 candidate needs the version update first (see Version state).
- Owner installation check, after the test runs in this round: 557 files, none newer than the post-render snapshot. The Desktop and Start Menu shortcuts still date from 2 October, and the per-user environment key was last written on 24 October. The uninstall entry was not touched.
- Finding, not fixed: the installer and uninstaller are not scoped to their own install. They can overwrite or remove shortcuts and registry entries they did not create.

## Candidate and track status (2026-10-25, later)

- **Development candidate from `a328b956`** (`apps/desktop/dist/releases`; the manifest's `targetCommit` matches). Digests, recomputed:
  - setup `joy-media-setup.exe`: `ddbacc6d220fd7e18ca251ec2f7b7388d2946ea7d978990f9e84ca509ec2eb4c`
  - ZIP `joy-media-windows-x64-v1.0.3.zip`: `deeee9b3552259a398d9f1366e5443eb8c79109facad141ae99574c26c637848`
  - `joy-media.exe`: `e048632e03fabc96de5e10afbebc0aa31f4e1674155ea3d270597fe7523f9d80`
  - `joy-media-bundle.mjs`: `fa2a38f19642c92092e43a8366648520bf75d8b6f39f9fe764eda4de54c969dd`
  - `joy-worker.exe`: `9c8dd143bdb6ae4f2d9f810ba9ff0f19312f326ea2cb939b317cd16be8d43eb2`
  - It is not frozen. HEAD has moved on through test-only commits, and any formal candidate needs a clean rebuild from its own SHA. The installer integrity check did not complete for this candidate.
- **Incident, 2026-10-25.** Running the installer integrity check on this PC during the candidate build left the owner's per-user install folder missing. The Desktop and Start Menu shortcuts and the uninstall entry still point to it. The folder was removed while the check ran, but the exact operation was not identified. The owner's rule is to leave the installation, shortcuts, PATH and uninstall entry untouched. Update: the owner approved restoring the folder, and it was restored from the v1.0.0 release ZIP (`apps/desktop/dist/releases/joy-media-windows-x64-v1.0.0.zip`, SHA-256 `73e3271a…`). All 581 files match a fresh read of the ZIP. This verifies file restoration only: the app was not launched, runtime validation is not done, the shortcuts and uninstall entry still point to the folder, and the PATH entry was not recreated. The check now refuses unless the host is a positively identified CI container or Hyper-V guest (commit `85243821`). The earlier gate (`3f1d190c`) refused only when an install was visible.
- **Track status.**
  - L9: done locally. One fixture-only control-port helper refuses real-service runs. Specs that reach the port through imports are detected transitively. Three reverse mutations are caught (commits `82c50441` and `02988e7a`).
  - L3: the caption probe compares rendered frames, not logs. The WOFF2-to-TTF tool and its same-bytes test are done (`1f82cbc7`). Still open: a committed reference for the probe, the desktop canonical-face case, and the lifecycle caption font check, which still requires `arial.ttf` and waits for the desktop case. The lifecycle gate `JOY_MEDIA_REQUIRE_CAPTION_FACE=1` is already set for the caption case.
  - Installer lifecycle: BLOCKED. Hyper-V is available, and the VM-creation script passed a read-only dry run. It is waiting for approval. The install media is identified: Microsoft's English 64-bit multi-edition Windows 11 ISO (2026 Update, version 26H2), SHA-256 `BD4307DF32BC8AF33B39CCECB1174AEB345386630F89A2B86C7A4E36B55EA650`, not downloaded. The v1.0.1 setup, ZIP and checksums were retrieved and match the pinned harness values.

## Remaining uncertainties

- The P0 timeout is fixed on this host, and the fix is the test's own change, not a host-load workaround. The earlier host-load explanation did not match the measurements. A synchronous gap of about 9 s remains in each run. It is under the 60 s limit, and its source is not attributed.
- The byte-level difference between the lab's H.264 stream and the CLI's stream was not explained. The decoded pictures are identical.
- The desktop editor's Persian export was not run.
- The version metadata still says 1.0.2 (see Version state).
