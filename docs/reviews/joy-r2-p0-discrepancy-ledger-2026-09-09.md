# JOY Live Director R2 — P0 discrepancy ledger (2026-09-09)

Corrected active summary for the reconciliation items. Historical / frozen reports
are linked, not rewritten. Each row: **claim → source → direct P0 observation →
evidence → impact → resolution or remaining hypothesis.**

Legend for "state": **RESOLVED** (direct observation settles it) ·
**OPEN-HYPOTHESIS** (cause not proven) · **GAP** (evidence absent) ·
**CONFIRMED** (claim verified true).

---

## Git / branch / lock

### D-01 — `main` identity: local vs GitHub — RESOLVED
- **Claim:** local `main` `6a6a336c`; "GitHub main observed by reviewer `93552f7a`".
- **Observation:** local `main` = `6a6a336c`, tracks **`vps/main`** (not github).
  `git ls-remote github refs/heads/main` = `93552f7a`. `6a6a336c` **is an ancestor
  of** `93552f7a`; both objects present locally.
- **Evidence:** `git ls-remote github`, `git merge-base --is-ancestor`.
- **Impact:** "main" is ambiguous across three references (local checkout, `vps/main`,
  `github/main`). None is verified as the deployed identity.
- **Resolution:** github `main` is 5 commits ahead of the local checkout — see D-02.
  Deployed production identity remains unverified in P0 (out of scope; needs the VPS).

### D-02 — GitHub `main` advanced past the handoff record — RESOLVED
- **Claim:** handoff: "`main` gained 2 dispatch-only workflow-file commits
  (`f766c981`, `a0a9f309`)".
- **Observation:** `6a6a336c..93552f7a` = **5** commits, all dispatch-only CI:
  `f766c981`, `a0a9f309`, `d40fdca4`, `0f70b52d`, `93552f7a`
  (`release-candidate-v2.yml` syncs + `artifact-quota-check.yml`). No product code.
  `github/main` reflog: all "update by push", newest `93552f7a` @ 2026-09-09 02:25 +0330.
- **Impact:** low. Confirms the "no product code on main" intent; the doc count is stale.
- **Resolution:** github `main` = `93552f7a` (dispatch-only workflows only). Local
  checkout intentionally not updated. Not reverted.

### D-03 — "R2 adds no deps / lock unchanged since R1" — RESOLVED (claim is false as stated)
- **Claim:** handoff for candidate `7a509e6c`: `pnpm-lock.yaml` sha256
  `36426937…` "(unchanged since R1 — R2 adds no deps)".
- **Observation (binary-safe `git cat-file blob | sha256sum`):**
  - frozen CI `6c21c589`: lock blob `4f272117…`, raw SHA-256 `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3`, 133 032 B.
  - R2 `d01770b1`: lock blob `bcf36b0d…`, raw SHA-256 `c9e147f8f56265b5e53e64800c1f691d67675ac2618434bfc821f666176b88aa`, 133 132 B.
  - `git diff 6c21c589 d01770b1 -- pnpm-lock.yaml`: **+3 lines** — `@joy-media/motion-core: specifier workspace:* / version link:../motion-core` added to the `visual-object-renderer` importer.
  - `git diff … packages/visual-object-renderer/package.json`: `@joy-media/motion-core: "workspace:*"` added to `devDependencies`.
- **Impact:** the R2 candidate's lock **is not** the frozen-CI lock. It is a new
  **workspace-internal link** (no third-party package, no registry fetch), but any
  gate qualified on `36426937…` does not, by identity, cover `c9e147f8…`.
  Matches plan item 10 / §1 "explain the visual-object-renderer motion-core dev dependency".
- **Resolution:** the "no deps" phrasing is true only for external packages. Lock
  identity changed; recorded above. Lock not modified.

### D-17 — frozen CI tag: object vs peeled commit — CONFIRMED (not a mutation)
- **Claim:** `ci-v2-gate-frozen-6c21c589` → `44b2b11f…` vs peeled `6c21c589…`.
- **Observation:** local + `git ls-remote github`: annotated **tag object**
  `44b2b11fac73be6b03058b3dd73d9d26540fd261`; `^{}` peeled **commit**
  `6c21c589e47a8fc0fa1b843487de284e706329a2`. Tagger `Hadi` 2026-09-09 03:18:35 +0330.
  Identical local and remote.
- **Impact:** none. The two hashes are different object types, as designed.
- **Resolution:** tag unchanged, not mutated. Not touched.

---

## Full-workspace check / test-timeout failures

### D-04 — "render timeout" — CONFIRMED
- **Claim:** plan: `full-check-0a829af4.log` = render timeout.
- **Observation:** `full-check-0a829af4.log` (session `6672909d` scratchpad):
  `SHA: 0a829af4…`, `CHECK_EXIT: 1`. Sole failure:
  `packages/visual-object-renderer/src/looks-render-acceptance.test.ts:160 >
  … (GAP 4) > editorial-clean (portrait): identical preview/export at 3 frames…`
  → `Error: Test timed out in 5000ms.` Counts: 4327 pass / 1 fail / 38 skip.
- **Evidence:** `session-6672909d-logs/full-check-0a829af4.log` (84 110 B).
- **Impact:** the GAP 4 acceptance case exceeded Vitest's 5 s default under
  full-suite load (collect ~186 s, transform ~32 s in that run).
- **Resolution:** fixed forward by the next (and only) commit — see D-06.

### D-05 — "font-assets failure at f80e029a" — RESOLVED (it is a timeout, not a licensing violation)
- **Claim:** handoff/plan: "font-assets timeout … cold-start / load sensitivity";
  elsewhere shorthand "font-assets failure".
- **Observation:** `full-check-f80e029a.log`: `SHA: f80e029a…`, `CHECK_EXIT: 1`.
  Sole failure: `tooling/release/src/font-assets.test.ts:104 > editor font
  redistribution gate > is clean through the same scanner used by release:gate`
  → **`Error: Test timed out in 5000ms.`** inside `scanFontAssets(repositoryRoot)`.
  The assertion `expect(result.errors).toEqual([])` was **never reached** — the
  filesystem scan did not return within 5 s. Counts: 4263 pass / 1 fail / 38 skip.
- **Evidence:** `session-6672909d-logs/full-check-f80e029a.log` (81 962 B).
- **Impact:** this is **not** a Fontiran / redistribution-gate breach. It is the
  same failure mode as D-04 (5 s Vitest default exceeded under load), on a
  different test. The "load sensitivity" framing is consistent with the evidence.
- **Resolution / remaining hypothesis:** root cause (why the scan/compile is
  slow enough to blow 5 s intermittently) is **OPEN-HYPOTHESIS** — not measured.
  `font-assets.test.ts:104` was **not** given a timeout bump (D-06); its green
  status on `d01770b1` depends on `scanFontAssets` finishing within 5 s that run.

### D-06 — "green full check on `d01770b1`" — CONFIRMED, with a caveat
- **Claim:** "`pnpm -w run check` green at `d01770b1`; 538 files / 4328 tests pass / 0 fail".
- **Observation:** `full-check-d01770b1.log`: `SHA: d01770b1…`, `CHECK_EXIT: 0`,
  `Test Files 538 passed | 1 skipped (539)`, `Tests 4328 passed | 38 skipped (4366)`.
  `git log 0a829af4..d01770b1` = **exactly one commit**:
  `d01770b1 test(r2): GAP 4 — give render/export acceptance cases a 30s timeout`.
  `git show d01770b1:…looks-render-acceptance.test.ts` → the GAP 4 `it(...)` block
  ends `}, 30_000);` (was 5 000). `font-assets.test.ts` unchanged (still default).
- **Impact:** the green run is genuine. But `d01770b1` differs from the
  timed-out `0a829af4` **only by raising one test's timeout** — the underlying
  slowness that produced D-04 (and, on a sibling commit, D-05) was **not fixed**.
- **Resolution:** green = real; "the timeout is a budget increase, not a fix"
  (handoff item 6) is accurate. The residual flake risk on `font-assets.test.ts`
  (unbumped 5 s) is real; the plan's "stop and explain if it recurs" stands.

---

## Sample inventory & media

### D-07 — "11 MP4s" — RESOLVED
- **Claim:** `r2-technical-acceptance-handoff` TL;DR: "generated 11 MP4s (10 proxy
  + 1 A/V sync fixture + 4 intended-resolution samples)". (10+1+4 = 15.)
- **Observation:** on disk in `jm-r2-check/samples-out/`: **10** proxy
  (`manifest.json`), **4** intended (`intended/manifest.json`), **1**
  `av-sync-fixture.mp4` → **15 MP4 files**. `manifest.json` generatedAt
  16:25:11Z; `intended/manifest.json` 17:35:10Z.
- **Impact:** cosmetic. The "11" pre-dates the intended renders; the parenthetical
  was extended to "+ 4 intended" but the headline number was not corrected.
- **Resolution:** **15** MP4 files (10 + 4 + 1). Reviewer's count (15) is correct.

### D-08 — "all 10 proxy + 4 intended decode = PASS" — GAP
- **Claim:** handoff: "Container-level decode of all 10 proxy MP4s = PASS";
  gap-reconciliation / handoff also assert the 4 intended files decode with
  "correct dims, frame count, duration, sample rate".
- **Observation:** `samples-out/verify/verify-report.json` `sampleCount = 11` and
  its `samples[]` are the **10 proxy + `av-sync-fixture.mp4` only**.
  `verify-look-samples.mjs` enumerates `readdirSync(SAMPLES_DIR)` at the **top
  level** and does **not** recurse into `samples-out/intended/`. There is **no
  verifier JSON for the 4 intended files.** Only **3** of the 4 intended files
  have a `sweep-*.txt` (`editorial-clean-landscape`, `kinetic-type-landscape`,
  `kinetic-type-portrait`); `sweep-editorial-clean-portrait.txt` is **absent**.
- **Evidence:** `verify-report.json`, `verify-look-samples.mjs:809-811`,
  `ls samples-out/intended/`.
- **Impact:** the intended-resolution decode claim is backed only by 3 `frame-sweep`
  text logs and the P0 spot-probes below (D-09) — **not** by the verifier.
- **Resolution:** treat "4 intended decoded and verified" as **partially
  evidenced** (P0 probed all 4; the project's own verifier covered 0 of 4).

### D-09 — "intended renders = 241 frames / 8.021 s (batch-boundary timestamp drift)" — RESOLVED
- **Claim:** handoff item 5 / gallery: intended-resolution renders produce
  **241 frames / 8.021 s** instead of 240 / 8.000 s; P3 lists a "fix the
  241-frame concat sample generator" task; the plan warns against an
  "extra-frame fix on an unproven premise".
- **Observation (P0 `ffprobe`, one decoder at a time, all four intended files):**
  - video stream: `nb_frames = 240`, **`nb_read_frames = 240`** (real decode,
    `-count_frames`), `duration = 8.000000`, `r_frame_rate = 30/1`.
  - video stream `start_time = **0.021029**` (all four, identical).
  - container `format.duration = 8.021029` = video `start_time` + video `duration`.
  - audio: `start_time = 0.000000`, `duration = 8.002667`, 376 AAC frames.
  - proxy files (single `renderRgbaFrames` call, no concat): `start_time = 0`,
    240 decoded frames, 8.000 s, no offset.
  - `frame-sweep.mjs` header prints `totalFrames=241` because it computes
    `Math.round(container_duration * fps)` = `round(8.021029 * 30)` = `round(240.63)`.
- **Evidence:** P0 `ffprobe` transcript (provenance report §Commands);
  `samples-out/intended/sweep-*.txt`; `render-look-samples-intended.mjs:423-469`.
- **Impact:** **there is no 241st video frame and no 8.021 s video.** The video is
  exactly 240 frames / 8.000 s. The container over-runs by **21.029 ms** because
  `render-look-samples-intended.mjs` encodes 8 separate 30-frame H.264+AAC
  segments and joins them with `ffmpeg -f concat -c copy`; the concatenated
  stream carries a ~1-AAC-frame (1024 samples ≈ 21.33 ms) priming/edit-list
  offset on the video start. This is a **muxing artdefact of the RAM-bounded
  concat workaround**, isolated to the 4 intended files.
- **Resolution:** the plan's "concat extra frame fix" would target a
  non-existent defect. The real (cosmetic, tooling-only) artefact is a 21 ms
  A/V start-offset from `-c copy` segment concatenation. The single-call proxy
  path and the real shipping export path are not implicated by this evidence.
  **Do not relax any authored frame count; do not "fix" a 241st frame.**

### D-13 — "midToSettle = 0.00 for 3/10 packs" — CONFIRMED (phrasing note)
- **Claim:** handoff: `midToSettle = 0.00` for editorial-clean / product-precision
  / music-pulse.
- **Observation:** `verify-report.json` `motion.midToSettle`: editorial-clean
  0.00 (both orientations), product-precision 0.00 (both), music-pulse 0.00
  (both), quiet-documentary 0.01, kinetic-type 0.04 → **6 of 10 proxy samples**
  have ~zero mid→settle pixel motion (= the 3 named packs × 2 orientations).
- **Impact:** none new. Same finding, "3 packs" vs "6 samples". The IR-level
  acceptance test passes because it only requires one of
  opacity/translateX/translateY/scaleX to differ across the 3 sample times.
- **Resolution:** distinguish intended hold periods from missing motion per pack
  (plan P3) — deferred to P3, not a P0 defect.

---

## A/V sync fixture

### D-10 — "A/V delta −0.24 ms, sub-frame accurate" — RESOLVED (precision claim overstated)
- **Claim:** handoff: "video first red PTS 1 999 995 µs (offset −0.01 ms), audio
  centroid 1 999 758 µs, A/V delta **−0.24 ms** vs ±33 ms tolerance".
- **Observation (`verify-av-sync.mjs` + `av-sync-report.json`):**
  - `firstFlashPtsUs = 1999995` is set at `verify-av-sync.mjs:1067-1069` to the
    **loop seek variable `us`**, which steps by `frameStepUs = round(1e6/30) =
    33 333` from `sweepStartUs = max(0, 2e6 − 5e5) = 1 500 000`. `1 500 000 +
    15·33 333 = 1 999 995` — **exactly the seek-grid value**, not a decoded video
    PTS. `-ss <t>` is applied **before** `-i` (fast/inaccurate seek).
  - `firstFlashOffsetMsFromExpected = -0.005` is `(1 999 995 − 2 000 000)/1000` —
    pure grid arithmetic.
  - the audio side **is** a real measurement: `centroidPtsUs = 1 999 758` from the
    energy-weighted centroid of the decoded PCM burst.
  - `avDeltaMs.usingCentroid = -0.237` = real audio centroid − grid-quantized
    video seek value.
- **Evidence:** `verify-av-sync.mjs`, `samples-out/verify/av-sync-report.json`,
  the 16 preserved `.av-sweep-frame-*.ppm` (seek grid 1 500 000…1 999 995 µs).
- **Impact:** the A/V delta **is within** the ±33 ms tolerance, but the video axis
  of the measurement carries at minimum ±16.7 ms (half a frame-step) grid
  quantization **plus** fast-seek error. The reported **−0.24 ms** figure and any
  "sub-frame / −0.24 ms precision" phrasing is **not supported by the method** —
  it is a real audio centroid differenced against a quantized seek target.
- **Resolution:** treat as "single-event A/V alignment within one frame,
  video-side precision ≈ ±½ frame". Do not cite −0.24 ms as a measured
  cross-stream precision.

### D-14 — A/V fixture as "Music Pulse audio-bake export proof" — GAP
- **Claim:** implied linkage of the −0.24 ms fixture result to GAP 2
  (Music Pulse decoded-PCM → beat envelope → `bakeLookFromAudio` → `audioBakes`).
- **Observation:** `render-av-sync-fixture.mjs` builds solid-colour P6 PPMs +
  an `ffmpeg aevalsrc` 1 kHz sine and muxes them. It imports **nothing** from
  `motion-core`, `bakeLookFromAudio`, `audioBakes`, the Look compiler, or any
  Joy project. The 10 `music-pulse-*.mp4` proxy samples have **silent** AAC
  (`verify-report.json` `audioPcm.peak = 0`; `controlValues: {}` — no audio
  asset imported).
- **Impact:** GAP 2 end-to-end (import non-silent workspace audio → bake →
  approve/apply → export → independently decode audio-reactive motion +
  synchronized audio) has **no decoded-media evidence in this bundle**. The
  handoff itself concedes this ("Decoded-MP4 A/V-sync verification is owner-gated").
- **Resolution:** the fixture is a valid **encoder/mux timing control only**.
  GAP 2 acceptance remains **GAP** — see proposed P1/P3 scope.
- **Related — D-15:** `av-sync-report.json` `peakValue = 32768` (int16 overflow):
  the `aevalsrc` sine is generated at amplitude 1.0 and clips. Cosmetic; the
  centroid is not materially shifted. Fixture is a clipped tone, not a clean one.

---

## Verifier correctness

### D-11 — `countedFrames = 0` / `firstFramePtsSeconds = null` in verify-report — RESOLVED (structural, not evidence)
- **Claim:** (none explicit) — but these fields sit in `verify-report.json` next
  to real metadata and could be read as decode confirmation.
- **Observation:** `verify-look-samples.mjs:642-654` `probe()` runs `ffprobe`
  with `-count_packets -count_frames` but **without `-show_frames`**, so
  `probeJson.frames` is `undefined`; therefore `countedFrames =
  (probeJson.frames?.filter(...) ?? []).length` is **always 0** and
  `firstFramePtsSeconds` is **always `null`** (`frames[0]?.pkt_pts_time`
  undefined) for **every** sample. Confirmed: all 11 rows show `counted=0`,
  `firstPts=None`.
- **Impact:** these two fields are **not** independent decoded-frame or PTS
  evidence and must not be presented as such (matches the P0 brief).
  The real per-sample frame count in the report is `video.nbFrames`, which is
  **container stream metadata** (`nb_frames`), not a decode.
- **Resolution:** P0 obtained genuine decode counts with `ffprobe -count_frames`
  (`nb_read_frames`): proxy `editorial-clean-portrait` = 240, proxy
  `kinetic-type-portrait` = 240, all 4 intended = 240, `av-sync-fixture` = 180
  video / audio present. Recorded in the provenance report.

### D-12 — "container-level PASS" is asserted by the verifier — RESOLVED (it is not)
- **Claim:** handoff: "Container-level decode … = PASS".
- **Observation:** `verify-look-samples.mjs` has **no pass/fail assertions**. It
  populates `report.failures` **only** when `ffmpeg`/`ffprobe` throws
  (`try/catch`, line 919-922). There is no threshold check on dimensions, frame
  count, duration, fps, motion, or audio. "PASS" is a **human reading the JSON**,
  not a machine verdict. It also does not enumerate `samples-out/intended/`.
- **Impact:** the "PASS" is an informal review conclusion. It is well-supported
  for the 10 proxy files by the recorded metadata (all H.264 480×270 / 270×480,
  240 `nb_frames`, 8 s, AAC 48 kHz stereo) but is not a gated result and does
  not extend to the intended files.
- **Resolution:** report as "10 proxy files: metadata consistent with intent
  (human-reviewed, not asserted); 4 intended: P0-probed only; verifier asserts
  nothing".

---

## Build / renderer provenance

### D-16 — BITMAP glyph limitation (J/O/Y only) — CONFIRMED
- **Claim:** handoff: `packages/renderer-headless/src/index.ts` ships only
  `J`/`O`/`Y`; "JOY LIVE" → "JOY", "the sequel" → nothing; same at 1080p.
- **Observation:** `git show d01770b1:packages/renderer-headless/src/index.ts`:
  `const BITMAP: Readonly<Record<string, readonly string[]>> = { J: [...], O:
  [...], Y: [...] };` (5-row × 3-col bitmaps, ~line 369). The sample producers
  set headline text `"JOY LIVE"` and deck `"the sequel"`
  (`render-look-samples.mjs:103-104`).
- **Impact:** the headless rasteriser is a **diagnostic/geometry path**, not a
  typography-acceptance path. Every proxy and intended MP4 in this bundle shows
  at most the J/O/Y of "JOY"; "LIVE" and "the sequel" are absent. Pixel/text
  fidelity is **unobservable** from these artefacts. (Plan P2.)
- **Resolution:** confirmed baseline limitation, unmodified. Typography
  acceptance must run on the real shipping browser/export renderer (plan P2),
  not this bitmap.

### D-19 — source → build → media linkage has no receipt — GAP (linkage plausible, not proven)
- **Claim:** (none) — manifests record only `frozenSha` (git HEAD `d01770b1`).
- **Observation (all times UTC; local is +0330 — earlier drafts confused the two):**
  the producers `import('../packages/<pkg>/dist/index.js')` directly
  (`render-look-samples.mjs:43-52`); all `packages/*/dist` are **git-ignored**.
  dist newest-file mtimes: `render-ir` / `project-schema` / `export-core` /
  `renderer-headless` **13:09:4x**, `motion-core` **14:36:38**,
  `visual-object-renderer` **14:58:47**; `node_modules/.modules.yaml` **14:52:34**.
  Sample renders: proxy `manifest.json` `generatedAt` **16:25:11**, intended
  **17:35:10**, `verify-report.json` **17:39:22**. The `full-check` `build` step
  for `0a829af4` (~14:53) / `d01770b1` (~14:59) is the most recent thing that
  wrote those dist trees.
- **Evidence:** `find packages/*/dist -printf %T@`, manifest `generatedAt`,
  `full-check-{0a829af4,d01770b1}.log` start times.
- **Assessment:** the dist trees **predate the renders by ~1.5–3 h and nothing
  rebuilt them in between**, so they are *plausibly* the exact bytes used — most
  likely the `pnpm -w run check` build output at `d01770b1`. **But** no receipt
  binds them: `manifest.json` stores only git HEAD; dist/ is unversioned; no
  dist hash, `node_modules` hash, or `pnpm` version was captured at render time.
- **Resolution:** historical source → build → media linkage is **plausible but
  UNPROVEN — mark UNPROVEN where receipts are absent** (plan §P0). Point-in-time
  dist aggregate SHA-256s are recorded in the provenance report for future
  comparison. A receipted re-render under a recorded toolchain is P3.

### D-18 — "SAFE TO FREEZE" reviewer receipt — RESOLVED (documented secondary claim; no independent artefact)
- **Claim:** plan §3.3 / handoff: independent review of `e3c1a049..6c21c589`
  returned **SAFE TO FREEZE**; earlier `0cfb6ef8..e3c1a049` review = review
  agent `ab3412457a7670bc0` (status "pending").
- **Observation:** the verdict lives in
  `joy-media-ci-review-response-2026-09-08.md` "Update 2026-09-09c" (committed
  `3b0446d5` "docs(ci): record fix re-review = SAFE TO FREEZE; frozen candidate
  6c21c589"), authored on `codex/joy-live-director-ci-opt` by the implementer
  session. It records candidate `6c21c589` / tree `bd52e21a` / lock blob
  `4f272117` / lock sha256 `36426937…` / workflow blob `b5a5880d…`. **No
  independent reviewer transcript, session ID, or signed verdict artefact was
  located** on any scoped worktree or in the referenced session
  (`6672909d`) as an inspectable receipt — only the implementer's own
  narration and doc edits. Agent `ab3412457a7670bc0` has **no located output**.
- **Impact:** "SAFE TO FREEZE" is a **documented secondary claim**, not an
  inspectable independent review. Per the plan it is "neither completed CI
  qualification nor deployment approval".
- **Resolution:** classify as secondary/self-reported. If an independent
  receipt exists it is outside the scoped worktrees; otherwise the CI-v2
  independent acceptance (plan P4) is still owed.

---

## Concurrent / freshness

### D-20 — concurrent-work freshness — RESOLVED (noted, not touched)
- **Observation (mtimes, local +0330):**
  - `apps/editor-web/src/looks-encoded-sample-acceptance.test.ts` (untracked on
    `codex/joy-live-director`) — 2026-09-09 **19:18**; SHA-256
    `4454b4afde4ceba4dac6b8307b1fd9c66c942763a299e2a864886f8f1c7aee30`
    (unchanged on P0 re-hash). Imports `bakeLookFromAudio` + does encoded-sample
    acceptance — i.e. it targets the GAP 2 / GAP 4 evidence gap.
  - `jm-r2-check/docs/reviews/joy-live-director-r2-sample-gallery-2026-09-09.md`
    (untracked) — 2026-09-09 **21:11**.
  - Desktop: `joydirectorr2andcicloseplan20260909.md` **21:42**,
    `…before-codex-review.md` **21:35**,
    `joy-director-r2-and-ci-close-plan-2026-09-09.md` **21:34**,
    `joy-media-handoff.md` **21:36**, `r2-technical-acceptance-handoff…` **21:20**.
  - session `6672909d` jsonl last modified **21:35**.
- **Impact:** planning docs and at least one test file were being actively
  edited by another actor within ~1–3 h before this P0 session started
  (2026-09-09T18:49Z ≈ 22:19 local). Nothing indicates edits *during* the P0
  window; all scoped worktree HEADs and the concurrent test hash were rechecked
  at P0 end and were unchanged.
- **Resolution:** snapshotted read-only; not adopted, run, staged, reverted, or
  edited.

### D-21 — plan/backup filename divergence — RESOLVED (not a discrepancy)
- **Claim:** the P0 brief points at `joydirectorr2andcicloseplan20260909.md`;
  session `6672909d` (jsonl L13707) wrote `joy-director-r2-and-ci-close-plan-2026-09-09.md`.
- **Observation:** `joy-director-r2-and-ci-close-plan-2026-09-09.md` and
  `joydirectorr2andcicloseplan20260909.before-codex-review.md` are **byte-identical**
  (both SHA-256 `F378287911723E057792F44F63550948CD515FBF12BBCA7595E3394CAF6718C9`
  — matches the value the active plan cites for its backup). The active
  `joydirectorr2andcicloseplan20260909.md` (27 053 B) is the Codex revision.
- **Resolution:** provenance clean: session wrote the long-name file → Codex
  byte-preserved it as `…before-codex-review.md` → revised into the active plan.

---

## Cross-reference to frozen / historical records (not rewritten)

- `jm-r2-check/docs/reviews/joy-live-director-r2-sample-gallery-2026-09-09.md`
  (untracked) — the technical-acceptance session's own gallery + four-axis status.
- `jm-r2-check/docs/reviews/joy-live-director-r2-gap-reconciliation-2026-09-08.md`
  lines 378–392 — the f80e029a failure narrative (see D-05).
- `.../joy-live-director-r2-{acceptance-bundle,look-scorecard}-2026-09-08.md` —
  describe the historical 4-pack `7a509e6c` candidate; superseded by 5-pack
  `d01770b1` but **not** rewritten here.
- `joy-media-ci-opt` `joy-media-ci-{review-response,open-items}-2026-09-08.md` —
  CI-v2 review response and the 15-namespace inventory (D-18).
