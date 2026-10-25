# v1.0.3 Persian caption validation (2026-10-25)

**Status: partial.** Persian and Arabic captions render right to left in the packaged CLI, checked in an isolated copy of the portable package built from this branch. Two things were not exercised: the packaged editor's Persian export, and the installer lifecycle.

## Scope and artifacts

- Branch `v1.0.3/no-owner-tracks`, base `0704d369`, fix `49162696`.
- `joy-media-windows-x64-v1.0.2.zip` sha256 `da2b1b1e27058dc334b2cea8a0c70733888a85fe65e4ea0c48ab4d8018e09664`.
- `joy-media-setup.exe` sha256 `6e9d8551cabd76bfe510412fbcb80bd59d77df17e57b442ef232cc66287423e3`. It embeds the zip byte-for-byte (head and tail checked). It was not run.
- Packaged `resources/app/cli/joy-media-bundle.mjs` sha256 `df5244c8c5507f159f97646ee5916160844b8db0650a283a46b3fe2ca81b0ab3`, identical to the built bundle.
- The desktop and CLI manifests still declare version `1.0.2`, and the artifact names say so. This is not changed here; a version bump is a release decision.

## Root cause and fix

- `compileCaptionAss` passed caption lines to libass without bidi embedding. libass lays a paragraph out left to right unless it is embedded, so Persian sentences came out with their word order and punctuation reversed.
- The cue `direction` reached the compiler but was never read.
- Fix: each right-to-left line is wrapped in U+202B and U+202C. Direction comes from the cue when it is `ltr` or `rtl`; for `auto` it comes from the first letter of each line. Digits are neutral. Left-to-right lines are written exactly as before.
- A controlled probe (same FFmpeg, packaged TrueType face) confirmed that the embedding works and that a leading RLM mark does not change the order.

## Font integrity (packaged)

- `verify-package` runs 17 checks, all PASS: both manifests are OFL-1.1; the four WOFF2 files are byte-identical to the repository assets; the two TrueType faces match their pinned length and SHA-256 and carry the TrueType magic; the licence is identical; the bundle is identical to the built bundle.
- TrueType faces: `noto-sans-arabic-arabic-400-normal.ttf` 151388 bytes, sha256 `65046a85464c7583d47ea9107486da964770e996fa93899a1c3d31067de29693`; `noto-sans-arabic-arabic-700-normal.ttf` 151512 bytes, sha256 `ace3b202eb09d4cd08237fe950b9dfd65350654b016e6a3a44abd5a7a7be06c0`.

## FFmpeg and libass

- FFmpeg `n8.1.3-20260922` (gcc 16.2.0), configured with libass, libfreetype, libfribidi, libharfbuzz and fontconfig.
- libass API `0x1705000`, source commit `3087d2b2ffda76602a17f9b09d25cb8addc8d313`. Shaper: FriBidi 1.0.16 (SIMPLE), HarfBuzz-ng 14.3.0 (COMPLEX). Font provider: DirectWrite (with GDI).
- The canonical WOFF2 cannot be opened by this libass build: `Error opening memory font 'noto-sans-arabic-arabic-400-normal.woff2'`. The TrueType companion loads and is selected for Arabic-script glyphs. WOFF2 is therefore not usable for captions, and the WOFF2 files remain for the browser only.

## Installed CLI and real render

The isolated copy was extracted from the portable zip. The render used no override; the bundle is the packaged one.

- `capabilities`: `libass: true`, `captionFont: true`, `woff2Font: loadable` (this key reports the canonical TrueType caption face, see findings), `chromium: true`.
- Project: 640x360, 30 fps, 6.0 s blue backdrop. Three caption cues:

| Cue | Start / duration | Text                   | What it checks                                                       |
| --- | ---------------- | ---------------------- | -------------------------------------------------------------------- |
| 1   | 0.2 s / 1.6 s    | `سلام، دنیا!`          | RTL order, punctuation at the logical end                            |
| 2   | 2.0 s / 1.6 s    | `سلام Hello 123 ۴۵۶ ؟` | Persian, Latin, digits (Extended Arabic-Indic), Arabic question mark |
| 3   | 3.9 s / 2.0 s    | three explicit lines   | multi-line hard breaks, long sentence                                |

- Single-line preparation of the long cue is refused with `CAPTION_LAYOUT_OVERFLOW`, as designed. The explicit breaks are stored as `textOverride` on the segment (see findings for why `add-caption` cannot create them).
- Prepare, apply and render then succeed. Render reports `complete`, `Captions: ass`, no warnings.
- Output (ffprobe): H.264 High 640x360 yuv420p, 30 fps, 180 frames, 6.000 s, plus an AAC audio stream. MP4 sha256 `3824320c781c0c4068a0a5e09d0e55a3f6385f466b9da6d1d4efa27ac771df75`.
- Frames at 0.1 s (no caption), 1.0 s, 3.0 s and 5.0 s were inspected at 3x and 6x. Cue 1 has `!` at the left end. Cue 2 has `؟` at the left and the Persian word at the right. Cue 3 is three right-aligned lines with joined glyphs. Latin letters and digits draw with the Windows fallback face, as described below.

## English regression

- `HELLO WORLD`, `Second caption 123`, and a three-line English cue. Output is left to right and centred. The English ASS is unchanged, and the golden unit test pins it.
- MP4 sha256 `81481fb8848b6e03c2eb19f6e38656ab8106a9aacd6244e3e7ecdc499009e5ff`.

## Negative tests (installed copy, same package)

| Case                                                              | Plan prepare                                                                             | Render                                                                                      | Output written |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------- |
| Libass face folder removed                                        | `SETUP_REQUIRED`: canonical-caption-face-unavailable, "libass font directory is missing" | `RENDER_PREPARATION_REQUIRED`                                                               | no             |
| Same-length tamper (one bit, length unchanged) before preparation | `SETUP_REQUIRED`: "does not match its pinned length and digest"                          | `RENDER_PREPARATION_REQUIRED`                                                               | no             |
| Same-length tamper after a good plan was applied                  | prepare and apply succeed                                                                | `RENDER_ENVIRONMENT_DRIFT`: "Canonical caption face probe facts changed after preparation." | no             |

In the first two cases `captionFont` stays `true`, because it checks the browser WOFF2 file. The canonical-face probe (`woff2Font`) reports the failure.

## Tests and checks (final source)

- `captions-ass.test.ts`: 15/15, including five RTL and escaping cases.
- CLI unit tests, all 24 non-end-to-end files: 312/312.
- `render-parity.e2e.test.ts` 19/19 and `timeline-captions.e2e.test.ts` 11/11.
- `html-scene-runtime` font tests 7/7; desktop `copy-cli-fonts` 7/7; `install-electron-windows` 4/4.
- ESLint and Prettier clean on the changed files; `tsc -b` for the CLI passes.

## Findings and remaining risks

1. **Desktop editor not exercised.** The packaged editor's Persian export was not run. The installer was not run either, because its registry and shortcut steps would touch an owner install.
2. **Latin fallback.** The bundled Arabic face has no Latin letters, digits or ASCII punctuation (libass logs `Glyph 0x21 not found`). Those characters use the Windows system face (Arial). A Latin TrueType companion under OFL would bundle them.
3. **Hard breaks cannot be created by `timeline add-caption`.** It splits `--text` on whitespace, so a newline becomes a space. The `CAPTION_LAYOUT_OVERFLOW` refusal tells the user to add a hard break that the CLI cannot add. Breaks currently need a project file edit (`textOverride`) or the editor.
4. **No automatic word wrap.** The ASS style uses `WrapStyle: 2`, so a line wider than the frame is refused and long captions need hard breaks.
5. **Plans prepared before this change are refused.** The frozen record stores the ASS digest, so a plan with right-to-left captions prepared before this commit fails with `RENDER_PREPARATION_INVALID` and must be prepared again. English-only plans are unaffected.
6. **Misleading capability key.** `woff2Font` reports the canonical TrueType face, not WOFF2 loading. Renaming it changes the capability contract, so it is not changed here.
7. **Version metadata.** The packages still declare 1.0.2 (see scope).
8. **No automated direction test.** The direction is covered by ASS-text unit tests and by frame inspection. A pixel-level direction test is not yet in the suite.
9. **Render telemetry.** `totalFrames` (336) is the sum of clip frames: 180 video plus 48, 48 and 60 caption frames. The encoded output has 180 frames, as ffprobe confirms.
10. **Not pushed, CI not dispatched.** The runner-safety conditions for a non-release CI run were not verified, so no push or CI dispatch was made for this change.

## WOFF2 conclusion

WOFF2 is not the blocker any more. This libass build cannot open the canonical WOFF2, so caption rendering uses the TrueType companions (OFL-1.1, pinned digests, fail-closed when missing or tampered). Latin coverage in the bundle is the open item (finding 2).
