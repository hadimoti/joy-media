# JOY Live Director R2 — P0 discrepancy ledger (2026-09-09, rev P0-R1)

Corrected active summary for the reconciliation items. Historical / frozen reports
are linked, not rewritten. Each row: **claim → source → direct observation →
evidence → impact → resolution or remaining hypothesis.**

Legend for "state": **RESOLVED** (direct observation settles it) ·
**OPEN-HYPOTHESIS** (cause not proven) · **GAP** (evidence absent) ·
**CONFIRMED** (claim verified true).

Status words on individual conclusions: **REPORTED** (someone else's claim, not
re-checked here) · **OBSERVED** (measured in P0 or P0-R1) · **INFERRED** (follows
from observations plus a stated assumption) · **UNVERIFIED** (asserted, no receipt).

> **P0-R1 revision (2026-09-09, Claude session `7c5ec584`).** Fresh read-only
> `ffprobe` observations over the preserved media are in
> `C:\Users\HadiMoti\Desktop\joy-r2-p0-r1-evidence-20260909T192442Z\`
> (`per-sample.json`, `raw-command-index.json`, `raw/<tag>.*`). Script line
> citations are corrected against the preserved copies (real line counts:
> `render-look-samples.mjs` 249, `render-look-samples-intended.mjs` 245,
> `render-av-sync-fixture.mjs` 94, `verify-look-samples.mjs` 355,
> `verify-av-sync.mjs` 271, `frame-sweep.mjs` 100, `inspect-ppm.mjs` 94).

---

## Git / branch / lock

### D-01 — `main` identity: local vs GitHub — RESOLVED

- **Claim:** local `main` `6a6a336c`; "GitHub main observed by reviewer `93552f7a`".
- **Observation:** local `main` = `6a6a336c`, tracks **`vps/main`** (not github).
  `git ls-remote github refs/heads/main` = `93552f7a`. `6a6a336c` **is an ancestor
  of** `93552f7a`; both objects present locally.
- **Impact:** "main" is ambiguous across three references (local checkout, `vps/main`,
  `github/main`). None is verified as the deployed identity.
- **Resolution:** github `main` is 5 commits ahead of the local checkout — see D-02.
  Deployed production identity remains **UNVERIFIED** in P0 (out of scope; needs the VPS).

### D-02 — GitHub `main` advanced past the handoff record — RESOLVED

- **Claim:** handoff: "`main` gained 2 dispatch-only workflow-file commits".
- **Observation:** `6a6a336c..93552f7a` = **5** commits, all dispatch-only CI
  (`f766c981`, `a0a9f309`, `d40fdca4`, `0f70b52d`, `93552f7a` —
  `release-candidate-v2.yml` syncs + `artifact-quota-check.yml`). No product code.
  `github/main` reflog: all "update by push", newest `93552f7a` @ 2026-09-09 02:25 +0330.
- **Impact:** low. Confirms "no product code on main"; the doc count is stale.
- **Resolution:** github `main` = `93552f7a` (dispatch-only workflows only). Local
  checkout intentionally not updated. Not reverted.

### D-03 — "R2 adds no deps / lock unchanged since R1" — RESOLVED (lock identity diverged between candidates)

- **Claim:** the technical-acceptance handoff, **for candidate `7a509e6c`**, states
  `pnpm-lock.yaml` raw SHA-256 `36426937…` "(unchanged since R1 — R2 adds no deps)".
- **Observation (binary-safe `git cat-file blob <rev>:pnpm-lock.yaml | sha256sum`):**
  - `7a509e6c`: raw SHA-256 `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3`.
  - frozen CI `6c21c589`: **same** — `36426937…` (133 032 B), blob `4f272117…`.
  - application baseline `d01770b1`: `c9e147f8f56265b5e53e64800c1f691d67675ac2618434bfc821f666176b88aa`
    (133 132 B), blob `bcf36b0d…`.
  - `7a509e6c` **is an ancestor of** `d01770b1`.
  - `git diff 6c21c589 d01770b1 -- pnpm-lock.yaml`: **+3 lines** —
    `@joy-media/motion-core: specifier workspace:* / version link:../motion-core`
    added to the `visual-object-renderer` importer.
  - `git diff … packages/visual-object-renderer/package.json`:
    `@joy-media/motion-core: "workspace:*"` added to `devDependencies`.
- **Impact:** the handoff claim was **correct for its candidate** `7a509e6c` (and
  for the frozen `6c21c589`). The lock **changed later**, between `7a509e6c` and the
  5-pack baseline `d01770b1`, to add a **workspace-internal link** (no third-party
  package, no registry fetch). Any release gate qualified on `36426937…` does not,
  by identity, cover `c9e147f8…`. Matches plan §1 / item 10.
- **Resolution:** "no external deps" is accurate throughout. Lock **identity** for
  the current baseline is `c9e147f8…` and is **not** the frozen-CI lock. Lock not
  modified. Do not retroactively call the `7a509e6c` statement "false".

### D-17 — frozen CI tag: object vs peeled commit — CONFIRMED (not a mutation)

- **Claim:** `ci-v2-gate-frozen-6c21c589` → `44b2b11f…` vs peeled `6c21c589…`.
- **Observation:** local + `git ls-remote github`: annotated **tag object**
  `44b2b11fac73be6b03058b3dd73d9d26540fd261`; `^{}` peeled **commit**
  `6c21c589e47a8fc0fa1b843487de284e706329a2`. Tagger `Hadi` 2026-09-09 03:18:35 +0330.
  Identical local and remote.
- **Resolution:** two different object types, as designed. Tag unchanged, not touched.

---

## Full-workspace check / test-timeout failures

### D-04 — "render timeout" at `0a829af4` — CONFIRMED

- **Claim:** plan: `full-check-0a829af4.log` = render timeout.
- **Observation (`session-6672909d-logs/full-check-0a829af4.log`, 84 110 B):**
  `SHA: 0a829af4…`, `CHECK_EXIT: 1`. `looks-render-acceptance.test.ts`
  (10 tests | 1 failed | 28152 ms). Sole failure:
  `R2 Look pack rendered-frame + preview/export acceptance (GAP 4) >
editorial-clean (portrait): identical preview/export at 3 frames, with real
motion 5091ms` → `Error: Test timed out in 5000ms.` The **other 9** GAP-4 pack
  cases in the same file passed (2365–3244 ms). `Tests 4327 passed / 1 failed /
38 skipped`. In this same run, `font-assets.test.ts` **passed** (6 tests, 408 ms).
- **Impact:** the first GAP-4 acceptance case (cold, first in the suite) exceeded
  Vitest's 5 s default by ~91 ms under full-suite load.
- **Resolution:** fixed forward by the next (and only) commit — see D-06.

### D-05 — "font-assets failure at `f80e029a`" — RESOLVED (a test timeout, not a gate assertion failure)

- **Claim:** handoff/plan: "font-assets timeout … cold-start / load sensitivity";
  elsewhere shorthand "font-assets failure".
- **Observation (`session-6672909d-logs/full-check-f80e029a.log`, 81 962 B):**
  `SHA: f80e029a…`, `CHECK_EXIT: 1`. `tooling/release/src/font-assets.test.ts`
  (6 tests | 1 failed | 13903 ms). Sole failure:
  `editor font redistribution gate > is clean through the same scanner used by
release:gate 13694ms` → `Error: Test timed out in 5000ms.` Stack top
  `font-assets.test.ts:104:3`; the case body's first statement (line 105) is
  `const result = scanFontAssets(repositoryRoot);`. The **other 5** cases in that
  file passed (0–202 ms). `Tests 4263 passed / 1 failed / 38 skipped (4302)`;
  `Test Files 532 passed / 1 failed / 1 skipped (534)` — this is an **earlier GAP
  checkpoint** than `0a829af4` / `d01770b1` (539 files). At `0a829af4` (D-04) the
  same file passed.
- **Impact:** **not** a Fontiran / redistribution-gate assertion failure. Same
  failure _mode_ as D-04 (Vitest 5 s default exceeded), a different test, on a
  flaky basis (passed at `0a829af4`, timed out at `f80e029a`).
- **Resolution / remaining hypothesis:** the timeout establishes only that the 5 s
  budget was exceeded (reported case duration ~13.7 s). It does **not** establish
  which internal operation was slow, nor whether any assertion in that case ran.
  Root cause is **OPEN-HYPOTHESIS** (not measured). `font-assets.test.ts` was
  **not** given a timeout bump (D-06); at `d01770b1` it still runs on the default
  5 s and its green status that run depends on the case finishing in time.

### D-06 — "green full check on `d01770b1`" — CONFIRMED, with a caveat

- **Claim:** "`pnpm -w run check` green at `d01770b1`; 538 files / 4328 tests pass / 0 fail".
- **Observation (`full-check-d01770b1.log`):** `SHA: d01770b1…`, `CHECK_EXIT: 0`,
  `Test Files 538 passed | 1 skipped (539)`, `Tests 4328 passed | 38 skipped
(4366)`, `Duration 46.56s`. `git log 0a829af4..d01770b1` = **exactly one commit**:
  `d01770b1 test(r2): GAP 4 — give render/export acceptance cases a 30s timeout`.
  `git show d01770b1:…looks-render-acceptance.test.ts` → the GAP-4 `it(...)` block
  ends `}, 30_000);`. `font-assets.test.ts` unchanged (still default).
- **Impact:** the green run is genuine. `d01770b1` differs from `0a829af4` **only**
  by raising one test's timeout; the slowness that produced D-04 (and, on an
  earlier checkpoint, D-05) is **not addressed**.
- **Resolution:** green = real; "the timeout is a budget increase, not a fix"
  (handoff) is accurate. Residual flake risk on `font-assets.test.ts` (unbumped
  5 s) is real; "stop and explain if it recurs" stands.

---

## Sample inventory & media

### D-07 — "11 MP4s" — RESOLVED

- **Claim:** `r2-technical-acceptance-handoff` TL;DR: "generated 11 MP4s (10 proxy
  - 1 A/V sync fixture + 4 intended-resolution samples)". (10+1+4 = 15.)
- **Observation:** on disk / in the preserved bundle: **10** proxy, **4** intended,
  **1** `av-sync-fixture.mp4` → **15 MP4 files**. `manifest.json` `generatedAt`
  16:25:11Z; `intended/manifest.json` 17:35:10Z.
- **Resolution:** **15** MP4 files (10 + 4 + 1). Reviewer's count (15) is correct.

### D-08 — "all 10 proxy + 4 intended decode = PASS" — GAP (partial coverage)

- **Claim:** handoff: "Container-level decode of all 10 proxy MP4s = PASS"; and the
  4 intended files "decode with correct dims, frame count, duration, sample rate".
- **Observation:** `samples-out/verify/verify-report.json` `sampleCount = 11`; its
  `samples[]` are the **10 proxy + `av-sync-fixture.mp4` only**.
  `verify-look-samples.mjs` enumerates `readdirSync(SAMPLES_DIR)` at the **top
  level** (lines 214–215) and does **not** recurse into `samples-out/intended/`.
  **No verifier JSON exists for the 4 intended files.** Only **3** of 4 have a
  `sweep-*.txt` (`sweep-editorial-clean-portrait.txt` absent).
- **Impact:** the intended-resolution decode claim is backed by 3 `frame-sweep`
  logs + the P0 / P0-R1 `ffprobe` probes (D-09) — not by the project's verifier.
- **Resolution:** "4 intended decoded and verified" is **partially evidenced**:
  P0-R1 `ffprobe -count_frames` covered all 4 (240 decoded each); the project's own
  verifier covered 0 of 4.

### D-09 — "intended renders = 241 frames / 8.021 s" — RESOLVED (240 frames; the 21 ms is a real, separate video start offset)

- **Claim:** handoff / gallery: intended-resolution renders produce **241 frames /
  8.021 s** instead of 240 / 8.000 s; plan P3 lists "fix the 241-frame concat
  sample generator"; the plan warns against an "extra-frame fix on an unproven
  premise".
- **Observation — P0-R1 `ffprobe`, one decoder at a time, all four intended files
  (`raw/intended-*.02-vcount.*`, `.01-show.*`, `.04-vpkts.*`, `.05-apkts.*`,
  `.06-sidedata.*`):**
  - video stream: `nb_frames = 240` **and** `nb_read_frames = 240` (real decode),
    `duration = 8.000000`, `r_frame_rate = avg_frame_rate = 30/1`,
    `time_base = 1/15360`, `pix_fmt = yuv420p`.
  - video stream `start_time = 0.021029` (all four, identical; = 323/15360 ticks).
  - container `format.duration = 8.021029` = video `start_time` + video `duration`.
  - first **video** packet `pts_time = 0.021029`; first **audio** packet
    `pts_time = 0.000000`; audio `start_time = 0.000000`, `duration = 8.002667`,
    `nb_frames = nb_read_frames = 376`.
  - proxy files (single `renderRgbaFrames` call): video `start_time = 0.000000`,
    first video packet `pts_time = 0.000000`, first **audio** packet
    `pts_time = -0.021333` (ordinary encoder pre-roll), 240 decoded, 8.000 s.
  - `ffprobe -show_entries stream_side_data` surfaced **no `elst` / edit list** on
    the intended files.
  - `frame-sweep.mjs:79` computes `const totalFrames = Math.round(dur * fps)` where
    `dur = format.duration` → `round(8.021029 * 30) = round(240.63) = 241`.
- **Impact:** **there is no 241st decoded video frame and no 8.021 s video** — the
  video is exactly 240 frames / 8.000000 s (OBSERVED). The intended container
  over-runs by **21.029 ms** because the video stream starts at `0.021029` while
  the audio starts at `0`. The "241" is a `round(container_dur × fps)` artefact of
  `frame-sweep.mjs`.
- **Cause (INFERRED, not proven):** `render-look-samples-intended.mjs` renders in
  30-frame batches (`BATCH = 30`, line 174), encodes **8 separate H.264+AAC MP4
  segments**, and joins them with `ffmpeg -f concat -safe 0 -i … -c copy` (line
  211). The proxy path does a single `renderRgbaFrames` call and shows **no**
  offset (OBSERVED). The `-c copy` segment concat is the mechanism that differs.
  The exact derivation of `0.021029` (≈ one AAC frame `1024/48000 = 0.021333`, but
  not equal) and whether it is realised as shifted timestamps vs an edit list is
  **UNVERIFIED** — no packet/edit-list receipt pins it.
- **Resolution:** the plan's "concat extra-frame fix" would target a non-existent
  241st frame. The real artefact is a **21.029 ms video-start offset present only
  in the 8-segment `-c copy` path**. Whether the _shipping_ export path uses a
  single-call encode (like the proxy path, no offset) or a segmented one is a
  **path audit deferred to P2/P3** — not done here. **Do not** relax any authored
  frame count; **do not** "fix" a 241st frame; **do not** yet label the 21 ms
  effect cosmetic, harmless, or shipping-path-excluded.

### D-13 — "midToSettle = 0.00 for 3/10 packs" — CONFIRMED (phrasing note)

- **Observation:** `verify-report.json` `motion.midToSettle`: editorial-clean 0.00
  (both orientations), product-precision 0.00 (both), music-pulse 0.00 (both),
  quiet-documentary 0.01, kinetic-type 0.04 → **6 of 10 proxy samples** have
  ~zero mid→settle pixel motion (the 3 named packs × 2 orientations).
- **Resolution:** "3 packs" vs "6 samples" — same finding. Distinguish intended
  hold periods from missing motion (plan P3), not a P0 defect.

---

## A/V sync fixture

### D-10 — "A/V delta −0.24 ms, sub-frame accurate" — RESOLVED (precision claim not supported by the method)

- **Claim:** handoff: "video first red PTS 1 999 995 µs (offset −0.01 ms), audio
  centroid 1 999 758 µs, A/V delta **−0.24 ms** vs ±33 ms tolerance".
- **Observation (`verify-av-sync.mjs`, 271 lines, preserved copy sha256
  `885b6523…`; `samples-out/verify/av-sync-report.json`):**
  - `frameStepUs = Math.round(1_000_000 / fps)` (line 60) = 33 333;
    `sweepStartUs = Math.max(0, 2_000_000 − 500_000)` (line 63) = 1 500 000;
    the seek loop is `for (let us = sweepStartUs; us <= sweepEndUs; us += frameStepUs)`
    (line 71) and seeks with `-ss` at `t.toFixed(6)` (line 76).
  - on the first frame whose mean colour passes the red test,
    `firstFlashPtsUs = us` (**line 116**, inside the `if` at line 115) — i.e. the
    field is assigned the **loop seek variable**, `1 500 000 + 15·33 333 =
1 999 995`. It is not read back from a decoded packet/frame PTS.
  - `firstFlashOffsetMsFromExpected = (1 999 995 − 2 000 000)/1000 = −0.005` — grid
    arithmetic.
  - the audio side **is** a real measurement: `centroidPtsUs` (line 197) from the
    energy-weighted centroid of the decoded PCM burst; `av-sync-report.json`
    `avDeltaMs.usingCentroid = -0.237` = real audio centroid − the quantised video
    seek value.
- **Impact:** the reported A/V delta is a **real audio centroid differenced against
  a seek-grid target**. The video axis of that measurement is **not** a decoded
  timestamp. The historical PASS verdict (`av-sync-report.json` `verdict` set at
  line 256/257 from `pass.avDeltaCentroidWithinTolerance`, ±33 ms) stands **as
  reported by that tool**, but the actual cross-stream alignment tolerance is
  **NOT VERIFIED by this method**, and the "−0.24 ms" / "sub-frame" precision
  phrasing is unsupported. (Whether `-ss` before `-i` is an accurate or fast seek
  here is not determined and is not diagnosed from argument order alone.)
- **Resolution:** cite the historical result as "REPORTED PASS within ±33 ms by
  `verify-av-sync.mjs`; video-axis timestamp is the seek-grid value, so measured
  cross-stream precision is NOT ESTABLISHED." A decoded first-red-frame PTS
  measurement is P1-adjacent verifier work (deferred; see provenance report §9).

### D-14 — A/V fixture as "Music Pulse audio-bake export proof" — GAP

- **Claim:** implied linkage of the fixture's A/V result to GAP 2 (Music Pulse
  decoded-PCM → beat envelope → `bakeLookFromAudio` → `audioBakes`).
- **Observation:** `render-av-sync-fixture.mjs` (94 lines) builds solid-colour P6
  PPMs + an `ffmpeg aevalsrc` 1 kHz sine (`sinExpr`, line 68) and muxes them
  (`ffmpeg -i frame%04d.ppm -i <sinExpr>`, lines 69–75). It imports **nothing**
  from `motion-core`, `bakeLookFromAudio`, `audioBakes`, the Look compiler, or any
  Joy project. Both `music-pulse-*.mp4` proxy samples (portrait + landscape — **2
  files, not 10**) have **silent** audio: `verify-report.json` `audioPcm.peak = 0`
  for all 10 proxy rows including the two music-pulse rows (REPORTED by
  `verify-look-samples.mjs`; peak via `peakDb` at line 190).
- **Impact:** GAP 2 end-to-end (import non-silent workspace audio → bake →
  approve/apply → export → independently decode audio-reactive motion +
  synchronized audio) has **no decoded-media evidence in this bundle**.
- **Resolution:** the fixture is a valid **encoder/mux timing control only**.
  GAP 2 acceptance remains **GAP**.

### D-15 — `av-sync-report.json` `peakValue = 32768` — RESOLVED (not int16 overflow)

- **Observation:** `verify-av-sync.mjs` computes `peakValue` as the maximum
  `Math.abs(sample)` over the decoded PCM; the `aevalsrc` sine is generated at
  amplitude 1.0 (line 68). `verify-report.json` also reports the fixture's
  `audioPcm.peak = 32768`.
- **Impact:** `abs(-32768) = 32768` is an ordinary JavaScript number — **not** an
  int16 overflow. One boundary sample at negative full scale does not, by itself,
  prove sustained clipping.
- **Resolution:** record as "decoded PCM reaches negative full scale (a −32768
  sample); whether the tone audibly clips or the centroid is materially shifted is
  **not established**." No further audio investigation required here.

---

## Verifier correctness

### D-11 — `countedFrames = 0` / `firstFramePtsSeconds = null` in `verify-report.json` — RESOLVED (structural, not decode evidence)

- **Observation:** `verify-look-samples.mjs` `probe()` runs `ffprobe` with
  `-count_packets` (line 54) and `-count_frames` (line 55) but **without
  `-show_frames`**, so `probeJson.frames` is `undefined`; therefore the
  `frames?.filter((f) => f.media_type === 'video') ?? []` at **line 250** is always
  empty and `countedFrames` (**line 263**) / `firstFramePtsSeconds` (**line 264**)
  are structurally `0` / `null` for **every** sample. Confirmed: all 11 rows in
  `verify-report.json` show `countedFrames = null`, `firstFramePtsSeconds = null`.
- **Impact:** these two fields are **not** independent decoded-frame or PTS
  evidence. The per-sample frame count the report does carry (`video.nbFrames`) is
  container stream metadata (`nb_frames`), not a decode.
- **Resolution:** P0-R1 obtained genuine decode counts with `ffprobe
-count_frames` (`nb_read_frames`) for **all 15** files (proxy 240, intended 240,
  fixture 180) — recorded in `per-sample.json` and the provenance report §2.

### D-12 — "container-level PASS" is asserted by the verifier — RESOLVED (only `verify-look-samples.mjs` has no assertions)

- **Observation:**
  - `verify-look-samples.mjs` (355 lines) has **no pass/fail assertions**. It
    pushes to `report.failures` **only** inside `catch (error)` when
    `ffmpeg`/`ffprobe` throws (`report.failures.push({ name, error: error.message })`,
    **line 326**). There is no threshold check on dimensions, frame count,
    duration, fps, motion, or audio, and it does not enumerate
    `samples-out/intended/`. "PASS" for the proxy set is a **human reading the
    JSON**.
  - `verify-av-sync.mjs` (271 lines) **does** have threshold logic: a `pass`
    object with `flashWithinTolerance` / `centroidWithinTolerance` /
    `avDeltaCentroidWithinTolerance` (**lines 239–242**, `TOLERANCE_MS`), and
    `const verdict = report.pass.avDeltaCentroidWithinTolerance ? 'PASS' : 'FAIL'`
    (**line 256**). Its timing method is still inadequate on the video axis (D-10),
    but it is not assertion-free.
- **Resolution:** report the proxy "PASS" as "10 proxy files: metadata consistent
  with intent (human-reviewed, not asserted)"; report the A/V fixture as
  "REPORTED PASS by `verify-av-sync.mjs`'s own ±33 ms threshold, video-axis
  timestamp caveat per D-10".

---

## Build / renderer provenance

### D-16 — BITMAP glyph limitation (J/O/Y only) — CONFIRMED

- **Observation:** `git show d01770b1:packages/renderer-headless/src/index.ts`
  (377 lines): `const BITMAP: Readonly<Record<string, readonly string[]>> = {`
  at **line 369**, entries `J` / `O` / `Y` (5-row × 3-col) at **lines 370–372**,
  helper `bitmap()` at line 376, used from the rasteriser at line 106. The sample
  producers set headline text `'JOY LIVE'` (`render-look-samples.mjs:102`) and
  deck `'the sequel'` (line 103).
- **Impact:** every proxy and intended MP4 renders at most the J/O/Y of "JOY";
  "LIVE" and "the sequel" have no glyphs. **Typography acceptance is incomplete**
  from these artefacts. This does **not** make every pixel unobservable —
  background, layout geometry, motion, and colour are still present; it does mean
  no readable-text conclusion can be drawn. The standalone A/V flash fixture
  contains **no typography** and is not affected by this limitation.
- **Resolution:** whether the J/O/Y rasteriser is a diagnostic/geometry path or a
  promised shipping export path is **deferred to P2**. Typography acceptance must
  run on the real shipping browser/export renderer (plan P2), not this bitmap.

### D-19 — source → build → media linkage — GAP (check ≠ build; no receipt binds dist to the renders)

- **Claim:** (none) — `manifest.json` records only `frozenSha` (git HEAD `d01770b1`).
- **Observation (static, read-only):**
  - The root `check` script is
    `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. It contains
    **no `pnpm build` step.** `verify:ci` is `pnpm check && pnpm build &&
pnpm audit:prod`. The preserved `full-check-d01770b1.log` records `CHECK_EXIT`
    and the `check` script, **not** `verify:ci`.
  - `typecheck` = `tsc -b` at the repo root. Each of the six imported packages has
    `"build": "tsc -b"`, `tsconfig.json` `compilerOptions.outDir = "dist"`,
    `rootDir = "src"`, `extends ../../tsconfig.base.json`. `tsconfig.base.json` sets
    `composite: true`, `declaration: true`, `sourceMap: true` and **no** `noEmit` /
    `emitDeclarationOnly`. The `dist/*.js` files carry `//# sourceMappingURL=…` and
    original JSDoc — plain `tsc` emit, no bundler. So the `pnpm typecheck` step of
    `pnpm -w run check` **is** a TypeScript project-reference build that emits to
    `packages/*/dist`; it is the most plausible writer of the current dist bytes.
  - dist / `.tsbuildinfo` mtimes fall in two waves: ~13:09Z (most packages) and
    ~14:36–14:58Z (`motion-core`, `visual-object-renderer`, and their dependency
    closure — the packages touched by the D-03 devDep addition). Sample renders:
    proxy `manifest.json` `generatedAt` 16:25:11Z, intended 17:35:10Z.
  - the producers `import('../packages/<pkg>/dist/index.js')` by relative path
    (`render-look-samples.mjs:43–50`); `packages/*/dist` are **git-ignored**.
    Per-package `node_modules/@joy-media/*` are Windows **junctions** to the
    in-tree sibling source directories (e.g.
    `visual-object-renderer/node_modules/@joy-media/motion-core` →
    `packages/motion-core`); no `.pnpm` entry, no registry package.
- **Assessment:** mtimes are **observations**, not proof — they do not establish
  that a `tsc -b` run wrote exactly these bytes, that nothing rewrote them
  afterward with identical or different content, or that the dist the scripts
  `import()`ed at 16:25 / 17:35 is byte-for-byte what is on disk now. No dist hash,
  `node_modules` hash, or `pnpm`/`tsc` version was captured **at render time**;
  `manifest.json` stores only git HEAD.
- **Resolution:** historical **production-build execution** and the
  **source → dist → media** linkage are **UNPROVEN**. A per-file dist hash list
  (`dist-files.sha256`, 436 entries, normalized paths) and per-package inventory
  (`package-provenance.json`) are recorded now as a point-in-time reference for a
  future receipted re-render (P3). The earlier undocumented aggregate dist hashes
  are superseded by that list.

### D-18 — "SAFE TO FREEZE" reviewer receipt — RESOLVED (documented secondary claim; no independent artefact located)

- **Claim:** plan §3.3 / handoff: independent review of `e3c1a049..6c21c589`
  returned **SAFE TO FREEZE**; earlier `0cfb6ef8..e3c1a049` review = agent
  `ab3412457a7670bc0` (status "pending").
- **Observation:** the verdict lives in
  `joy-media-ci-review-response-2026-09-08.md` "Update 2026-09-09c" (committed
  `3b0446d5` on `codex/joy-live-director-ci-opt` by the implementer session). It
  records candidate `6c21c589` / tree `bd52e21a` / lock blob `4f272117` / lock
  sha256 `36426937…` / workflow blob `b5a5880d…`. **No independent reviewer
  transcript, session ID, or signed verdict artefact was located** on any scoped
  worktree or in session `6672909d`. Agent `ab3412457a7670bc0` has **no located
  output**.
- **Resolution:** classify "SAFE TO FREEZE" as a **documented secondary claim**,
  not an inspectable independent review. If an independent receipt exists it is
  outside the scoped worktrees; otherwise the CI-v2 independent acceptance
  (plan P4) is still owed. SAFE TO FREEZE ≠ CI-v2 qualification ≠ deployment approval.

---

## Concurrent / freshness

### D-20 — concurrent-work freshness — RESOLVED (noted, not touched)

- **Observation (mtimes, local +0330):**
  - `apps/editor-web/src/looks-encoded-sample-acceptance.test.ts` (untracked on
    `codex/joy-live-director`) — SHA-256
    `4454b4afde4ceba4dac6b8307b1fd9c66c942763a299e2a864886f8f1c7aee30` (unchanged
    on P0 and P0-R1 re-hash). Imports `bakeLookFromAudio` and does encoded-sample
    acceptance — targets the GAP 2 / GAP 4 evidence gap.
  - `jm-r2-check/docs/reviews/joy-live-director-r2-sample-gallery-2026-09-09.md`
    (untracked); Desktop plan/handoff docs; session `6672909d` jsonl — all last
    modified ~1–3 h before this P0 session started.
- **Impact:** another actor was editing planning docs and at least one test file
  shortly before P0. Nothing indicates edits **during** the P0 or P0-R1 window;
  all scoped worktree HEADs (`6a6a336c`, `d01770b1`, `d01770b1`, `61ac7e92`) and
  the concurrent test hash were rechecked at P0-R1 start and were unchanged.
- **Resolution:** snapshotted read-only into `concurrent-unverified/`; **not**
  adopted, run, staged, reverted, or edited. Ownership must be established before
  P1 touches it.

### D-21 — plan/backup filename divergence — RESOLVED (not a discrepancy)

- **Observation:** `joy-director-r2-and-ci-close-plan-2026-09-09.md` and
  `joydirectorr2andcicloseplan20260909.before-codex-review.md` are
  **byte-identical** (both SHA-256
  `F378287911723E057792F44F63550948CD515FBF12BBCA7595E3394CAF6718C9` — the value
  the active plan cites for its backup). The active
  `joydirectorr2andcicloseplan20260909.md` (27 053 B) is the Codex revision.
- **Resolution:** provenance clean; session wrote the long-name file → Codex
  byte-preserved it → revised into the active plan.

---

## Cross-reference to frozen / historical records (not rewritten)

- `jm-r2-check/docs/reviews/joy-live-director-r2-sample-gallery-2026-09-09.md`
  (untracked) — the technical-acceptance session's own gallery + four-axis status.
- `jm-r2-check/docs/reviews/joy-live-director-r2-gap-reconciliation-2026-09-08.md`
  lines 378–392 — the `f80e029a` failure narrative (see D-05).
- `.../joy-live-director-r2-{acceptance-bundle,look-scorecard}-2026-09-08.md` —
  describe the historical 4-pack `7a509e6c` candidate; superseded by the 5-pack
  `d01770b1` but **not** rewritten here.
- `joy-media-ci-opt` `joy-media-ci-{review-response,open-items}-2026-09-08.md` —
  CI-v2 review response and the 15-namespace inventory (D-18).
