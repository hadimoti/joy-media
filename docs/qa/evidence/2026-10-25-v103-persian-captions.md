# v1.0.3 Persian caption validation (2026-10-25)

**Status: partial.** Persian and Arabic captions lay out right to left in the packaged CLI, and captions now wrap automatically and take typed line breaks. Not exercised: the packaged editor's Persian export and the installer run. The Latin companion face is not adopted; see finding 1.

## Scope and artifacts

- Branch `v1.0.3/no-owner-tracks`, base `0704d369`. Commits: `49162696` right-to-left embedding; `e9836525` typed line breaks; `67aca127` automatic word wrap; `955db53a` accurately named canonical-face key; `52175fc0` automated direction test; `e5ce234d` earlier evidence note. The branch is on origin for review. No CI was dispatched and no pull request was opened.
- Package rebuilt from this branch: `joy-media-windows-x64-v1.0.2.zip` sha256 `9acc3e1b95006198e2e9d4648cc6195e644e9ea12d724de01d277432f367588c`.
- `joy-media-setup.exe` sha256 `5c3b05bb1d8e187edcf5244da8cc7da677dba4cb24f0e2f12e86ecfdddd156f4`. It embeds the zip (head and tail checked). It was not run.
- Packaged `resources/app/cli/joy-media-bundle.mjs` sha256 `83e8976ce6c123219000f098ce85239d7e2d9349be8ad7ad1e3a7c9d58ca1288`, identical to the built bundle.
- The desktop and CLI manifests still declare version `1.0.2`, and the artifact names say so. A version bump is a release decision and is not made here.

## Root cause and fix (right-to-left)

- `compileCaptionAss` passed caption lines to libass without bidi embedding. libass lays a paragraph out left to right unless it is embedded, so Persian sentences came out with their word order and punctuation reversed.
- The cue `direction` reached the compiler but was never read.
- Fix: each right-to-left line is wrapped in U+202B and U+202C. Direction comes from the cue when it is `ltr` or `rtl`; for `auto` it comes from the first letter of each line. Digits are neutral. Left-to-right lines are written exactly as before.

## Closed in this round

| Item | Change | Evidence |
| --- | --- | --- |
| Hard breaks from the CLI | `add-caption` treats each line of `--text` as a hard break. The lines are stored as the segment text override, and the words keep their timing. | End-to-end test `a line break in the caption text starts a new line…` passes. The English sample's cue 2 renders on two lines. |
| Automatic word wrap | The planner breaks an over-wide line at spaces, greedily, using the measured width. A single word wider than the frame is still refused with `CAPTION_LAYOUT_OVERFLOW`. The frozen layout keeps the words and source breaks. | Six new preparation tests. The Persian long cue prepared as two lines of 549.8 px and 172.2 px (limit 560 px). The English long cue prepared as two lines of 540.2 px and 338.3 px. |
| Plans from before the caption change | A layout made by another caption compiler is refused with a message to prepare again, instead of a generic inconsistency. | Unit test `asks for a new preparation when the frozen layout came from another caption compiler`. |
| Accurately named capability key | `canonicalCaptionFace` reports the canonical TrueType face. `woff2Font` stays as a deprecated alias with the same value. The Markdown line and the committed support document say what the key measures. | Capability and probe tests pass. |
| Automated direction test | Renders the Persian and Latin words with libass, embedded right to left and left to right, and compares the drawn ink at each end with each word drawn alone. | Two tests pass. A mutant that compiles the line left to right fails the first assertion (agreement 0.69 against the 0.85 threshold). |

## Open: the Latin companion face (decision needed)

The Latin subset faces were decoded from the bundled WOFF2 files with wawoff2 2.0.1. That decoder reproduces the pinned Arabic digests exactly. The Latin faces were trialled and then reverted, so the branch keeps the Windows Arial fallback for Latin.

- With the Latin faces in the same folder, Latin-only captions were not visible. The Latin face has the same family and PostScript name as the Arabic face, so libass fell back to the Arabic face for Latin glyphs and drew nothing above the threshold.
- With a unique PostScript name (same length, OFL, no Reserved Font Name), libass selects the Latin face and draws it. Its peak brightness is 204, against 255 for the hinted Arial fallback, so the caption tests' bright-pixel count (threshold 200) fails.
- Adopting the face therefore needs a derived font with a changed name table, and changes to the brightness assertions in the caption end-to-end tests. Those tests must not be weakened without your approval, so the change was not made.

Options: (a) keep the Arial fallback for Latin, which is the current state with all tests green; (b) adopt the Latin face with the renamed PostScript name and approve the test change.

## Installed CLI renders (this round)

Both samples render from the rebuilt package, with no override. Each sample is a 640x360 blue backdrop with three caption cues at 0.2, 2.0 and 3.9 s.

- Persian: `سلام، دنیا!`; `سلام Hello 123 ۴۵۶ ؟`; and one long sentence with no hard break. The planner prepared the long sentence as two lines, and it renders right-aligned. Render reports `Captions: ass` with no warnings. MP4 sha256 `695830e4c76b59590369aae8d8d48f8ac056cf2b66bbdcdd2b7a0d6aabf6e874` (20,720 bytes).
- English: `HELLO WORLD`; `Second caption` on one line and `123` on the next, from a typed break; and one long sentence that wraps into two lines. Render reports `Captions: ass` with no warnings. MP4 sha256 `3a94df3fde4731d843b74fd1e2913a4719d8c5b315b178a82faf5d64bfb64a35` (26,973 bytes).
- Both outputs by ffprobe: H.264 High 640x360 yuv420p, 30 fps, 180 frames, 6.000 s, with an AAC audio stream.
- Frames at 1.0, 3.0 and 5.0 s were inspected. Persian cue 1 has `!` at the left end, cue 2 has `؟` at the left with the Persian word at the right, and cue 3 is two right-aligned lines. English frames show the two-line typed break and the two-line wrap.

## Negative tests (installed copy, same package)

| Case | Plan prepare | Render | Output written |
| --- | --- | --- | --- |
| Libass face folder removed | `SETUP_REQUIRED`: canonical-caption-face-unavailable, "libass font directory is missing" | `RENDER_PREPARATION_REQUIRED` | no |
| Same-length tamper (one bit, length unchanged) before preparation | `SETUP_REQUIRED`: "does not match its pinned length and digest" | `RENDER_PREPARATION_REQUIRED` | no |
| Same-length tamper after a good plan was applied | prepare and apply succeed | `RENDER_ENVIRONMENT_DRIFT`: "Canonical caption face probe facts changed after preparation." | no |

## Font integrity and libass

- `verify-package` runs 17 checks on the rebuilt package, all PASS. Both TrueType faces match their pinned length and digest, the four WOFF2 files are byte-identical to the repository assets, the licence is identical, and the bundle is identical to the built bundle.
- TrueType faces: `noto-sans-arabic-arabic-400-normal.ttf` 151388 bytes, sha256 `65046a85464c7583d47ea9107486da964770e996fa93899a1c3d31067de29693`; `noto-sans-arabic-arabic-700-normal.ttf` 151512 bytes, sha256 `ace3b202eb09d4cd08237fe950b9dfd65350654b016e6a3a44abd5a7a7be06c0`.
- FFmpeg `n8.1.3-20260922` (gcc 16.2.0), configured with libass, libfreetype, libfribidi, libharfbuzz and fontconfig. libass API `0x1705000`, source commit `3087d2b2ffda76602a17f9b09d25cb8addc8d313`. Shaper: FriBidi 1.0.16 (SIMPLE), HarfBuzz-ng 14.3.0 (COMPLEX). Font provider: DirectWrite (with GDI).
- The canonical WOFF2 cannot be opened by this libass build (`Error opening memory font`). Captions draw from the TrueType companion, and the WOFF2 files remain for browsers.

## Tests and checks (final tree)

- CLI unit tests, all 25 non-end-to-end files: 320 of 320 pass.
- End-to-end: `timeline-captions` 12 of 12, `render-parity` 19 of 19, and `p0-design` 12 of 12.
- Direction on pixels: 2 of 2, plus the mutant check.
- Font runtime and desktop packaging tests: 20 of 20.
- ESLint and Prettier clean on the changed files. `tsc -b` for the CLI passes.

## Findings and remaining risks

1. **Latin face: decision needed.** See the section above. Latin text keeps the Arial fallback until the owner decides.
2. **Desktop editor not exercised.** The packaged editor's Persian export was not run, so the editor path is not verified.
3. **Installer lifecycle not run.** The setup's registry and shortcut steps would touch an owner install.
4. **Earlier RTL plans are refused.** A plan with right-to-left captions prepared before the caption change fails with `RENDER_PREPARATION_INVALID`, with a message to prepare again. English-only plans are unaffected.
5. **Version metadata.** The packages still declare 1.0.2 (see scope).
6. **Render telemetry.** `totalFrames` is the sum of clip frames: 180 video frames plus the caption frames (48, 48 and 60 in the first sample). The encoded output has 180 frames, as ffprobe confirms.

## WOFF2 conclusion

WOFF2 is not the blocker. This libass build cannot open the canonical WOFF2, so caption rendering uses the TrueType companions (OFL-1.1, pinned digests, fail-closed when missing or tampered). The Latin face is the only open font question (finding 1).
