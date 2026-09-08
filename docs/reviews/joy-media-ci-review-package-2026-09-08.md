# JOY Media CI v2 — independent review package

**Branch `codex/joy-live-director-ci-opt`.** Assembled 2026-09-08 for the
independent reviewer of the release-contract change. **A green benchmark approves
nothing and authorizes no deployment** — this package is the evidence; the
decision is the reviewer's, then the owner's.

## Revisions under review

| Artifact                                          | Revision              | Note                                                                                                                                                                  |
| ------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application candidate                             | `3eaa8cd7` (R2 GAP 3) | the app code the gate was benchmarked against                                                                                                                         |
| CI-opt branch HEAD (workflow + harness + tooling) | `185f18c6`            | janitor `pg` fix + structured gate-summary on top of the hardened `8c5a4445`                                                                                          |
| Benchmark 1 (speed)                               | ran on `cdbb771f`     | pre-hardening teardown → performance evidence only                                                                                                                    |
| Benchmark 2 (failed)                              | ran on `498c45fe`     | caught the janitor `pg`-resolution bug                                                                                                                                |
| Benchmark 3 (hardened evidence)                   | ran on `8c5a4445`     | teardown enforcement + janitor + prod-build-smoke; gate-summary was still the grep form here — the `185f18c6` swap to the structured evaluator is unit-proven, see §4 |

`main` carries only the **dispatch-only** `release-candidate-v2.yml` (2 commits,
workflow file only; `release-candidate.yml` and all product code untouched;
`workflow_dispatch`-only, runs nothing on push).

## 1. Complete results, including all skipped tests, and the 4190 vs 4171 explanation

`verify:ci` → `check` → `test` → `vitest run` — the **same** command as a local
`pnpm test`. The vitest **total is identical** at every revision: **4244**
(`4206 passed / 38 skipped` locally on a Windows dev machine; `4171 passed /
73 skipped` on the headless CI Linux `joy-media-ci` runner).

**The 35-test delta is environment-gated tests that skip on the headless CI
runner** — not lost, not a v2 regression:

| Test file                                                 | CI-skipped | Gate                                                     | Why it skips in CI                                                                                              |
| --------------------------------------------------------- | ---------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tooling/golden-render/src/first-party-scenes.test.ts`    | 31 (file)  | `describe.runIf(findChromiumExecutable() !== undefined)` | `linux-real-services` runs `verify:ci` **before** `playwright install chromium`, so no Chromium binary is found |
| `packages/html-scene-runtime/src/chromium-driver.test.ts` | 2 (file)   | `describe.runIf(chromiumAvailable)`                      | same                                                                                                            |
| `apps/api/src/whisper-transcribe.test.ts`                 | 1 (file)   | `describe.skipIf(!whisperAvailable)`                     | no Whisper model on the runner                                                                                  |

Those 3 fully-skipped files account for **34** of the 35-test delta (verified
from the CI log). The remaining **1** is a partial env `runIf`/`skipIf` inside a
file that still reports other passing tests; the CI log does not name it and it
was not chased further — the vitest **total is provably unchanged (4244)**, and
this same behaviour holds on the current gate. The **current**
`release-candidate.yml` runs the identical
`pnpm run verify:ci` on the identical `[self-hosted, linux, x64, joy-media-ci]`
runner (v1 lines 42, 77) → v1's gate **also** reports 4171/73 on Linux. The
golden pixel + Chromium-scene coverage is exercised separately by the Playwright
`acceptance-primary` / `prod-build-smoke` / `real-service-acceptance` lanes.

### Benchmark 1 lane results (measured, `cdbb771f`)

| Lane                                                                                                                                        | Result                                                                             | Time                     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------ |
| validate-candidate                                                                                                                          | ✅                                                                                 | 43s                      |
| linux-real-services ×2 (`verify:ci`: **4171 passed / 73 skipped / 0 failed**)                                                               | ✅                                                                                 | 2m01s + 1m56s (serial)   |
| windows-worker-clean (2 internal passes)                                                                                                    | ✅ no flake                                                                        | 2m06s (parallel)         |
| acceptance-responsive ×2 (`wp32-responsive-checkpoints` × 6 viewports)                                                                      | ✅ 6/6 each, ~6.5s/viewport                                                        | 1m43s + 1m52s            |
| acceptance-primary ×2 (`tests/e2e` × desktop-primary `--workers=2`)                                                                         | ✅ **99 passed / 1 skipped / 0 flaky** each                                        | 3m06s + 3m14s            |
| real-service-acceptance ×2 (primary-full + 6-responsive vs real services + 30-min soak + delivery journey + N/N-1 restore + `release:gate`) | ✅ `release:gate` passed each                                                      | 39m23s + 39m17s (serial) |
| gate-summary                                                                                                                                | ❌ grep-parse bug on all-`success` input (**not a lane failure**) — replaced by §4 | 12s                      |

**End-to-end: 1h37m11s.** `acceptance-primary` reports the same `1 skipped` as a
local `playwright test tests/e2e --project=desktop-primary` (a pre-existing
`test.skip`, unchanged by this work — the CI log reports the count, not the
name).

## 2. Separate isolation evidence, per resource

Each pass derives every mutable name from `runId`, `runAttempt`, `pass`. Verified
live during benchmark 3 pass 1 (`ci_accept_34252332556_1_1`):

### Database

- `schema = ci_accept_<run>_<attempt>_<pass>`; `pool` opened with
  `options: -c search_path=${schema},public` — **every** query is schema-scoped.
- `CREATE SCHEMA` on start; `DROP SCHEMA … CASCADE` on teardown, then re-inspected.
- **Live (bench 3 pass 1):** the pass schema had **18 tables / 116 project rows**;
  `public` had **0** app tables (`projects/workers/jobs/media_assets`); **0**
  other `ci_accept%` schemas existed. A query without the search_path prefix
  finds nothing.
- The N/N-1 restore test uses a **separate** `ci_legacy_accept_<ns>` schema with
  its own create/drop/verify.

### Object storage

- `bucket = joy-media-<run>-<attempt>-<pass>`; `MinioObjectStore` built with
  `{ bucket }`; **every** `put`/`get`/`remove`/`probeReadiness` path is
  `joy-ci/${this.options.bucket}/…`.
- `mc mb` on start; `mc rm --recursive` + `mc rb` on teardown, then `mc ls`
  re-inspected.
- **Live (bench 3 pass 1):** exactly **one** bucket existed
  (`joy-media-34252332556-1-1`), holding this pass's export derivative +
  original chunks. No path can address another bucket.

### Browser profile / storage

- `chromium.launch({ headless: true })` fresh per pass; `browser.newContext({ viewport })`
  is an **ephemeral incognito context** — no `userDataDir`, no persistent profile.
- `playwright.config.ts` sets **no `storageState`, no `userDataDir`, no
  `launchPersistentContext`** (verified — none present).
- The session token is injected per-context via
  `context.addInitScript(() => localStorage.setItem(…))` — in-memory, gone on
  `context.close()` / `browser.close()`.
- `runDesktopMatrix` spawns **separate `playwright test` processes** (each its
  own browser) against a per-pass dev server on a `freePort()`-allocated
  `webPort`.
- Teardown: `browser.close()`, then the residue check confirms `webProcess.pid`
  is dead via `process.kill(pid, 0)`.

### Worker state

- `realWorkerId = real-service-render-worker-<run>-<pass>` — unique per (run, pass).
- Registered via `pairWorker` + `helloWorker` **into the pass's schema** — it can
  only lease jobs from that schema.
- The worker is an **in-process async loop**, not a subprocess;
  `realWorkerLifecycle.stopped = true` + `await realWorkerPromise` on teardown.
- Its scratch dir is `${tempRoot}/worker`, `tempRoot = mkdtemp('/tmp/joy-media-real-acceptance-')`
  (unique), removed + `stat`-verified on teardown.

### Non-coexistence (benchmark 1, sampled every 90s)

GitHub ran pass 2 then pass 1 (matrix order not guaranteed), serially on the one
`joy-media-acceptance` runner:
`_2` schema+bucket present → **`_2` dropped 15:31:53Z** → **`_1` created fresh
15:33:26Z** → `_1` dropped 16:10:52Z → post-run **0** `%<run>%` schemas/buckets.
**The two passes' resources never coexisted.**

## 3. Interruption recovery + authenticated janitor classification (measured)

`ci-namespace-janitor.mjs` classifies each CI namespace by the **owning workflow
run's status** (GitHub Actions API, `GITHUB_TOKEN` + `actions: read`):
`current` (= `GITHUB_RUN_ID`) / `active` (`in_progress`/`queued`/`waiting`) /
`orphan` (`completed` any conclusion, or `not-found`) / `unknown` (API error).
Default **inventory** mode writes `test-output/ci-janitor/inventory.json` and
deletes nothing (v2 requires this evidence file). `--sweep` (double-gated by
`JOY_MEDIA_CI_JANITOR_SWEEP=1`) deletes **only** `orphan`.

**Recovery test (2026-09-08, real CI Postgres + MinIO), 3 disposable schemas —
owning runs: `34239133175` completed, `34252332556` the then-active benchmark 3,
`99999999991` bogus/404:**

| Phase | Token                                  | `34239133175_9_1` (completed) | `34252332556_9_1` (active/current) | `99999999991_9_1` (404) | swept                                |
| ----- | -------------------------------------- | ----------------------------- | ---------------------------------- | ----------------------- | ------------------------------------ |
| 1     | **invalid**                            | `unknown`                     | `current`                          | `unknown`               | **[] — nothing deleted**             |
| 2     | **valid**, `GITHUB_RUN_ID=34252332556` | `orphan` → **swept**          | `current` → **kept**               | `not-found` → **swept** | `[34239133175_9_1, 99999999991_9_1]` |

`sweepErrors: []`. After phase 2 the only survivor was the active-run schema.
**When status is unknowable, nothing is touched; an active run's namespace is
never touched; a proven-terminal namespace is cleaned.** The v2 workflow runs
inventory-only; `--sweep` is enabled after this review.

**Note:** phase 2 (`--sweep`) also cleared the 15 historical leaked namespaces
(all `completed`-run, empty schemas / 0-byte buckets — enumerated in
`joy-media-ci-open-items-2026-09-08.md` §6). This was a side effect of exercising
`--sweep` against the shared store; those namespaces are gone. Their identities
are preserved in that doc.

## 4. Gate-summary — structured JSON parsing + regression cases

`tooling/release/src/ci-gate-summary.ts` (`evaluateGateSummary`) —
`JSON.parse(needs.*.result)`, require a non-empty array whose length equals the
expected lane count, and every entry `=== "success"`.
`ci-gate-summary.test.ts` — **10 tests, all green in `verify:ci`:**

| Case                                           | Expectation                                |
| ---------------------------------------------- | ------------------------------------------ |
| all `success` (6 lanes)                        | pass                                       |
| one `failure`                                  | fail, names `#i="failure"`                 |
| one `cancelled`                                | fail, names `#i="cancelled"`               |
| one `skipped` (required lane did not run)      | fail, names `#i="skipped"`                 |
| **missing required job** (short array, 5 of 6) | fail, "expected 6 … got 5"                 |
| empty array                                    | fail, "no lane results"                    |
| malformed JSON                                 | fail, "not valid JSON" (not a silent pass) |
| non-array JSON                                 | fail, "not a JSON array"                   |
| multiple problems                              | reports ≥ 2 reasons                        |
| non-integer expected count                     | fail                                       |

Both `release-candidate-v2` (6 lanes) and `ci-dev` (3 lanes) call it; both
summary jobs `checkout` first. This is a self-contained logic change with no
runtime/infra dependency, so it does not require its own full benchmark — the
grep form it replaces already completed the workflow end-to-end in benchmark 1's
happy path, and this form is strictly more correct.

## 5. Final measured runtime + the contract / coverage changes

_Benchmark 3 numbers appended on completion._

Benchmark 1 (speed) established: **one workflow ≈ 1h37m** vs the current
~4h20–4h32; contract `2 workflow runs → 1 run, 2 isolated passes` →
**end-to-end gate ≈ 1h37m vs ≈ 8.7–9h ≈ 5.4× faster.** The 30-min effects soak
is retained one-per-pass (2 per gate, was 4); any 2→1 change is a **separate**
proposal, not made here.

### Coverage / repetition changes for the reviewer

- **Browser viewport matrix** — full `tests/e2e` on `desktop-primary` (×2
  passes, `--workers=2`); `wp32-responsive-checkpoints` on the other 6 viewports.
  One Chromium engine → zero engine-coverage change. Every removed execution
  mapped in `joy-media-ci-coverage-matrix-2026-09-08.md`.
- **Real-service `runDesktopMatrix`** — 7 full suites → primary-full + 6
  responsive, still vs real services. Distinct real-service coverage kept.
- **`prod-build-smoke`** — NEW additive lane: the shipped `dist/` bundle through
  the public UI (import / decode-seek / export / Worker). Validated 5/5.
- **Contract** — `2 green workflow runs` → `1 run, 2 genuinely isolated passes`.
  Rationale + the "what a second whole run added" analysis + the minimal fallback
  (one auto re-dispatch on infra-only failure) are in
  `joy-media-ci-repetition-contract-2026-09-08.md`.
- **Teardown** is now a **required acceptance item** (no swallowed failures;
  runner re-inspected; `teardown.json` gate). **Interruption recovery** via the
  janitor. Both detailed in `joy-media-ci-open-items-2026-09-08.md` §1–2.

### Evidence files in this branch

`joy-media-ci-baseline-2026-09-08.md` · `…-benchmarks-…` · `…-coverage-matrix-…`
· `…-repetition-contract-…` · `…-open-items-…` · `…-benchmark-results-…` · this
file. Plus `ci-gate-summary.ts` + `.test.ts`, `ci-namespace-janitor.mjs`, and the
hardened `real-service-acceptance.mjs` teardown.

**On independent acceptance:** v2 replaces v1; `ci-dev.yml` gets scoped triggers
(PR + push-to-`main` only, not every `codex/**`); the janitor `--sweep` is
enabled. Then R2 completion resumes (GAP 1 / 2 / 4 / 5).
