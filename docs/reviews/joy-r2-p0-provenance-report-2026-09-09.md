# JOY Live Director R2 — P0 provenance report (2026-09-09, rev P0-R1)

Companion to `joy-r2-p0-evidence-index-2026-09-09.md` and
`joy-r2-p0-discrepancy-ledger-2026-09-09.md`. All hashes SHA-256. All times UTC.

Status words: **REPORTED** (another party's claim, not re-checked here) ·
**OBSERVED** (measured in P0 or P0-R1) · **INFERRED** (observations + a stated
assumption) · **UNVERIFIED** (asserted, no receipt).

> **P0-R1 revision (2026-09-09, Claude session `7c5ec584`).** The per-sample matrix
> (§2), provenance matrix (§3), command register (§7) and proposed next scope (§9)
> are reworked from fresh read-only observations in
> `C:\Users\HadiMoti\Desktop\joy-r2-p0-r1-evidence-20260909T192442Z\`. The original
> P0 preservation bundle and its `MANIFEST.csv` are unchanged.

---

## 1. Identity anchors

### 1a. The three commits (distinct — do not conflate)

| #   | Thing                              | Commit                                           | Tree                                       |
| --- | ---------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| 1   | Application baseline (R2 impl)     | `d01770b1eafeb10f9cc0386ca3122d8314a4ee90`       | `551ddb516a2a14ea3dc49dba4ae3ac863a88291b` |
| 2   | Reviewed P0 checkpoint (parent #1) | `03e8909affdc97e2b922763251d4707085587351`       | `07a470238203ef4831ffc9cb149009160f8f0494` |
| 3   | P0-R1 result (parent #2)           | supplied in the P0-R1 return report after commit | —                                          |

### 1b. Other references (P0 observation; not re-checked in P0-R1)

| Thing                                               | Value                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2 `pnpm-lock.yaml` @ `d01770b1` blob / raw SHA-256 | `bcf36b0d24e24d55305898e783b4813723e22d90` / `c9e147f8f56265b5e53e64800c1f691d67675ac2618434bfc821f666176b88aa` (133 132 B)                                            |
| CI-opt HEAD (`codex/joy-live-director-ci-opt`)      | `61ac7e92ff5c4ae458df041f04b2627888930299` (doc-only past `6c21c589`; worktree HEAD re-checked in P0-R1, unchanged)                                                    |
| Frozen CI tag object / peeled commit / tree         | `44b2b11fac73be6b03058b3dd73d9d26540fd261` / `6c21c589e47a8fc0fa1b843487de284e706329a2` / `bd52e21aeb9f5021e1be5b045f3b347eae8fab41`                                   |
| Frozen CI + `7a509e6c` lock blob / raw SHA-256      | `4f2721172df53e834be167dc8d91d56bbaaacb88` / `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3` (133 032 B)                                            |
| Local `main` / `github` `main`                      | `6a6a336cdd4fb0126c002dda86167f5c92ebfe32` (tracks `vps/main`) / `93552f7aa7ce21b62eefba9f939d7160fc227a32` (5 dispatch-only CI commits ahead; `6a6a336c` an ancestor) |

Lock delta `6c21c589 → d01770b1`: **+3 lines**, `@joy-media/motion-core:
workspace:* → link:../motion-core` added to the `visual-object-renderer` importer
(and to that package's `devDependencies`). Workspace-internal link only.
`7a509e6c` (an ancestor of `d01770b1`) has the **same** lock as the frozen
`6c21c589` (`36426937…`); the identity diverged only at `d01770b1` (`c9e147f8…`).
(Ledger D-03.) Recompute method: `git cat-file blob <rev>:pnpm-lock.yaml |
sha256sum` (binary-safe subprocess). Lock **not modified**.

---

## 2. Per-sample matrix (15 MP4 files) — P0-R1 fresh `ffprobe`

Every file was fully probed in P0-R1 (`raw/<slug>.01-show`, `.02-vcount`,
`.03-acount`; six files also `.04-vpkts`, `.05-apkts`, `.06-sidedata`).
**meta** = container stream `nb_frames`; **decoded** = `ffprobe -count_frames`
`nb_read_frames`. All video: `codec h264`, `pix_fmt yuv420p`,
`r_frame_rate = avg_frame_rate = 30/1`, `time_base 1/15360`. All files carry muxer
tag `Lavf62.12.101` and video encoder tag `Lavc62.28.101 libx264`.
**No decoder-error line appeared on any stream's stderr.**

### 2a. Proxy samples — `jm-r2-check/samples-out/` (producer `render-look-samples.mjs`, sha256 `9dfd3642…`, 249 lines)

| File                            | sha256      | Dims    | video meta/decoded | V dur    | C dur    | V start  | Audio (aac 48k stereo) meta/decoded frames | Notes                                                                                |
| ------------------------------- | ----------- | ------- | ------------------ | -------- | -------- | -------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| editorial-clean-portrait.mp4    | `7510d1e4…` | 270×480 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | text incomplete (D-16); m→s motion ≈0 (D-13)                                         |
| editorial-clean-landscape.mp4   | `ab9286aa…` | 480×270 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | m→s ≈0                                                                               |
| product-precision-portrait.mp4  | `817039c8…` | 270×480 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | m→s ≈0                                                                               |
| product-precision-landscape.mp4 | `c006f94a…` | 480×270 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | m→s ≈0                                                                               |
| kinetic-type-portrait.mp4       | `9da49f73…` | 270×480 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | m→s 0.04                                                                             |
| kinetic-type-landscape.mp4      | `0ebc7bca…` | 480×270 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | m→s 0.04                                                                             |
| quiet-documentary-portrait.mp4  | `97579c6c…` | 270×480 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | m→s 0.01                                                                             |
| quiet-documentary-landscape.mp4 | `4cb7a818…` | 480×270 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | m→s 0.01                                                                             |
| music-pulse-portrait.mp4        | `5eeb1702…` | 270×480 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | audio silent (`verify-report.json` peak 0, REPORTED); no audio-bake exercised (D-14) |
| music-pulse-landscape.mp4       | `df3980b3…` | 480×270 | 240 / **240**      | 8.000000 | 8.000000 | 0.000000 | 376 / **375**                              | idem                                                                                 |

First video packet `pts_time` = `0.000000`; first audio packet `pts_time` =
`-0.021333` (ordinary AAC encoder pre-roll; probed on `editorial-clean-portrait`).
`verify-look-samples.mjs` covers these 10 with **no assertions** (D-12); status is
human-reviewed metadata consistency, not a gate.

### 2b. Intended-resolution samples — `jm-r2-check/samples-out/intended/` (producer `render-look-samples-intended.mjs`, sha256 `364ee617…`, 245 lines; only `editorial-clean` + `kinetic-type`)

| File                          | sha256      | Dims      | video meta/decoded | V dur    | C dur        | V start      | Audio meta/decoded / dur |
| ----------------------------- | ----------- | --------- | ------------------ | -------- | ------------ | ------------ | ------------------------ |
| editorial-clean-portrait.mp4  | `9425699f…` | 1080×1920 | 240 / **240**      | 8.000000 | **8.021029** | **0.021029** | 376 / **376** / 8.002667 |
| editorial-clean-landscape.mp4 | `9d350cbb…` | 1920×1080 | 240 / **240**      | 8.000000 | 8.021029     | 0.021029     | 376 / 376 / 8.002667     |
| kinetic-type-portrait.mp4     | `de83545a…` | 1080×1920 | 240 / **240**      | 8.000000 | 8.021029     | 0.021029     | 376 / 376 / 8.002667     |
| kinetic-type-landscape.mp4    | `b9a43dc8…` | 1920×1080 | 240 / **240**      | 8.000000 | 8.021029     | 0.021029     | 376 / 376 / 8.002667     |

First video packet `pts_time` = `0.021029` (all 4); first audio packet `pts_time` =
`0.000000` (all 4); `ffprobe -show_entries stream_side_data` surfaced no `elst`.
**OBSERVED:** video is exactly 240 decoded frames / 8.000000 s; the container
over-run of 21.029 ms is the video-stream start offset, audio starts at 0.
**INFERRED (not proven):** the offset arises in the 8-segment `ffmpeg -f concat
-c copy` path (`render-look-samples-intended.mjs:171–211`); the single-call proxy
path shows no offset. Exact tick derivation and edit-list-vs-shifted-timestamps
mechanism **UNVERIFIED**. **No producer verifier JSON exists for these 4**;
`frame-sweep` logs exist for 3 of 4. The "241 frames / 8.021 s" figure is
`frame-sweep.mjs:79` `Math.round(container_dur × fps)` — **there is no 241st
frame** (D-09).

### 2c. A/V sync fixture — `jm-r2-check/samples-out/av-sync-fixture.mp4` (producer `render-av-sync-fixture.mjs`, sha256 `8c8dda9b…`, 94 lines)

| Field                 | Value (P0-R1 OBSERVED unless marked)                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sha256                | `7ee395e3611d59450713ac3c002b206e66f372fb2fb83b065b9c78cfc230136a`                                                                                                                                                                                                                                                                                                               |
| Video                 | h264 480×270, 180 meta / **180 decoded**, 6.000000 s, start 0.000000, 30/1                                                                                                                                                                                                                                                                                                       |
| Audio                 | aac 48 kHz **mono** (1 ch), 283 meta / **282 decoded**, 6.000000 s, start 0.000000; first audio packet `pts_time` −0.021333                                                                                                                                                                                                                                                      |
| Content (from source) | solid black + full-frame red flash frames 60–62 (`FLASH_START_FRAME` line 37); 1 kHz sine burst centred t=2.0 s, 0.2 s wide (`sinExpr` line 68)                                                                                                                                                                                                                                  |
| Provenance            | **pure `ffmpeg` mux** — no `motion-core` / `bakeLookFromAudio` / compiler / Joy project. Encoder/timing control only (D-14).                                                                                                                                                                                                                                                     |
| Reported result       | `av-sync-report.json`: `verdict` PASS (`verify-av-sync.mjs:256`), A/V delta (centroid) −0.237 ms vs ±33 ms `TOLERANCE_MS`                                                                                                                                                                                                                                                        |
| P0-R1 caveat          | `firstFlashPtsUs` is assigned the **seek-loop variable `us`** at `verify-av-sync.mjs:116` (grid `1 500 000 + 15·33 333 = 1 999 995`), not a decoded PTS. The audio centroid (`verify-av-sync.mjs:197`) is a real PCM measurement. So the ±33 ms PASS stands **as reported by that tool**, but the cross-stream alignment precision is **NOT ESTABLISHED** by this method (D-10). |
| PCM peak              | `av-sync-report.json` `peakValue = 32768` = max `abs(sample)`. `abs(-32768)` is an ordinary JS number, **not int16 overflow**; a single negative-full-scale sample does not prove clipping (D-15).                                                                                                                                                                               |

---

## 3. Provenance matrix

| Axis          | What is pinned                                                                                                                                                                                                                                                                                           | What is NOT pinned                                                                                                                                                                     | Verdict                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Source**    | `d01770b1` tree `551ddb51…` (git, local == `github` — P0 observation)                                                                                                                                                                                                                                    | the untracked concurrent test `looks-encoded-sample-acceptance.test.ts` is not in this tree                                                                                            | **PINNED** for committed source; concurrent file excluded                                                            |
| **Scripts**   | 7 producer/verifier `.mjs` — sha256 + line counts recorded (§4); **untracked** in `jm-r2-check` (git `??`)                                                                                                                                                                                               | not committed anywhere; no test covers them; `verify-look-samples.mjs` has no assertions (D-12)                                                                                        | **HASH-PINNED, unversioned**                                                                                         |
| **Build**     | `check` = `typecheck (tsc -b) && lint && format:check && test` — **no `build` step**; all 6 packages `build: tsc -b`, `outDir dist`, `tsconfig.base` `composite`/`declaration`/`sourceMap`, no `noEmit`; per-file dist hashes in `dist-files.sha256`; per-package inventory in `package-provenance.json` | no dist / `node_modules` / `tsc` / `pnpm` hash captured **at render time**; mtimes are observations, not proof a `tsc -b` wrote exactly these bytes or that nothing rewrote them after | **UNPROVEN** — `tsc -b` emit is the most plausible dist writer but the source→dist→media chain has no receipt (D-19) |
| **Media**     | 15 MP4 sha256 recorded (§2); every file decoded == metadata; proxy path = single `renderRgbaFrames`; intended path = 8-segment `-c copy` concat                                                                                                                                                          | pixel content: typography acceptance incomplete (J/O/Y only, D-16), non-text pixels not audited here; intended files carry a 21 ms video start offset (D-09)                           | **HASH-PINNED**; content acceptance deferred to P2/P3                                                                |
| **Toolchain** | at run time: `ffprobe` 8.1.1-full_build-www.gyan.dev, `node` v22.22.3, `pnpm` 11.15.0; every MP4 embeds muxer `Lavf62.12.101` + encoder `Lavc62.28.101 libx264`; `verify-report.json` recorded ffmpeg/ffprobe 8.1.1; sweeps recorded `Node.js v22.22.3`                                                  | `pnpm` / `tsc` version at render time not independently recorded; OS/host not in manifests                                                                                             | **PARTIAL**                                                                                                          |

### Per-package dist inventory (P0-R1, `package-provenance.json` + `dist-files.sha256`)

`dist-files.sha256` recipe: for every file under `packages/<pkg>/dist/`, one line
`<sha256>  packages/<pkg>/dist/<relpath>` (forward slashes), sorted. 436 lines
total. The per-package **aggregate** is `sha256("\n".join(sorted lines)) + "\n"`
for that package's lines.

| package                | package.json sha256 | `src/index.ts` sha256 | dist files / bytes | dist aggregate sha256 | dist newest mtime    |
| ---------------------- | ------------------- | --------------------- | ------------------ | --------------------- | -------------------- |
| motion-core            | `f74fac968b…`       | `f2a4630aaf…`         | 212 / 653 935      | `c8a090a8cc44d3d5…`   | 2026-09-09T14:36:38Z |
| render-ir              | `6af8bba6e6…`       | `f445ff9154…`         | 24 / 38 054        | `0d0143cdae2a4fe4…`   | 2026-09-09T13:09:42Z |
| project-schema         | `d183f2dbff…`       | `9a5f2f79b7…`         | 160 / 860 828      | `4da0f0e9749efead…`   | 2026-09-09T13:09:41Z |
| visual-object-renderer | `e743f26056…`       | `e499220834…`         | 16 / 116 185       | `068335af470fc477…`   | 2026-09-09T14:58:47Z |
| renderer-headless      | `a1e783c308…`       | `24c3b69023…`         | 12 / 77 834        | `4af3339465e53498…`   | 2026-09-09T13:09:54Z |
| export-core            | `15518e61c6…`       | `77c6dd00ed…`         | 12 / 43 159        | `594f429a11f90fc1…`   | 2026-09-09T13:09:46Z |

File **counts** match the earlier revision's numbers (212/24/160/16/12/12); the
earlier aggregate hashes were computed by an undocumented recipe and are
**superseded** by `dist-files.sha256` + the recipe above. Two dist mtime waves:
~13:09Z (most packages) and ~14:36–14:58Z (`motion-core`, `visual-object-renderer`
and closure — the D-03 devDep set). `.tsbuildinfo` mtimes match. **These are
observations, not proof of when or by what the bytes were written.**

Workspace links (per-package `node_modules/@joy-media/*`, Windows junctions to
in-tree source): `visual-object-renderer` → `{motion-core, project-schema,
render-ir, evaluator, transition-shaders, renderer-headless, renderer-pixi,
golden-render}`; `renderer-headless` → `render-ir`; `motion-core` →
`{project-schema, expression-core}`; `export-core` → `test-fixtures`. All targets
in-tree; no `.pnpm` entry, no registry package for `@joy-media/*`.

---

## 4. Script inventory & hashes (`jm-r2-check/tooling/`, all untracked)

| Script                             | lines | SHA-256                                                            | Loads / uses                                                                                                                                                                                                                                         | Notable (with file-local lines)                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ----- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render-look-samples.mjs`          | 249   | `9dfd3642826c7011086d3f3eff2067e233b519e87f2f7b231f7e71be3da2899e` | `packages/{motion-core,render-ir,project-schema,visual-object-renderer,renderer-headless,export-core}/dist/index.js` (lines 43–50); `BUILT_IN_LOOK_PACKS`, `compileLook`, `buildRenderFrameIRFromProject`, `renderHeadlessFrame`, `renderRgbaFrames` | 5 packs × P/L, 240 frames @ 30 fps (`FRAME_COUNT` line 39); headline `'JOY LIVE'` (line 102) / deck `'the sequel'` (line 103); preset `'social-h264-aac'` (line 215)                                                                                                                                                                                                                              |
| `render-look-samples-intended.mjs` | 245   | `364ee6175a0f09862ff444c81f41faeb9c25b5a480c0d21ce312548b0267ed68` | same dist modules                                                                                                                                                                                                                                    | only `editorial-clean` + `kinetic-type`; 1080p; 30-frame batches (`BATCH = 30`, line 174) → per-batch MP4 (line 187) → `ffmpeg -f concat -safe 0 -i … -c copy` (line 211) → D-09                                                                                                                                                                                                                  |
| `render-av-sync-fixture.mjs`       | 94    | `8c8dda9b7e9234aa9812c0017ae000e68b196a2f64439c91f208f8c08c3fa959` | `ffmpeg` only                                                                                                                                                                                                                                        | **no Joy code**; flash frames 60–62 (line 37); `aevalsrc` 1 kHz sine `sinExpr` (line 68); `ffmpeg -i PPM -i sine` (lines 69–75)                                                                                                                                                                                                                                                                   |
| `verify-look-samples.mjs`          | 355   | `1e333de681dadf647abbf6057ac325d7f8d6f0b173d40a69c2bfb6545fe724f0` | `ffprobe`/`ffmpeg` only                                                                                                                                                                                                                              | `-count_packets`/`-count_frames` **without `-show_frames`** (lines 54–55); enumerates **top-level** `*.mp4` only via `readdirSync(SAMPLES_DIR).filter(n => n.endsWith('.mp4'))` (lines 214–215), not `intended/`; **no pass/fail assertions** — `report.failures` pushed only in `catch` (line 326); `countedFrames`/`firstFramePtsSeconds` structurally 0/null (lines 250, 263–264) — D-11, D-12 |
| `verify-av-sync.mjs`               | 271   | `885b6523d726bfcfdcc4a0378d0e1e65a358a3783ec7985e74f875bf4b55f88a` | `ffprobe`/`ffmpeg` only                                                                                                                                                                                                                              | seek grid: `frameStepUs` line 60, `sweepStartUs` line 63, loop line 71, `-ss` line 76; `firstFlashPtsUs = us` (line 116) — **seek-grid value, not decoded PTS** (D-10); audio centroid `centroidPtsUs` (line 197) is a real PCM measurement; **has** threshold `pass` fields (lines 239–242) and `verdict` (lines 256–257)                                                                        |
| `frame-sweep.mjs`                  | 100   | `a6cf4404c604f9d413890de7f03de0b2c11c230da9d0b637ac7ac59d0d542954` | `ffprobe`/`ffmpeg` only                                                                                                                                                                                                                              | `const totalFrames = Math.round(dur * fps)` where `dur = format.duration` (line 79) → prints 241 for the intended files (D-09)                                                                                                                                                                                                                                                                    |
| `inspect-ppm.mjs`                  | 94    | `3333f0d3d86594829f69365fdc208ef2a809e72463a6141ad794b9c6581c7ead` | none (PPM reader)                                                                                                                                                                                                                                    | ad-hoc pixel/ASCII inspector                                                                                                                                                                                                                                                                                                                                                                      |

Renderer bitmap: `git show d01770b1:packages/renderer-headless/src/index.ts`
(377 lines) — `const BITMAP` line 369, glyphs `J`/`O`/`Y` lines 370–372, helper
`bitmap()` line 376 (D-16).

Gallery doc `joy-live-director-r2-sample-gallery-2026-09-09.md` (untracked):
sha256 `44c32db762f0713df1f2731445fc68dba34907fe33431d197179d0d8d75a25a6`.
Concurrent test `looks-encoded-sample-acceptance.test.ts` (untracked, **not
adopted**): sha256 `4454b4afde4ceba4dac6b8307b1fd9c66c942763a299e2a864886f8f1c7aee30`.

---

## 5. Raw-log & reviewer-receipt availability

| Item                                                                                                 | Status                                                                      | Where                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full-check-0a829af4.log` (render timeout)                                                           | **LOCATED** (original stdout)                                               | `session-6672909d-logs/` — CHECK_EXIT 1; GAP-4 case #1 `timed out in 5000ms` at 5091 ms; other 9 pack cases passed                                                                                                           |
| `full-check-d01770b1.log` (green)                                                                    | **LOCATED**                                                                 | `session-6672909d-logs/` — CHECK_EXIT 0, 4328 pass, Duration 46.56 s                                                                                                                                                         |
| `full-check-f80e029a.log` (font-assets flake)                                                        | **LOCATED**                                                                 | `session-6672909d-logs/` — CHECK_EXIT 1; `font-assets.test.ts:104` case `timed out in 5000ms` (reported 13 694 ms); other 5 cases passed; earlier GAP checkpoint (534 files). A timeout, not a gate assertion failure (D-05) |
| other GAP checkpoint checks (`e65c132a`, `9f97ff0b`, `04edd236`, `4d3c8ce1`, `1bf0e656`, `c0de248c`) | **LOCATED**, not individually audited                                       | `session-6672909d-logs/`                                                                                                                                                                                                     |
| CI `check-52b11d51*.log` (×3)                                                                        | **LOCATED**, not audited                                                    | `session-6672909d-logs/`                                                                                                                                                                                                     |
| CI "SAFE TO FREEZE" (`e3c1a049..6c21c589`)                                                           | **DOCUMENTED SECONDARY CLAIM** — no independent reviewer artefact located   | `ci-opt-docs/joy-media-ci-review-response-2026-09-08.md` "Update 2026-09-09c" (commit `3b0446d5`)                                                                                                                            |
| CI review agent `ab3412457a7670bc0` output (`0cfb6ef8..e3c1a049`)                                    | **NOT LOCATED** (handoff lists it "pending")                                | —                                                                                                                                                                                                                            |
| GitHub artifact-quota / billing raw evidence                                                         | preserved dated (run `34165045011`, 2026-09-08) per handoff; not re-fetched | `ci-opt-docs/github-support-artifact-quota-2026-09-09.md`, `session-6672909d-logs/quota-probe-results.log`                                                                                                                   |
| Production / deployed identity                                                                       | **NOT VERIFIED** (needs VPS — out of P0 scope)                              | —                                                                                                                                                                                                                            |
| P0-R1 fresh `ffprobe` pass (15 MP4, 63 calls)                                                        | **PRESENT** — every call's argv/cwd/UTC/exit/stdout/stderr retained         | `joy-r2-p0-r1-evidence-20260909T192442Z/raw/` + `raw-command-index.json`                                                                                                                                                     |

Nothing was reconstructed from transcript. Transcript summaries are not raw logs.

---

## 6. Four-axis status (dated, attributed — P0 / P0-R1 do not advance any axis)

### 6.1 Implementation

- **REPORTED COMPLETE at `d01770b1`** (2026-09-09, Claude session `6672909d`):
  GAP 5, GAP 1a (migration 006), GAP 2 (audio bake), GAP 4, GAP 3.
- **P0 direct check:** `full-check-d01770b1.log` = CHECK_EXIT 0 (538 files / 4328
  pass / 38 skip), genuine. Caveat: `d01770b1` = `0a829af4` + one test-timeout
  bump; the slowness behind D-04/D-05 is not addressed (D-06).
- Source audit of GAP-1a migration ledger, GAP-2 render path, GAP-5 approval
  reuse **not performed** in P0/P0-R1 (out of scope).

### 6.2 Technical acceptance — **PARTIAL / PENDING**

- **Evidence in bundle (OBSERVED):** 15/15 MP4 well-formed; every file's decoded
  frame count equals its container metadata (proxy 240, intended 240, fixture
  180); proxy container metadata consistent with intent (human-reviewed, not
  asserted); the A/V fixture returns a REPORTED PASS within its own ±33 ms
  threshold.
- **Not closed:** typography acceptance **incomplete** — headline/deck text has no
  glyphs beyond J/O/Y (D-16); intended-resolution files have **no project-verifier
  coverage** and carry a 21 ms video start offset of unproven mechanism (D-08,
  D-09); GAP-2 baked-audio export has **no decoded-media evidence** (D-14); the
  A/V fixture's cross-stream precision is **not established** by its method (D-10);
  `font-assets` 5 s timeout root cause unmeasured (D-05).
- Attribution: technical-acceptance continuation, Claude session `6672909d`,
  2026-09-09; gallery doc `joy-live-director-r2-sample-gallery-2026-09-09.md`.

### 6.3 Subjective review — **PENDING (owner-only)**

- Historical Opus taste pass (plan Step 3): product-precision / quiet-documentary
  APPROVED; editorial-clean / kinetic-type CHANGES → fixed → APPROVED; music-pulse
  HELD → GAP 3 fix (`3eaa8cd7`) → APPROVED; persian-editorial RETIRED (handoff,
  2026-09-08/09). **Final readable-output review not done** — blocked on 6.2
  (text is incomplete in all preserved media).

### 6.4 Release infrastructure — **BLOCKED**

- Artifact uploads blocked; cause unresolved; billing is a **hypothesis** (handoff
  2026-09-09). No purchase, no scope change.
- Frozen CI tag `ci-v2-gate-frozen-6c21c589` → `44b2b11f…` → `6c21c589` —
  unchanged, local == `github` (P0 observation).
- "SAFE TO FREEZE" = documented secondary claim, no independent receipt (D-18).
- `codex/joy-live-director-ci-opt` **not folded**.
- R2 baseline lock (`c9e147f8…`) ≠ frozen-CI lock (`36426937…`) (D-03).
- `github` `main` carries 5 dispatch-only CI commits past the local checkout (D-02).

---

## 7. Command register

All commands read-only except the single `git worktree add` (P0). Full P0-R1
`ffprobe` argv/cwd/UTC/exit/stdout/stderr are in
`joy-r2-p0-r1-evidence-20260909T192442Z/raw-command-index.json`.

### 7a. P0 (session `7c5ec584`, ~18:49–19:10Z 2026-09-09)

| cwd                                | command (abbrev)                                                                                                                                             | exit |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| joy-media                          | `git worktree list` / `remote -v` / `ls-remote github <refs>` / `merge-base --is-ancestor`                                                                   | 0    |
| joy-live-director                  | `git cat-file blob <rev>:pnpm-lock.yaml \| sha256sum` (×3 rev) ; `git diff 6c21c589 d01770b1 -- pnpm-lock.yaml packages/visual-object-renderer/package.json` | 0    |
| 6672909d scratchpad                | `head`/`sed`/`grep` on `full-check-{0a829af4,d01770b1,f80e029a}.log`                                                                                         | 0    |
| jm-r2-check                        | `cat` manifests + `verify/*.json` ; `python` summariser                                                                                                      | 0    |
| jm-r2-check/samples-out[/intended] | `ffprobe -show_entries …` + `ffprobe -count_frames` on a **subset** of files (2 intended + 2 proxy + fixture) — superseded by the P0-R1 full pass            | 0    |
| jm-r2-check                        | `find packages/*/dist -exec sha256sum` (undocumented aggregate) ; `find -printf %T@`                                                                         | 0    |
| Desktop                            | `python preserve.py` — hash→copy→hash→re-hash, 78 items                                                                                                      | 0    |
| joy-media                          | `git worktree add -b codex/joy-r2-p0-provenance-20260909T185139Z … d01770b1`                                                                                 | 0    |

_Correction:_ the earlier "5 files" phrasing for the P0 `-count_frames` work was
inconsistent (it could not simultaneously mean "4 intended + 2 proxy + 1
fixture"). P0 spot-probed a subset; **P0-R1 probed all 15** and supersedes it.

### 7b. P0-R1 (session `7c5ec584`, ~19:24–19:35Z 2026-09-09)

| cwd         | command                                                                                                                                                                                        | count | exit |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- |
| samples-out | `ffprobe -v error -print_format json -show_format -show_streams <mp4>`                                                                                                                         | 15    | 0    |
| samples-out | `ffprobe -v error -count_frames -select_streams v:0 -print_format json -show_entries stream=… <mp4>`                                                                                           | 15    | 0    |
| samples-out | `ffprobe -v error -count_frames -select_streams a:0 -print_format json -show_entries stream=… <mp4>`                                                                                           | 15    | 0    |
| samples-out | `ffprobe … -select_streams v:0 -show_packets -read_intervals %+#3 <mp4>`                                                                                                                       | 6     | 0    |
| samples-out | `ffprobe … -select_streams a:0 -show_packets -read_intervals %+#3 <mp4>`                                                                                                                       | 6     | 0    |
| samples-out | `ffprobe … -show_streams -show_data -show_entries stream=…:stream_side_data <mp4>`                                                                                                             | 6     | 0    |
| jm-r2-check | `git status --porcelain` / `--untracked-files=all` ; `git show d01770b1:<paths>` ; `git cat-file blob 7a509e6c:pnpm-lock.yaml \| sha256sum` ; `git merge-base --is-ancestor 7a509e6c d01770b1` | —     | 0    |
| jm-r2-check | `python` static read of `packages/*/{package.json,tsconfig.json,tsconfig.tsbuildinfo,src/index.ts,dist/**}` + per-package `node_modules/@joy-media/*` link inspection                          | —     | 0    |
| —           | `which` / `--version` for `ffprobe`/`ffmpeg`/`node`/`pnpm`                                                                                                                                     | —     | 0    |

- **At most one `ffprobe` decoder ran at a time**; every call wrapped in a 120 s
  (metadata/decode) or 60 s (packet) timeout. **0 timeouts, 0 non-zero exits.**
  No render, build, install, benchmark, package script, or test suite was run.
- No child process force-killed. Residue: the two evidence roots + this worktree;
  scratchpad helpers under `…/7c5ec584-…/scratchpad/`.

## 8. Tests / checks NOT run in P0 or P0-R1 (explicit)

`pnpm -w run check` · `pnpm typecheck` / `tsc -b` · `pnpm build` · any Vitest
suite · `render-look-samples*.mjs` · `verify-look-samples.mjs` ·
`verify-av-sync.mjs` · `frame-sweep.mjs` · `scanFontAssets` /
`font-assets.test.ts` · any CI workflow / `gh workflow run` · migration 006 apply ·
browser / headless export · production smoke · GitHub billing or artifact-quota
probe · `git fetch/pull/merge` · `pnpm install`.

The old producers/verifiers were **not executed** — they create, overwrite, and
delete outputs in `samples-out/` and would mutate the preserved evidence.

---

## 9. Proposed next package — **P1 as the revised plan defines it** (inspection/patch — DO NOT EXECUTE)

Per plan §4 P1 ("Close the real cold-session agent discoverability gap, if
confirmed") — the **only** authorized next scope:

- Trace the actual `read_project_context` / host-tool results **after reopening a
  saved project**. Prove whether the agent can discover the instance IDs, pack
  IDs/version, bindings, orphan state, overrides and revision it needs to
  update / reset / detach — **without** the owner typing IDs and **without**
  relying on earlier chat memory.
- Source to inspect (choose real paths from current source): the JOY agent
  host-tool registry, `resolveLivingLookRun`, the project-context domain builders.
- **If** a gap is proven: implement the **smallest** bounded project-scoped
  `looks` context domain, reusing existing context / schema / pagination /
  redaction patterns; no agent-engine redesign. Tests: saved/reopened project,
  multiple instances / pagination, orphaned targets, stale revision, no
  unrelated-project data, update/detach approval. Deterministic provider fixtures
  are labelled as fixtures, never presented as a live model result.
- **If discovery already works:** demonstrate it and make no speculative changes.

Exit: source-backed finding or a small tested patch + cold-session task evidence.

### Deferred to later bounded packages — NOT P1, NOT executed here

| Item                                                                                                                                                                                               | Plan package                | Ledger           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------- |
| Typography acceptance on the real shipping renderer; whether J/O/Y bitmap is diagnostic-only or a shipping path                                                                                    | **P2**                      | D-16             |
| Real baked-audio (Music Pulse) end-to-end encoded-media acceptance with independent audio+motion decode; ownership of the concurrent untracked test                                                | **P3**                      | D-14             |
| Intended-resolution verifier coverage + real assertions in `verify-look-samples.mjs`; reframing the "241-frame" task as the 21 ms start-offset (no frame-count change) after a shipping-path audit | **P3**                      | D-08, D-09       |
| `verify-av-sync.mjs` decoded first-red-frame PTS instead of the seek-loop variable                                                                                                                 | **P3**                      | D-10             |
| `font-assets.test.ts` 5 s timeout: instrument `scanFontAssets` wall-time under load, then choose a fix with evidence                                                                               | **P2/P3** (release tooling) | D-05             |
| CI-v2 independent acceptance; ci-opt fold; final R2 release gate on the integrated candidate; `github/main` divergence                                                                             | **P4–P6**                   | D-02, D-03, D-18 |

---

_P0 / P0-R1 preserve and reconcile. They do not accept. External GPT-6 Astra's
candidate-specific `APPROVE_FOR_DEPLOY <sha> <tree> <lock-sha256>` and the owner's
separate deployment go-ahead remain mandatory and unmet._
