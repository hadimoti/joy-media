# JOY Media self-hosted CI — baseline timing & bottleneck report

**Written 2026-09-08 (session `joy-media-62`), branch `codex/joy-live-director-ci-opt`.**
Owner authorized a scoped CI optimization pass before the next full
release-candidate run. This is the part-2 baseline. It is source- and
log-anchored; where a number is inferred it says so.

## Safe cancellation (part 1)

- **Active run identified from GitHub:** `release-candidate.yml` run
  **`34229759821`**, candidate_sha input **`7a509e6c5aeca07aa4dc6539b326b283f511078e`**
  (the 4-pack R2 partial), branch tip `1f91fa4a`, workflow revision = the copy on
  `main` at dispatch. Dispatched 2026-09-08T13:04:37Z.
- **State at cancel (~13:46Z):** `validate-candidate` ✅, `linux-real-services`
  ×2 ✅, `windows-worker-clean` ✅, 4 of 14 `acceptance` jobs ✅, 1 in progress,
  ~9 queued; `real-service-acceptance` ×2 not started. No failures. Cancellation
  reason: owner-authorized CI optimization; `7a509e6c` was already superseded
  (R2 is being finished to plan, see the gap-reconciliation doc).
- **Cancelled** with `gh run cancel 34229759821` (that run only). Final state
  `completed / cancelled`.
- **Cleanup verified:** the 4 self-hosted CI containers
  (`joy-media-ci-{linux,acceptance,minio,postgres}`) are up and healthy — they
  are the runners, not run-owned, and were left alone. No leftover `joy-worker`
  processes. The only recent `node.exe` processes belong to an unrelated OpenAI
  Codex runtime (`%LOCALAPPDATA%\OpenAI\Codex\...`) — the parallel `joy-vps`
  agent's toolchain — and were **not** touched. Every heavy job in
  `release-candidate.yml` has an `if: always()` bounded-retry teardown
  (`RUNNER_TEMP`-scoped `rm -rf` ×15, `git clean`, `git status --porcelain`
  assertion), so the interrupted acceptance job self-cleaned. Docker was **not**
  stopped; no shared volumes touched; no other project's workflow affected.

## Runner topology (verified against `gh api .../actions/runners`)

| Runner                    | Labels                                          | Kind                    |
| ------------------------- | ----------------------------------------------- | ----------------------- |
| `joy-media-ci-linux`      | `self-hosted, linux, x64, joy-media-ci`         | Docker container        |
| `joy-media-ci-acceptance` | `self-hosted, linux, x64, joy-media-acceptance` | Docker container        |
| `joy-media-ci-worker`     | `self-hosted, windows, x64, joy-media-worker`   | native Windows          |
| `joy-media-ci-windows`    | `self-hosted, windows, x64, joy-media-ci`       | native Windows (legacy) |

**Only `joy-media-ci-acceptance` carries `joy-media-acceptance`.** Both the
`acceptance` matrix (14 jobs) and `real-service-acceptance` (2 jobs) require that
label, so all 16 serialize on one container. `linux-real-services` and
`validate-candidate` require `joy-media-ci`; `ci.yml` and `windows-worker-clean`
target the Windows runners.

## Measured job timings — run `34229759821`

| Job                                            | Runner                       | Wall time                                                         | Notes                                                                                                                                  |
| ---------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `validate-candidate`                           | linux `joy-media-ci`         | **0m20s**                                                         | SHA reachability check only                                                                                                            |
| `linux-real-services (pass 2)`                 | linux `joy-media-ci`         | **1m27s**                                                         | `verify:ci` + `release-real-services.sh`                                                                                               |
| `windows-worker-clean`                         | windows `joy-media-worker`   | **1m29s**                                                         | 2 internal passes; the only heavy job that runs in parallel                                                                            |
| `linux-real-services (pass 1)`                 | linux `joy-media-ci`         | **1m23s**                                                         | started only after pass 2 freed the runner                                                                                             |
| `acceptance` job (observed ×4)                 | linux `joy-media-acceptance` | **6m35s / 6m36s / 6m44s / 6m54s** → ~**6m45s avg**                | checkout + `pnpm install` + `pnpm build` + `playwright install chromium` + `playwright test tests/e2e --project=<profile> --workers=1` |
| `acceptance` total (14 jobs, serialized)       |                              | **≈ 95 min** (inferred: 14 × 6.8m)                                | matches the historical "~105 min" figure                                                                                               |
| `real-service-acceptance` (2 jobs, serialized) | linux `joy-media-acceptance` | **not reached this run**; historical ≈ **80 min each → ~160 min** | breakdown below                                                                                                                        |
| **One full workflow**                          |                              | **≈ 4h20m–4h32m** (historical, confirmed range)                   | dominated by the single acceptance runner                                                                                              |
| **Gate contract = 2 full green workflows**     |                              | **≈ 8.5–9 h**                                                     | see "Repetition" below                                                                                                                 |

Repeated `pnpm build` is ~20s (build caching is genuinely secondary), but
`pnpm install --frozen-lockfile` + `pnpm exec playwright install chromium` add
**~1.5–2 min of repeated setup per acceptance job → ~25–30 min of pure
per-job overhead** across the 14-job matrix.

## `real-service-acceptance` ~80-min pass — phase breakdown (from `ops/self-hosted/linux-runner/real-service-acceptance.mjs`)

The workflow step runs `$JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND` →
`real-service-acceptance.sh` → `real-service-acceptance.mjs`. The YAML is a thin
wrapper; the harness owns the work:

1. **Setup** — create namespaced Postgres schema `ci_accept_<run>_<attempt>_<pass>`,
   MinIO bucket `joy-media-<run>-<attempt>-<pass>`, in-process disposable render
   Worker, control-plane HTTP server on a free port, and a **Vite dev server**
   (`pnpm --filter @joy-media/editor-web dev`) — not a production build.
   `waitForHttp(webUrl, 120_000)` is a bounded readiness check (good).
2. **`runDesktopMatrix`** (lines 497–586) — runs
   `playwright test tests/e2e --project=<profile> --workers=1` for **all 7 desktop
   profiles sequentially** against the real dev server + Postgres + MinIO.
   **This is a full duplicate of the separate `acceptance` job matrix**, which
   already runs the same 7 profiles (as `fixture-only`). Inferred **~30–45 min**.
3. **`recordJourney`** (lines 611–1325) — one scripted browser journey: new
   project → panels → import video+audio → timeline → apply a Motion preset →
   **real Export MP4 download** (`REAL_SERVICE_EXPORT_DOWNLOAD_TIMEOUT_MS = 35 min`
   — a _timeout_, not a sleep; a 3-second clip exports fast) → register/upload/
   download/ffprobe the export → re-import → re-download → delivery cancel/retry
   recovery (bounded 60 s poll) → page reload + Motion-persistence assertion.
   Inferred **~8–12 min**.
4. **`runObserver`** → `tooling/release/release-performance-observer.mjs` —
   `POLLING_WARMUP_MS = 60_000` + `POLLING_DURATION_MS = 60_000` + a **fixed
   30-minute effects soak** (`EFFECTS_DURATION_MS = 30 * 60_000`). The gate
   _requires_ the full soak ran (`observer` validation line ~212:
   `e.durationMs >= EFFECTS_DURATION_MS`). **This 30 min is the single largest
   fixed cost in the pass, and it runs in every pass of every workflow.**
5. **`verifyRestoreCompatibility`** — N / N-1 Postgres schema restore; fast.
6. **Teardown** — drop schema, remove bucket, kill process tree, `rm -rf`
   tempRoot. One `setTimeout(500)` at line 1690 (in a helper), otherwise no
   arbitrary sleeps in the hot path.

**So each ~80-min real-service pass ≈ 30–45 min duplicate profile matrix +
30 min mandatory soak + 8–12 min journey + setup/teardown.**

## Repetition — where the time multiplies

| Level                                                    | Count                          | Source                                                                                                   |
| -------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `acceptance` matrix                                      | 7 profiles **× 2 passes** = 14 | `release-candidate.yml` `strategy.matrix.pass: [1, 2]`                                                   |
| `real-service-acceptance`                                | **2 passes**                   | same                                                                                                     |
| 7-profile browser matrix _inside_ each real-service pass | 7                              | `real-service-acceptance.mjs` `runDesktopMatrix`                                                         |
| **Whole workflow**                                       | **× 2 green runs**             | the handoff's release gate ("2× green self-hosted `release-candidate.yml`"), **not** encoded in the YAML |

The 30-min effects soak therefore runs **2 passes × 2 workflows = 4 times per
candidate ≈ 2 hours of soak alone**. The 7-profile `tests/e2e` suite runs
**14 (acceptance) + 14 (2 real-service passes × 7) = 28 times per workflow, 56
per candidate**, most of them not viewport-sensitive.

## Resource headroom — TO MEASURE

Not yet captured: CPU / RAM / swap / disk / Docker cgroup limits on the
acceptance container during a heavy job. Part 4 (a 2nd acceptance executor)
is gated on this: _additional containers on the same machine are not additional
hardware._ A fresh instrumented run with `docker stats` sampling + `/proc`
snapshots is the next measurement step before any concurrency change.

## Confirmed vs. corrected owner baseline

| Owner's stated baseline                                               | This report                                                                                                           |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Full workflow ~4h18m–4h32m                                            | ✅ confirmed                                                                                                          |
| One runner has `joy-media-acceptance`                                 | ✅ confirmed                                                                                                          |
| 4 runners, labels block most from browser jobs                        | ✅ confirmed                                                                                                          |
| 7 profiles × 2 passes sequential on acceptance, ~105 min              | ✅ ~95 min measured this run                                                                                          |
| 2 real-service passes sequential, ~80 min each                        | ✅ historical; not reached this run                                                                                   |
| Browser jobs `--workers=1`                                            | ✅ confirmed (YAML + harness)                                                                                         |
| Handoff requires 2 complete green workflows despite 2 internal passes | ✅ confirmed — 4× multiplication                                                                                      |
| Repeated builds ~20 s, caching secondary                              | ✅ — but `pnpm install` + `playwright install` per job is ~25–30 min of matrix overhead                               |
| —                                                                     | **NEW: `real-service-acceptance` re-runs the entire 7-profile matrix internally** (duplicate of the `acceptance` job) |
| —                                                                     | **NEW: 30-min fixed effects soak runs 4× per candidate**                                                              |
| —                                                                     | **NEW: real-service web server is a Vite dev server, not a prod build**                                               |

## Optimization targets, ranked by measured saving

1. **Collapse "2 green workflows" → "1 workflow, 2 genuinely isolated passes."**
   The workflow already has pass 1 + pass 2 for every heavy job. Removes a whole
   ~4.5 h duplicate. **Gate-contract change → independent review required** (part 7).
2. **Drop the redundant 7-profile matrix inside `real-service-acceptance`** —
   run the real-service journey + soak on `desktop-primary` only (the journey
   already fixes 1639×1066). The `acceptance` job matrix already owns
   cross-viewport functional coverage. Saves ~30–45 min × 2 passes.
3. **Restructure the `acceptance` matrix like `ci.yml` already does** — full
   `tests/e2e` on `desktop-primary`; only layout-sensitive specs on the other 6
   viewports. 14 full runs → 2 full + 12 targeted. Needs a before/after coverage
   matrix (part 5). Saves ~60–70 min.
4. **Build once per candidate, share an immutable SHA-bound artifact** across
   acceptance jobs (preserve one independent clean build). Removes ~25–30 min of
   repeated `pnpm install` + `playwright install`.
5. **Run the 30-min effects soak once per candidate**, not once per pass per
   workflow. It is a memory/perf check, not a repeatability check. **Independent
   review required** (part 6).
6. **A 2nd acceptance executor** — only after measuring container headroom; if
   the box is CPU-bound, document the measured limit + an optional separate-CI-VPS
   recommendation (already the standing Opus ruling for R3).

## Next steps (this branch)

- Instrumented baseline run for the resource + intra-phase numbers still marked
  TO MEASURE.
- `ci-dev.yml` (development verification) + a leaner `release-candidate.yml`
  (release verification), clearly labelled.
- Before/after coverage matrix for the browser restructure.
- Revised repetition contract + verifier/runbook/acceptance-bundle updates.
- Isolation audit (ports, schemas, buckets, temp dirs, singleton locks) before
  any concurrency.
- Part-9 verification sequence, then evidence pack for the independent reviewer.
- Never self-approve gate changes.
