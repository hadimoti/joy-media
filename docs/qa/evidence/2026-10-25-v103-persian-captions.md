# v1.0.3 Persian caption validation (2026-10-25)

**Status: partial.** Right-to-left caption lines lay out correctly in the packaged CLI (Persian is the sample verified here), captions wrap automatically, and typed line breaks are honoured. The Latin companion face is adopted, and the Noto caption faces draw at the Arial-equivalent size (owner option B, commit `a8bc28be`). The installer embeds the release ZIP, and the installed copy renders both samples. Not done: the real installer and uninstaller, which are blocked on this PC. P0-4 Step 10 fails on this build. Its root cause is measured below, and the proposed assertion change is waiting for owner approval.

## Build and artifacts

- Branch `v1.0.3/no-owner-tracks`. Pushed up to `2a2c0c35`. Local and not pushed: `b701332d` (Latin companion faces), `b480c3f5` (caption ink threshold 200 to 100, owner-approved), `a8bc28be` (Arial-equivalent metrics for the Noto caption faces), and the commit that adds this note.
- No push, pull request, CI dispatch, tag, release or deploy. The published v1.0.2 assets were not touched.
- Release manifest: `targetCommit` `a8bc28beb21f92715cbd6de9b7e8ac6a663106d8`, built `2026-10-25T14:46:49Z`. The artifact names and the manifest say version `1.0.2`. This branch is v1.0.3. The version change is a release decision and was not made here.

| Artifact                                               | SHA-256                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `joy-media-windows-x64-v1.0.2.zip` (167,652,781 bytes) | `c052cac474f9b0dc7a20128ac60447f6ab5c5c1d7db707553cc22affb85a9040` |
| `joy-media-setup.exe` (167,669,248 bytes)              | `d61e0e1fecf5a0acb2e0c5f127fb7d1ce320aabb21281a0ea43d72c9e0e5c6bf` |
| `joy-media.exe`                                        | `e048632e03fabc96de5e10afbebc0aa31f4e1674155ea3d270597fe7523f9d80` |
| `joy-media-bundle.mjs`                                 | `1c5a241fd0f6542f1815598e0f272c491e498708b8de807b08e064749ffa150b` |

## Installer payload (PASS)

- The four digests above match `SHA256SUMS.txt` and the release manifest. They were recomputed on 2026-10-25.
- `verify-release` ran against a fresh extraction of the ZIP and the source commit `a8bc28be`: 13 checks pass, 0 fail. The setup contains the ZIP exactly once, byte for byte, and the SHA-256 of the embedded payload equals the ZIP's.
- The installer itself was not run. See "Installer and uninstall".

## Font manifest (PASS)

The libass folder `packages/html-scene-runtime/assets/fonts/noto-sans-arabic/libass/fonts/` holds four TrueType faces under OFL-1.1. Their lengths and digests were recomputed today and match the libass manifest:

| File                                     | Bytes   | SHA-256                                                            |
| ---------------------------------------- | ------- | ------------------------------------------------------------------ |
| `noto-sans-arabic-arabic-400-normal.ttf` | 151,388 | `b14cc971b62d127a0659904262f5a4f604aa7fe7bff3e86976598eb3739e27e5` |
| `noto-sans-arabic-arabic-700-normal.ttf` | 151,512 | `40bc2694cfea3c5b4f00d8b38837723b4573d70c0b8271e22dbf395897cdf715` |
| `noto-sans-arabic-latin-400-normal.ttf`  | 21,452  | `26568b66dd3e100ae68400967587ab58d7b6db3f74ee3a11c7670c4f57da60ae` |
| `noto-sans-arabic-latin-700-normal.ttf`  | 21,436  | `890a4ebc26118188be87f022db33adb79636353c02996eca7f8100c992ac5508` |

- Commit `a8bc28be` sets `usWinAscent` to 905 and `usWinDescent` to 212 on all four faces. They were 1431 and 738. The byte lengths are unchanged, the table and file checksums were recomputed, and the `hhea` and typo metrics are unchanged.
- `libass-fonts.test.ts` pins the Windows metrics. `copy-cli-fonts.test.mjs` lists the four faces.
- `verify-package` on the installed copy: 21 checks pass, 0 fail. The installed fonts are byte-identical to the repository assets.

## Drawn size (owner decision: option B)

libass draws a face at the requested size multiplied by unitsPerEm and divided by (usWinAscent + usWinDescent). Measured at 640 × 360 with a requested size of 20 px, drawing `HELLO WORLD`:

| Face and metrics                               | usWinAscent + usWinDescent | Drawn width × height | Drawn em       |
| ---------------------------------------------- | -------------------------- | -------------------- | -------------- |
| Windows Arial fallback (used for Latin before) | 1117 per 1000 em           | 125 × 13             | 17.9 px (0.89) |
| Noto, shipped metrics                          | 2169 per 1000 em           | 63 × 7               | 9.2 px (0.46)  |
| Noto, Arial-equivalent metrics (chosen)        | 1117 per 1000 em           | 123 × 13             | 17.9 px (0.89) |
| Noto, nominal metrics                          | 1000 per 1000 em           | 137 × 15             | 20 px (1.00)   |

The Arabic alef behaves the same way: 6 px tall at the shipped metrics and 13 px with Arial-equivalent metrics, against 14.3 px nominal.

The owner reviewed the before and after frames and chose option B. English keeps the size it had on the Arial fallback. The Persian frames approved before this decision were drawn at 0.46 of the planned size. Arial-equivalent metrics draw them about 1.9 times larger, so the option-B frames replace them.

## Right-to-left lines (from the earlier round, unchanged)

- `compileCaptionAss` passed caption lines to libass without bidi embedding. libass lays out a paragraph left to right unless it is embedded, so Persian sentences came out with their word order and punctuation reversed.
- The cue `direction` reached the compiler but was never read.
- Fix: each right-to-left line is wrapped in U+202B and U+202C. Direction comes from the cue when it is `ltr` or `rtl`. For `auto` it comes from the first letter of each line. Digits are neutral. Left-to-right lines are written exactly as before.

## Closed items

| Item                                 | Change                                                                                                                                                                                                                       | Evidence                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard breaks from the CLI             | `add-caption` treats each line of `--text` as a hard break. The lines are stored as the segment text override, and the words keep their timing.                                                                              | End-to-end test `a line break in the caption text starts a new line…` passes. The English sample's cue 2 renders on two lines.                                                  |
| Automatic word wrap                  | The planner breaks an over-wide line at spaces, greedily, using the measured width. A single word wider than the frame is still refused with `CAPTION_LAYOUT_OVERFLOW`. The frozen layout keeps the words and source breaks. | Six preparation tests. The Persian long cue prepares as two lines of 549.8 px and 172.2 px (limit 560 px). The English long cue prepares as two lines of 540.2 px and 338.3 px. |
| Plans from before the caption change | A layout made by another caption compiler is refused with a message to prepare again, instead of a generic inconsistency.                                                                                                    | Unit test `asks for a new preparation when the frozen layout came from another caption compiler`.                                                                               |
| Accurately named capability key      | `canonicalCaptionFace` reports the canonical TrueType face. `woff2Font` stays as a deprecated alias with the same value.                                                                                                     | Capability and probe tests pass.                                                                                                                                                |
| Automated direction test             | Renders the Persian and Latin words with libass, embedded right to left and left to right, and compares the drawn ink at each end with each word drawn alone.                                                                | Two tests pass. A mutant that compiles the line left to right fails the first assertion (agreement 0.69 against the 0.85 threshold).                                            |

## Installed-copy renders (PASS for the isolated file set)

Each sample was built with the packaged CLI from an isolated copy of the release files, not from the owner's installation. The steps were: project create (640 × 360), add a caption track, add a 6 s blue picture clip, add three caption cues, export the project, prepare the plan, apply it, and render to MP4. The isolated copy's `joy-media.exe` and CLI bundle match the manifest.

| Sample  | MP4 SHA-256                                                        | Bytes  |
| ------- | ------------------------------------------------------------------ | ------ |
| Persian | `13332bc2a9cc14d03932c1145dec0a769b1059ddfde1bd9fd7d79ff1b99f0ec4` | 27,632 |
| English | `e7ed77bb41f5198a34150f1d997cfd8d98f2e19d60b5e262c2f55b0fd074ac73` | 28,569 |

- Cues. Persian: `سلام، دنیا!` at 0.2 s; `سلام Hello 123 ۴۵۶ ؟` at 2.0 s; a long Persian sentence at 3.9 s. English: `HELLO WORLD` at 0.2 s; `Second caption` and `123` on two lines from a typed break at 2.0 s; a long English sentence at 3.9 s.
- Plan prepare reports no changed entities and no warnings. The planner wrapped the long cues.
- Render reports `Captions: ass.` with no warnings. ffprobe: H.264, 640 × 360, yuv420p, 30 fps, 180 frames, 6.000 s, with an AAC audio stream. The render events show `totalFrames` 336, which is the sum of clip frames: 180 picture frames, then 48, 48 and 60 caption frames.
- A second render from an earlier extraction of the same build gave the same MP4 bytes and the same CLI bundle digest.
- Frames at 0.1, 1.0, 3.0 and 5.0 s were extracted from both MP4s and reviewed as a grid. The frame images are kept outside the repository.
- The Arial-fallback digests in the earlier version of this note are superseded.

## Negative tests (installed copy, final build)

| Case                                                       | Plan prepare                                                                                | Render                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Libass folder removed                                      | `SETUP_REQUIRED`, `canonical-caption-face-unavailable` ("libass font directory is missing") | `RENDER_PREPARATION_REQUIRED`; no media                                                                |
| One-bit tamper, same length, before preparation            | `SETUP_REQUIRED` ("does not match its pinned length and digest")                            | `RENDER_PREPARATION_REQUIRED`; no media                                                                |
| One-bit tamper, same length, after a good plan was applied | Prepare and apply succeed                                                                   | `RENDER_ENVIRONMENT_DRIFT` ("Canonical caption face probe facts changed after preparation."); no media |

Each refusal ended with an error event and no completion event.

## Installer and uninstall (BLOCKED on this PC)

- The real installer and uninstaller were not run. The release was exercised as an isolated copy instead.
- Why: the installer and uninstaller use fixed names. The installer writes a fixed install folder, a Desktop shortcut and a Start Menu shortcut with fixed names, appends to the user PATH, and writes a per-user uninstall entry with a fixed name. `uninstall.cmd` removes those shortcuts and that entry by name. On this PC, running either would overwrite or remove the owner's existing files.
- Owner installation, checked before and after the test runs: no file or folder entry in it changed. Its shortcuts, its per-user uninstall entry and the per-user environment were not modified during these runs.
- To close this item, run the installer and uninstaller in a clean Windows account or a virtual machine.
- Finding, not fixed: the installer and uninstaller are not scoped to their own install. They can overwrite or remove shortcuts and registry entries that they did not create.

## P0-4 Step 10: FAIL on this build

- Test: `runs the P0 slice with independently checked font bytes and FFmpeg version plus reported Chromium`, Step 10. Result: `expected 5639 to be less than or equal to 128`. The test stops at that expectation, so Steps 11 onward did not run in this run.
- Metric, as the test computes it: frame 75 (75/30 s) of the decoded MP4 with the caption, compared with the decoded MP4 without it. The band is x 120 to 1159 and y 560 to 659. A pixel counts when its largest RGB channel difference is above 12.
- The caption timing is correct. The composed picture before encoding has caption ink in the band on every frame from 45 to 74 (between 11,507 and 11,515 luma pixels per frame) and none on frame 75 (0 in the band and in the full frame).

Root cause, as measured:

1. The two clips are encoded separately, and the difference is not limited to the caption band or to the caption's frames. Before the caption appears, the decoded clips already differ in the band: 947 luma pixels at frame 44 with the CLI settings.
2. The same kind of difference appears for any change to the clip. A non-caption block change (160 × 90 luma pixels in frame 10) gives 5,222 RGB pixels in the band at frame 75 with the same settings.
3. The data are consistent with MB-tree (lookahead-based quantizer decisions) together with B-frame and temporal prediction carrying the difference forward. The stream has one keyframe, at frame 0, and 88 B-frames. Turning MB-tree off reduces the difference. A keyframe at frame 75 removes it at that frame. The x264 decisions were not traced further.

| Variant (decoded pictures, band count at frame 75) | RGB   | Luma |
| -------------------------------------------------- | ----- | ---- |
| CLI settings (the test's clips)                    | 5,639 | 593  |
| MB-tree off (`mbtree=0`)                           | 3,891 | 95   |
| Keyframe at frame 75 (2.5 s)                       | 0     | 0    |
| Control: non-caption change at frame 10            | 5,222 | 532  |

With the keyframe the caption is still present at frame 74 (18,290 RGB pixels), so the removal at frame 75 is not a missing caption.

Method notes:

- The reproduced encodes use the same composed input and the same libx264 settings. They decode to the same pictures as the CLI's MP4s: the decoded 150-frame files have identical SHA-256 digests for both clips. Their H.264 byte streams differ, which was not investigated, so the variant rows use the reproduction.
- An earlier variant run passed the keyframe interval in seconds as if it were a frame number. Its results are not used.
- MB-tree off does not meet the 128-pixel bound (3,891 RGB pixels). A keyframe at the caption end does (0). The keyframe is a product encoder change with a size cost, so it is not recommended without a size and quality check.

Proposed assertion change (not applied; needs owner approval):

1. An exact check on composed frames: the caption band differs from the no-caption frame on every frame from 45 to 74, and is identical on frame 75. Measured: 11,507 to 11,515 luma pixels on frames 45 to 74, and 0 on frame 75.
2. A fidelity check: each decoded luma frame matches its composed frame at 40 dB PSNR or better. Measured: 44.22 to 48.8 dB over all 150 frames of both clips.

This proposal removes the 128-pixel bound on the encoded frame, so it needs owner approval. The test would need the composed frames from the CLI's filter graph, which is an implementation choice. The band and the threshold of 12 stay as they are. The caption-minus-baseline count on the encoded frame stays as a diagnostic.

## Tests (this round)

| Suite                                                          | Result                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| P0 design test (`apps/cli/src/commands/p0-design.e2e.test.ts`) | 1 failed: Step 10 (above)                                |
| CLI, all of `apps/cli/src`                                     | 53 files passed, 2 skipped; 804 tests passed, 25 skipped |
| `packages/html-scene-runtime` and `apps/desktop/scripts`       | 15 files passed, 1 skipped; 82 tests passed, 1 skipped   |
| Font metric and copy-fonts tests                               | 2 files, 10 tests passed                                 |
| Prettier, changed files                                        | pass                                                     |
| ESLint, changed test files                                     | pass                                                     |

## Findings and remaining risks

1. **P0-4 Step 10 fails.** A decision is needed on the assertion change above. This branch keeps the 128-pixel bound and the threshold of 12.
2. **Installer and uninstaller not run** (blocked on this PC). They are not scoped to their own install (see above).
3. **Desktop editor not exercised.** The packaged editor's Persian export was not run.
4. **Version metadata.** The packages and the manifest say 1.0.2. This branch is v1.0.3.
5. **Earlier right-to-left plans are refused.** A plan with right-to-left captions that was prepared before the caption change fails with `RENDER_PREPARATION_INVALID`, with a message to prepare again. English-only plans are unaffected.
6. **Encoder drift.** Any test that compares two separately encoded clips sees a similar drift. The byte-level difference between the reproduction's H.264 stream and the CLI's stream is not explained.

## WOFF2

The canonical WOFF2 files cannot be opened by this libass build (`Error opening memory font`). Captions draw from the TrueType companion faces, which are OFL-1.1, have pinned lengths and digests, and fail closed when a file is missing or altered. The WOFF2 files remain for browsers.
