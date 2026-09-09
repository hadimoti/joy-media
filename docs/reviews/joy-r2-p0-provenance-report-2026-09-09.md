# JOY Live Director R2 — P0 provenance report (2026-09-09)

Companion to `joy-r2-p0-evidence-index-2026-09-09.md` and
`joy-r2-p0-discrepancy-ledger-2026-09-09.md`. All hashes SHA-256. All times UTC.

---

## 1. Identity anchors (re-verified in P0, read-only)

| Thing | Value |
|---|---|
| R2 impl commit (`codex/joy-live-director`, `jm-r2-check`) | `d01770b1eafeb10f9cc0386ca3122d8314a4ee90` |
| R2 tree | `551ddb516a2a14ea3dc49dba4ae3ac863a88291b` |
| R2 `pnpm-lock.yaml` blob / raw SHA-256 | `bcf36b0d24e24d55305898e783b4813723e22d90` / `c9e147f8f56265b5e53e64800c1f691d67675ac2618434bfc821f666176b88aa` (133 132 B) |
| CI-opt HEAD (`codex/joy-live-director-ci-opt`) | `61ac7e92ff5c4ae458df041f04b2627888930299` (doc-only past `6c21c589`) |
| Frozen CI tag object | `44b2b11fac73be6b03058b3dd73d9d26540fd261` (annotated, tagger Hadi 2026-09-09T03:18:35+0330) |
| Frozen CI peeled commit | `6c21c589e47a8fc0fa1b843487de284e706329a2` |
| Frozen CI tree | `bd52e21aeb9f5021e1be5b045f3b347eae8fab41` |
| Frozen CI `pnpm-lock.yaml` blob / raw SHA-256 | `4f2721172df53e834be167dc8d91d56bbaaacb88` / `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3` (133 032 B) |
| Local `main` checkout | `6a6a336cdd4fb0126c002dda86167f5c92ebfe32` (tracks `vps/main`) |
| `github` `main` (ls-remote) | `93552f7aa7ce21b62eefba9f939d7160fc227a32` (5 dispatch-only CI commits ahead; `6a6a336c` is an ancestor) |
| `github` `codex/joy-live-director` | `d01770b1…` (matches local) |
| `github` `codex/joy-live-director-ci-opt` | `61ac7e92…` (matches local) |

Lock delta `6c21c589 → d01770b1`: **+3 lines**, `@joy-media/motion-core:
workspace:* → link:../motion-core` added to the `visual-object-renderer` importer
(and to that package's `devDependencies`). Workspace-internal link only; no
third-party package. **The R2 lock is not the frozen-CI lock.** (Ledger D-03.)

Recompute method: `git cat-file blob <rev>:pnpm-lock.yaml | sha256sum` (binary-safe
subprocess, no PowerShell text pipeline). Lock **not modified**.

---

## 2. Per-sample matrix (15 MP4 files)

Frame counts: **meta** = container stream `nb_frames`; **decoded** = `ffprobe
-count_frames` `nb_read_frames` (real decode). "P0 decoded" cells are from this
package; "—" = not decoded in P0 (bounded: one decoder at a time).

Durations: **V** = video stream `duration`; **C** = container `format.duration`.
All video `r_frame_rate = 30/1`. Proxy video `time_base` per stream metadata;
intended video `time_base = 1/15360`.

### 2a. Proxy samples — `jm-r2-check/samples-out/` (producer: `render-look-samples.mjs`, sha256 `9dfd3642…`)

| File | sha256 | Dims | meta / decoded frames | V dur | C dur | start | Audio | Check status |
|---|---|---|---|---|---|---|---|---|
| editorial-clean-portrait.mp4 | `7510d1e4…` | 270×480 | 240 / **240** (P0) | 8.000 | 8.000 | 0.000 | AAC 48k/2 silent (peak 0) | metadata consistent; text unobservable (D-16); m→s motion ≈0 (D-13) |
| editorial-clean-landscape.mp4 | `ab9286aa…` | 480×270 | 240 / — | 8.000 | 8.000 | 0.000 | AAC 48k/2 silent | metadata consistent; m→s ≈0 |
| product-precision-portrait.mp4 | `817039c8…` | 270×480 | 240 / — | 8.000 | 8.000 | 0.000 | AAC 48k/2 silent | metadata consistent; m→s ≈0 |
| product-precision-landscape.mp4 | `c006f94a…` | 480×270 | 240 / — | 8.000 | 8.000 | 0.000 | AAC 48k/2 silent | metadata consistent; m→s ≈0 |
| kinetic-type-portrait.mp4 | `9da49f73…` | 270×480 | 240 / **240** (P0) | 8.000 | 8.000 | 0.000 | AAC 48k/2 silent | metadata consistent; m→s 0.04 |
| kinetic-type-landscape.mp4 | `0ebc7bca…` | 480×270 | 240 / — | 8.000 | 8.000 | 0.000 | AAC 48k/2 silent | metadata consistent; m→s 0.04 |
| quiet-documentary-portrait.mp4 | `97579c6c…` | 270×480 | 240 / — | 8.000 | 8.000 | 0.000 | AAC 48k/2 silent | metadata consistent; m→s 0.01 |
| quiet-documentary-landscape.mp4 | `4cb7a818…` | 480×270 | 240 / — | 8.000 | 8.000 | 0.000 | AAC 48k/2 silent | metadata consistent; m→s 0.01 |
| music-pulse-portrait.mp4 | `5eeb1702…` | 270×480 | 240 / — | 8.000 | 8.000 | 0.000 | AAC 48k/2 **silent** (peak 0) | metadata consistent; **no audio-bake exercised** (D-14) |
| music-pulse-landscape.mp4 | `df3980b3…` | 480×270 | 240 / — | 8.000 | 8.000 | 0.000 | AAC 48k/2 **silent** | metadata consistent; no audio-bake exercised |

All 10: H.264, `avg_frame_rate = 30/1`, `nb_frames = 240`, silent AAC stereo
48 kHz. Producer verifier (`verify-look-samples.mjs`) covers these 10 with
**no assertions** — status is human-reviewed metadata consistency, not a gate
(D-11, D-12).

### 2b. Intended-resolution samples — `jm-r2-check/samples-out/intended/` (producer: `render-look-samples-intended.mjs`, sha256 `364ee617…`; only `editorial-clean` + `kinetic-type`)

| File | sha256 | Dims | meta / decoded frames | V dur | C dur | V start | Audio | Check status |
|---|---|---|---|---|---|---|---|---|
| editorial-clean-portrait.mp4 | `9425699f…` | 1080×1920 | 240 / **240** (P0) | 8.000000 | **8.021029** | **0.021029** | AAC 48k, 376 frames, dur 8.002667 | 240 real frames; +21 ms container over-run from `-c copy` concat (D-09) |
| editorial-clean-landscape.mp4 | `9d350cbb…` | 1920×1080 | 240 / **240** (P0) | 8.000000 | 8.021029 | 0.021029 | AAC 48k | same as above |
| kinetic-type-portrait.mp4 | `de83545a…` | 1080×1920 | 240 / **240** (P0) | 8.000000 | 8.021029 | 0.021029 | AAC 48k | same |
| kinetic-type-landscape.mp4 | `b9a43dc8…` | 1920×1080 | 240 / **240** (P0) | 8.000000 | 8.021029 | 0.021029 | AAC 48k | same |

**No producer verifier JSON exists for these 4** (`verify-look-samples.mjs` does
not recurse into `intended/`). `frame-sweep` text logs exist for **3 of 4**
(missing: `sweep-editorial-clean-portrait.txt`). P0 `-count_frames` on all 4 =
240 decoded. **The "241 frames / 8.021 s" claim is a `round(container_dur × fps)`
artefact — there is no 241st frame** (D-09).

### 2c. A/V sync fixture — `jm-r2-check/samples-out/av-sync-fixture.mp4` (producer: `render-av-sync-fixture.mjs`, sha256 `8c8dda9b…`)

| Field | Value |
|---|---|
| sha256 | `7ee395e3611d59450713ac3c002b206e66f372fb2fb83b065b9c78cfc230136a` |
| Video | H.264 480×270, 180 meta / **180 decoded** (P0), 6.000 s, start 0.000, 30/1 |
| Audio | AAC 48 kHz **mono**, 283 frames (P0 probe), 6.000 s, start 0.000; PCM peak `32768` (**clipped**, D-15) |
| Content | solid black + full-frame red flash frames 60–62; 1 kHz sine burst 1.9–2.1 s |
| Provenance | **pure `ffmpeg` mux** — no `motion-core` / `bakeLookFromAudio` / compiler / Joy project. Encoder/timing control only (D-14). |
| Reported result | `av-sync-report.json`: A/V delta (centroid) **−0.237 ms**, within ±33 ms → PASS |
| P0 caveat | video `firstFlashPtsUs = 1999995` is the **seek-grid value** (`1 500 000 + 15·33 333`), not a decoded PTS (`verify-av-sync.mjs:1067-1069`). Audio centroid is a real PCM measurement. Cross-stream precision ≈ ±½ frame on the video axis; the "−0.24 ms" precision is not method-supported (D-10). |

---

## 3. Provenance matrix

| Axis | What is pinned | What is NOT pinned | Verdict |
|---|---|---|---|
| **Source** | `d01770b1` tree `551ddb51…` (git, verified local == `github`) | the untracked concurrent test `looks-encoded-sample-acceptance.test.ts` is **not** part of this tree | **PINNED** for committed source; concurrent file excluded |
| **Scripts** | 7 producer/verifier `.mjs` — sha256 recorded (§4); **untracked** in `jm-r2-check` (git `??`) | not committed anywhere; not covered by any test; assertions absent in the verifiers (D-11, D-12) | **HASH-PINNED, unversioned** |
| **Build** | `packages/*/dist` aggregate SHA-256 recorded now (§below); dist mtimes 13:09–14:59 UTC, before the 16:25/17:35 renders, nothing rebuilt between | dist is git-ignored; no dist/`node_modules`/`pnpm` hash captured **at render time**; `manifest.json` records only git HEAD | **PLAUSIBLE, UNPROVEN** (D-19) |
| **Media** | 15 MP4 sha256 recorded (§2); proxy path = single `renderRgbaFrames`; intended path = 8-segment `-c copy` concat | pixel/typography content unobservable (bitmap J/O/Y only, D-16); intended files carry the concat mux artefact (D-09) | **HASH-PINNED**; content acceptance deferred to P2/P3 |
| **Toolchain** | present PATH: `pnpm 11.15.0`, `node v22.22.3`, `ffmpeg/ffprobe 8.1.1-full_build-www.gyan.dev`; `verify-report.json` recorded ffmpeg/ffprobe 8.1.1; sweeps recorded `Node.js v22.22.3` | `pnpm` version at render time not independently recorded; OS/host not captured in manifests | **PARTIAL** |

`packages/*/dist` aggregate SHA-256 (sorted `sha256sum` of every dist file,
re-hashed) — point-in-time reference for future re-render comparison:

| package | files | dist aggregate SHA-256 | dist newest mtime (UTC) |
|---|---|---|---|
| motion-core | 212 | `13f4886dfcbe1dd54802d406c188a809a3e546c107fd44b6ac1ce43424bb5eff` | 2026-09-09T14:36:38Z |
| render-ir | 24 | `9f65870183b7069587f5cdd6e60ee3be9f6bdf2773030d648f62a25d8f0b8ddd` | 2026-09-09T13:09:42Z |
| project-schema | 160 | `fef14059bd07656847024f0a3c6bfb2f7bac5ae385f48c7c5bb29fe1c6ced37a` | 2026-09-09T13:09:41Z |
| visual-object-renderer | 16 | `c8623027c2de552ef90a49e69ed9bde6ce767c108639ef6198b2ef8b4da0d3f1` | 2026-09-09T14:58:47Z |
| renderer-headless | 12 | `32f22a24afff2ab0c0365b8dc06abe6d689ca5c31443018b96aef9aafafd9819` | 2026-09-09T13:09:54Z |
| export-core | 12 | `3f438658958788d603584b019a7714985f6c2aef1d7000fc45483528a98ea109` | 2026-09-09T13:09:46Z |

(`node_modules/.modules.yaml` mtime 2026-09-09T14:52:34Z; `pnpm-lock.yaml` on
disk in `jm-r2-check` hashes to `c9e147f8…` = the `d01770b1` committed lock.)

---

## 4. Script inventory & hashes (`jm-r2-check/tooling/`, all untracked)

| Script | lines | SHA-256 | Loads / uses | Notable |
|---|---|---|---|---|
| `render-look-samples.mjs` | 249 | `9dfd3642826c7011086d3f3eff2067e233b519e87f2f7b231f7e71be3da2899e` | `packages/{motion-core,render-ir,project-schema,visual-object-renderer,renderer-headless,export-core}/dist/index.js`; `BUILT_IN_LOOK_PACKS`, `compileLook`, `buildRenderFrameIRFromProject`, `renderHeadlessFrame`, `renderRgbaFrames` | 5 packs × P/L, 240 frames @ 30 fps, text `"JOY LIVE"` / `"the sequel"`, preset `social-h264-aac` (silent), 270×480 / 480×270 |
| `render-look-samples-intended.mjs` | 245 | `364ee6175a0f09862ff444c81f41faeb9c25b5a480c0d21ce312548b0267ed68` | same dist modules | only `editorial-clean` + `kinetic-type`; 1080p; 30-frame batches → `ffmpeg -f concat -c copy` (→ D-09) |
| `render-av-sync-fixture.mjs` | 94 | `8c8dda9b7e9234aa9812c0017ae000e68b196a2f64439c91f208f8c08c3fa959` | `ffmpeg` only (`aevalsrc` sine + P6 PPMs) | **no Joy code**; 6 s, flash+burst co-timed @ 2.0 s |
| `verify-look-samples.mjs` | 355 | `1e333de681dadf647abbf6057ac325d7f8d6f0b173d40a69c2bfb6545fe724f0` | `ffprobe`/`ffmpeg` only | enumerates **top-level** `*.mp4` only (not `intended/`); **no pass/fail assertions**; `countedFrames`/`firstFramePtsSeconds` structurally 0/null (D-11, D-12) |
| `verify-av-sync.mjs` | 271 | `885b6523d726bfcfdcc4a0378d0e1e65a358a3783ec7985e74f875bf4b55f88a` | `ffprobe`/`ffmpeg` only | `firstFlashPtsUs` = seek-grid var, not decoded PTS (D-10); audio centroid is real |
| `frame-sweep.mjs` | 100 | `a6cf4404c604f9d413890de7f03de0b2c11c230da9d0b637ac7ac59d0d542954` | `ffprobe`/`ffmpeg` only | `totalFrames = round(container_dur × fps)` → prints 241 for the intended files (D-09) |
| `inspect-ppm.mjs` | 94 | `3333f0d3d86594829f69365fdc208ef2a809e72463a6141ad794b9c6581c7ead` | none (PPM reader) | ad-hoc pixel/ASCII inspector |

Gallery doc `joy-live-director-r2-sample-gallery-2026-09-09.md` (untracked):
sha256 `44c32db762f0713df1f2731445fc68dba34907fe33431d197179d0d8d75a25a6`.
Concurrent test `looks-encoded-sample-acceptance.test.ts` (untracked, **not
adopted**): sha256 `4454b4afde4ceba4dac6b8307b1fd9c66c942763a299e2a864886f8f1c7aee30`.

---

## 5. Raw-log & reviewer-receipt availability

| Item | Status | Where |
|---|---|---|
| `full-check-0a829af4.log` (render timeout) | **LOCATED** (original stdout) | `session-6672909d-logs/` — CHECK_EXIT 1, GAP-4 test `timed out in 5000ms` |
| `full-check-d01770b1.log` (green) | **LOCATED** | `session-6672909d-logs/` — CHECK_EXIT 0, 4328 pass |
| font-assets failure at `f80e029a` | **LOCATED** (`full-check-f80e029a.log`) | `session-6672909d-logs/` — CHECK_EXIT 1, `font-assets.test.ts:104` `timed out in 5000ms` (a timeout, not a licence breach — D-05) |
| other GAP checkpoint checks (`e65c132a`, `9f97ff0b`, `04edd236`, `4d3c8ce1`, `1bf0e656`, `c0de248c`) | **LOCATED**, not individually audited in P0 | `session-6672909d-logs/` |
| CI `check-52b11d51*.log` (×3) | **LOCATED**, not audited in P0 | `session-6672909d-logs/` |
| CI "SAFE TO FREEZE" (`e3c1a049..6c21c589`) | **DOCUMENTED SECONDARY CLAIM** — no independent reviewer artefact | `ci-opt-docs/joy-media-ci-review-response-2026-09-08.md` "Update 2026-09-09c" (commit `3b0446d5`) |
| CI review agent `ab3412457a7670bc0` output (`0cfb6ef8..e3c1a049`) | **NOT LOCATED** (handoff lists it "pending") | — |
| GitHub artifact-quota / billing raw evidence | preserved dated (run `34165045011`, 2026-09-08) per handoff; not re-fetched in P0 | `ci-opt-docs/github-support-artifact-quota-2026-09-09.md`, `session-6672909d-logs/quota-probe-results.log` |
| Production / deployed identity | **NOT VERIFIED** (needs VPS — out of P0 scope) | — |

Nothing was reconstructed from transcript. Transcript summaries are not raw logs.

---

## 6. Four-axis status (dated, attributed — P0 does not advance any axis)

### 6.1 Implementation
- **Reported COMPLETE at `d01770b1`** (2026-09-09, Claude session `6672909d`):
  GAP 5 (agent Look tools), GAP 1a (additive server-sync extension, migration
  006), GAP 2 (audio bake), GAP 4 (render/export acceptance), GAP 3 (music-pulse).
- **P0 direct check:** `full-check-d01770b1.log` = CHECK_EXIT 0 (538 files /
  4328 pass / 38 skip), genuine. Caveat: `d01770b1` = `0a829af4` + one
  test-timeout bump; the slowness behind D-04/D-05 is unfixed (D-06).
- Source audit of GAP-1a migration ledger, GAP-2 render path, GAP-5 approval
  reuse **not performed in P0** (out of scope).

### 6.2 Technical acceptance — **PARTIAL / PENDING**
- **Green (evidence in bundle):** 10 proxy MP4 container metadata consistent
  with intent (human-reviewed, not asserted); 15/15 MP4 well-formed; single-event
  A/V alignment within one frame on the fixture.
- **Not closed:** typography/pixel fidelity **unobservable** (bitmap J/O/Y,
  D-16); intended-resolution files unverified by the project's own verifier and
  carrying a concat mux artefact (D-08, D-09); GAP-2 baked-audio export has **no
  decoded-media evidence** (D-14); A/V coverage = one event pattern, video-axis
  precision ≈ ±½ frame (D-10); `font-assets` 5 s flake root cause unmeasured (D-05).
- Attribution: technical-acceptance continuation, Claude session `6672909d`,
  2026-09-09; gallery doc `joy-live-director-r2-sample-gallery-2026-09-09.md`.

### 6.3 Subjective review — **PENDING (owner-only)**
- Historical Opus taste pass (plan Step 3): product-precision / quiet-documentary
  APPROVED as-is; editorial-clean / kinetic-type CHANGES → fixed → APPROVED;
  music-pulse HELD → GAP 3 fix (`3eaa8cd7`) → APPROVED; persian-editorial RETIRED
  (handoff, 2026-09-08/09). **Final readable-output review not done** — depends on
  6.2 (text is currently unobservable in all preserved media).

### 6.4 Release infrastructure — **BLOCKED**
- Artifact uploads blocked; cause unresolved; billing is a **hypothesis** (handoff
  2026-09-09). No purchase, no scope change in P0.
- Frozen CI tag `ci-v2-gate-frozen-6c21c589` → `44b2b11f…` → `6c21c589` —
  **unchanged**, local == `github` (P0 verified).
- "SAFE TO FREEZE" = documented secondary claim, no independent receipt (D-18).
  SAFE TO FREEZE ≠ CI-v2 qualification ≠ deployment approval.
- `codex/joy-live-director-ci-opt` **not folded** into `codex/joy-live-director`.
- R2 lock (`c9e147f8…`) ≠ frozen-CI lock (`36426937…`) — any gate qualified on
  the frozen lock does not cover the R2 candidate by identity (D-03).
- `github` `main` carries 5 dispatch-only CI commits past the local checkout (D-02).

---

## 7. P0 command register (representative; all read-only except the worktree add)

| # | cwd | command (abbrev) | exit |
|---|---|---|---|
| 1 | joy-media | `git --no-optional-locks worktree list` / `remote -v` | 0 |
| 2 | (each wt) | `git --no-optional-locks rev-parse HEAD / HEAD^{tree}` ; `status --porcelain` | 0 |
| 3 | joy-media | `git ls-remote github refs/heads/{main,codex/joy-live-director,codex/joy-live-director-ci-opt} refs/tags/ci-v2-gate-frozen-6c21c589*` | 0 |
| 4 | joy-media | `git merge-base --is-ancestor 6a6a336c 93552f7a` | 0 (ancestor) |
| 5 | joy-live-director | `git cat-file blob <rev>:pnpm-lock.yaml \| sha256sum` (×2) ; `git diff 6c21c589 d01770b1 -- pnpm-lock.yaml packages/visual-object-renderer/package.json` | 0 |
| 6 | — | `grep`/`python` over `6672909d.jsonl` for `full-check-*` markers (bounded) | 0 |
| 7 | 6672909d scratchpad | `head`/`sed`/`grep` on `full-check-{0a829af4,d01770b1,f80e029a}.log` | 0 |
| 8 | joy-live-director | `git log 0a829af4..d01770b1` ; `git show d01770b1:<test files>` | 0 |
| 9 | jm-r2-check | `cat` manifests + `verify/*.json` ; `python` summariser | 0 |
| 10 | jm-r2-check/samples-out/intended | `ffprobe -v error -show_entries …` (×4 files) | 0 |
| 11 | jm-r2-check/samples-out/intended | `ffprobe -count_frames` on `editorial-clean-portrait.mp4`, `kinetic-type-portrait.mp4` | 0 |
| 12 | jm-r2-check/samples-out | `ffprobe -count_frames` on 2 proxy + `av-sync-fixture.mp4` | 0 |
| 13 | jm-r2-check | `find packages/*/dist -exec sha256sum` (hash-of-hashes) ; `find -printf %T@` | 0 |
| 14 | Desktop | `python preserve.py` — hash→copy→hash→re-hash, 78 items, MANIFEST.csv/.md | 0 |
| 15 | Desktop | `sha256sum` plan backups (== plan's stated `F3782879…`) | 0 |
| 16 | joy-media | `git worktree add -b codex/joy-r2-p0-provenance-20260909T185139Z C:\Users\HadiMoti\joy-r2-p0-20260909T185139Z d01770b1` | 0 |

- **At most one `ffprobe` decoder ran at a time**; every decode call wrapped in
  `timeout` (≤120 s). No render, build, install, benchmark, or full test suite.
- No child process was force-killed. No residue left outside the evidence root
  and this worktree. Scratchpad helper: `…/7c5ec584-…/scratchpad/preserve.py`.

## 8. Tests / checks NOT run in P0 (explicit)

`pnpm -w run check` · any Vitest suite · `render-look-samples*.mjs` ·
`verify-look-samples.mjs` · `verify-av-sync.mjs` · `frame-sweep.mjs` ·
`scanFontAssets` / `font-assets.test.ts` · any CI workflow / `gh workflow run` ·
migration 006 apply · browser / headless export · production smoke ·
GitHub billing or artifact-quota probe · `git fetch/pull/merge`.

The old producers/verifiers were **not executed** — they create, overwrite, and
delete outputs in `samples-out/` and would mutate the very evidence being preserved.

---

## 9. Proposed P1 scope (inspection/patch — DO NOT EXECUTE; for Codex/Astra review)

P1 as the plan frames it = "close the real cold-session agent discoverability gap,
if confirmed." P0 did not touch agent code; that scope stands. In priority order,
the **smallest** next inspection package:

1. **GAP-2 decoded-media evidence (highest — it is a true GAP, D-14).**
   Inspect `apps/editor-web/src/living-look-audio.ts` (`bakeLookFromAudio`,
   `DecodedCompositionAudio`) and the concurrent untracked
   `apps/editor-web/src/looks-encoded-sample-acceptance.test.ts` — **determine
   ownership first** (it is unknown-owner concurrent work). If it already drives
   import → bake → apply → export → independent decode of audio-reactive motion
   **and** non-silent synchronized audio, adopt it under review rather than
   writing a parallel one. Do not present a deterministic fixture as a live path.

2. **Cold-session agent discoverability (plan P1 proper).**
   Trace `read_project_context` / host-tool results after reopening a saved
   project: can the agent discover instance IDs, pack IDs/version, bindings,
   orphan state, overrides, revision — without the owner typing IDs and without
   chat memory? Source paths to inspect: the JOY agent host-tool registry
   (`JOY_AGENT_HOST_TOOL_NAMES`), `resolveLivingLookRun`, the project-context
   domain builders. If a gap is real, the smallest bounded project-scoped
   `looks` context domain using existing context/schema/pagination/redaction.

3. **`font-assets.test.ts` 5 s flake (D-05) — measurement, not a fix.**
   Instrument `scanFontAssets(repositoryRoot)` wall-time under full-suite load;
   decide (with evidence) between a scoped timeout, a scan-scope reduction, or a
   caching fix. Do **not** relabel it benign.

4. **Intended-resolution verifier coverage (D-08) + concat artefact note (D-09).**
   Extend `verify-look-samples.mjs` to enumerate `samples-out/intended/` (or run
   the real bounded export path), and add real pass/fail assertions
   (dims / decoded frame count / durations / audio) so "PASS" is machine-checked.
   Reframe the plan's P3 "fix the 241-frame concat generator" as "the 21 ms
   container over-run is an AAC-priming `-c copy` concat artefact; the video is
   240/8.000 s" — no frame-count change.

5. **A/V verifier precision (D-10).**
   In `verify-av-sync.mjs`, record the **decoded** first-red-frame PTS
   (`ffprobe -show_frames` / `-count_frames` on the event window) instead of the
   seek-loop variable, so the video axis is a measurement, not a grid target.

Typography (plan P2), full encoded-media acceptance and gallery (P3), CI
reconciliation (P4+) remain as the plan describes — **not** part of this P1.

---

*P0 preserves and reconciles. It does not accept. External GPT-6 Astra's
candidate-specific `APPROVE_FOR_DEPLOY <sha> <tree> <lock-sha256>` and the
owner's separate deployment go-ahead remain mandatory and unmet.*
