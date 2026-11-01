# JOY Media — full test and fixture plan

Written 2026-10-14 on branch `hadimoti/wonderful-ritchie-vfpgv7`. Companion to
[`handoff/HANDOFF.md`](handoff/HANDOFF.md) (the CLI campaign). This plan covers the whole product,
not only the CLI.

## 0. What "ready to use" means, and what this plan can and cannot do

A plan does not make an app ready. Executing it, and fixing what it finds, does. This document
defines "ready" as a checklist that can be proved with evidence (section 9), orders the work so the
riskiest gaps close first (section 8), and lists the decisions only the owner can make (section 10).

"Ready" for JOY Media v1.x is deliberately scoped to the product as it is positioned today
(`STATE.md`): a **100% offline-first Windows desktop editor**, a **CLI built for AI agents first**,
a **local AI worker**, and a **thin control plane** (`joyst.ir`: OTP sign-in, device entitlements,
release downloads, the model gateway). It is not "no bug will ever exist". It is "every shipped
surface has an automated test that fails when it breaks, every claim in the docs is proven by one,
and no known P0/P1 is open".

Two known facts the plan must not paper over:

1. **`joy-media render` does not render.** It writes a plan manifest and now says so
   (`mediaProduced: false`). Real encoding lives elsewhere (editor/desktop export through
   `export-core` and WebCodecs, worker ffmpeg). Whether the CLI should produce real media is an
   owner decision (section 10, Q1). Until then the CLI's agent story ends at "edit the project";
   it cannot deliver a video.
2. **`docs/product/FEATURE-STATUS.md` is stale** (audited 2026-09-05; it still says the native
   Windows app is "not packaged" although v1.0.0 and v1.0.1 installers shipped). Phase 0 refreshes it
   from evidence, because a plan that trusts it will test the wrong things.

## 1. Measured baseline (2026-10-14)

| Layer                      | State                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static gates               | `tsc -b`, eslint, prettier: clean repo-wide.                                                                                                                                                                                                                                                                                      |
| Unit/integration (vitest)  | 617 files, 5,441 tests; 5,417 pass + 1 timeout-under-load (font-assets, passes alone) + 23 skipped. Concentrated in `apps/editor-web` (296 files), `apps/api` (47), `packages/agent-tools` (23), `packages/motion-core` (21), `apps/cli` (18).                                                                                    |
| CLI black-box              | 18 files, 414 pass, 20 POSIX-only skipped. Real binary, both entry points (`bin`, `bundle`), isolated HOME, mock OpenAI server.                                                                                                                                                                                                   |
| Browser e2e (Playwright)   | 29 specs in `tests/e2e` (golden path, export, agent, WP-29/30/32/35 journeys), 7 desktop viewport projects. CI job `browser-e2e` on the self-hosted Linux runner. **Not run in this session; current status unknown.**                                                                                                            |
| Desktop (Electron)         | 13 unit test files in `apps/desktop`; four script checks in `tests/desktop` (installer package, asset library, worker IPC, computer-use debug). No automated clean-install / upgrade / uninstall run.                                                                                                                             |
| Golden render              | `tooling/golden-render`: 4 test files (effects, first-party scenes, RTL caption, index). Pins frame digests and Chromium RGBA for HTML scenes. No audio goldens.                                                                                                                                                                  |
| Fixtures                   | `packages/test-fixtures` (reference project, benchmark, spike, WP-34 animation), `tooling/generate-media-fixtures.mjs` (ffmpeg `lavfi`, deterministic), `tests/desktop/fixtures/demo-project.json`, `tooling/fixtures/joy-director-fixture-manifest.json`, two transcription JSONs, `tests/e2e/fixtures/fake-openai-provider.ts`. |
| Packages with no test file | `ui-kit`, `renderer-pixi-web` (UI/GPU glue, covered only indirectly by e2e). Everything else has at least one.                                                                                                                                                                                                                    |
| Platform coverage          | Dev/CI on Linux; the shipped product is **Windows**. Windows-specific behaviour (DPAPI, installer, PowerShell host, paths, file locks, CRLF) is covered by `worker-package` CI and by hand.                                                                                                                                       |

## 2. Principles

1. **Test what the user observes.** Exit code, stdout/stderr, pixels, audio samples, files on disk,
   state read back by a fresh process. Not internals.
2. **Hermetic by default.** Isolated HOME/USERPROFILE/APPDATA, no real network, fake keys
   (`sk-test-…`), no wall-clock thresholds. Network-touching tests are tagged `@network`, opt-in.
3. **Every bug fix ships a test that fails without it.** Proven by reverting the fix (done for
   every CLI fix so far).
4. **Windows is the primary platform.** A test that only passes on Linux does not count for release.
   POSIX-only assertions are `skipIf(win32)` with a Windows-appropriate twin, never silently absent.
5. **Fixtures are generated, not hand-checked-in binaries.** Small binaries are allowed only with a
   recorded SHA-256, licence, and generator command (section 5).
6. **Determinism is a feature.** Same inputs, same pixels, same samples; tolerances live in one
   place and loosening one needs an ADR (existing golden-render rule).
7. **Agents-first.** The CLI and the agent tool surface are products; their JSON shapes, error codes
   and exit codes are versioned contracts with schema tests, not conventions.

## 3. Surface and risk map

Ranked by (impact if broken) × (how likely it is untested).

| #   | Surface                                                                                        | Impact                        | Current confidence                      | Priority |
| --- | ---------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------- | -------- |
| S1  | Export correctness: a project becomes a playable file that matches the preview (video + audio) | Critical: this is the product | Medium (specs exist, status unverified) | P0       |
| S2  | Desktop install / first run / upgrade / uninstall on a clean Windows profile                   | Critical: first impression    | Low (scripts only)                      | P0       |
| S3  | Project data safety: save, autosave, crash recovery, migration across schema versions          | Critical: user work           | Medium                                  | P0       |
| S4  | Account/entitlement: OTP sign-in, device binding, token ledger, gateway failure modes          | High                          | Medium (API unit-tested)                | P1       |
| S5  | CLI + agent tool surface contract                                                              | High (agents-first)           | High (this campaign)                    | P1       |
| S6  | Local AI worker: GPU/venv/model presence, job protocol, cancellation                           | High                          | Medium-low                              | P1       |
| S7  | Editor UI: timeline editing, a11y, RTL/Persian, responsive viewports                           | High                          | Medium-high (many specs)                | P1       |
| S8  | Providers/BYOK: key storage, redaction, failure handling                                       | High (security)               | High on CLI, Medium on desktop          | P1       |
| S9  | Performance and resource limits: long timelines, 4K, memory soak                               | Medium-high                   | Low (no budgets)                        | P2       |
| S10 | Deploy/ops: control-plane deploy, backup/restore, nginx edge rules                             | High, but separate repo flows | Medium                                  | P2       |
| S11 | Plugins/marketplace                                                                            | Low (parked)                  | n/a                                     | Out      |

## 4. Test layers

Each layer has one command, one owner area, and one failure meaning.

| Layer | Name                     | Command (from repo root)                                                  | Runs where                     | Fails when                                       |
| ----- | ------------------------ | ------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------ |
| L0    | Static                   | `tsc -b`, `eslint .`, `prettier --check .`                                | every PR, Windows + Linux      | type/lint/format break                           |
| L1    | Unit/integration         | `vitest run` (per package)                                                | every PR, Windows + Linux      | logic regression                                 |
| L2    | CLI black-box            | `vitest run apps/cli/src` (real binary, both entries)                     | every PR, **Windows required** | contract break (exit codes, `--json`, stderr)    |
| L3    | Contract/schema          | JSON-schema + snapshot tests for CLI `--json`, agent tools, API responses | every PR                       | an agent-visible shape changed without a version |
| L4    | Golden media             | `golden-render` (frames, audio, A/V sync) on generated fixtures           | every PR touching render/audio | pixels/samples drift beyond tolerance            |
| L5    | Browser e2e              | `playwright test` (7 viewport projects)                                   | PR + nightly                   | user journey or a11y regression                  |
| L6    | Desktop e2e              | Electron via Playwright `_electron` + clean-profile VM                    | nightly + release candidate    | install/launch/IPC/worker break                  |
| L7    | Release acceptance       | `release:gate` + installer matrix + manual checklist                      | release candidate only         | any ready-criterion in section 9 unmet           |
| L8    | Fuzz/chaos/soak (opt-in) | property tests, kill-mid-write, concurrent writers, 30-min memory soak    | nightly                        | corruption, leak, hang                           |

Rules: L0–L3 must run in under ~8 minutes on the Windows runner and gate merges. L4–L5 gate merges
only when their paths are touched. L6–L8 gate releases. Flaky tests are quarantined within 24 hours
into a tracked list with an owner; they are never retried silently.

## 5. Fixture plan

### 5.1 Principles

- One generator, one manifest. `tooling/generate-media-fixtures.mjs` is extended, not duplicated.
  Output goes to `packages/test-fixtures/media/` (git-ignored except the manifest) and is
  regenerated in CI with ffmpeg. `media-manifest.test.ts` already checks hashes; extend it so a
  generator change that alters output fails loudly.
- Every fixture has: `id`, purpose, generator command, byte size, SHA-256, licence (all generated
  fixtures are CC0 by construction), and the tests that use it.
- Hostile inputs are fixtures too. A corrupt file is a first-class, named, versioned asset.
- Per-test sandboxes only (`createSandbox()` for CLI, a temp profile for desktop). No fixture is
  ever mutated in place.

### 5.2 Catalogue

**Media (generated with ffmpeg `lavfi`, deterministic seeds)**

| ID                                            | What                                                                       | Used by                          |
| --------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| `v-bars-1s-30`                                | 1 s, 30 fps, 320×180 colour bars with burned-in frame counter + 1 kHz tone | export, A/V sync, golden         |
| `v-bars-10s-30-1080p`                         | 10 s, 1080×1920 portrait, frame counter                                    | export, long timeline            |
| `v-vfr`                                       | variable-frame-rate clip (timestamps jittered)                             | import, trim accuracy            |
| `v-rotated-90`                                | rotation metadata, 1920×1080 stored as 1080×1920                           | import, preview orientation      |
| `v-odd-dims`                                  | 321×181 (odd) yuv420p edge                                                 | encoder, scaler                  |
| `v-no-audio`                                  | video only                                                                 | audio mixer                      |
| `a-sine-440-2s`                               | stereo 48 kHz sine, known RMS                                              | audio golden, pan, gain          |
| `a-sweep-44k1`                                | 44.1 kHz sweep (resample path)                                             | resample, drift                  |
| `a-silence-5s`                                | digital silence                                                            | silence trim, normalise          |
| `i-png`/`i-jpg`/`i-webp`/`i-gif-anim`/`i-svg` | images incl. animated GIF, alpha PNG                                       | import, overlay                  |
| `bad-truncated-mp4`                           | valid header, tail cut                                                     | import error path                |
| `bad-zero-byte.mp4`                           | empty file                                                                 | import error path                |
| `bad-wrong-ext.mp4`                           | PNG bytes named `.mp4`                                                     | sniffing                         |
| `bad-huge-dim`                                | header claims 65535×65535                                                  | resource limits                  |
| `name-فارسی-😀.mp4`                           | Persian + emoji filename; second copy at a ~240-char path                  | path handling, Windows long path |

**Projects (`packages/test-fixtures/projects/`)**

| ID                                | What                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `p-minimal`                       | one track, no clips (already `demo-project.json`-like)                                     |
| `p-reference`                     | existing `reference-project.ts`, promoted to a JSON file                                   |
| `p-kitchen-sink`                  | every clip kind, effect, transition, keyframe, caption, HTML scene, 3D scene, audio lane   |
| `p-schema-v{N}` for each past `N` | one real project per historical schema version (migration chain input)                     |
| `p-rtl-persian`                   | Persian title, RTL captions, mixed-bidi text                                               |
| `p-scale-10k`                     | 10,000 clips across 40 tracks (generated, not committed)                                   |
| `p-malformed-*`                   | missing field, wrong type, duplicate ids, dangling asset ref, cyclic composition, NaN time |

**Captions/transcripts:** `en-US`, `fa-IR` (existing), mixed-bidi, SRT/VTT with BOM, overlapping
cues, zero-length cue, 10k-cue file.

**Providers and services (local servers started by the test, random port)**

- Mock OpenAI-compatible server (exists in `agent-helpers.ts`; promote to a shared package):
  `/v1/models`, chat non-stream + SSE, scripted tool calls, 401/429/500, malformed JSON, hung stream,
  oversize body.
- Mock control plane: OTP mailer sink, entitlement responses (active/expired/over-quota/revoked),
  release manifest with good and tampered SHA-256.
- Mock ComfyUI/worker endpoints for job-protocol tests (accept, progress, fail, cancel, vanish).

**Desktop profiles (`tests/desktop/profiles/`, built by script, never committed as binaries)**

- clean profile; v1.0.0-upgraded profile (settings + DPAPI-wrapped key + SQLite with old schema);
  corrupt SQLite; read-only app-data; profile on a path with spaces/Persian; low-disk simulation.

**Goldens:** frame digests/PNGs per `v-*` fixture and first-party scene; **audio goldens** (RMS,
peak, spectral centroid, sample-accurate length) for `a-*`; **A/V sync golden** (first frame and
first audible sample within ±1 frame); tolerances in a single `tolerances.ts`.

### 5.3 Generation and storage

- `pnpm test:fixtures:media` generates everything; CI caches by generator hash.
- Binaries stay out of git (size, licence clarity). Manifest (`fixtures.manifest.json`) is committed
  and lists expected hashes per ffmpeg major version; a fixture-hash mismatch on a different ffmpeg
  build downgrades to a warning with a decode-based check (frame count, duration, stream layout)
  so the suite is not tied to one encoder build.
- ffmpeg/ffprobe version is pinned in the runner image and recorded in every test report.

## 6. Per-surface test plans

### S1 — Export correctness (P0)

- **Round-trip suite:** for each of `p-minimal`, `p-reference`, `p-kitchen-sink`: export through the
  real desktop/editor export path, then `ffprobe` the output (duration ±1 frame, fps, resolution,
  codec, audio layout) and decode it (frame count; sampled frames vs headless reference within
  tolerance; audio RMS/peak vs expected). Extends `final-encoded-export-decoder.spec.ts`.
- **Preview/export parity:** pixel diff between preview adapter and headless reference per fixture
  (exists for HTML scenes; extend to effects, transitions, captions, 3D).
- **A/V sync:** `v-bars-1s-30` with tone, assert offset ≤ 1 frame at start, end, and after a trim.
  (The 21 ms start offset noted in earlier R2 evidence becomes an explicit threshold decision.)
- **Failure modes:** export cancelled mid-way (no partial file left, project intact); disk full;
  output path locked by another process (Windows); missing media (clear error, not a black frame);
  GPU unavailable (CPU fallback or clear message).
- **Determinism:** same project exported twice → identical frames, audio within tolerance.
- **Limits:** 4K, 60 fps, 10-minute timeline: completes, memory under budget (section S9).

### S2 — Desktop lifecycle (P0)

Run on a clean Windows 11 VM (Hyper-V snapshot) driven by a PowerShell script plus Playwright
`_electron`; evidence = screenshots + log bundle.

1. Install (per-user, no admin) → first launch → no console errors → account modal opens.
2. Sign-in with the mock control plane; offline sign-in failure message; token persisted via DPAPI
   (verify the file is not plain text).
3. Create project → import fixtures → edit → save → quit → relaunch → project identical.
4. Force-kill during autosave (L8) → relaunch → recovery offered, no corruption.
5. Upgrade v1.0.0 → current with the upgraded profile: settings, keys, projects, asset library kept.
6. Uninstall: app files removed, user data kept by default, "remove data" option removes it; no
   orphan processes (worker, GPU helper).
7. Installer integrity: SHA-256 matches the release manifest; tampered installer rejected by the
   updater; PowerShell 5.1 and 7 hosts both work (fixed once in v1.0.1, now a regression test).
8. Windows specifics: path with spaces/Persian, long path, OneDrive-redirected Documents, non-C
   drive, low-integrity temp, antivirus-style file lock, high-DPI, 3 viewport sizes.

### S3 — Project data safety (P0)

- **Migration chain:** every `p-schema-v{N}` loads, migrates to current, and round-trips; migrating
  twice is a no-op; a newer-than-supported project is refused with an upgrade message and is not
  rewritten.
- **Atomic save:** kill the process at every write boundary (fault-injection hook around
  write/rename/fsync); the project is either the old or the new version, never torn.
- **Concurrency:** two processes on one SQLite (CLI + desktop) — WAL contention yields a clear
  retry/lock message, not corruption. Two CLI writers on one project: revisions monotonic.
- **Backup/restore:** export `.joyproject.json`, import on a clean profile, relink missing media.
- **Property tests (fast-check):** random edit sequences preserve invariants (no overlap on a track
  unless allowed, durations non-negative, undo∘redo = identity, serialise∘parse = identity).

### S4 — Account and entitlement (P1)

API tests exist (47 files). Add: OTP replay/expiry/rate limit, device limit, token-ledger
arithmetic under concurrency, gateway upstream failure (timeout/429/500 → clear client message, no
token charge on failure), edge rules (`/v1/(projects|media|jobs)` stay 404/410), nginx config lint,
deploy-script dry run against a throwaway Postgres, backup→restore drill.

### S5 — CLI and agent contract (P1)

Done this campaign: exit codes, `--json` purity, stderr discipline, atomicity, secrets, signals.
Remaining:

- **Schema tests:** publish JSON Schemas for each `--json` document (`project list/show`, timeline
  edit results, `render` NDJSON events, `benchmark` events, `doctor`, `help`, error documents) and
  assert every command output validates. Version the schemas; a shape change without a version bump
  fails L3.
- **Agent-loop scenarios:** a scripted "AI agent" (mock LLM) creates a project, adds clips from
  fixtures, splits/trims, exports a project file, and (after Q1) renders — asserting the final state
  by reading back, with a retry-after-error variant (wrong flag → error doc → corrected call).
- **Windows twins** for the 20 POSIX-skipped tests (file ACL check for the key file, `taskkill`-style
  termination for signal exit codes).
- **Filesystem hostility** (not yet probed): symlink/junction `--out`, path traversal, reserved names
  (`CON`, `NUL`), trailing dot/space, 260+ char paths, read-only target, network share, Unicode
  normalisation (NFC vs NFD), killed mid-write.
- Both entries (`bin`, `bundle`) and the **packaged standalone CLI exe** from the installer.

### S6 — Local AI worker (P1)

Job-protocol contract tests against the mock endpoints (accept/progress/fail/cancel/vanish);
`worker status|upscale|denoise` with: no GPU, no venv, no models, partial models, wrong CUDA,
low VRAM, cancelled job, worker killed mid-job (project untouched, temp files cleaned), large input.
Real-hardware smoke on the GPU runner (nightly) for one upscale and one denoise with output checks
(dimensions, no NaN, RMS in range).

### S7 — Editor UI (P1)

Keep the Playwright suite as the backbone. Add: timeline operations matrix driven from one table
(add/split/trim/move/ripple/delete × tracks × snapping on/off) with undo/redo after each; keyboard
only run-through; axe a11y on every route in all 7 viewports; Persian/RTL pass (captions, text
editing, mirrored layout); drag-and-drop of fixture files incl. bad ones (error toast, no crash);
long-session soak (200 edits, memory flat). Visual regression on key screens with a strict mask for
dynamic content.

### S8 — Providers and secrets (P1)

Mirror the CLI secret tests on the desktop: key never in logs, crash dumps, URLs, IPC payloads or
renderer devtools; DPAPI file ACL; `redact()` unit-fuzzed with 1,000 synthetic keys; provider
failure UX (401 → "check key", 429 → backoff message, hang → timeout) rendered, not just returned.

### S9 — Performance and resource budgets (P2)

Define budgets once, assert them as ratios against a calibrated baseline on the same machine, not
wall-clock absolutes: open `p-scale-10k` (time-to-interactive, heap), scrub, export 1080p10s
(realtime factor), 30-minute soak (heap growth < X%). Budgets are recorded per machine class in
`tooling/benchmark`; a >20% regression fails nightly.

### S10 — Ops (P2)

`deploy-control-plane.sh` and `apply-nginx-cutover.sh` dry-run in a container in CI; rollback script
exercised; backup restore drill monthly with evidence; edge deny-list checked by a live smoke
(`curl` expectations) after each deploy.

## 7. Cross-cutting infrastructure

- **Windows CI lane for L1–L3.** Today the Linux runner carries the gate and only the worker
  package builds on Windows. Add a Windows job (self-hosted runner exists) running L0–L3 so
  Windows-only breakage fails the PR. Include Node and pnpm provisioning in the runner image; this
  PC currently has neither on `PATH`, which is itself a reproducibility bug to fix.
- **Test runner robustness:** serialize e2e files that spawn the real binary
  (`--no-file-parallelism` or a dedicated project); raise process-heavy timeouts (done), keep the
  harness fail-fast on build errors (done), and make the harness build step not depend on `pnpm`
  being on `PATH`.
- **Evidence bundles:** every L5–L7 run uploads logs, screenshots, ffprobe output, and the fixture
  manifest to `docs/qa/evidence/<date>/` (or the artifact store) with a one-page summary.
- **Flake policy:** one quarantine list, 24 h SLA, no silent retries; a test failing twice in a row
  on `main` blocks merges.
- **Coverage as a map, not a target:** report line/branch coverage per package, but gate only on
  "no uncovered _new_ lines in changed files". Use mutation testing (Stryker) on the five
  highest-risk packages (`project-schema`, `commands`, `timeline-engine`, `export-core`,
  `project-persistence`) to prove the tests would notice a bug.
- **Security checks:** `pnpm audit --prod`, secret scanning in CI, dependency licence check
  (THIRD_PARTY_NOTICES stays truthful), installer code-signing verification when signing exists.

## 8. Execution plan

Effort is rough engineering effort, not calendar time. Agent routing follows the owner's standing
rule: **Codex CLI Luna is the only sub-agent** in this session; implementers can be Luna or (when
the owner allows) Kilo/BytePlus and AGY; every review is a fresh read-only session of a model that
did not write the change; the orchestrator runs all tests and merges.

| Phase | Goal                                  | Work                                                                                                                                                                        | Effort | Exit gate                                                                          |
| ----- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| 0     | Truth                                 | Re-audit `FEATURE-STATUS.md` from source + the last release evidence; run the full Playwright suite and desktop scripts once and record pass/fail; fix Node/pnpm on this PC | S      | Status ledger current; a written list of every currently failing e2e/desktop check |
| 1     | Fixtures                              | Extend generator to the section 5.2 catalogue; shared mock servers package; manifest + hash/decode tests; profile builders                                                  | M      | `pnpm test:fixtures:media` reproducible on Windows and Linux; manifest test green  |
| 2     | Export + A/V truth (S1)               | Round-trip suite, parity, A/V sync, failure modes, determinism; audio goldens                                                                                               | L      | All S1 checks green on Windows; every failure fixed or logged as an owner decision |
| 3     | Data safety (S3)                      | Migration chain, fault-injection saves, concurrency, property tests                                                                                                         | M      | No torn/corrupt project in 1,000 fault-injected runs                               |
| 4     | Desktop lifecycle (S2) + secrets (S8) | VM harness, install/upgrade/uninstall scripts, kill-recovery, DPAPI checks                                                                                                  | L      | Full S2 matrix green on a clean VM with evidence bundle                            |
| 5     | CLI/agent contract completion (S5)    | JSON Schemas + L3, agent-loop scenarios, Windows twins, filesystem hostility                                                                                                | M      | Schema suite green; zero open P0/P1 from the bug bash                              |
| 6     | Worker + account (S6, S4)             | Job-protocol suite, hardware smoke, OTP/ledger/gateway failure tests, deploy dry-runs                                                                                       | M      | Green on the GPU runner nightly; deploy dry-run green                              |
| 7     | UI depth + performance (S7, S9)       | Operations matrix, a11y/RTL/visual, soak, budgets                                                                                                                           | M      | Nightly green 7 days in a row; budgets recorded                                    |
| 8     | Release acceptance (L7)               | Run section 9 end to end on a release candidate; fix; re-run                                                                                                                | M      | Section 9 fully ticked with linked evidence                                        |

Sizing: S ≈ ½–1 day, M ≈ 2–4 days, L ≈ 4–8 days of focused work including review loops. Phases 1
and 5 can run in parallel with 0; 2 and 3 can run in parallel after 1; 4 needs 1 and the VM.

**Per-task loop (every phase):** write the failing test → minimal fix → prove the test fails without
the fix → commit test+fix together → fresh read-only review → orchestrator runs L0–L3 (and the
layer touched) → merge. After three review rounds, remaining theoretical-only findings may be
merged with the judgement written down (owner decision 2026-09-26).

## 9. Release readiness checklist ("ready to use")

Every box needs a linked evidence file; none is ticked on belief.

- [ ] L0–L3 green on Windows and Linux for the exact release commit (two consecutive runs).
- [ ] L4 goldens green; zero tolerance changes since the last release without an ADR.
- [ ] L5 Playwright green on all 7 viewport projects, axe zero serious/critical.
- [ ] L6 desktop matrix (section S2) green on a clean Windows 11 VM; upgrade from the previous
      release verified; uninstall leaves nothing running.
- [ ] Export round-trip green for all three reference projects; A/V offset within the agreed bound.
- [ ] Migration chain green for every historical schema version; fault-injected saves never torn.
- [ ] CLI contract + schema suite green for `bin`, `bundle` and the packaged exe; no open P0/P1.
- [ ] Secrets: no key in any log, dump, URL, IPC payload or world-readable file (Windows ACL checked).
- [ ] Worker smoke on real GPU green; clean failure messages with no GPU/models.
- [ ] Control plane: API tests, deploy dry-run, backup→restore drill, edge deny-list smoke green.
- [ ] Installer: SHA-256 matches manifest, tamper rejected, signing status stated honestly.
- [ ] 30-minute soak: no crash, heap growth within budget; performance budgets within 20% of baseline.
- [ ] `FEATURE-STATUS.md`, `STATE.md`, README and `--help` match shipped behaviour (a docs-vs-reality
      check, partly automated: every `--help` flag and every documented exit code is exercised).
- [ ] No open P0/P1; every P2 either fixed or listed in release notes with a workaround.
- [ ] Two reviewers' sign-off recorded, neither the author of the code under review.

## 10. Decisions only the owner can make

1. **Should the CLI `render` produce real media?** Options: (a) wire it to the same export path as
   the desktop (largest value for agents, largest effort, adds S1 coverage to the CLI); (b) keep it a
   planner and rename it (`render plan`) so the name stops over-promising; (c) delegate to the worker's
   ffmpeg for simple timelines only. Recommendation: (a) after Phase 2, because an agents-first
   editor that cannot output a video is incomplete.
2. Strict flag parsing (unknown flags are errors): confirm it is intended (it makes agent mistakes
   visible instead of silent).
3. `doctor` exit policy and the `JOY_MEDIA_EDGE_URL` override name.
4. Provider-key storage: restricted file now vs OS credential store (DPAPI/Windows Credential
   Manager) as the single policy for CLI and desktop.
5. A/V sync tolerance (frames) and the performance-budget percentage.
6. Whether a Windows VM (Hyper-V) and the GPU runner may be used for nightly L6/S6 runs.
7. Code-signing: until a certificate exists, the readiness checklist records "unsigned" explicitly;
   decide whether unsigned is acceptable for the target audience.
8. Marking PR #7 ready for review once Phase 5 completes.

## 11. Risks and mitigations

| Risk                                                   | Mitigation                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Fixtures differ across ffmpeg builds → flaky hashes    | Decode-based checks as fallback; pin ffmpeg in the runner image; record version in reports |
| Self-hosted runners offline (VPN/MTU incident history) | Runner health check job; documented recovery; Windows lane uses a second runner label      |
| Desktop e2e is slow and brittle                        | Keep it nightly + RC only; page-object helpers; retry-free but with rich evidence on fail  |
| Test count inflation without bug-finding power         | Mutation testing on core packages; every test traces to a risk row in section 3            |
| Agents write tests that pass trivially                 | "Fails without the fix" proof is mandatory; fresh-model review checks for it               |
| Scope creep (marketplace, plugins)                     | S11 is explicitly out of scope until un-parked                                             |
| Claude/Codex quota limits                              | Orchestrator stays thin; cheap models for fixtures; Luna for reviews; batch work per phase |
