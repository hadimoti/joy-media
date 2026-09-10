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

## Production-build parity — **NOT a parity problem; the ~16 tests are dev-server-only by design**

The real-service harness serves the editor with `pnpm --filter
@joy-media/editor-web dev` (Vite dev). A prod build (`vite build` → `vite
preview` with a mirrored `/api` proxy) was tested end to end:

| Server                             | `tests/e2e --project=desktop-primary --workers=2`           |
| ---------------------------------- | ----------------------------------------------------------- |
| Vite dev (current)                 | **99 passed** / 1 skipped                                   |
| `vite preview` of the prod `dist/` | **83 passed** / 1 flaky / 1 skipped — **~16 tests not run** |

**Root cause (identified, not guessed):** `agent-observation-decode.spec.ts` and
`final-encoded-export-decoder.spec.ts` do a **runtime dynamic import of a raw
TypeScript source path** — `await import('/src/media-observation/observation-worker-client.ts')`
— to white-box-test the internal decode Worker module. Vite dev transpiles and
serves `/src/**/*.ts` on demand; a production build (`dist/`, bundled + hashed,
no `/src/` and no `.ts`) cannot serve that path, so those tests error in setup
and do not run. **This is not COOP/COEP** — the specs use a plain `Worker` +
`VideoDecoder`/`AudioDecoder` and `observation-service.ts` explicitly avoids
`SharedArrayBuffer`; nginx for joyst.ir (`deploy/joy-media.nginx.conf`) sets
only `X-Content-Type-Options`.

**Implications for the owner's questions:**

1. **Why ~16 tests are lost:** they reach into `/src/*.ts` at runtime — a
   Vite-dev-only mechanism. Not a product defect and not a prod-config defect.
2. **Does deployed production have the same problem:** N/A — these tests would
   never run against _any_ built artifact (prod, `vite preview`, or joyst.ir);
   they are internal-module tests bound to the dev server.
3. **Do not count skipped decoder tests as production acceptance:** agreed — and
   they never were. Both the current gate lanes (`acceptance` fixture-only and
   `real-service-acceptance`) run against the Vite dev server, and **v2 keeps the
   dev server for both** (prod-build switch rejected). So all 100 tests,
   including the 16 `/src/` importers, **still run in v2's gate, twice**, exactly
   as before. Nothing is lost by this optimization.

**Tracked follow-up (not this pass):** a white-box test that imports `/src/*.ts`
at runtime cannot be exercised against a shipped artifact. If a prod-representative
render/decode path is ever wanted in the gate, those specs need rewriting to
import the built module (or a dedicated prod-preview harness with a `/src` alias).
Pre-existing test-design choice; out of scope for CI speed.

## Windows `windows-worker-clean` teardown flake — root cause + fix + real-process test

Run `34227092126` failed at the **workflow YAML step** "Verify clean Worker
teardown" (not `worker-acceptance.ps1`, which has a thorough `finally` +
`Stop-ProcessTree`). That step does `Get-Process -Name 'joy-worker'` — a
**name-only match, any source** — with a 15 × 1 s wait, then force-kill + throw.
`worker-acceptance.ps1` ends with `repair` / `update` / `rollback`
`Invoke-WorkerSelfTest` calls; under machine load a SEA `joy-worker.exe` can take

> 15 s to fully release after printing its result.

**v2 fix:** classify `joy-worker.exe` processes by command line:

- **run-owned** — `CommandLine` matches this job's `RUNNER_TEMP` → a leak if it
  survives a **30 s** settle.
- **unreadable** — `CommandLine` is null/unreadable → **also a failure** if it
  survives the window: we cannot prove it is not ours, so it is not silently
  passed.
- **unrelated** — `CommandLine` readable and not matching `RUNNER_TEMP` → ignored.

**Verified with real processes** (2026-09-08): two `timeout.exe` copies renamed
`joy-worker.exe` were launched — one with `RUNNER_TEMP` in its arguments, one
without. The detection matched **only** the run-owned one (correct PID),
**ignored** the unrelated one, and saw **zero** unreadable-cmdline workers.
Verdict: PASS — precise.

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
