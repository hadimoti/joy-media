# JOY Media CI — measured benchmarks (correcting the baseline)

**Written 2026-09-08 (session `joy-media-62`), branch `codex/joy-live-director-ci-opt`.**
All numbers below were measured **inside the real `joy-media-ci-acceptance`
Linux container** against the branch source at `3eaa8cd7` (git archive copied in,
not a network clone — the runner's per-job token is not reusable). They replace
the inferred figures in `joy-media-ci-baseline-2026-09-08.md`.

## Container resources

| Fact         | Value                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CPU limit    | **none** (`HostConfig.NanoCpus=0`, no cpuset) → all 32 host CPUs                                                                                       |
| Memory limit | **none** (`HostConfig.Memory=0`) → host has 32 GB, ~29 GB free during measurement                                                                      |
| `/dev/shm`   | **64 MB** (Docker default) — Chromium still runs at `--workers` 1–3 without crashing, but this is the standard cap that discourages higher parallelism |
| Disk         | 926 GB free on `/`                                                                                                                                     |
| Node / pnpm  | 22.14.0 / 11.15.0                                                                                                                                      |

**Hardware is not the limiter.** The limiters are (a) only one runner carries the
`joy-media-acceptance` label, (b) `PLAYWRIGHT_WORKERS=1` in every job, (c) the
64 MB `/dev/shm`.

## Setup step timings — the baseline over-counted these

The `release-candidate.yml` heavy jobs run on a **persistent runner workspace**;
`git clean -xdf -e node_modules -e '.pnpm-store'` keeps `node_modules` and the
pnpm store, and `~/.cache/ms-playwright` lives in `$HOME` (never cleaned). So the
realistic per-job setup is the _warm_ case:

| Step                                    | Cold (rm node_modules / dist / tsbuildinfo / playwright cache) | Warm (persistent workspace) |
| --------------------------------------- | -------------------------------------------------------------- | --------------------------- |
| `pnpm install --frozen-lockfile`        | ~1.6 s (pnpm store warm)                                       | ~0.3 s                      |
| `pnpm build` (all packages)             | ~19 s                                                          | ~8 s                        |
| `pnpm exec playwright install chromium` | ~96 s (full download)                                          | ~1 s (cache hit)            |

**Corrected:** repeated setup is **~10–20 s per acceptance job (~3 min across the
14-job matrix)**, not the ~25–30 min the baseline inferred. "Build once, share an
immutable artifact" is therefore a **~3 min** saving, not ~30 min — worth doing
for determinism and to guarantee one clean build, but it is not a headline lever.

## The real acceptance-job cost is the browser suite

`playwright test tests/e2e` against one project (fixture stack: `tsx`
`e2e-server.ts` in-memory API + Vite dev server):

| Config                                                              | Wall time           | Result                                                                  |
| ------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------- |
| `--project=desktop-primary --workers=1` (current CI)                | **347 s (5.8 min)** | 99 passed / 1 skipped                                                   |
| `--project=desktop-primary --workers=2`                             | **187 s (3.1 min)** | 99 passed / 1 skipped — **clean**                                       |
| `--project=desktop-primary --workers=3` (config default)            | **145 s (2.4 min)** | 98 passed / **1 flaky** (`stock-video-ui`, passed on retry) / 1 skipped |
| `wp32-responsive-checkpoints.spec.ts` only, one non-primary project | **7 s**             | 1 passed                                                                |

- **`--workers=2` is a clean ~1.85× speed-up** with no observed flakiness.
- `--workers=3` adds flakiness (`stock-video-ui` — a shared-rail / project-scoped
  import test) so it is **not** proposed for the gate without a per-spec
  independence pass first (part 4/5 follow-up).
- 29 spec files, 100 tests. **All 7 "profiles" are the same Chromium engine**
  (`devices['Desktop Chrome']`) differing only in `viewport` — restructuring the
  viewport matrix touches **zero** browser-engine coverage.

## Production-build parity — **NOT achieved; keep the dev server**

The real-service harness serves the editor with `pnpm --filter
@joy-media/editor-web dev` (Vite dev). A prod build (`vite build` → `vite
preview` with a mirrored `/api` proxy) was tested end to end:

| Server                             | `tests/e2e --project=desktop-primary --workers=2`                   |
| ---------------------------------- | ------------------------------------------------------------------- |
| Vite dev (current)                 | **99 passed** / 1 skipped                                           |
| `vite preview` of the prod `dist/` | **83 passed** / 1 flaky / 1 skipped — **~16 tests unaccounted for** |

The unaccounted specs cluster around `agent-observation-decode.spec.ts` and
`final-encoded-export-decoder.spec.ts` (WebCodecs / dedicated browser-worker
decode paths). Those same specs pass in 11.5 s against the dev server, so the
gap is a **preview-server config parity problem** (worker module URLs / response
headers), not a product defect. **Conclusion: do not switch the harness to a
prod build in this pass — it would silently drop ~16 WebCodecs/decoder tests.**
A header-parity preview server is a separate, reviewable follow-up.

## Windows `windows-worker-clean` teardown flake — root cause

Run `34227092126` failed at the **workflow YAML step** "Verify clean Worker
teardown" (not `worker-acceptance.ps1`, which has a thorough `finally` +
`Stop-ProcessTree`). That step does `Get-Process -Name 'joy-worker'` — a
**name-only match, any source** — with a 15 × 1 s wait, then force-kill + throw.
`worker-acceptance.ps1` ends with `repair` / `update` / `rollback`
`Invoke-WorkerSelfTest` calls (`& $Path --joy-worker-self-test`); under machine
load a SEA `joy-worker.exe` can take >15 s to fully release after printing its
result. **Fix (this branch):** match run-owned processes by command-line
(`RUNNER_TEMP` / candidate), like `Get-WorkerRootProcesses` already does, and
widen the settle window to ~30 s. Keeps genuine-leak detection, removes the
load-sensitivity.

## Consolidated before → after (no double-counting)

Savings are stated once each and the combined figure is the actual end-to-end
number, not a sum of overlapping parts.

### Within one workflow

| Lane                                                  | Now                                                              | Proposed                                                                                                                                                             | Basis                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `acceptance` matrix (7 profiles × 2 passes)           | 14 jobs × ~6.5 min ≈ **95 min**                                  | per pass: `desktop-primary` full (`--workers=2`, ~3.1 min) + one job running `wp32-responsive-checkpoints` on the other 6 viewports (~1 min). 2 passes ≈ **8–9 min** | workers=2 measured; responsive spec 7 s × 6; functional behaviour is viewport-independent (one engine) |
| `real-service-acceptance` internal `runDesktopMatrix` | 7 full `tests/e2e` vs real services, sequential, ~30–45 min/pass | `desktop-primary` full vs real services + `wp32-responsive-checkpoints` on the other 6 vs real services, ~8–10 min/pass                                              | preserves _distinct_ real-service viewport coverage; drops 6 redundant full real-service suites        |
| `real-service-acceptance` 30-min effects soak         | 1 per pass (**retained as-is per owner**)                        | 1 per pass (**retained**)                                                                                                                                            | any 2→1 reduction is a separate proposal for independent review                                        |
| `real-service-acceptance` journey + restore + setup   | ~15 min/pass                                                     | ~15 min/pass                                                                                                                                                         | unchanged                                                                                              |
| **`real-service-acceptance` per pass**                | ~80 min                                                          | ~55 min (≈ 10 min matrix + 30 min soak + 15 min journey/restore/setup)                                                                                               |                                                                                                        |
| Build/setup dedup                                     | ~3 min/matrix                                                    | ~1 clean build shared                                                                                                                                                | minor; determinism, not speed                                                                          |
| **One full workflow**                                 | **~4h20–4h32**                                                   | **≈ 2h10–2h20** (validate + parallel light jobs + ~9 min acceptance + 2 × ~55 min real-service)                                                                      |                                                                                                        |

### The gate contract

|                            | Now                                            | Proposed                                                                |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Passes inside the workflow | pass 1 + pass 2 for every heavy lane           | **unchanged** — 2 genuinely isolated passes                             |
| Whole-workflow repeats     | **× 2 green runs** (handoff rule, not in YAML) | **× 1** — the in-workflow pass 1/2 already gives the clean-state repeat |
| **End-to-end gate**        | 2 × ~4.4 h ≈ **~8.5–9 h**                      | 1 × ~2.2 h ≈ **~2.2 h**                                                 |
| **Measured improvement**   |                                                | **≈ 4× faster** (≈ 6.5 h saved)                                         |

The "× 2 green runs → × 1" change is a **release-contract change** and goes to
the independent reviewer with the verifier/runbook/bundle updates — never
self-approved. The soak stays at one-per-pass (two per gate) until separately
reviewed.

## Still to measure

- One instrumented full run of the _new_ orchestration on the _same_ candidate,
  for the true end-to-end wall clock and `docker stats` resource profile.
- Two-executor isolation test (part 4) — only if the instrumented run shows CPU
  headroom during the heavy lanes.
